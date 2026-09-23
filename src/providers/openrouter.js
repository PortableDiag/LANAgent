import OpenAI from "openai";
import { createHash } from "crypto";
import axios from "axios";
import { BaseProvider } from "./BaseProvider.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://openrouter.ai/api/v1";

// The public catalog needs no API key, so a provider that failed to
// authenticate can still describe what it would have called.
const MODELS_URL = `${BASE_URL}/models`;

// Refresh the catalog at most this often in-process. The scheduled model
// updater persists it to ModelCache; this is the in-provider safety net for
// pricing lookups between those runs.
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export class OpenRouterProvider extends BaseProvider {
  // Upstreams do not cache short prompts (OpenAI's floor is ~1024 tokens). Requests below
  // this are excluded from cache statistics entirely rather than counted as misses.
  static CACHE_MIN_PROMPT_TOKENS = 1024;
  // Consecutive eligible misses before saying something. One miss is ordinary.
  static CACHE_MISS_ALERT_AFTER = 5;

  constructor(config = {}) {
    super("OpenRouter", config);
    // OpenRouter serves web search as a first-class plugin, so this provider
    // really does search rather than answering from training data.
    this.supportsWebSearch = true;
    this.client = null;
    this.models = {
      chat: config.chatModel || config.model || process.env.OPENROUTER_CHAT_MODEL || "openai/gpt-4o-mini",
      // Vision goes through the same chat endpoint — a separate id only so the
      // chat model can stay text-only without breaking analyzeImage().
      vision: config.visionModel || process.env.OPENROUTER_VISION_MODEL || config.chatModel || config.model || process.env.OPENROUTER_CHAT_MODEL || "openai/gpt-4o-mini"
    };
    this.requestTimeoutMs = Number(
      config.requestTimeoutMs ?? process.env.OPENROUTER_TIMEOUT_MS ?? 120000
    );
    // id → { promptPerToken, completionPerToken, contextLength, inputModalities,
    //        supportsReasoning }. Empty until the catalog loads; every consumer
    //        must treat "not in the map" as unknown, never as zero.
    this.catalog = new Map();
    this.catalogFetchedAt = 0;
    this._catalogPromise = null;

    // Prompt-cache accounting. Kept separately from this.metrics because the question
    // "is caching working" must be answerable without reading a bill — see _recordCache().
    this.cacheStats = {
      eligibleRequests: 0,   // prompts big enough that a cache COULD apply
      hits: 0,               // eligible requests that came back with cached tokens
      cachedTokens: 0,
      eligiblePromptTokens: 0,
      consecutiveMisses: 0
    };

    // Pin the upstream so the cache is reachable at all. OpenRouter load-balances one
    // model across several upstreams (gpt-5.6-luna is served by both OpenAI and Azure),
    // and a prompt cache lives ON the upstream — so unpinned routing means a cold cache
    // every time the router moves. Measured 2026-09-18: unpinned gave 0 cached tokens on
    // an identical 8.8k-token prompt; pinned gave 8812/8815.
    //
    // allow_fallbacks stays TRUE: preferring an upstream buys cache hits, but refusing to
    // route anywhere else would turn one upstream's outage into ours. A fallback costs a
    // cold cache, not a failure.
    this.pinUpstream = String(
      config.pinUpstream ?? process.env.OPENROUTER_PIN_UPSTREAM ?? 'true'
    ).toLowerCase() !== 'false';
    this.providerOrder = (config.providerOrder || process.env.OPENROUTER_PROVIDER_ORDER || '')
      .split(',').map(x => x.trim()).filter(Boolean);
  }

  /**
   * OpenRouter `provider` routing preferences for a model, or null when pinning is off.
   *
   * Default order is the model id's own vendor prefix ("openai/gpt-5.6-luna" -> "openai"),
   * which is the first-party upstream for every namespaced id. A wrong guess is harmless:
   * with allow_fallbacks the router just ignores an order it cannot satisfy.
   */
  _providerRouting(model) {
    if (!this.pinUpstream) return null;
    const order = this.providerOrder.length
      ? this.providerOrder
      : [String(model).split('/')[0]].filter(Boolean);
    if (order.length === 0) return null;
    return { order, allow_fallbacks: true };
  }

  /**
   * Record what the prompt cache actually did, and say so when it is doing nothing.
   *
   * A cache that silently stops working costs money and changes no output, so nothing
   * else in the system would ever surface it — the operator's concern exactly. Small
   * prompts are excluded from the statistics rather than counted as misses: upstreams
   * do not cache below ~1k tokens, so counting them would bury a real regression in
   * noise from intent-detection calls.
   */
  /**
   * Fingerprint of the region a prefix cache can actually reach: the start of the first
   * message. Two misses with the SAME fingerprint mean the upstream or its cache is the
   * problem; two misses with DIFFERENT fingerprints mean the prompt prefix is changing and
   * no amount of routing will help. Without this the two causes are indistinguishable from
   * the outside, which is what makes a dead cache hard to diagnose.
   */
  _promptFingerprint(messages) {
    const first = messages?.[0]?.content;
    const head = typeof first === 'string' ? first : JSON.stringify(first ?? '');
    if (!head) return null;
    const h = (t) => createHash('sha1').update(t).digest('hex').slice(0, 8);
    // Hash the WHOLE first message, not a window of it: on a 47k-token prompt a 4000-char
    // window covers ~2%, so matching heads proved almost nothing. Quarter hashes locate
    // WHERE divergence starts — the first quarter that differs is the region to look at.
    const q = Math.ceil(head.length / 4);
    return {
      full: h(head),
      chars: head.length,
      quarters: [0, 1, 2, 3].map(i => h(head.slice(i * q, (i + 1) * q))),
      messages: messages?.length ?? 0
    };
  }

  _recordCache(usage, model, upstream, fingerprint) {
    const prompt = usage?.prompt_tokens || 0;
    if (prompt < OpenRouterProvider.CACHE_MIN_PROMPT_TOKENS) return;

    const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
    const st = this.cacheStats;
    st.eligibleRequests++;
    st.eligiblePromptTokens += prompt;
    st.cachedTokens += cached;

    if (cached > 0) {
      st.hits++;
      st.consecutiveMisses = 0;
      logger.debug(
        `OpenRouter cache hit: ${cached}/${prompt} prompt tokens (${Math.round(100 * cached / prompt)}%) ` +
        `on ${model} via ${upstream || 'unknown'}`
      );
      return;
    }

    st.consecutiveMisses++;
    if (fingerprint) {
      // Logged on every eligible miss: the sequence of fingerprints IS the diagnosis.
      const prev = this._lastMissFingerprint;
      let verdict = '';
      if (prev) {
        if (prev.full === fingerprint.full) {
          verdict = ' | first message IDENTICAL — the prompt is stable, suspect the upstream or its cache';
        } else {
          const diverged = fingerprint.quarters.findIndex((q, i) => q !== prev.quarters[i]);
          verdict = ` | first message CHANGED (from ${prev.full}, ${prev.chars} chars) — first differing ` +
            `quarter: ${diverged < 0 ? 'length only' : diverged + 1}/4. Routing cannot fix an unstable prompt.`;
        }
      }
      logger.info(
        `[openrouter-cache] miss on ${prompt} prompt tokens | msg0 ${fingerprint.full} ` +
        `(${fingerprint.chars} chars, ${fingerprint.messages} messages) | ${model} via ` +
        `${upstream || 'unknown'}${verdict}`
      );
      this._lastMissFingerprint = fingerprint;
    }
    // One miss is ordinary (first call, or the prefix genuinely changed). A run of them
    // on large prompts means the cache is not working — a changing prefix, or the router
    // moving between upstreams — and that is worth saying out loud, once per run.
    if (st.consecutiveMisses === OpenRouterProvider.CACHE_MISS_ALERT_AFTER) {
      logger.warn(
        `[openrouter-cache] ${st.consecutiveMisses} consecutive cache misses on prompts ` +
        `over ${OpenRouterProvider.CACHE_MIN_PROMPT_TOKENS} tokens (latest ${prompt} on ${model} ` +
        `via ${upstream || 'unknown'}). Either the prompt prefix changes between calls, or the ` +
        `upstream is moving — check pinUpstream/OPENROUTER_PROVIDER_ORDER. Paying full price for ` +
        `every prompt until this resolves.`
      );
    }
  }

  /** Prompt-cache summary, safe to read at any time. */
  getCacheStats() {
    const st = this.cacheStats;
    return {
      ...st,
      hitRate: st.eligibleRequests ? st.hits / st.eligibleRequests : null,
      cachedTokenShare: st.eligiblePromptTokens ? st.cachedTokens / st.eligiblePromptTokens : null,
      pinnedUpstream: this.pinUpstream ? (this.providerOrder.length ? this.providerOrder : 'model vendor') : false
    };
  }

  async initialize() {
    try {
      const apiKey = this.config.apiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OpenRouter API key not found");
      }

      this.client = new OpenAI({
        apiKey,
        baseURL: BASE_URL,
        timeout: this.requestTimeoutMs,
        // OpenRouter attributes usage to an app via these two headers. They are
        // optional and purely cosmetic on their leaderboard — but sending the
        // agent's own name keeps a shared key's spend attributable per instance.
        defaultHeaders: {
          "HTTP-Referer": this.config.siteUrl || process.env.OPENROUTER_SITE_URL || "https://lanagent.net",
          "X-Title": this.config.appName || process.env.OPENROUTER_APP_NAME || process.env.AGENT_NAME || "LANAgent"
        }
      });

      // Cost: OpenRouter bills 446+ models from a dozen upstreams and changes
      // prices without notice, so there is no pricing table to hardcode that
      // would still be true next month. Two sources instead, in order:
      //   1. usage.cost on the response itself — what was ACTUALLY billed, in
      //      USD credits. Recorded verbatim by generateResponse() as directCost.
      //   2. the public catalog's per-token pricing, for the metrics rollup when
      //      a response carried no cost field.
      // A model absent from the catalog contributes 0 rather than a guessed
      // price: an invented number in a spend figure is worse than a low one,
      // and the per-request directCost path still carries the real total.
      this.calculateCost = (metrics) => {
        let totalCost = 0;
        for (const [model, usage] of Object.entries(metrics.tokensByModel || {})) {
          const price = this.catalog.get(model);
          if (!price) continue;
          totalCost += (usage.input || 0) * price.promptPerToken;
          totalCost += (usage.output || 0) * price.completionPerToken;
        }
        return totalCost;
      };

      // Don't block startup on it — a slow catalog fetch must not delay boot,
      // and everything it feeds degrades gracefully while it is empty.
      this.refreshCatalog().catch(err =>
        logger.debug(`OpenRouter catalog prefetch failed: ${err.message}`)
      );

      await super.initialize();
      logger.info(`OpenRouter provider initialized successfully (model: ${this.models.chat})`);
    } catch (error) {
      logger.error("Failed to initialize OpenRouter provider:", error);
      throw error;
    }
  }

  /**
   * Fetch the public model catalog. No API key required, so this works even
   * when the configured key is rejected. Concurrent callers share one request.
   * @param {boolean} force - refetch even if the cached copy is still fresh
   */
  async refreshCatalog(force = false) {
    if (!force && this.catalog.size > 0 && Date.now() - this.catalogFetchedAt < CATALOG_TTL_MS) {
      return this.catalog;
    }
    if (this._catalogPromise) return this._catalogPromise;

    this._catalogPromise = (async () => {
      try {
        const res = await axios.get(MODELS_URL, { timeout: 20000 });
        const entries = Array.isArray(res.data?.data) ? res.data.data : [];
        if (entries.length === 0) {
          throw new Error("catalog response contained no models");
        }

        const catalog = new Map();
        for (const m of entries) {
          if (!m?.id) continue;
          catalog.set(m.id, {
            name: m.name || m.id,
            // Catalog prices are per-token USD strings ("0.0000006"), not per-1K.
            // A NEGATIVE price is OpenRouter's "decided at routing time" sentinel — the
            // auto-router entries (openrouter/auto, /fusion, /pareto-code, …) all publish
            // -1. Stored verbatim it would SUBTRACT from the spend estimate. Unknown and
            // unpriced must land on the same value, and that value is 0: a model absent
            // from the catalog already contributes 0, and the per-request directCost from
            // usage.cost carries the real figure either way.
            promptPerToken: this._price(m.pricing?.prompt),
            completionPerToken: this._price(m.pricing?.completion),
            contextLength: m.context_length || m.top_provider?.context_length || null,
            inputModalities: m.architecture?.input_modalities || [],
            supportsReasoning: Array.isArray(m.supported_parameters) &&
              m.supported_parameters.includes("reasoning")
          });
        }

        this.catalog = catalog;
        this.catalogFetchedAt = Date.now();
        this.updateAvailableModels(
          Array.from(catalog.entries()).map(([id, meta]) => ({
            id,
            name: meta.name,
            contextWindow: meta.contextLength,
            category: "chat"
          }))
        );
        logger.info(`OpenRouter catalog loaded: ${catalog.size} models`);
        return catalog;
      } finally {
        this._catalogPromise = null;
      }
    })();

    return this._catalogPromise;
  }

  /**
   * A catalog price as a usable per-token number: anything not finite and positive
   * (missing, unparseable, or the -1 "priced at routing time" sentinel) is unknown,
   * and unknown is 0 — never a negative that would credit the spend estimate.
   */
  _price(raw) {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Does this model spend its token budget on hidden reasoning before the first
   * visible token? Such a model returns content:"" when the budget is small —
   * the same failure openai.js floors against, and it reaches here through the
   * same 124+ call sites that pass maxTokens:20 for intent detection.
   *
   * The catalog is authoritative; the id heuristic covers the window before it
   * loads and any model whose flags are missing.
   */
  _isReasoningModel(model) {
    const meta = this.catalog.get(model);
    if (meta) return meta.supportsReasoning;
    return /(^|\/)(o[1-9]|gpt-5|deepseek-r|qwq)|:thinking|-thinking|-reasoner/i.test(model);
  }

  /**
   * OpenRouter can answer 200 with an error payload instead of a completion —
   * upstream refusals and moderation blocks arrive that way. Left unchecked the
   * caller gets content:undefined and no indication anything went wrong.
   */
  _assertUsableCompletion(completion, model) {
    if (completion?.error) {
      const err = new Error(`OpenRouter error for ${model}: ${completion.error.message || "unknown"}`);
      err.status = completion.error.code;
      throw err;
    }
    if (!Array.isArray(completion?.choices) || completion.choices.length === 0) {
      throw new Error(`OpenRouter returned no choices for ${model}`);
    }
  }

  /**
   * Metrics payload for one completion. Uses the cost OpenRouter actually
   * billed when it reported one, so spend is measured rather than estimated.
   */
  _usagePayload(completion, model, extra = {}) {
    const usage = completion?.usage || {};
    const payload = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      model: completion?.model || model,
      ...extra
    };
    // usage.cost is USD credits for THIS request. Number.isFinite keeps a
    // missing field from being recorded as a $0 request.
    if (Number.isFinite(usage.cost)) payload.directCost = usage.cost;
    return payload;
  }

  _buildParams(prompt, options = {}) {
    const model = options.model || this.models.chat;
    const messages = options.messages || [
      { role: "system", content: options.systemPrompt || "You are a helpful AI assistant." },
      { role: "user", content: prompt }
    ];

    const params = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      // OpenRouter normalises max_tokens across upstreams, so the
      // max_completion_tokens split openai.js needs is not required here.
      max_tokens: options.maxTokens || 1000,
      // Ask for real billing on every response rather than estimating it.
      usage: { include: true },
      ...options.additionalParams
    };

    if (this._isReasoningModel(model)) {
      params.max_tokens = Math.max(params.max_tokens, 4000);
    }

    // Caller-supplied routing always wins; otherwise pin so the prompt cache is reachable.
    if (params.provider === undefined) {
      const routing = this._providerRouting(model);
      if (routing) params.provider = routing;
    }

    if (options.enableWebSearch === true) {
      // The `web` plugin is OpenRouter's search path and works with any model,
      // unlike the `:online` id suffix which changes the model id and so breaks
      // per-model cost attribution.
      params.plugins = [
        ...(params.plugins || []),
        { id: "web", max_results: options.maxSearches || 5 }
      ];
    }

    return { model, params };
  }

  async generateResponse(prompt, options = {}) {
    const startTime = Date.now();

    try {
      const { model, params } = this._buildParams(prompt, options);
      const completion = await this.client.chat.completions.create({ ...params, stream: false });
      this._assertUsableCompletion(completion, model);

      const responseTime = Date.now() - startTime;
      const content = completion.choices[0].message?.content || "";

      // OpenRouter routes to whichever upstream provider it picked, which is not
      // always the one the model id implies — log both so a surprising bill or a
      // surprising answer can be traced to the route that produced it.
      logger.info(
        `OpenRouter call: requested ${model}, served ${completion.model}` +
        (completion.provider ? ` via ${completion.provider}` : "")
      );

      // requestType MUST stay inside TokenUsage's enum (chat/embedding/audio/vision/
      // speech/tts/image/video). It is not a free-text label: the usage queue is flushed
      // with insertMany, so one document Mongoose rejects fails the WHOLE batch — a
      // single web-search call was discarding up to ten unrelated usage records with it.
      // Web search is an attribute of a chat call, not a modality of its own, so it goes
      // in metadata.
      this._recordCache(completion.usage, completion.model || model, completion.provider,
        this._promptFingerprint(params.messages));

      const cachedTokens = completion.usage?.prompt_tokens_details?.cached_tokens || 0;
      const meta = {};
      if (options.enableWebSearch) meta.webSearch = true;
      if (cachedTokens > 0) meta.cachedTokens = cachedTokens;
      if (completion.provider) meta.upstream = completion.provider;

      await this.updateMetrics(responseTime, this._usagePayload(completion, model, {
        requestType: "chat",
        metadata: Object.keys(meta).length ? meta : undefined
      }));

      return {
        content,
        model: completion.model || model,
        usage: completion.usage,
        provider: this.name,
        upstreamProvider: completion.provider,
        cachedPromptTokens: cachedTokens,
        webSearchUsed: options.enableWebSearch === true
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenRouter generateResponse error:", error);
      throw error;
    }
  }

  async generateStreamingResponse(prompt, options = {}, onChunk) {
    const startTime = Date.now();

    try {
      const { model, params } = this._buildParams(prompt, options);
      const stream = await this.client.chat.completions.create({ ...params, stream: true });

      let fullContent = "";
      let usage = null;
      let servedModel = model;

      for await (const chunk of stream) {
        if (chunk.error) {
          throw new Error(`OpenRouter stream error: ${chunk.error.message || "unknown"}`);
        }
        if (chunk.model) servedModel = chunk.model;
        // With usage.include the final chunk carries the billed totals and no
        // choices — read it before assuming every chunk is a delta.
        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (delta) {
          fullContent += delta;
          if (onChunk) {
            try { await onChunk(delta, fullContent); } catch (e) { /* ignore callback errors */ }
          }
        }
      }

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, this._usagePayload({ usage, model: servedModel }, model));

      return { content: fullContent, model: servedModel, usage, provider: this.name };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenRouter generateStreamingResponse error:", error);
      throw error;
    }
  }

  /**
   * Vision through the same chat endpoint. Refuses up front when the catalog
   * says the routed model cannot take images: OpenRouter answers that case with
   * a 400 from the upstream, which reads as a provider fault rather than a
   * model-selection mistake.
   */
  async analyzeImage(imageBuffer, prompt, options = {}) {
    const startTime = Date.now();
    const model = options.model || this.models.vision;

    try {
      await this.refreshCatalog().catch(() => {});
      const meta = this.catalog.get(model);
      if (meta && !meta.inputModalities.includes("image")) {
        throw new Error(
          `OpenRouter model ${model} does not accept images — set OPENROUTER_VISION_MODEL to one that does`
        );
      }

      const mimeType = options.mimeType || "image/jpeg";
      const base64 = Buffer.isBuffer(imageBuffer)
        ? imageBuffer.toString("base64")
        : String(imageBuffer);

      const completion = await this.client.chat.completions.create({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt || "Describe this image." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } }
          ]
        }],
        max_tokens: options.maxTokens || 1000,
        usage: { include: true }
      });
      this._assertUsableCompletion(completion, model);

      const responseTime = Date.now() - startTime;
      await this.updateMetrics(responseTime, this._usagePayload(completion, model, { requestType: "vision" }));

      return {
        analysis: completion.choices[0].message?.content || "",
        model: completion.model || model,
        usage: completion.usage,
        provider: this.name
      };
    } catch (error) {
      this.metrics.errors++;
      logger.error("OpenRouter analyzeImage error:", error);
      throw error;
    }
  }

  // OpenRouter is a chat-completions gateway only — it serves no embeddings,
  // audio or speech endpoint. Returning null (rather than throwing) matches the
  // other partial providers, so allowedProviders() can route those capabilities
  // elsewhere without treating this provider as broken.
  async generateEmbedding(text) {
    logger.warn("OpenRouter does not support embeddings");
    return null;
  }

  async transcribeAudio(audioBuffer) {
    logger.warn("OpenRouter does not support audio transcription");
    return null;
  }

  async generateSpeech(text, options = {}) {
    logger.warn("OpenRouter does not support speech generation");
    return null;
  }

  /**
   * Remaining credit on the key. OpenRouter exposes this directly, which is
   * worth surfacing: the manager's quota cooldown only reacts AFTER a 402.
   */
  async getCredits() {
    const apiKey = this.config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    try {
      const res = await axios.get(`${BASE_URL}/credits`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const data = res.data?.data || {};
      const total = Number(data.total_credits);
      const used = Number(data.total_usage);
      return {
        totalCredits: Number.isFinite(total) ? total : null,
        totalUsage: Number.isFinite(used) ? used : null,
        remaining: Number.isFinite(total) && Number.isFinite(used) ? total - used : null
      };
    } catch (error) {
      logger.debug(`OpenRouter credits lookup failed: ${error.message}`);
      return null;
    }
  }

  getCapabilities() {
    return {
      local: false,
      chat: true,
      streaming: true,
      webSearch: true,
      vision: true,
      embeddings: false,
      transcription: false,
      speech: false
    };
  }

  healthCheck() {
    return {
      ...super.healthCheck(),
      configured: !!(this.config.apiKey || process.env.OPENROUTER_API_KEY),
      chatModel: this.models.chat,
      promptCache: this.getCacheStats(),
      catalogSize: this.catalog.size,
      catalogAge: this.catalogFetchedAt ? Date.now() - this.catalogFetchedAt : null
    };
  }
}
