import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import { retryOperation } from '../utils/retryUtils.js';

export class BaseProvider extends EventEmitter {
  constructor(name, config = {}) {
    super();
    this.name = name;
    this.config = config;
    this.isActive = false;
    this.simulationMode = config.simulationMode || false;
    this.metrics = {
      totalRequests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: 0,
      averageResponseTime: 0,
      tokensByDay: {},
      tokensByModel: {},
      costEstimate: 0
    };
    this.alertThresholds = {
      responseTime: config.responseTimeThreshold || 1000, // default 1000ms
      errorRate: config.errorRateThreshold || 0.1 // default 10%
    };
    // Token usage batching — flush via insertMany instead of per-request create
    this.tokenUsageQueue = [];
    this.queueThreshold = config.queueThreshold || 10;
    this.queueFlushInterval = config.queueFlushInterval || 5000;
    this._flushTimer = setInterval(() => this.flushTokenUsageQueue(), this.queueFlushInterval);
  }

  async initialize() {
    logger.info(`Initializing ${this.name} provider`);
    // Override in subclasses
  }

  async generateResponse(prompt, options = {}) {
    if (this.simulationMode) {
      logger.info(`[Simulation] ${this.name}.generateResponse called`);
      return { text: "Simulated response", tokens: 10 };
    }
    throw new Error("generateResponse must be implemented by subclass");
  }

  async generateEmbedding(text) {
    if (this.simulationMode) {
      logger.info(`[Simulation] ${this.name}.generateEmbedding called`);
      return { embedding: [0.1, 0.2, 0.3], tokens: 5 };
    }
    throw new Error("generateEmbedding must be implemented by subclass");
  }

  async transcribeAudio(audioBuffer) {
    if (this.simulationMode) {
      logger.info(`[Simulation] ${this.name}.transcribeAudio called`);
      return { transcript: "Simulated transcript", tokens: 15 };
    }
    throw new Error("transcribeAudio must be implemented by subclass");
  }

  async generateSpeech(text, options = {}) {
    if (this.simulationMode) {
      logger.info(`[Simulation] ${this.name}.generateSpeech called`);
      return { audioBuffer: Buffer.from("Simulated audio"), tokens: 20 };
    }
    throw new Error("generateSpeech must be implemented by subclass");
  }

  async analyzeImage(imageBuffer, prompt) {
    if (this.simulationMode) {
      logger.info(`[Simulation] ${this.name}.analyzeImage called`);
      return { analysis: "Simulated analysis", tokens: 25 };
    }
    throw new Error("analyzeImage must be implemented by subclass");
  }

  async updateMetrics(requestTime, usage = {}) {
    this.metrics.totalRequests++;
    
    let inputTokens, outputTokens, totalTokens;
    
    if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
      inputTokens = usage.input_tokens;
      outputTokens = usage.output_tokens;
      totalTokens = inputTokens + outputTokens;
    } else if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
      inputTokens = usage.prompt_tokens || 0;
      outputTokens = usage.completion_tokens || 0;
      totalTokens = usage.total_tokens || (inputTokens + outputTokens);
    } else {
      inputTokens = usage.inputTokens || 0;
      outputTokens = usage.outputTokens || 0;
      totalTokens = usage.totalTokens || (inputTokens + outputTokens);
    }
    
    this.metrics.inputTokens += inputTokens;
    this.metrics.outputTokens += outputTokens;
    this.metrics.totalTokens += totalTokens;
    
    const today = new Date().toISOString().split('T')[0];
    if (!this.metrics.tokensByDay[today]) {
      this.metrics.tokensByDay[today] = { input: 0, output: 0, total: 0 };
    }
    this.metrics.tokensByDay[today].input += inputTokens;
    this.metrics.tokensByDay[today].output += outputTokens;
    this.metrics.tokensByDay[today].total += totalTokens;
    
    const model = usage.model || this.config.model || 'unknown';
    if (!this.metrics.tokensByModel[model]) {
      this.metrics.tokensByModel[model] = { input: 0, output: 0, total: 0, count: 0 };
    }
    this.metrics.tokensByModel[model].input += inputTokens;
    this.metrics.tokensByModel[model].output += outputTokens;
    this.metrics.tokensByModel[model].total += totalTokens;
    this.metrics.tokensByModel[model].count += 1;
    
    let requestCost = 0;
    // Use directCost for image/video generation (priced per-generation, not per-token)
    if (usage.directCost !== undefined) {
      requestCost = usage.directCost;
      this.metrics.costEstimate += requestCost;
    } else if (this.calculateCost) {
      const tempMetrics = {
        tokensByModel: {
          [model]: { input: inputTokens, output: outputTokens }
        }
      };
      requestCost = this.calculateCost(tempMetrics);
      this.metrics.costEstimate = this.calculateCost(this.metrics);
    }
    
    const prevAvg = this.metrics.averageResponseTime;
    this.metrics.averageResponseTime = 
      (prevAvg * (this.metrics.totalRequests - 1) + requestTime) / this.metrics.totalRequests;
    
    this.tokenUsageQueue.push({
      provider: this.name.toLowerCase(),
      model,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens,
      cost: requestCost,
      responseTime: requestTime,
      requestType: usage.requestType || 'chat',
      success: true,
      userId: usage.userId,
      metadata: usage.metadata
    });

    if (this.tokenUsageQueue.length >= this.queueThreshold) {
      this.flushTokenUsageQueue();
    }

    this.checkAlerts();
  }

  checkAlerts() {
    const errorRate = this.metrics.errors / this.metrics.totalRequests;
    if (this.metrics.averageResponseTime > this.alertThresholds.responseTime) {
      this.emitAlert('High response time', `Average response time exceeded threshold: ${this.metrics.averageResponseTime}ms`);
    }
    if (errorRate > this.alertThresholds.errorRate) {
      this.emitAlert('High error rate', `Error rate exceeded threshold: ${(errorRate * 100).toFixed(2)}%`);
    }
  }

  emitAlert(title, message) {
    logger.warn(`Alert: ${title} - ${message}`);
    this.emit('alert', { title, message });
  }

  getMetrics() {
    return { ...this.metrics };
  }

  activate() {
    this.isActive = true;
    this.emit("activated");
  }

  async flushTokenUsageQueue() {
    if (this.tokenUsageQueue.length === 0) return;
    const queueCopy = [...this.tokenUsageQueue];
    this.tokenUsageQueue = [];
    try {
      const { TokenUsage } = await import('../models/TokenUsage.js');
      await retryOperation(() => TokenUsage.insertMany(queueCopy), { retries: 3, context: 'TokenUsagePersist' });
      logger.debug(`Token usage batch persisted for ${this.name}: ${queueCopy.length} records`);
    } catch (error) {
      logger.error(`Failed to persist token usage batch for ${this.name} (${queueCopy.length} records lost):`, error);
    }
  }

  deactivate() {
    this.isActive = false;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this.flushTokenUsageQueue();
    this.emit("deactivated");
  }

  updateAvailableModels(models) {
    logger.info(`Updating available models for ${this.name}:`, 
      Array.isArray(models) ? `${models.length} models` : 'model categories');
    
    if (this.models) {
      if (typeof this.models === 'object' && !Array.isArray(models)) {
        Object.assign(this.models, models);
      } else if (Array.isArray(models)) {
        this.availableModels = models;
      }
    }
    
    this.emit('models-updated', models);
  }

  getAvailableModels() {
    if (this.availableModels) {
      return this.availableModels;
    }
    
    if (this.models && typeof this.models === 'object' && !Array.isArray(this.models)) {
      return [];
    }
    
    return this.models || [];
  }

  /**
   * Update the configuration dynamically and apply changes to the provider's behavior at runtime.
   * @param {Object} newConfig - The new configuration parameters.
   */
  updateConfig(newConfig) {
    try {
      this.config = { ...this.config, ...newConfig };
      logger.info(`Configuration updated for ${this.name}`);
      this.emit('config-updated', this.config);
    } catch (error) {
      logger.error(`Failed to update configuration for ${this.name}:`, error);
    }
  }

  /**
   * Update alert thresholds dynamically and emit an event when thresholds are updated.
   * @param {Object} newThresholds - The new alert threshold values.
   */
  updateAlertThresholds(newThresholds) {
    try {
      this.alertThresholds = { ...this.alertThresholds, ...newThresholds };
      logger.info(`Alert thresholds updated for ${this.name}`);
      this.emit('alert-thresholds-updated', this.alertThresholds);
    } catch (error) {
      logger.error(`Failed to update alert thresholds for ${this.name}:`, error);
    }
  }

  /**
   * Perform a health check to ensure the provider is functioning correctly.
   * @returns {Object} - The health status of the provider.
   */
  healthCheck() {
    const status = {
      isActive: this.isActive,
      totalRequests: this.metrics.totalRequests,
      errorRate: this.metrics.errors / this.metrics.totalRequests,
      averageResponseTime: this.metrics.averageResponseTime
    };
    logger.info(`Health check for ${this.name}:`, status);
    return status;
  }
}