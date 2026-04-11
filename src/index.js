// LAN Agent - Main Entry Point
import dotenv from 'dotenv';
import { Agent } from './core/agent.js';
import { logger } from './utils/logger.js';

// Load environment variables
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Get the current directory path for ES modules
 * @type {string}
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Construct path to the environment configuration file
 * @type {string}
 */
const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// Debug env loading
logger.info('Loading environment from: ' + envPath);
logger.info('Environment loaded, TELEGRAM_BOT_TOKEN exists: ' + !!process.env.TELEGRAM_BOT_TOKEN);
logger.info('First 10 chars of token: ' + (process.env.TELEGRAM_BOT_TOKEN || 'undefined').substring(0, 10));

// Import and setup global error handlers
import { setupGlobalErrorHandlers } from './utils/errorHandlers.js';
setupGlobalErrorHandlers();

/**
 * Start the LAN Agent with full initialization and graceful shutdown handling
 * 
 * This function creates a new Agent instance, initializes all components including
 * databases, providers, plugins, and interfaces, then starts all services.
 * Also sets up graceful shutdown handlers for SIGTERM signals.
 * 
 * @async
 * @function start
 * @throws {Error} When agent initialization or startup fails
 * @returns {Promise<void>} Resolves when agent is successfully started
 */
async function start() {
  try {
    logger.info('Starting LAN Agent...');
    
    const agent = new Agent();
    await agent.initialize();
    await agent.start();
    
    logger.info('LAN Agent is running!');
    
    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await agent.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start agent:', error);
    process.exit(1);
  }
}

start();
