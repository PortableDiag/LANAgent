import { logger } from './logger.js';
import * as Sentry from '@sentry/node';

/**
 * Global error handling utilities
 */

// Track unhandled rejections to prevent duplicates
const unhandledRejections = new Map();

// Initialize Sentry if DSN is provided
let sentryEnabled = false;
if (process.env.SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE) : 0.1,
      integrations: [
        // Automatically capture console errors
        new Sentry.Integrations.Console(),
        // Capture context from Node
        new Sentry.Integrations.Context(),
      ],
      beforeSend(event, hint) {
        // Filter out sensitive information
        if (event.request) {
          delete event.request.cookies;
          delete event.request.headers?.authorization;
          delete event.request.headers?.['x-api-key'];
        }
        
        // Don't send events in development unless explicitly enabled
        if (process.env.NODE_ENV === 'development' && process.env.SENTRY_DEV_ENABLED !== 'true') {
          logger.debug('Sentry event suppressed in development:', event.event_id);
          return null;
        }
        
        return event;
      }
    });
    
    sentryEnabled = true;
    logger.info('Sentry error reporting initialized');
  } catch (error) {
    logger.error('Failed to initialize Sentry:', error);
  }
} else {
  logger.debug('Sentry DSN not configured, error reporting disabled');
}

// Cleanup run once on the way out, newest registration first (a service registered
// after its dependencies stops before them).
const shutdownHandlers = new Map();
let shutdownPromise = null;
let globalHandlersInstalled = false;

// Signal shutdowns must finish inside PM2's kill_timeout (10 s in ecosystem.config.cjs),
// after which PM2 sends SIGKILL and nothing is flushed.
const signalShutdownMs = () => Number(process.env.SHUTDOWN_TIMEOUT_MS) || 9000;

/**
 * Register cleanup to run when the process shuts down (SIGTERM, SIGINT, or a fatal error).
 * Registering a name again replaces the earlier handler.
 * @param {string} name
 * @param {Function} handler - sync or async
 * @returns {Function} unregister
 */
export function registerShutdownHandler(name, handler) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('Shutdown handler name must be a non-empty string');
  if (typeof handler !== 'function') throw new TypeError(`Shutdown handler "${name}" must be a function`);
  if (shutdownPromise) {
    logger.warn(`Shutdown handler "${name}" registered after shutdown started; ignored`);
    return () => {};
  }
  shutdownHandlers.delete(name);
  shutdownHandlers.set(name, handler);
  return () => { if (shutdownHandlers.get(name) === handler) shutdownHandlers.delete(name); };
}

/**
 * Run the registered cleanup (bounded by deadlineMs overall), flush Sentry, then exit.
 * Idempotent: a second signal or a fatal error during shutdown joins the first one.
 * @param {number} exitCode
 * @param {{deadlineMs?: number}} [options]
 * @returns {Promise<void>}
 */
export function shutdown(exitCode = 0, { deadlineMs = signalShutdownMs() } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const endAt = Date.now() + Math.max(0, deadlineMs);
    const handlers = [...shutdownHandlers.entries()].reverse();
    shutdownHandlers.clear();
    for (const [name, handler] of handlers) {
      const remaining = endAt - Date.now();
      if (remaining <= 0) {
        logger.error(`Shutdown deadline reached; skipped "${name}" and any handlers after it`);
        break;
      }
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => handler()),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline exceeded')), remaining); })
        ]);
      } catch (error) {
        logger.error(`Shutdown handler "${name}" failed: ${error?.message || error}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (sentryEnabled) {
      try { await Sentry.flush(Math.max(500, endAt - Date.now())); } catch { /* exiting anyway */ }
    }
  })().catch(error => logger.error('Shutdown failed:', error))
    .finally(() => process.exit(exitCode));
  return shutdownPromise;
}

/**
 * Setup global error handlers with better recovery
 */
export function setupGlobalErrorHandlers() {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;

  // Termination signals run the registered cleanup (index.js registers agent.stop).
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info(`${signal} received, shutting down gracefully...`);
      shutdown(0);
    });
  }

  // Handle uncaught exceptions - log but don't exit immediately
  process.on('uncaughtException', (error, origin) => {
    logger.error('Uncaught Exception:', {
      error: error.message,
      stack: error.stack,
      origin
    });
    
    // Send to Sentry
    if (sentryEnabled) {
      Sentry.captureException(error, {
        tags: { type: 'uncaughtException' },
        extra: { origin }
      });
    }
    
    // Give time to flush logs and Sentry before exit — the same window as before, now
    // also offered to the registered cleanup (state may be corrupt, so keep it short).
    const flushTimeout = sentryEnabled ? 2000 : 1000;
    shutdown(1, { deadlineMs: flushTimeout });
  });

  // Handle unhandled promise rejections - track and warn
  process.on('unhandledRejection', (reason, promise) => {
    const key = promise.toString();
    unhandledRejections.set(key, { reason, timestamp: Date.now() });
    
    logger.error('Unhandled Promise Rejection:', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
      promise: key
    });
    
    // Send to Sentry
    if (sentryEnabled) {
      if (reason instanceof Error) {
        Sentry.captureException(reason, {
          tags: { type: 'unhandledRejection' },
          extra: { promise: key }
        });
      } else {
        Sentry.captureMessage(`Unhandled Promise Rejection: ${reason}`, 'error', {
          tags: { type: 'unhandledRejection' },
          extra: { promise: key, reason }
        });
      }
    }
    
    // Don't exit immediately - give chance for recovery
    // Monitor if rejections accumulate
    if (unhandledRejections.size > 10) {
      logger.fatal('Too many unhandled rejections, exiting...');
      shutdown(1, { deadlineMs: 1000 });
    }
  });

  // Handle when a rejection is eventually handled
  process.on('rejectionHandled', (promise) => {
    const key = promise.toString();
    if (unhandledRejections.has(key)) {
      logger.info('Previously unhandled rejection was handled', {
        promise: key
      });
      unhandledRejections.delete(key);
    }
  });

  // Clean up old unhandled rejections periodically
  setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, data] of unhandledRejections) {
      if (data.timestamp < oneHourAgo) {
        unhandledRejections.delete(key);
      }
    }
  }, 30 * 60 * 1000); // Every 30 minutes
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandler(fn, context = 'Unknown') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(`Error in ${context}:`, error);
      
      // Send to Sentry with context
      if (sentryEnabled) {
        Sentry.withScope(scope => {
          scope.setTag('context', context);
          scope.setContext('function', {
            name: fn.name || 'anonymous',
            context
          });
          // Add additional context if available
          if (args[0]?.userId) {
            scope.setTag('user_id', args[0].userId);
          }
          if (args[0]?.sessionId) {
            scope.setTag('session_id', args[0].sessionId);
          }
          Sentry.captureException(error);
        });
      }
      
      throw error;
    }
  };
}

/**
 * Create a safe interval that handles errors
 */
export function safeInterval(callback, interval, context = 'interval') {
  const wrappedCallback = async () => {
    try {
      await callback();
    } catch (error) {
      logger.error(`Error in ${context}:`, error);
      // Don't let error stop the interval
    }
  };
  
  return setInterval(wrappedCallback, interval);
}

/**
 * Create a safe timeout that handles errors
 */
export function safeTimeout(callback, timeout, context = 'timeout') {
  const wrappedCallback = async () => {
    try {
      await callback();
    } catch (error) {
      logger.error(`Error in ${context}:`, error);
    }
  };
  
  return setTimeout(wrappedCallback, timeout);
}

/**
 * Safely execute Promise.all with partial failure handling
 */
export async function safePromiseAll(promises, options = {}) {
  const { returnErrors = false, context = 'Promise.all' } = options;
  
  const results = await Promise.allSettled(promises);
  
  const fulfilled = [];
  const rejected = [];
  
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
    } else {
      logger.error(`Promise ${index} failed in ${context}:`, result.reason);
      rejected.push({
        index,
        reason: result.reason
      });
    }
  });
  
  if (returnErrors) {
    return { fulfilled, rejected };
  }
  
  if (rejected.length > 0 && rejected.length === promises.length) {
    throw new Error(`All promises failed in ${context}`);
  }
  
  return fulfilled;
}

/**
 * Capture an error to Sentry with custom context
 * @param {Error} error - The error to capture
 * @param {Object} context - Additional context
 * @param {string} level - Error level (error, warning, info)
 */
export function captureError(error, context = {}, level = 'error') {
  // Always log locally
  logger[level](`Captured ${level}:`, error, context);
  
  // Send to Sentry if enabled
  if (sentryEnabled) {
    Sentry.withScope(scope => {
      // Add custom context
      Object.entries(context).forEach(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          scope.setContext(key, value);
        } else {
          scope.setExtra(key, value);
        }
      });
      
      // Set level
      scope.setLevel(level);
      
      // Capture
      if (error instanceof Error) {
        Sentry.captureException(error);
      } else {
        Sentry.captureMessage(String(error), level);
      }
    });
  }
}

/**
 * Check if Sentry is enabled
 */
export function isSentryEnabled() {
  return sentryEnabled;
}
