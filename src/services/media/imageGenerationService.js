import { logger } from '../../utils/logger.js';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';
import { Agent } from '../../models/Agent.js';
import PQueueModule from 'p-queue';
const PQueue = PQueueModule.default || PQueueModule;

class ImageGenerationService {
    constructor() {
        this.providerManager = null;
        this.settings = null;
        this.initialized = false;
        this.queue = new PQueue({ concurrency: 5 });
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
            openai: {
                model: 'gpt-image-1',
                size: '1024x1024',
                quality: 'auto'
            },
            huggingface: {
                model: 'black-forest-labs/FLUX.1-schnell',
                numInferenceSteps: 5
            }
        };
    }

    /**
     * Generate an image with a given prompt and options, supporting priority levels.
     * @param {string} prompt - The prompt for image generation.
     * @param {Object} options - Options for image generation.
     * @param {number} [options.priority=0] - Priority level for the request.
     * @returns {Promise<Object>} - The result of the image generation.
     */
    async generate(prompt, options = {}) {
        if (!this.initialized) {
            throw new Error('ImageGenerationService not initialized. Call initialize() first.');
        }

        if (!this.settings.enabled) {
            throw new Error('Image generation is disabled in settings');
        }

        const priority = options.priority || 0;
        return this.queue.add(() => this.generateImageTask(prompt, options), { priority });
    }

    async generateImageTask(prompt, options) {
        const provider = options.provider || this.settings.provider;
        const providerInstance = this.providerManager.providers.get(provider);

        if (!providerInstance) {
            const availableProvider = this.getAvailableImageProvider();
            if (!availableProvider) {
                throw new Error(`Provider ${provider} not available and no fallback found`);
            }
            logger.warn(`Provider ${provider} not available, using fallback: ${availableProvider.name}`);
            return this.generateWithProvider(availableProvider, prompt, options);
        }

        return this.generateWithProvider(providerInstance, prompt, options);
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
        } else {
            providerOptions = options;
        }

        logger.info(`Generating image with ${provider}: "${prompt.substring(0, 50)}..."`);

        try {
            const result = await retryOperation(() => providerInstance.generateImage(prompt, providerOptions), {
                retries: 3,
                factor: 2,
                minTimeout: 1000,
                maxTimeout: 5000,
                shouldRetry: isRetryableError
            });

            if (!result.success) {
                throw new Error(result.error || 'Image generation failed');
            }

            logger.info(`Image generated successfully with ${provider}`);
            return result;
        } catch (error) {
            logger.error(`Image generation failed with ${provider}:`, error.message);
            throw error;
        }
    }

    getAvailableImageProvider() {
        if (!this.providerManager?.providers) {
            return null;
        }

        for (const providerName of ['openai', 'huggingface']) {
            const provider = this.providerManager.providers.get(providerName);
            if (provider && typeof provider.generateImage === 'function') {
                return provider;
            }
        }

        return null;
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
