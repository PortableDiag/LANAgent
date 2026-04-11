import { logger } from './logger.js';
import NodeCache from 'node-cache';

/**
 * Circuit breaker states
 */
const CircuitBreakerState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Circuit breaker class to manage failure rates and prevent system overload
 */
class CircuitBreaker {
  constructor(failureThreshold = 5, recoveryTimeout = 10000) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
    this.failureCount = 0;
    this.state = CircuitBreakerState.CLOSED;
    this.lastFailureTime = null;
  }

  /**
   * Check if the circuit is open
   * @returns {boolean} Whether the circuit is open
   */
  isOpen() {
    if (this.state === CircuitBreakerState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime > this.recoveryTimeout) {
        this.state = CircuitBreakerState.HALF_OPEN;
      }
    }
    return this.state === CircuitBreakerState.OPEN;
  }

  /**
   * Record a failure and potentially open the circuit
   */
  recordFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
      this.lastFailureTime = Date.now();
      logger.warn('Circuit breaker opened due to high failure rate');
    }
  }

  /**
   * Record a success and potentially close the circuit
   */
  recordSuccess() {
    this.failureCount = 0;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.CLOSED;
      logger.info('Circuit breaker closed after successful operation');
    }
  }

  /**
   * Dynamically adjust circuit breaker parameters based on historical data
   * @param {string} operationName - Unique name of the operation
   */
  adjustParameters(operationName) {
    const history = retryHistoryCache.get(operationName) || { successCount: 0, failureCount: 0 };
    const totalAttempts = history.successCount + history.failureCount;
    const failureRate = totalAttempts > 0 ? history.failureCount / totalAttempts : 0;

    // Adjust parameters based on failure rate
    if (failureRate > 0.7) {
      this.failureThreshold = 3;
      this.recoveryTimeout = 15000;
    } else if (failureRate > 0.4) {
      this.failureThreshold = 5;
      this.recoveryTimeout = 10000;
    } else {
      this.failureThreshold = 7;
      this.recoveryTimeout = 5000;
    }

    logger.info(`Adjusted circuit breaker parameters for ${operationName}: failureThreshold=${this.failureThreshold}, recoveryTimeout=${this.recoveryTimeout}`);
  }
}

/**
 * Historical data cache for retry adjustments
 */
const retryHistoryCache = new NodeCache({ stdTTL: 3600 });

/**
 * Calculate dynamic retry parameters based on historical data
 * @param {string} operationName - Unique name of the operation
 * @returns {Object} Dynamic retry parameters
 */
function calculateDynamicRetryParams(operationName) {
  const history = retryHistoryCache.get(operationName);
  if (!history) return {}; // No history — use caller's defaults

  const totalAttempts = history.successCount + history.failureCount;
  if (totalAttempts < 3) return {}; // Not enough data to adjust

  const successRate = history.successCount / totalAttempts;

  // Adjust retry parameters based on success rate
  // Keep retries <= 4 to stay below circuit breaker threshold (5)
  const retries = successRate < 0.5 ? 4 : 3;
  const factor = successRate < 0.5 ? 3 : 2;
  const minTimeout = successRate < 0.5 ? 2000 : 1000;
  const maxTimeout = successRate < 0.5 ? 8000 : 4000;

  return { retries, factor, minTimeout, maxTimeout };
}

/**
 * Update historical data for retry adjustments
 * @param {string} operationName - Unique name of the operation
 * @param {boolean} success - Whether the operation was successful
 */
function updateRetryHistory(operationName, success) {
  const history = retryHistoryCache.get(operationName) || { successCount: 0, failureCount: 0 };
  if (success) {
    history.successCount += 1;
  } else {
    history.failureCount += 1;
  }
  retryHistoryCache.set(operationName, history);
}

/**
 * Retry utility for handling transient errors with exponential backoff and circuit breaker
 * @param {Function} operation - The async function to retry
 * @param {Object} options - Retry configuration options
 * @param {number} options.retries - Maximum number of retry attempts (default: 3)
 * @param {number} options.factor - Exponential backoff factor (default: 2)
 * @param {number} options.minTimeout - Minimum timeout between retries in ms (default: 1000)
 * @param {number} options.maxTimeout - Maximum timeout between retries in ms (default: 4000)
 * @param {Function} options.onRetry - Optional callback called on each retry
 * @param {string} options.context - Context for logging (default: 'Operation')
 * @param {CircuitBreaker} options.circuitBreaker - Circuit breaker instance
 * @param {Function} options.customErrorClassifier - Custom function to classify errors for retry (default: null)
 * @returns {Promise} Result of the operation
 */
export async function retryOperation(operation, options = {}) {
  const {
    retries = 3,
    factor = 2,
    minTimeout = 1000,
    maxTimeout = 4000,
    onRetry = null,
    context = 'Operation',
    circuitBreaker = new CircuitBreaker(),
    customErrorClassifier = null
  } = options;

  const dynamicParams = calculateDynamicRetryParams(context);
  const finalRetries = dynamicParams.retries || retries;
  const finalFactor = dynamicParams.factor || factor;
  const finalMinTimeout = dynamicParams.minTimeout || minTimeout;
  const finalMaxTimeout = dynamicParams.maxTimeout || maxTimeout;

  let lastError;
  let delay = finalMinTimeout;

  for (let attempt = 1; attempt <= finalRetries + 1; attempt++) {
    if (circuitBreaker.isOpen()) {
      logger.error(`${context} aborted due to open circuit breaker`);
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await operation(attempt);
      circuitBreaker.recordSuccess();
      updateRetryHistory(context, true);
      if (attempt > 1) {
        logger.info(`${context} succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      circuitBreaker.recordFailure();
      updateRetryHistory(context, false);

      const shouldRetry = customErrorClassifier ? customErrorClassifier(error) : isRetryableError(error);

      if (!shouldRetry || attempt > finalRetries) {
        logger.error(`${context} failed after ${finalRetries} retries`, {
          error: error.message,
          attempts: attempt
        });
        break;
      }

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * finalFactor, finalMaxTimeout);
      
      logger.warn(`${context} failed on attempt ${attempt}, retrying in ${delay}ms`, {
        error: error.message,
        nextAttempt: attempt + 1,
        delay
      });

      // Call onRetry callback if provided
      if (onRetry) {
        await onRetry(error, attempt);
      }

      // Wait before next retry
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Retry operation with custom retry logic and circuit breaker
 * @param {Function} operation - The async function to retry
 * @param {Function} shouldRetry - Function that determines if retry should happen
 * @param {Object} options - Retry configuration options (same as retryOperation)
 * @returns {Promise} Result of the operation
 */
export async function retryWithCondition(operation, shouldRetry, options = {}) {
  const {
    retries = 3,
    factor = 2,
    minTimeout = 1000,
    maxTimeout = 4000,
    onRetry = null,
    context = 'Operation',
    circuitBreaker = new CircuitBreaker()
  } = options;

  const dynamicParams = calculateDynamicRetryParams(context);
  const finalRetries = dynamicParams.retries || retries;
  const finalFactor = dynamicParams.factor || factor;
  const finalMinTimeout = dynamicParams.minTimeout || minTimeout;
  const finalMaxTimeout = dynamicParams.maxTimeout || maxTimeout;

  let lastError;
  let delay = finalMinTimeout;

  for (let attempt = 1; attempt <= finalRetries + 1; attempt++) {
    if (circuitBreaker.isOpen()) {
      logger.error(`${context} aborted due to open circuit breaker`);
      throw new Error('Circuit breaker is open');
    }

    try {
      const result = await operation(attempt);
      circuitBreaker.recordSuccess();
      updateRetryHistory(context, true);
      if (attempt > 1) {
        logger.info(`${context} succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      circuitBreaker.recordFailure();
      updateRetryHistory(context, false);

      // Check if we should retry
      const shouldRetryResult = await shouldRetry(error, attempt);
      
      if (!shouldRetryResult || attempt > finalRetries) {
        logger.error(`${context} failed, not retrying`, {
          error: error.message,
          attempts: attempt,
          shouldRetry: shouldRetryResult
        });
        break;
      }

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * finalFactor, finalMaxTimeout);
      
      logger.warn(`${context} failed on attempt ${attempt}, retrying in ${delay}ms`, {
        error: error.message,
        nextAttempt: attempt + 1,
        delay
      });

      // Call onRetry callback if provided
      if (onRetry) {
        await onRetry(error, attempt);
      }

      // Wait before next retry
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Determines if an error is retryable (common patterns)
 * @param {Error} error - The error to check
 * @returns {boolean} Whether the error is retryable
 */
export function isRetryableError(error) {
  // Network errors
  if (error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' || 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND') {
    return true;
  }
  
  // HTTP errors that are typically transient
  if (error.response) {
    const status = error.response.status;
    // Retry on 5xx errors and specific 4xx errors
    return status >= 500 || status === 429 || status === 408;
  }
  
  // MongoDB/Database errors that are retryable
  if (error.name === 'MongoNetworkError' || 
      error.name === 'MongoTimeoutError' ||
      (error.code >= 11600 && error.code <= 11699)) { // MongoDB transient transaction errors
    return true;
  }
  
  return false;
}

/**
 * Create a retryable version of a function
 * @param {Function} fn - The function to make retryable
 * @param {Object} defaultOptions - Default retry options
 * @returns {Function} Retryable version of the function
 */
export function makeRetryable(fn, defaultOptions = {}) {
  return async function(...args) {
    const options = {
      context: fn.name || 'Function',
      ...defaultOptions
    };
    
    return retryOperation(() => fn(...args), options);
  };
}