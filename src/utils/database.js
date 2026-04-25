import mongoose from 'mongoose';
import { logger } from './logger.js';
import { retryOperation, isRetryableError } from './retryUtils.js';

// Connection state tracking
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_INTERVAL = 1000; // 1 second base for exponential backoff
const RECONNECT_MAX_INTERVAL = 30000; // 30 second max backoff
const CIRCUIT_BREAKER_THRESHOLD = 5; // Number of failures before circuit breaker trips
const CIRCUIT_BREAKER_COOLDOWN = 30000; // 30 seconds cooldown period

let circuitBreakerOpen = false;
let circuitBreakerTimer = null;

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
  
  if (isConnecting) {
    logger.debug('MongoDB connection already in progress');
    // Wait for current connection attempt
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!isConnecting) {
          clearInterval(checkInterval);
          resolve(mongoose.connection);
        }
      }, 100);
    });
  }

  if (circuitBreakerOpen) {
    logger.warn('Circuit breaker is open. Skipping connection attempt.');
    throw new Error('Circuit breaker is open. Please try again later.');
  }

  isConnecting = true;
  
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
    setupConnectionHandlers();

    return mongoose.connection;
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    isConnecting = false;

    if (isRetryableError(error)) {
      reconnectAttempts++;
      if (reconnectAttempts >= CIRCUIT_BREAKER_THRESHOLD) {
        openCircuitBreaker();
      }
    }

    // Attempt reconnection with exponential backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const backoffDelay = Math.min(RECONNECT_BASE_INTERVAL * Math.pow(2, reconnectAttempts), RECONNECT_MAX_INTERVAL);
      logger.info(`Attempting to reconnect to MongoDB (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${backoffDelay}ms...`);

      await new Promise(resolve => setTimeout(resolve, backoffDelay));
      return connectDatabase(); // Recursive retry
    } else {
      logger.error('Max reconnection attempts reached. MongoDB connection failed.');
      throw error;
    }
  } finally {
    isConnecting = false;
  }
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
    if (mongoose.connection.readyState === 0) {
      const backoffDelay = Math.min(RECONNECT_BASE_INTERVAL * Math.pow(2, reconnectAttempts), RECONNECT_MAX_INTERVAL);
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
    const backoffDelay = Math.min(RECONNECT_BASE_INTERVAL * Math.pow(2, reconnectAttempts), RECONNECT_MAX_INTERVAL);
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
