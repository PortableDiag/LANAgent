import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';
import { Agent } from '../../models/Agent.js';
import { decrypt } from '../../utils/encryption.js';
import axios from 'axios';

const MODELSLAB_BASE_URL = 'https://modelslab.com/api/v6/video';

class VideoGenerationService {
    constructor() {
        this.providerManager = null;
        this.settings = null;
        this.initialized = false;
        this.pendingJobs = new Map(); // Track OpenAI async jobs
        this.modelslabApiKey = null;
    }

    async initialize(providerManager) {
        if (this.initialized && this.providerManager) {
            return;
        }

        this.providerManager = providerManager;
        await this.loadSettings();

        // Initialize ModelsLab API key from encrypted DB or env var
        this.modelslabApiKey = await this.loadModelslabApiKey();

        this.initialized = true;
        logger.info('VideoGenerationService initialized');
    }

    async loadSettings() {
        try {
            const agent = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' });
            this.settings = agent?.mediaGeneration?.video || this.getDefaultSettings();
        } catch (error) {
            logger.warn('Failed to load video generation settings, using defaults:', error.message);
            this.settings = this.getDefaultSettings();
        }
    }

    async loadModelslabApiKey() {
        // Priority 1: Encrypted API key from video settings in DB (set via Settings UI)
        const modelslabSettings = this.settings?.['modelslab'];
        if (modelslabSettings?.apiKey) {
            try {
                const key = decrypt(modelslabSettings.apiKey);
                if (key) {
                    logger.info('Loaded ModelsLab API key from encrypted video settings');
                    return key;
                }
            } catch (error) {
                logger.warn('Failed to decrypt ModelsLab API key from settings:', error.message);
            }
        }

        // Priority 2: Environment variable fallback
        if (process.env.MODELSLAB_API_KEY) {
            logger.info('Using ModelsLab API key from MODELSLAB_API_KEY environment variable');
            return process.env.MODELSLAB_API_KEY;
        }

        logger.warn('No ModelsLab API key configured. Set it in Video Generation settings or MODELSLAB_API_KEY env var.');
        return null;
    }

    async reloadCredentials() {
        this.modelslabApiKey = await this.loadModelslabApiKey();
        if (this.modelslabApiKey) {
            logger.info('ModelsLab API key reloaded');
        }
    }

    getDefaultSettings() {
        return {
            enabled: true,
            provider: 'modelslab',
            modelslab: {
                model: 'wan2.1',
                endpoint: 'text2video_ultra',
                resolution: '720p',
                numFrames: 65,
                numInferenceSteps: 30,
                guidanceScale: 5.0,
                fps: 16
            },
            openai: {
                model: 'sora-2',
                size: '1280x720',
                duration: '8'
            },
            huggingface: {
                model: 'Wan-AI/Wan2.1-T2V-14B'
            }
        };
    }

    async generate(prompt, options = {}) {
        if (!this.initialized) {
            throw new Error('VideoGenerationService not initialized. Call initialize() first.');
        }

        if (!this.settings.enabled) {
            throw new Error('Video generation is disabled in settings');
        }

        const provider = options.provider || this.settings.provider;

        // ModelsLab is handled directly (like Replicate was)
        if (provider === 'modelslab') {
            return this.generateWithModelslab(prompt, options);
        }

        const providerInstance = this.providerManager.providers.get(provider);

        if (!providerInstance) {
            // Fallback to OpenAI if available (warn about content moderation)
            const openaiProvider = this.providerManager.providers.get('openai');
            if (openaiProvider && typeof openaiProvider.generateVideo === 'function') {
                logger.warn(`Provider ${provider} not available, falling back to OpenAI (content-moderated)`);
                return {
                    ...await this.generateWithProvider(openaiProvider, prompt, options),
                    fallbackWarning: 'Fell back to OpenAI — this provider applies content moderation and may alter your prompt.'
                };
            }
            // Try any available provider
            const availableProvider = this.getAvailableVideoProvider();
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

        // Get provider-specific options
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

        logger.info(`Generating video with ${provider}: "${prompt.substring(0, 50)}..."`);

        try {
            const result = await retryOperation(() => providerInstance.generateVideo(prompt, providerOptions), { retries: 2, context: 'video-generation' });

            if (!result.success) {
                throw new Error(result.error || 'Video generation failed');
            }

            // For OpenAI, track the async job
            if (result.jobId) {
                this.pendingJobs.set(result.jobId, {
                    prompt,
                    provider,
                    options: providerOptions,
                    startTime: Date.now(),
                    status: result.status
                });
            }

            logger.info(`Video generation initiated with ${provider}`);
            return result;
        } catch (error) {
            logger.error(`Video generation failed with ${provider}:`, error.message);
            throw error;
        }
    }

    async generateWithModelslab(prompt, options = {}) {
        if (!this.modelslabApiKey) {
            throw new Error('ModelsLab API key not configured. Set it in Video Generation settings or MODELSLAB_API_KEY env var.');
        }

        const mlSettings = this.settings['modelslab'] || this.getDefaultSettings()['modelslab'];
        const model = options.model || mlSettings.model;
        const endpoint = options.endpoint || mlSettings.endpoint || 'text2video_ultra';
        const resolution = options.resolution || mlSettings.resolution || '720p';
        const numFrames = options.numFrames || mlSettings.numFrames || 65;
        const numInferenceSteps = options.numInferenceSteps || mlSettings.numInferenceSteps || 30;
        const guidanceScale = options.guidanceScale || mlSettings.guidanceScale || 5.0;
        const fps = options.fps || mlSettings.fps || 16;
        const negativePrompt = options.negativePrompt || options.negative_prompt || '';

        // Map resolution to width/height
        const resolutionMap = {
            '480p': { width: 832, height: 480 },
            '720p': { width: 1280, height: 720 },
            '1080p': { width: 1920, height: 1080 }
        };
        const { width, height } = resolutionMap[resolution] || resolutionMap['720p'];

        logger.info(`Generating video with ModelsLab (${model} via ${endpoint}): "${prompt.substring(0, 80)}..." [${resolution}, ${numFrames} frames]`);

        try {
            // Step 1: Submit the generation request
            const requestBody = {
                key: this.modelslabApiKey,
                model_id: model,
                prompt,
                negative_prompt: negativePrompt || 'low quality, worst quality, deformed, distorted',
                height,
                width,
                num_frames: numFrames,
                num_inference_steps: numInferenceSteps,
                guidance_scale: guidanceScale,
                fps,
                output_format: 'mp4',
                webhook: null,
                track_id: null
            };

            logger.info(`ModelsLab request: ${endpoint}, model=${model}, ${width}x${height}, ${numFrames} frames`);

            const submitResponse = await axios.post(
                `${MODELSLAB_BASE_URL}/${endpoint}`,
                requestBody,
                { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
            );

            const submitData = submitResponse.data;
            logger.info(`ModelsLab submit response: status=${submitData.status}, id=${submitData.id}, eta=${submitData.eta}`);

            // If the video is immediately ready
            if (submitData.status === 'success' && submitData.output?.length > 0) {
                return this.downloadModelslabVideo(submitData.output, submitData.proxy_links, prompt, model);
            }

            if (submitData.status === 'error') {
                throw new Error(`ModelsLab API error: ${submitData.message || submitData.messege || JSON.stringify(submitData)}`);
            }

            // Step 2: Poll for completion
            const requestId = submitData.id;
            if (!requestId) {
                throw new Error(`ModelsLab returned no request ID. Response: ${JSON.stringify(submitData).substring(0, 300)}`);
            }

            const eta = parseInt(submitData.eta) || 120;
            return await this.pollModelslabJob(requestId, eta, prompt, model);

        } catch (error) {
            const detail = error.response?.data ? JSON.stringify(error.response.data).substring(0, 500) : '';
            logger.error(`ModelsLab video generation failed: ${error.message}` +
                (detail ? ` | detail: ${detail}` : ''));
            throw error;
        }
    }

    async pollModelslabJob(requestId, eta, prompt, model) {
        // Adaptive polling: start with longer intervals, increase frequency near ETA
        const maxTimeout = Math.max(eta * 3, 600) * 1000; // 3x ETA or 10 min minimum
        const startTime = Date.now();
        let pollInterval = Math.min(Math.max(eta * 0.15, 10), 30) * 1000; // 10-30s

        logger.info(`ModelsLab polling job ${requestId}, ETA=${eta}s, timeout=${maxTimeout / 1000}s, interval=${pollInterval / 1000}s`);

        while (Date.now() - startTime < maxTimeout) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));

            try {
                const pollResponse = await axios.post(
                    `${MODELSLAB_BASE_URL}/fetch/${requestId}`,
                    { key: this.modelslabApiKey },
                    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
                );

                const pollData = pollResponse.data;
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                logger.info(`ModelsLab poll ${requestId}: status=${pollData.status}, elapsed=${elapsed}s`);

                if (pollData.status === 'success' && pollData.output?.length > 0) {
                    logger.info(`ModelsLab job ${requestId} completed in ${elapsed}s`);
                    return this.downloadModelslabVideo(pollData.output, pollData.proxy_links, prompt, model);
                }

                if (pollData.status === 'error') {
                    throw new Error(`ModelsLab job failed: ${pollData.message || pollData.messege || 'Unknown error'}`);
                }

                // Adaptive: poll faster as we approach ETA
                const elapsedSec = (Date.now() - startTime) / 1000;
                if (elapsedSec > eta * 0.8) {
                    pollInterval = 10000; // 10s near/past ETA
                }

            } catch (error) {
                if (error.message.includes('ModelsLab job failed')) throw error;
                logger.warn(`ModelsLab poll error for ${requestId}: ${error.message}`);
                // Continue polling on transient errors
            }
        }

        throw new Error(`ModelsLab video generation timed out after ${maxTimeout / 1000}s (ETA was ${eta}s)`);
    }

    async downloadModelslabVideo(outputUrls, proxyLinks, prompt, model) {
        // Try output URLs first, then proxy_links as fallback
        const urlSets = [outputUrls, proxyLinks].filter(Boolean);

        for (const urls of urlSets) {
            for (const url of urls) {
                try {
                    logger.info(`Downloading ModelsLab video from: ${url.substring(0, 100)}`);
                    const response = await axios.get(url, {
                        responseType: 'arraybuffer',
                        timeout: 120000
                    });
                    const buffer = Buffer.from(response.data);

                    const cost = this.calculateModelslabCost();

                    logger.info(`ModelsLab video downloaded (${(buffer.length / 1024 / 1024).toFixed(1)}MB), cost: ~$${cost.toFixed(2)}`);

                    return {
                        success: true,
                        video: { buffer },
                        model,
                        provider: 'modelslab',
                        cost
                    };
                } catch (dlError) {
                    logger.warn(`Failed to download from ${url.substring(0, 80)}: ${dlError.message}`);
                }
            }
        }

        throw new Error('Failed to download video from all ModelsLab output URLs');
    }

    calculateModelslabCost() {
        // ModelsLab Ultra is $0.20/video flat, Standard is ~$0.08
        const endpoint = this.settings?.modelslab?.endpoint || 'text2video_ultra';
        return endpoint === 'text2video_ultra' ? 0.20 : 0.08;
    }

    async pollJobStatus(jobId, providerInstance, maxAttempts = 60, intervalMs = 10000) {
        let attempts = 0;

        while (attempts < maxAttempts) {
            try {
                const status = await providerInstance.getVideoStatus(jobId);

                logger.info(`Video job ${jobId} status: ${status.status} (${status.progress}%)`);

                if (status.status === 'completed' || status.status === 'succeeded') {
                    // Download the video
                    if (status.url) {
                        const buffer = await providerInstance.downloadVideo(status.url);
                        this.pendingJobs.delete(jobId);
                        return {
                            success: true,
                            video: { buffer },
                            jobId,
                            status: status.status
                        };
                    }
                    return status;
                }

                if (status.status === 'failed' || status.status === 'error') {
                    this.pendingJobs.delete(jobId);
                    const failError = new Error(`Video generation failed: ${status.error || 'Unknown error'}`);
                    failError.definitive = true;
                    throw failError;
                }

                // Update pending job status
                const job = this.pendingJobs.get(jobId);
                if (job) {
                    job.status = status.status;
                    job.progress = status.progress;
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, intervalMs));
                attempts++;
            } catch (error) {
                // Don't retry definitive failures (job failed/error status)
                if (error.definitive) throw error;
                logger.error(`Error polling video job ${jobId}:`, error.message);
                attempts++;
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }

        throw new Error(`Video generation timed out after ${maxAttempts} attempts`);
    }

    getAvailableVideoProvider() {
        if (!this.providerManager?.providers) {
            return null;
        }

        // Check OpenAI first, then HuggingFace
        for (const providerName of ['openai', 'huggingface']) {
            const provider = this.providerManager.providers.get(providerName);
            if (provider && typeof provider.generateVideo === 'function') {
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

            agent.mediaGeneration.video = {
                ...this.settings,
                ...newSettings
            };

            await agent.save();
            await this.loadSettings();

            logger.info('Video generation settings updated');
            return this.settings;
        } catch (error) {
            logger.error('Failed to update video generation settings:', error);
            throw error;
        }
    }

    isEnabled() {
        return this.settings?.enabled ?? true;
    }

    getPendingJobs() {
        const jobs = [];
        for (const [jobId, job] of this.pendingJobs) {
            jobs.push({
                jobId,
                ...job,
                elapsedMs: Date.now() - job.startTime
            });
        }
        return jobs;
    }

    getAvailableModels() {
        return {
            modelslab: [
                { id: 'wan2.1', name: 'Wan 2.1 (Ultra)' },
                { id: 'wan2.2', name: 'Wan 2.2 (Ultra)' },
                { id: 'cogvideox', name: 'CogVideoX (Standard)' },
                { id: 'wanx', name: 'WanX (Standard)' }
            ],
            openai: [
                { id: 'sora-2', name: 'Sora 2' }
            ],
            huggingface: [
                { id: 'Wan-AI/Wan2.1-T2V-14B', name: 'Wan 2.1 T2V 14B' }
            ]
        };
    }

    getAvailableDurations() {
        return {
            openai: [
                { id: '5', name: '5 seconds' },
                { id: '8', name: '8 seconds' },
                { id: '10', name: '10 seconds' }
            ]
        };
    }
}

export default new VideoGenerationService();
