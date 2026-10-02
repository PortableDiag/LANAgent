import crypto from 'crypto';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';
import { Agent } from '../../models/Agent.js';
import PQueueModule from 'p-queue';
const PQueue = PQueueModule.default || PQueueModule;

const DEFAULT_IDEMPOTENCY_TTL = 600;
const MAX_PROVIDER_CHAIN_LENGTH = 10;
const AVAILABLE_PROVIDER_ORDER = ['openai', 'openrouter', 'huggingface'];

class ImageGenerationService {
    constructor() {
        this.providerManager = null;
        this.settings = null;
        this.initialized = false;
        this.queue = new PQueue({ concurrency: 5 });
        // Idempotency: short-lived cache of recent results + in-flight de-dup
        this.idempotencyCache = new NodeCache({
            stdTTL: DEFAULT_IDEMPOTENCY_TTL,
            checkperiod: 60,
            maxKeys: 500,
            useClones: false
        });
        this.pendingByKey = new Map(); // key -> Promise
    }

    async initialize(providerManager) {
        if (this.initialized && this.providerManager) {
            return;
        }

        this.providerManager = providerManager;
        await this.loadSettings();
        this.initialized = true;
        logger.info('ImageGenerationService initialized');
    }

    async loadSettings() {
        try {
            const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
            this.settings = agent?.mediaGeneration?.image || this.getDefaultSettings();
        } catch (error) {
            logger.warn('Failed to load image generation settings, using defaults:', error.message);
            this.settings = this.getDefaultSettings();
        }
    }

    getDefaultSettings() {
        return {
            enabled: true,
            provider: 'openai',
            fallbackProviders: [],
            openai: {
                model: 'gpt-image-1',
                size: '1024x1024',
                quality: 'auto'
            },
            huggingface: {
                model: 'black-forest-labs/FLUX.1-schnell',
                numInferenceSteps: 5
            },
            openrouter: {
                model: 'google/gemini-3.1-flash-image',
                aspectRatio: '1:1',
                resolution: '',
                quality: 'auto'
            },
            idempotency: {
                enabled: true,
                ttlSeconds: DEFAULT_IDEMPOTENCY_TTL
            }
        };
    }

    isIdempotencyEnabled() {
        return this.settings?.idempotency?.enabled !== false;
    }

    getIdempotencyTTL() {
        const t = this.settings?.idempotency?.ttlSeconds;
        return Number.isFinite(t) && t > 0 ? t : DEFAULT_IDEMPOTENCY_TTL;
    }

    /**
     * Compute a stable cache key from prompt + options. Caller may supply
     * options.idempotencyKey to override. `priority` and `idempotencyKey`
     * themselves are excluded from key derivation.
     */
    computeIdempotencyKey(prompt, options = {}) {
        if (options.idempotencyKey) return String(options.idempotencyKey);
        const { priority, idempotencyKey, ...rest } = options;
        const sanitized = {};
        for (const [k, v] of Object.entries(rest)) {
            if (typeof v === 'function') continue;
            if (Buffer.isBuffer(v)) continue;
            sanitized[k] = v;
        }
        const payload = JSON.stringify({ prompt, options: sanitized });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    /**
     * Generate an image with a given prompt and options, supporting priority levels.
     * When idempotency is enabled, concurrent identical requests share the same
     * in-flight promise and recently-completed identical requests return the cached
     * result (TTL configurable via settings.idempotency.ttlSeconds, default 10m).
     */
    async generate(prompt, options = {}) {
        if (!this.initialized) {
            throw new Error('ImageGenerationService not initialized. Call initialize() first.');
        }

        if (!this.settings.enabled) {
            throw new Error('Image generation is disabled in settings');
        }

        const priority = options.priority || 0;

        if (!this.isIdempotencyEnabled()) {
            return this.queue.add(() => this.generateImageTask(prompt, options), { priority });
        }

        const key = this.computeIdempotencyKey(prompt, options);

        const inFlight = this.pendingByKey.get(key);
        if (inFlight) {
            logger.debug(`ImageGen idempotency: joining in-flight request key=${key.slice(0, 10)}…`);
            return inFlight;
        }

        const cached = this.idempotencyCache.get(key);
        if (cached !== undefined) {
            logger.debug(`ImageGen idempotency: cache hit key=${key.slice(0, 10)}…`);
            return cached;
        }

        const promise = this.queue.add(() => this.generateImageTask(prompt, options), { priority });
        this.pendingByKey.set(key, promise);
        promise
            .then(result => {
                if (result && result.success !== false) {
                    try {
                        this.idempotencyCache.set(key, result, this.getIdempotencyTTL());
                    } catch (e) {
                        // node-cache throws when maxKeys is hit; treat as soft cap and skip
                        logger.debug(`ImageGen idempotency cache full, skipping store: ${e.message}`);
                    }
                }
            })
            .catch(() => {})
            .finally(() => {
                this.pendingByKey.delete(key);
            });
        return promise;
    }

    /**
     * Build an ordered, duplicate-free provider chain. The requested provider
     * always has precedence, followed by configured fallbacks and then the
     * established availability order. The full chain is always built: a provider
     * that is not registered at all has always been substituted, even for strict
     * callers. Strictness only stops failover after a provider was actually tried.
     */
    getProviderChain(requestedProvider, fallbackProviders = []) {
        const candidates = [requestedProvider];

        if (Array.isArray(fallbackProviders)) {
            candidates.push(...fallbackProviders);
        }
        candidates.push(...AVAILABLE_PROVIDER_ORDER);

        const seen = new Set();
        return candidates
            .filter(providerName => typeof providerName === 'string' && providerName.trim())
            .map(providerName => providerName.trim().toLowerCase())
            .filter(providerName => {
                if (seen.has(providerName) || seen.size >= MAX_PROVIDER_CHAIN_LENGTH) {
                    return false;
                }
                seen.add(providerName);
                return true;
            });
    }

    /**
     * Resolve a provider by name while tolerating provider registration casing.
     */
    getProviderByName(providerName) {
        const providers = this.providerManager?.providers;
        if (!providers || typeof providerName !== 'string') {
            return null;
        }

        const normalizedName = providerName.toLowerCase();
        const directProvider = providers.get(normalizedName);
        if (directProvider && typeof directProvider.generateImage === 'function') {
            return directProvider;
        }

        for (const provider of providers.values()) {
            if (
                provider &&
                typeof provider.name === 'string' &&
                provider.name.toLowerCase() === normalizedName &&
                typeof provider.generateImage === 'function'
            ) {
                return provider;
            }
        }

        return null;
    }

    /**
     * Attach provider-attempt details without replacing the original provider
     * error. This keeps the original stack and error type available to callers.
     */
    attachProviderFailureMetadata(error, providerAttempts, originalError) {
        if (!error || typeof error !== 'object') {
            return error;
        }

        try {
            error.providerAttempts = providerAttempts;
            if (originalError && !error.originalError) {
                error.originalError = originalError;
            }
        } catch (metadataError) {
            logger.debug(`Unable to attach image provider failure metadata: ${metadataError.message}`);
        }

        return error;
    }

    async generateImageTask(prompt, options = {}) {
        const requestedProvider = options.provider || this.settings.provider;
        // A caller that named a provider or a model chose it deliberately (the paid
        // external route forwards both from the customer), and a model id is only
        // meaningful to the provider it belongs to. Those requests never fail over
        // to a different provider after a generation failure.
        const disableProviderFailover = options.disableProviderFailover === true ||
            Boolean(options.provider) ||
            Boolean(options.model);
        const fallbackProviders = this.settings?.fallbackProviders || [];
        const providerChain = this.getProviderChain(requestedProvider, fallbackProviders);
        const providerAttempts = [];
        let firstError = null;

        for (const providerName of providerChain) {
            const providerInstance = this.getProviderByName(providerName);

            if (!providerInstance) {
                providerAttempts.push({
                    provider: providerName,
                    available: false,
                    retryable: true
                });
                continue;
            }

            try {
                const result = await this.generateWithProvider(providerInstance, prompt, options);
                providerAttempts.push({
                    provider: providerName,
                    available: true,
                    success: true
                });
                return result;
            } catch (error) {
                const retryable = isRetryableError(error);
                providerAttempts.push({
                    provider: providerName,
                    available: true,
                    success: false,
                    retryable,
                    error
                });

                if (!firstError) {
                    firstError = error;
                }

                if (disableProviderFailover || !retryable) {
                    throw error;
                }

                // aiProviders.locked means "spend on this provider only": a failed
                // request fails rather than being billed to another provider.
                if (await this.isProviderLocked()) {
                    logger.warn(`[provider-lock] image provider ${providerName} failed; failover blocked by the provider lock`);
                    throw error;
                }

                logger.warn(
                    `Image provider ${providerName} failed with a retryable error; trying the next provider`
                );
            }
        }

        if (firstError) {
            this.attachProviderFailureMetadata(firstError, providerAttempts, firstError);
            throw firstError;
        }

        const unavailableError = new Error(
            `Provider ${requestedProvider} not available and no fallback found`
        );
        this.attachProviderFailureMetadata(unavailableError, providerAttempts, unavailableError);
        throw unavailableError;
    }

    async isProviderLocked() {
        if (typeof this.providerManager?.isLocked !== 'function') return false;
        try {
            return await this.providerManager.isLocked();
        } catch {
            // Fail closed on spending, as providerManager.isLocked() itself does.
            return true;
        }
    }

    async generateWithProvider(providerInstance, prompt, options = {}) {
        const provider = providerInstance.name.toLowerCase();

        let providerOptions;
        if (provider === 'openai') {
            providerOptions = {
                ...this.settings.openai,
                ...options
            };
        } else if (provider === 'huggingface') {
            providerOptions = {
                ...this.settings.huggingface,
                ...options
            };
        } else if (provider === 'openrouter') {
            providerOptions = {
                ...this.getDefaultSettings().openrouter,
                ...(this.settings.openrouter || {}),
                ...options
            };
        } else {
            providerOptions = options;
        }

        logger.info(`Generating image with ${provider}: "${prompt.substring(0, 50)}..."`);

        try {
            const result = await retryOperation(async () => {
                const generatedResult = await providerInstance.generateImage(prompt, providerOptions);

                if (!generatedResult || !generatedResult.success) {
                    throw new Error(generatedResult?.error || 'Image generation failed');
                }

                return generatedResult;
            }, {
                retries: 3,
                factor: 2,
                minTimeout: 1000,
                maxTimeout: 5000,
                shouldRetry: isRetryableError
            });

            logger.info(`Image generated successfully with ${provider}`);
            return result;
        } catch (error) {
            logger.error(`Image generation failed with ${provider}:`, error.message);
            throw error;
        }
    }

    getAvailableImageProviders() {
        if (!this.providerManager?.providers) {
            return [];
        }

        return AVAILABLE_PROVIDER_ORDER
            .map(providerName => this.getProviderByName(providerName))
            .filter(Boolean);
    }

    getAvailableImageProvider() {
        const availableProviders = this.getAvailableImageProviders();
        return availableProviders[0] || null;
    }

    getSettings() {
        return this.settings;
    }

    async updateSettings(newSettings) {
        try {
            const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
            if (!agent) {
                throw new Error('Agent not found');
            }

            if (!agent.mediaGeneration) {
                agent.mediaGeneration = {};
            }

            agent.mediaGeneration.image = {
                ...this.settings,
                ...newSettings
            };

            await agent.save();
            await this.loadSettings();

            logger.info('Image generation settings updated');
            return this.settings;
        } catch (error) {
            logger.error('Failed to update image generation settings:', error);
            throw error;
        }
    }

    isEnabled() {
        return this.settings?.enabled ?? true;
    }

    getAvailableModels() {
        return {
            openai: [
                { id: 'gpt-image-1', name: 'GPT-Image-1' },
                { id: 'gpt-image-1.5', name: 'GPT-Image-1.5' },
                { id: 'dall-e-3', name: 'DALL-E 3' },
                { id: 'dall-e-2', name: 'DALL-E 2' }
            ],
            huggingface: [
                { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX.1 Schnell' },
                { id: 'black-forest-labs/FLUX.1-dev', name: 'FLUX.1 Dev' },
                { id: 'stabilityai/stable-diffusion-3-medium', name: 'Stable Diffusion 3 Medium' },
                { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL 1.0' }
            ]
        };
    }

    getAvailableSizes() {
        return {
            openai: [
                { id: '1024x1024', name: '1024x1024 (Square)' },
                { id: '1792x1024', name: '1792x1024 (Landscape)' },
                { id: '1024x1792', name: '1024x1792 (Portrait)' },
                { id: '512x512', name: '512x512 (Small)' }
            ]
        };
    }
}

export default new ImageGenerationService();
