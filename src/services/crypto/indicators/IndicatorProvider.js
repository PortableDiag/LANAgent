import { logger as baseLogger } from '../../../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../../../utils/retryUtils.js';
import { PriceIndicators } from './PriceIndicators.js';
import { TimeIndicators } from './TimeIndicators.js';
import { MoonIndicators } from './MoonIndicators.js';
import { PositionIndicators } from './PositionIndicators.js';
import { TechnicalIndicators } from './TechnicalIndicators.js';
import { MarketIndicators } from './MarketIndicators.js';

const logger = baseLogger.child ? baseLogger.child({ service: 'indicator-provider' }) : baseLogger;

class IndicatorProvider {
  constructor() {
    // Cache with 60 second TTL
    this.cache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

    // Registered indicator functions
    this.indicators = new Map();

    // Indicator metadata (for documentation)
    this.metadata = new Map();

    // Register all built-in indicators
    this.registerBuiltInIndicators();
  }

  /**
   * Register built-in indicator providers
   */
  registerBuiltInIndicators() {
    // Price indicators
    const priceIndicators = new PriceIndicators();
    for (const [name, fn] of priceIndicators.getIndicators()) {
      this.register(name, fn, priceIndicators.getMetadata(name));
    }

    // Time indicators
    const timeIndicators = new TimeIndicators();
    for (const [name, fn] of timeIndicators.getIndicators()) {
      this.register(name, fn, timeIndicators.getMetadata(name));
    }

    // Moon indicators
    const moonIndicators = new MoonIndicators();
    for (const [name, fn] of moonIndicators.getIndicators()) {
      this.register(name, fn, moonIndicators.getMetadata(name));
    }

    // Position indicators
    const positionIndicators = new PositionIndicators();
    for (const [name, fn] of positionIndicators.getIndicators()) {
      this.register(name, fn, positionIndicators.getMetadata(name));
    }

    // Technical indicators
    const technicalIndicators = new TechnicalIndicators();
    for (const [name, fn] of technicalIndicators.getIndicators()) {
      this.register(name, fn, technicalIndicators.getMetadata(name));
    }

    // Market indicators
    const marketIndicators = new MarketIndicators();
    for (const [name, fn] of marketIndicators.getIndicators()) {
      this.register(name, fn, marketIndicators.getMetadata(name));
    }

    logger.info(`Registered ${this.indicators.size} indicators`);
  }

  /**
   * Register an indicator
   * @param {string} name - Indicator name
   * @param {function} fn - Async function(context) => value
   * @param {object} metadata - Optional metadata
   */
  register(name, fn, metadata = {}) {
    this.indicators.set(name, fn);
    this.metadata.set(name, {
      name,
      type: metadata.type || 'number',
      description: metadata.description || '',
      category: metadata.category || 'custom',
      ...metadata
    });
  }

  /**
   * Register a custom user-defined indicator
   * @param {string} name - Indicator name
   * @param {function} fn - Async function(context) => value
   * @param {object} metadata - Optional metadata
   */
  registerCustomIndicator(name, fn, metadata = {}) {
    if (this.has(name)) {
      throw new Error(`Indicator with name ${name} already exists`);
    }
    this.register(name, fn, metadata);
    logger.info(`Registered custom indicator: ${name}`);
  }

  /**
   * Check if indicator exists
   */
  has(name) {
    return this.indicators.has(name);
  }

  /**
   * Get indicator value with caching
   * @param {string} name - Indicator name
   * @param {object} context - Evaluation context
   * @returns {any} Indicator value
   */
  async getValue(name, context) {
    // Generate cache key
    const cacheKey = this.getCacheKey(name, context);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Get indicator function
    const fn = this.indicators.get(name);
    if (!fn) {
      throw new Error(`Unknown indicator: ${name}`);
    }

    // Execute indicator with retry logic
    try {
      const value = await retryOperation(() => fn(context), { retries: 3, context: `Indicator.${name}` });
      this.cache.set(cacheKey, value);
      return value;
    } catch (error) {
      logger.warn(`Indicator ${name} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get multiple indicator values with batch processing
   * @param {string[]} names - Array of indicator names
   * @param {object} context - Evaluation context
   * @returns {object} Map of indicator name -> value
   */
  async getValues(names, context) {
    const results = {};
    const errors = [];
    const cacheKeys = names.map(name => this.getCacheKey(name, context));
    const cachedResults = this.cache.mget(cacheKeys);

    const uncachedNames = names.filter(name => !cachedResults[this.getCacheKey(name, context)]);

    if (uncachedNames.length > 0) {
      await Promise.all(uncachedNames.map(async (name) => {
        try {
          results[name] = await this.getValue(name, context);
        } catch (error) {
          errors.push({ name, error: error.message });
          results[name] = null;
        }
      }));
    }

    // Merge cached results
    for (const name of names) {
      const cacheKey = this.getCacheKey(name, context);
      if (cachedResults[cacheKey] !== undefined) {
        results[name] = cachedResults[cacheKey];
      }
    }

    if (errors.length > 0) {
      logger.warn(`Some indicators failed: ${errors.map(e => e.name).join(', ')}`);
    }

    return results;
  }

  /**
   * Generate cache key for indicator + context
   */
  getCacheKey(name, context) {
    const parts = [
      name,
      context.network || 'default',
      context.asset || 'default'
    ];
    return parts.join(':');
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.flushAll();
  }

  /**
   * Get list of all available indicators
   */
  listIndicators() {
    return Array.from(this.metadata.values());
  }

  /**
   * Get indicators by category
   */
  getIndicatorsByCategory(category) {
    return this.listIndicators().filter(m => m.category === category);
  }

  /**
   * Get indicator metadata
   */
  getMetadata(name) {
    return this.metadata.get(name);
  }

  /**
   * Get all categories
   */
  getCategories() {
    const categories = new Set();
    for (const meta of this.metadata.values()) {
      categories.add(meta.category);
    }
    return Array.from(categories);
  }
}

// Singleton instance
export const indicatorProvider = new IndicatorProvider();
export default indicatorProvider;
