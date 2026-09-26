import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import { OpenAIProvider } from "../providers/openai.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { GabProvider } from "../providers/gab.js";
import { HuggingFaceProvider } from "../providers/huggingface.js";
import { OllamaProvider } from "../providers/ollama.js";
import { BitNetProvider } from "../providers/bitnet.js";
import { UncensoredProvider } from "../providers/uncensored.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { retryOperation, estimateRetryWallClockMs } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

// Attempts allowed for one generation call are `GENERATION_RETRIES + 1`. Named because
// getGenerationTimeoutMs() has to report a budget covering the whole loop, and a literal
// repeated in both places is how the two drift apart.
const GENERATION_RETRIES = 3;

// How long to skip a provider that reported depleted credits before probing it again.
// Short enough that a mid-cycle top-up is picked up quickly without a restart.
const PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

export class ProviderManager extends EventEmitter {
  constructor() {
    super();
    this.providers = new Map();
    this.activeProvider = null;
    this.fallbackProviders = [];
    this.providerMetricsCache = new NodeCache({ stdTTL: 300 });
    // Providers that reported exhausted quota/credits, mapped to the epoch ms at which
    // they may be probed again. Skipped (not called) while cooling down.
    this.quotaCooldowns = new Map();
    // Provider lock enforcement (2026-08-28). The lock used to gate only switchProvider(),
    // so a single failed call still went to the fallback chain — 18 self-modification
    // generations in five days were quietly billed to OpenAI while "locked to huggingface".
    // The lock means "spend on this provider only": when set, a failed request FAILS.
    this.lockedFallbackBlocks = 0;
    this.lastLockedFallbackBlockAt = null;
    this._lockCache = { value: null, at: 0 };
    this.commands = [
      { command: 'adjustProviderPriority', description: 'Adjust provider priority based on performance metrics', usage: 'adjustProviderPriority()' }
    ];
  }

  /**
   * A quota/billing failure (depleted credits, exceeded quota) will keep failing until the
   * account is topped up or the billing period rolls over — unlike a transient 429 rate limit.
   */
  isQuotaError(error) {
    const message = String(error?.message || '');
    return error?.status === 402 ||
      error?.response?.status === 402 ||
      /\b402\b|payment required|depleted|insufficient (credits|funds|quota|balance)|exceeded your (current )?quota|billing/i.test(message);
  }

  isCoolingDown(name) {
    const until = this.quotaCooldowns.get(name);
    if (!until) return false;
    if (Date.now() >= until) {
      this.quotaCooldowns.delete(name);
      logger.info(`[provider-quota] ${name} cooldown expired — will be probed again`);
      return false;
    }
    return true;
  }

  markQuotaExhausted(name, error) {
    if (this.quotaCooldowns.has(name)) return;
    this.quotaCooldowns.set(name, Date.now() + PROVIDER_QUOTA_COOLDOWN_MS);
    logger.warn(
      `[provider-quota] ${name} reports exhausted credits — skipping it for ` +
      `${Math.round(PROVIDER_QUOTA_COOLDOWN_MS / 60000)}m and using fallbacks | ${error.message}`
    );
  }

  /**
   * Is the provider selection locked (aiProviders.locked)? Cached briefly so the hot
   * path does not hit Mongo per request. Fails CLOSED on spending: if the flag cannot be
   * read and there is no prior reading, behave as locked.
   */
  async isLocked() {
    const LOCK_CACHE_MS = 15000;
    if (this._lockCache.value !== null && Date.now() - this._lockCache.at < LOCK_CACHE_MS) {
      return this._lockCache.value;
    }
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentName = process.env.AGENT_NAME || 'LANAgent';
      const doc = await Agent.findOne({ name: agentName }, { 'aiProviders.locked': 1 });
      const value = doc?.aiProviders?.locked === true;
      this._lockCache = { value, at: Date.now() };
      return value;
    } catch (err) {
      if (this._lockCache.value !== null) return this._lockCache.value;
      logger.warn(`[provider-lock] lock check failed (${err.message}) — treating as LOCKED (no spend on other providers)`);
      return true;
    }
  }

  invalidateLockCache() {
    this._lockCache = { value: null, at: 0 };
  }

  /**
   * Providers a multi-provider capability (embedding / transcription / TTS) may use.
   *
   * Locked → only the locked provider, so work the locked provider CAN do is never
   * billed to another one.
   *
   * But the lock only has something to say when the locked provider is actually a
   * candidate. If it is not on the list at all, filtering to it deletes the capability
   * rather than controlling spend — there was no substitution to prevent, because the
   * locked provider was never going to serve this. So the lock does not apply and the
   * normal candidate list stands.
   *
   * 2026-09-18: found the hard way. Locking to OpenRouter — which serves no embeddings
   * endpoint at all — silently killed embeddings agent-wide the moment it became the
   * active provider: the candidate list is openai/huggingface/ollama, the lock filtered
   * it to nothing, and every caller logged "No provider available for embedding
   * generation". It also defeated the standing decision that vector-intent embeddings
   * run on OpenAI, whenever the lock pointed anywhere else.
   */
  async allowedProviders(candidates, capability = 'this capability') {
    if (!(await this.isLocked())) return candidates;
    const lockedTo = this.providerNameOf(this.activeProvider);

    if (!candidates.includes(lockedTo)) {
      logger.info(
        `[provider-lock] locked to ${lockedTo}, which cannot serve ${capability} — ` +
        `the lock does not apply here; using ${candidates.join('/')}`
      );
      return candidates;
    }

    return candidates.filter(name => name === lockedTo);
  }

  providerNameOf(provider) {
    return Array.from(this.providers.entries()).find(([, p]) => p === provider)?.[0] || 'unknown';
  }

  /** Is there another registered provider, not itself cooling down, that could serve a request? */
  hasUsableAlternative(provider) {
    return Array.from(this.providers.entries())
      .some(([name, p]) => p !== provider && !this.isCoolingDown(name));
  }

  async initialize() {
    logger.info("Initializing AI providers...");
    
    let savedConfigs = {};
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      const aiProviders = agentData?.aiProviders || {};
      
      if (aiProviders.configurations) {
        savedConfigs = aiProviders.configurations;
      } else {
        savedConfigs = aiProviders;
      }
      
      for (const [providerKey, providerConfig] of Object.entries(aiProviders)) {
        if (providerKey !== 'current' && providerKey !== 'configurations') {
          if (!savedConfigs[providerKey]) savedConfigs[providerKey] = {};
          if (providerConfig.chatModel && !savedConfigs[providerKey].model) {
            savedConfigs[providerKey].chatModel = providerConfig.chatModel;
          }
        }
      }
      
      logger.info("Loaded saved AI provider configurations:", savedConfigs);
    } catch (error) {
      logger.debug("Could not load saved AI provider configurations:", error.message);
    }
    
    // A provider whose saved config carries enabled:false is not registered at
    // all — not in the active slot, not in the fallback chain. Having an API
    // key in .env is availability, not consent (2026-07-21: a fallback chain
    // hit the credit-less Anthropic account and alerted the operator twice).
    const providerDisabled = (key) => {
      if (savedConfigs[key]?.enabled === false) {
        logger.info(`Provider ${key} disabled in saved config — not registering`);
        return true;
      }
      return false;
    };

    if (process.env.OPENAI_API_KEY && !providerDisabled('openai')) {
      const config = {
        apiKey: process.env.OPENAI_API_KEY,
        ...savedConfigs.openai
      };
      const openai = new OpenAIProvider(config);
      await this.registerProvider("openai", openai);
    }

    if (process.env.ANTHROPIC_API_KEY && !providerDisabled('anthropic')) {
      const config = {
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...savedConfigs.anthropic
      };
      const anthropic = new AnthropicProvider(config);
      await this.registerProvider("anthropic", anthropic);
    }

    if (process.env.GAB_AI_API_KEY && !providerDisabled('gab')) {
      const config = {
        apiKey: process.env.GAB_AI_API_KEY,
        ...savedConfigs.gab
      };
      const gab = new GabProvider(config);
      await this.registerProvider("gab", gab);
    }

    if (process.env.HUGGINGFACE_TOKEN && !providerDisabled('huggingface')) {
      const config = {
        apiKey: process.env.HUGGINGFACE_TOKEN,
        ...savedConfigs.huggingface
      };
      const huggingface = new HuggingFaceProvider(config);
      await this.registerProvider("huggingface", huggingface);
    }

    // Ollama - Local LLM provider (no API key required)
    if ((process.env.OLLAMA_BASE_URL || process.env.ENABLE_OLLAMA === 'true') && !providerDisabled('ollama')) {
      try {
        const config = {
          ...savedConfigs.ollama,
          // Env vars take precedence over saved DB config
          ...(process.env.OLLAMA_BASE_URL && { baseUrl: process.env.OLLAMA_BASE_URL }),
          ...(process.env.OLLAMA_CHAT_MODEL && { chatModel: process.env.OLLAMA_CHAT_MODEL }),
          ...(process.env.OLLAMA_EMBEDDING_MODEL && { embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL }),
          ...(process.env.OLLAMA_VISION_MODEL && { visionModel: process.env.OLLAMA_VISION_MODEL }),
        };
        if (!config.baseUrl) config.baseUrl = 'http://localhost:11434';
        const ollama = new OllamaProvider(config);
        await this.registerProvider("ollama", ollama);
      } catch (error) {
        logger.warn(`Ollama provider not available: ${error.message}`);
      }
    }

    // BitNet - Local CPU-optimized 1-bit LLM inference (no API key required)
    if ((process.env.BITNET_BASE_URL || process.env.ENABLE_BITNET === 'true') && !providerDisabled('bitnet')) {
      try {
        const config = {
          baseUrl: process.env.BITNET_BASE_URL || 'http://localhost:8080',
          chatModel: process.env.BITNET_CHAT_MODEL,
          contextLength: parseInt(process.env.BITNET_CONTEXT_LENGTH) || 2048,
          ...savedConfigs.bitnet
        };
        const bitnet = new BitNetProvider(config);
        await this.registerProvider("bitnet", bitnet);
      } catch (error) {
        logger.warn(`BitNet provider not available: ${error.message}`);
      }
    }

    // OpenRouter - one key, 400+ models across every upstream vendor.
    // Env vars take precedence over saved DB config, matching ollama/bitnet.
    if (process.env.OPENROUTER_API_KEY && !providerDisabled('openrouter')) {
      try {
        const config = {
          apiKey: process.env.OPENROUTER_API_KEY,
          ...savedConfigs.openrouter,
          ...(process.env.OPENROUTER_CHAT_MODEL && { chatModel: process.env.OPENROUTER_CHAT_MODEL }),
          ...(process.env.OPENROUTER_VISION_MODEL && { visionModel: process.env.OPENROUTER_VISION_MODEL })
        };
        const openrouter = new OpenRouterProvider(config);
        await this.registerProvider("openrouter", openrouter);
      } catch (error) {
        logger.warn(`OpenRouter provider not available: ${error.message}`);
      }
    }

    // Uncensored AI - OpenAI-compatible uncensored LLM
    if (process.env.UNCENSORED_API_KEY && !providerDisabled('uncensored')) {
      try {
        const config = {
          apiKey: process.env.UNCENSORED_API_KEY,
          ...savedConfigs.uncensored
        };
        const uncensored = new UncensoredProvider(config);
        await this.registerProvider("uncensored", uncensored);
      } catch (error) {
        logger.warn(`Uncensored AI provider not available: ${error.message}`);
      }
    }

    await this.syncModelsWithDatabase();

    if (this.providers.size > 0) {
      let defaultProvider = process.env.DEFAULT_AI_PROVIDER;
      
      try {
        const { Agent } = await import('../models/Agent.js');
        const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
        if (agentData?.aiProviders?.current && this.providers.has(agentData.aiProviders.current)) {
          defaultProvider = agentData.aiProviders.current;
          logger.info(`Loading saved AI provider preference: ${defaultProvider}`);
        }
      } catch (error) {
        logger.debug("Could not load saved AI provider preference:", error.message);
      }
      
      if (!defaultProvider || !this.providers.has(defaultProvider)) {
        const priorityOrder = ["openai", "anthropic", "openrouter", "gab", "huggingface", "ollama", "bitnet"];
        for (const provider of priorityOrder) {
          if (this.providers.has(provider)) {
            defaultProvider = provider;
            break;
          }
        }
        
        if (!defaultProvider) {
          defaultProvider = this.providers.keys().next().value;
        }
      }
      
      logger.info(`Setting default provider to: ${defaultProvider}`);
      await this.switchProvider(defaultProvider);
    } else {
      logger.warn("No AI providers available!");
    }
  }

  async registerProvider(name, provider) {
    try {
      await provider.initialize();
      this.providers.set(name, provider);
      logger.info(`Registered AI provider: ${name}`);
      
      provider.on("error", (error) => {
        logger.error(`Provider ${name} error:`, error);
        this.handleProviderError(name, error);
      });
    } catch (error) {
      logger.error(`Failed to register provider ${name}:`, error);
    }
  }

  async syncModelsWithDatabase() {
    try {
      // Load the per-provider model list cached by the daily model-update job
      // and push it into each live provider via updateAvailableModels. Without
      // this, provider.availableModels is unset after every restart and the
      // dashboard's /api/ai/models/:provider endpoint returns [] until 3 AM
      // when the scheduled job runs and repopulates it in memory.
      try {
        const { ModelCache } = await import('../models/ModelCache.js');
        const caches = await ModelCache.find({});
        for (const cache of caches) {
          const provider = this.providers.get(cache.provider);
          if (provider?.updateAvailableModels && Array.isArray(cache.models) && cache.models.length > 0) {
            provider.updateAvailableModels(cache.models);
            logger.info(`Loaded ${cache.models.length} cached models for ${cache.provider} (last refresh: ${cache.updatedAt?.toISOString?.() || 'unknown'})`);
          }
        }
      } catch (cacheErr) {
        logger.debug('ModelCache load skipped:', cacheErr.message);
      }

      const { Agent } = await import('../models/Agent.js');
      const agentData = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      if (!agentData?.aiProviders?.configurations) {
        return;
      }

      for (const [providerKey, provider] of this.providers.entries()) {
        const savedConfig = agentData.aiProviders.configurations[providerKey];
        if (savedConfig?.model && provider.models) {
          const oldModel = provider.models.chat;
          provider.models.chat = savedConfig.model;
          if (provider.models.vision === oldModel) {
            provider.models.vision = savedConfig.model;
          }
          if (oldModel !== savedConfig.model) {
            logger.info(`Synced ${providerKey} model: ${oldModel} → ${savedConfig.model}`);
          }
        }
      }
    } catch (error) {
      logger.error("Failed to sync models with database:", error);
    }
  }

  async switchProvider(name, options = {}) {
    // Audit: who's calling switchProvider? Stack helps find any new offenders.
    const stack = new Error().stack.split('\n').slice(2, 6).map(s => s.trim()).join(' ← ');
    const currentName = this.activeProvider?.name;

    // Lock gate: when aiProviders.locked is true, only callers with options.force
    // can change the active provider. The web UI's /api/ai/switch endpoint is
    // the only legitimate force-caller (JWT-authenticated, user intent).
    // Switching to the same provider, or initializing from null, always proceeds.
    if (!options.force && currentName && currentName !== name) {
      if (await this.isLocked()) {
        logger.warn(`[provider-lock] switchProvider(${name}) BLOCKED — locked to ${currentName} | caller: ${stack}`);
        return;
      }
    } else if (options.force) {
      logger.info(`[provider-lock] switchProvider(${name}) forced (UI/explicit) | caller: ${stack}`);
    }

    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider ${name} not found`);
    }

    if (this.activeProvider) {
      this.activeProvider.deactivate();
    }

    provider.activate();
    this.activeProvider = provider;
    logger.info(`Switched to AI provider: ${name}`);
    
    await this.syncModelsWithDatabase();
    
    try {
      const { Agent } = await import('../models/Agent.js');
      const agentName = process.env.AGENT_NAME || 'LANAgent';
      const result = await Agent.updateOne({ name: agentName }, {
        $set: { 'aiProviders.current': name }
      }, { upsert: true });
      logger.info(`Saved AI provider preference: ${name}`, result);
      
      const saved = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" }, { aiProviders: 1 });
      logger.info(`Verified saved preference:`, saved?.aiProviders?.current);
    } catch (error) {
      logger.error("Failed to save AI provider preference:", error);
    }
    
    this.emit("provider-switched", name);
  }

  async getCurrentProvider() {
    if (!this.activeProvider) {
      if (this.providers.size > 0) {
        const firstProvider = this.providers.keys().next().value;
        logger.warn(`No active provider, attempting to use ${firstProvider}`);
        await this.switchProvider(firstProvider);
        return this.activeProvider;
      }
      throw new Error("No active AI provider");
    }
    return this.activeProvider;
  }

  getProviderList() {
    return Array.from(this.providers.keys()).map(key => {
      const provider = this.providers.get(key);
      return {
        name: provider.name,
        key: key,
        active: this.activeProvider === provider,
        metrics: provider.getMetrics()
      };
    });
  }

  /**
   * The wall-clock budget the provider that would serve `options` allows for one
   * attempt, in ms — null when it cannot be determined (no active provider, or a
   * provider that does not describe a budget).
   *
   * For callers that need to wrap generateResponse() in a watchdog. Derive the
   * deadline from this and stay above it: a watchdog below the provider's own
   * budget converts every slow call into a guaranteed failure.
   */
  /**
   * Wall-clock budget for one `generateResponse()` call ON THIS MANAGER — the whole
   * retry loop, not one attempt at it.
   *
   * The provider reports what it allows for a single attempt. This method wraps that
   * call in `retryOperation`, so a caller racing `generateResponse` against its own
   * deadline and sizing it from the per-attempt figure aborts partway through attempt
   * two. That is the same caller-below-callee bug the per-attempt budget was
   * introduced to fix, displaced one layer up: the scanner's watchdog sat 15s above
   * 90s while the loop beneath it could legitimately run to ~370s.
   *
   * Returns null when the provider cannot describe its budget, so the caller falls
   * back to its own floor rather than to a number invented here.
   */
  async getGenerationTimeoutMs(options = {}) {
    try {
      const provider = await this.getCurrentProvider();
      const perAttemptMs = provider?.getGenerationTimeoutMs?.(options) ?? null;
      if (perAttemptMs === null || perAttemptMs === undefined) return null;
      // Derived from the SAME option the call will use, so a caller that funds a
      // different number of attempts is quoted the budget for the loop it will
      // actually get rather than for the default one.
      return estimateRetryWallClockMs({
        perAttemptMs,
        retries: options.retries ?? GENERATION_RETRIES
      });
    } catch (error) {
      return null;
    }
  }

  async generateResponse(prompt, options = {}) {
    const provider = await this.getCurrentProvider();

    const providerName = this.providerNameOf(provider);
    const model = provider.models?.chat || provider.model || 'unknown';

    // A provider with exhausted credits fails every call until it is topped up. Skip the
    // doomed round-trip (and its error spam) and serve from a fallback until the cooldown
    // lapses. The configured provider is left in place — this never switches the selection.
    // Only worth skipping if something else can actually serve the request; with no usable
    // alternative, still call it (a failed attempt beats no attempt).
    // Locked → never skip the selected provider in favour of another one.
    if (this.isCoolingDown(providerName) && this.hasUsableAlternative(provider) && !(await this.isLocked())) {
      return await this.tryFallbackProviders(prompt, options);
    }

    logger.info(`🤖 Generating response using provider: ${providerName}, model: ${model}`);
    logger.info(`Active provider check: ${this.activeProvider?.name || 'none'}, Provider count: ${this.providers.size}`);

    // enableWebSearch is a tool call only anthropic/openai implement. Anywhere else it is
    // dropped on the floor and the model answers from training data — the request looks like
    // a success while carrying stale invented sources. Say so rather than let it pass silently.
    if (options.enableWebSearch === true && provider.supportsWebSearch !== true) {
      logger.warn(`${providerName} has no web search tool — enableWebSearch ignored, answering from training data`);
    }

    try {
      return await retryOperation(() => provider.generateResponse(prompt, options), { retries: options.retries ?? GENERATION_RETRIES });
    } catch (error) {
      if (this.isQuotaError(error)) {
        this.markQuotaExhausted(providerName, error);
      } else {
        logger.error("Primary provider failed, trying fallback...", error);
      }
      return await this.tryFallbackProviders(prompt, options);
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    const provider = await this.getCurrentProvider();
    const providerName = Array.from(this.providers.entries()).find(([key, prov]) => prov === provider)?.[0] || 'unknown';

    if (typeof provider.generateStreamingResponse !== 'function') {
      logger.info(`Provider ${providerName} does not support streaming, falling back to non-streaming`);
      const result = await this.generateResponse(prompt, options);
      if (onChunk) {
        try { await onChunk(result.content, result.content); } catch (e) {}
      }
      return result;
    }

    logger.info(`Streaming response using provider: ${providerName}`);
    try {
      return await provider.generateStreamingResponse(prompt, options, onChunk);
    } catch (error) {
      logger.error("Primary provider streaming failed, falling back to non-streaming:", error.message);
      const result = await this.generateResponse(prompt, options);
      if (onChunk) {
        try { await onChunk(result.content, result.content); } catch (e) {}
      }
      return result;
    }
  }

  /**
   * The cheaper model background work should use on this provider, if one is set:
   * `<PROVIDER>_AUX_MODEL` (e.g. OPENROUTER_AUX_MODEL). Null means "use the main model".
   */
  getAuxModel(providerName) {
    if (!providerName) return null;
    const envKey = `${String(providerName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AUX_MODEL`;
    return process.env[envKey]?.trim() || null;
  }

  /**
   * Generate with the auxiliary (cheap) model, for background work that does not need the
   * main model: memory analysis, intent classification, summaries.
   *
   * Stays on the CURRENT provider and overrides only the model for this one call, so it never
   * touches the provider selection or the lock. The aux model id is provider-specific, which is
   * why it is not passed through generateResponse: the fallback chain would hand an OpenRouter
   * slug to providers that do not know it. Any failure — no aux model configured, provider
   * cooling down, aux call erroring — falls through to the ordinary generateResponse path with
   * the caller's original options, so the worst case is today's behaviour.
   */
  async generateAux(prompt, options = {}) {
    if (options.model) return this.generateResponse(prompt, options);

    const provider = await this.getCurrentProvider();
    const providerName = this.providerNameOf(provider);
    const auxModel = this.getAuxModel(providerName);
    if (!auxModel || this.isCoolingDown(providerName)) {
      return this.generateResponse(prompt, options);
    }

    try {
      logger.info(`🤖 Aux generation on ${providerName}, model: ${auxModel}${options.auxTask ? ` (${options.auxTask})` : ''}`);
      return await retryOperation(() => provider.generateResponse(prompt, { ...options, model: auxModel }), { retries: 1 });
    } catch (error) {
      logger.warn(`Aux model ${auxModel} on ${providerName} failed (${error.message}); using the main model`);
      return this.generateResponse(prompt, options);
    }
  }

  async generateEmbedding(text) {
    // HuggingFace FIRST, deliberately. Memory embeddings were benched onto
    // sentence-transformers/all-MiniLM-L6-v2 on 2026-08-29 and have served every
    // embedding on this agent since (OpenAI: zero). That decision used to hold only
    // by accident — the provider lock happened to point at HuggingFace, so the lock
    // did the ordering. The moment the lock moved to a provider without embeddings,
    // the accident stopped working and this list would have sent embeddings to
    // OpenAI at 1536 dimensions instead of 384: new spend, and a THIRD vector table
    // that strands every row written since the bench (the store is one table per
    // width — see memory_embeddings_384). Encode the decision here instead.
    // Changing this order is changing the embedding model; read that note first.
    const embeddingProviders = ["huggingface", "openai", "ollama"];
    
    for (const providerName of await this.allowedProviders(embeddingProviders, 'embeddings')) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const embedding = await retryOperation(() => provider.generateEmbedding(text), { retries: 3 });
          if (embedding) return embedding;
        } catch (error) {
          logger.warn(`Embedding generation failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for embedding generation");
  }

  async transcribeAudio(audioBuffer) {
    const audioProviders = ["openai", "huggingface"];
    
    for (const providerName of await this.allowedProviders(audioProviders, 'transcription')) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const transcription = await retryOperation(() => provider.transcribeAudio(audioBuffer), { retries: 3 });
          if (transcription) return transcription;
        } catch (error) {
          logger.warn(`Audio transcription failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for audio transcription");
  }

  async generateSpeech(text, options = {}) {
    const ttsProviders = ["openai", "huggingface"];
    
    for (const providerName of await this.allowedProviders(ttsProviders, 'speech')) {
      const provider = this.providers.get(providerName);
      if (provider) {
        try {
          const speech = await retryOperation(() => provider.generateSpeech(text, options), { retries: 3 });
          if (speech) return speech;
        } catch (error) {
          logger.warn(`Speech generation failed with ${providerName}:`, error);
        }
      }
    }
    
    throw new Error("No provider available for speech generation");
  }

  async analyzeImage(imageBuffer, prompt) {
    const provider = await this.getCurrentProvider();
    return await retryOperation(() => provider.analyzeImage(imageBuffer, prompt), { retries: 3 });
  }

  async tryFallbackProviders(prompt, options) {
    if (await this.isLocked()) {
      this.lockedFallbackBlocks++;
      this.lastLockedFallbackBlockAt = new Date().toISOString();
      const lockedTo = this.providerNameOf(this.activeProvider);
      logger.warn(`[provider-lock] fallback BLOCKED — locked to ${lockedTo}; the request fails rather than spending on another provider (${this.lockedFallbackBlocks} blocked since boot)`);
      throw new Error(`AI request failed: locked provider ${lockedTo} is unavailable and cross-provider fallback is disabled by the provider lock`);
    }

    // A cooldown must never be the sole reason we have no AI at all: if every provider is
    // cooling down, drop the cooldowns and let them be tried for real rather than hard-failing.
    if (Array.from(this.providers.keys()).every(name => this.isCoolingDown(name))) {
      logger.warn('[provider-quota] every provider is quota-cooled — clearing cooldowns and retrying for real');
      this.quotaCooldowns.clear();
    }

    for (const [name, provider] of this.providers) {
      if (provider !== this.activeProvider && !this.isCoolingDown(name)) {
        try {
          logger.info(`Trying fallback provider: ${name}`);
          return await retryOperation(() => provider.generateResponse(prompt, options), { retries: options.retries ?? GENERATION_RETRIES });
        } catch (error) {
          if (this.isQuotaError(error)) {
            this.markQuotaExhausted(name, error);
          } else {
            logger.warn(`Fallback provider ${name} also failed:`, error);
          }
        }
      }
    }

    throw new Error("All AI providers failed");
  }

  handleProviderError(providerName, error) {
    this.emit("provider-error", { provider: providerName, error });
  }

  getMetrics() {
    const metrics = {};
    for (const [name, provider] of this.providers) {
      metrics[name] = provider.getMetrics();
    }
    return metrics;
  }

  /**
   * Adjust provider priority based on performance metrics
   */
  async adjustProviderPriority() {
    const metrics = this.getMetrics();
    const sortedProviders = Object.entries(metrics).sort((a, b) => {
      const aMetrics = a[1];
      const bMetrics = b[1];
      return (aMetrics.responseTime + aMetrics.errorRate) - (bMetrics.responseTime + bMetrics.errorRate);
    });

    this.fallbackProviders = sortedProviders.map(([name]) => name);
    logger.info("Adjusted provider priority based on metrics:", this.fallbackProviders);
  }

  async execute(command, params) {
    switch (command) {
      case 'adjustProviderPriority':
        return await this.adjustProviderPriority();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}