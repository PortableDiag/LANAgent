import mongoose from 'mongoose';
import { logger } from './logger.js';
import { retryOperation, isRetryableError } from './retryUtils.js';

// Connection state tracking
// The in-flight attempt; concurrent callers share it (and its failure) instead of polling.
let connectionPromise = null;
let reconnectAttempts = 0;
let failedConnectAttempts = 0; // every failed attempt, retryable or not — drives the backoff
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_INTERVAL = 1000; // 1 second base for exponential backoff
const RECONNECT_MAX_INTERVAL = 30000; // 30 second max backoff
const CIRCUIT_BREAKER_THRESHOLD = 5; // Number of failures before circuit breaker trips
const CIRCUIT_BREAKER_COOLDOWN = 30000; // 30 seconds cooldown period
const DEFAULT_DATABASE_WAIT_TIMEOUT = 30000;

let circuitBreakerOpen = false;
let circuitBreakerTimer = null;

/**
 * Connect errors that no amount of retrying fixes: an unparseable URI or rejected credentials.
 * @param {Error} error
 * @returns {boolean}
 */
export function isPermanentConnectError(error) {
  if (!error) return false;
  if (error.name === 'MongoParseError' || error.name === 'MongoAPIError') return true;
  // 18 = AuthenticationFailed
  return error.code === 18 || error.codeName === 'AuthenticationFailed';
}

/**
 * Exponential reconnect backoff, capped at RECONNECT_MAX_INTERVAL.
 * @param {number} failures Failed attempts so far
 * @returns {number} Delay in ms
 */
export function connectBackoffDelay(failures) {
  return Math.min(RECONNECT_BASE_INTERVAL * Math.pow(2, Math.max(0, failures)), RECONNECT_MAX_INTERVAL);
}

class DatabaseTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Timed out waiting for MongoDB connection after ${timeoutMs}ms.`);
    this.name = 'DatabaseTimeoutError';
    this.code = 'DATABASE_CONNECTION_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

class DatabaseCancellationError extends Error {
  constructor() {
    super('Waiting for MongoDB connection was cancelled.');
    this.name = 'DatabaseCancellationError';
    this.code = 'DATABASE_CONNECTION_CANCELLED';
  }
}

class DatabaseUnavailableError extends Error {
  constructor() {
    super('MongoDB connection is not active and reconnecting was not allowed.');
    this.name = 'DatabaseUnavailableError';
    this.code = 'DATABASE_CONNECTION_UNAVAILABLE';
  }
}

export { DatabaseTimeoutError, DatabaseCancellationError, DatabaseUnavailableError };

/**
 * Establish connection to MongoDB database with error handling and auto-reconnect
 * 
 * Connects to MongoDB using the provided URI from environment variables
 * or falls back to localhost. Sets up event listeners for connection
 * monitoring and error handling. Implements automatic reconnection logic.
 * 
 * @async
 * @function connectDatabase
 * @returns {Promise<mongoose.Connection>} The established MongoDB connection
 * @throws {Error} When connection fails after max attempts
 */
export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    logger.debug('MongoDB already connected');
    return mongoose.connection;
  }

  if (connectionPromise) {
    logger.debug('MongoDB connection already in progress');
    return connectionPromise;
  }

  if (circuitBreakerOpen) {
    logger.warn('Circuit breaker is open. Skipping connection attempt.');
    throw new Error('Circuit breaker is open. Please try again later.');
  }

  const activeConnectionPromise = establishDatabaseConnection();
  connectionPromise = activeConnectionPromise;

  // Clear the shared promise after settlement so a later caller can start
  // a fresh connection attempt when the current attempt has failed.
  activeConnectionPromise.then(
    () => {
      if (connectionPromise === activeConnectionPromise) {
        connectionPromise = null;
      }
    },
    () => {
      if (connectionPromise === activeConnectionPromise) {
        connectionPromise = null;
      }
    }
  );

  return activeConnectionPromise;
}

/**
 * Perform a connection attempt and handle bounded automatic reconnection.
 *
 * @async
 * @returns {Promise<mongoose.Connection>} The established MongoDB connection
 * @throws {Error} When connection fails after max attempts
 */
async function establishDatabaseConnection() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent';

    await retryOperation(() => mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000, // 5 second timeout
      heartbeatFrequencyMS: 10000, // Check connection every 10 seconds
      maxPoolSize: process.env.DB_MAX_POOL_SIZE ? parseInt(process.env.DB_MAX_POOL_SIZE, 10) : 10, // Connection pool for concurrent operations
      minPoolSize: process.env.DB_MIN_POOL_SIZE ? parseInt(process.env.DB_MIN_POOL_SIZE, 10) : 0, // Minimum number of connections in the pool
      maxIdleTimeMS: process.env.DB_MAX_IDLE_TIME_MS ? parseInt(process.env.DB_MAX_IDLE_TIME_MS, 10) : 30000, // Maximum idle time for connections
    }), { retries: 3 });

    logger.info('MongoDB connected successfully');
    reconnectAttempts = 0; // Reset on successful connection
    failedConnectAttempts = 0;
    setupConnectionHandlers();

    return mongoose.connection;
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);

    // A bad URI or rejected credentials cannot succeed on retry — fail loudly instead of
    // looping. Everything else (mongod down arrives as a non-"retryable" server-selection
    // error) keeps waiting: a boot-time throw crash-loops past PM2's max_restarts.
    if (isPermanentConnectError(error)) {
      logger.error('MongoDB connection error is not recoverable by retrying (check MONGODB_URI / credentials).');
      throw error;
    }

    // Every failure grows the backoff, so a long outage settles at the 30s cap instead of
    // retrying every second forever; only retryable errors count toward the give-up limit.
    failedConnectAttempts++;

    if (isRetryableError(error)) {
      reconnectAttempts++;
      if (reconnectAttempts >= CIRCUIT_BREAKER_THRESHOLD) {
        openCircuitBreaker();
      }
    }

    // Attempt reconnection with exponential backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !circuitBreakerOpen) {
      const backoffDelay = connectBackoffDelay(failedConnectAttempts);
      logger.info(`Attempting to reconnect to MongoDB (failure ${failedConnectAttempts}, retryable ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${backoffDelay}ms...`);

      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      return establishDatabaseConnection();
    } else {
      logger.error('Max reconnection attempts reached. MongoDB connection failed.');
      throw error;
    }
  }
}

/**
 * Wait for an active MongoDB connection without polling indefinitely.
 *
 * An already-connected database is returned immediately. If a connection is
 * already being established, callers share that in-flight promise. Otherwise,
 * a connection attempt is started unless `allowReconnect` is false.
 *
 * @async
 * @param {Object} options Wait options
 * @param {number} [options.timeoutMs=30000] Maximum time to wait in milliseconds
 * @param {AbortSignal} [options.signal] Optional signal used to cancel waiting
 * @param {boolean} [options.allowReconnect=true] Whether to start a connection attempt
 * @returns {Promise<mongoose.Connection>} The active MongoDB connection
 * @throws {DatabaseTimeoutError} When the timeout expires
 * @throws {DatabaseCancellationError} When the signal aborts
 * @throws {DatabaseUnavailableError} When no connection exists and reconnecting is disabled
 */
export async function waitForDatabase({
  timeoutMs = DEFAULT_DATABASE_WAIT_TIMEOUT,
  signal,
  allowReconnect = true
} = {}) {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (signal?.aborted) {
    throw new DatabaseCancellationError();
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite, non-negative number.');
  }

  let activePromise = connectionPromise;

  if (!activePromise) {
    if (!allowReconnect) {
      throw new DatabaseUnavailableError();
    }

    activePromise = connectDatabase();
  }

  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settle = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback(value);
    };

    const onAbort = () => {
      settle(reject, new DatabaseCancellationError());
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      settle(reject, new DatabaseTimeoutError(timeoutMs));
    }, timeoutMs);

    activePromise.then(
      connection => settle(resolve, connection),
      error => settle(reject, error)
    );
  });
}

/**
 * Open the circuit breaker to prevent further connection attempts
 */
function openCircuitBreaker() {
  circuitBreakerOpen = true;
  logger.warn('Circuit breaker opened due to repeated connection failures.');

  circuitBreakerTimer = setTimeout(() => {
    circuitBreakerOpen = false;
    reconnectAttempts = 0;
    circuitBreakerTimer = null;
    logger.info('Circuit breaker closed. Connection attempts can resume.');
  }, CIRCUIT_BREAKER_COOLDOWN);
}

/**
 * Setup connection event handlers
 */
function setupConnectionHandlers() {
  // Remove existing listeners to prevent duplicates
  mongoose.connection.removeAllListeners('error');
  mongoose.connection.removeAllListeners('disconnected');
  mongoose.connection.removeAllListeners('reconnected');

  // Handle connection errors
  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error:', err);

    // Attempt reconnection on error
    if (mongoose.connection.readyState === 0 && !connectionPromise) {
      const backoffDelay = connectBackoffDelay(failedConnectAttempts);
      setTimeout(() => {
        logger.info('Attempting to reconnect after error...');
        connectDatabase().catch(error => {
          logger.error('Reconnection failed:', error);
        });
      }, backoffDelay);
    }
  });

  // Handle disconnection
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');

    // Attempt automatic reconnection with exponential backoff
    const backoffDelay = connectBackoffDelay(failedConnectAttempts);
    setTimeout(() => {
      logger.info('Attempting automatic reconnection...');
      connectDatabase().catch(error => {
        logger.error('Auto-reconnection failed:', error);
      });
    }, backoffDelay);
  });

  // Log successful reconnection
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected successfully');
    reconnectAttempts = 0;
  });
}

/**
 * Gracefully close database connection
 */
export async function disconnectDatabase() {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed gracefully');
  } catch (error) {
    logger.error('Error closing MongoDB connection:', error);
    throw error;
  }
}

/**
 * Check if database is connected
 */
export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Health check endpoint for database connection
 * Returns detailed health status including connection state and stats
 *
 * @returns {Object} Health status of the database connection
 */
export function databaseHealthCheck() {
  const readyState = mongoose.connection.readyState;
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };

  return {
    status: readyState === 1 ? 'healthy' : 'unhealthy',
    state: states[readyState] || 'unknown',
    timestamp: new Date().toISOString(),
    reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    circuitBreakerOpen
  };
}
