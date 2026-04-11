import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * MCP Transport Layer
 * Handles communication with MCP servers via stdio or SSE transports
 */

/**
 * Base transport class
 */
class MCPTransport extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.messageId = 0;
    this.pendingRequests = new Map();
  }

  /**
   * Generate unique message ID
   */
  nextId() {
    return ++this.messageId;
  }

  /**
   * Send a JSON-RPC request
   * @param {string} method - Method name
   * @param {object} params - Method parameters
   * @returns {Promise} Response promise
   */
  async request(method, params = {}) {
    const id = this.nextId();
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.send(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param {string} method - Method name
   * @param {object} params - Method parameters
   */
  notify(method, params = {}) {
    const message = {
      jsonrpc: '2.0',
      method,
      params
    };
    this.send(message);
  }

  /**
   * Handle incoming message
   * @param {object} message - Parsed JSON-RPC message
   */
  handleMessage(message) {
    // Handle response to a request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          const error = this.categorizeError(message.error);
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Handle notification or request from server
    if (message.method) {
      this.emit('notification', message);
    }
  }

  /**
   * Categorize and enrich error messages
   * @param {object} error - Error object from message
   * @returns {Error} Categorized and enriched error
   */
  categorizeError(error) {
    let errorMessage = error.message || 'Unknown error';
    let errorType = 'GeneralError';

    if (error.code >= 500) {
      errorType = 'ServerError';
      errorMessage += ' - Please check server logs for more details.';
    } else if (error.code >= 400) {
      errorType = 'ClientError';
      errorMessage += ' - Please verify the request parameters.';
    } else if (error.code >= 300) {
      errorType = 'NetworkError';
      errorMessage += ' - Please check network connectivity.';
    }

    const enrichedError = new Error(errorMessage);
    enrichedError.type = errorType;
    return enrichedError;
  }

  /**
   * Send message (implemented by subclasses)
   */
  send(message) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Close the transport
   */
  async close() {
    this.connected = false;
    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport closed'));
    }
    this.pendingRequests.clear();
  }
}

/**
 * Stdio Transport for local MCP servers
 */
export class StdioTransport extends MCPTransport {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.process = null;
    this.buffer = '';
  }

  /**
   * Connect to the MCP server by spawning the process
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        logger.info(`Spawning MCP server: ${this.command} ${this.args.join(' ')}`);

        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.options.env },
          cwd: this.options.cwd
        });

        this.process.stdout.on('data', (data) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        this.process.stderr.on('data', (data) => {
          logger.debug(`MCP server stderr: ${data.toString()}`);
        });

        this.process.on('error', (error) => {
          logger.error('MCP server process error:', error);
          this.emit('error', error);
          if (!this.connected) {
            reject(error);
          }
        });

        this.process.on('close', (code) => {
          logger.info(`MCP server process closed with code: ${code}`);
          this.connected = false;
          this.emit('close', code);
        });

        // Consider connected after a short delay (or after first successful message)
        setTimeout(() => {
          this.connected = true;
          resolve();
        }, 500);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Process the buffer for complete JSON-RPC messages
   */
  processBuffer() {
    // Messages are newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          logger.debug(`Failed to parse MCP message: ${line}`);
        }
      }
    }
  }

  /**
   * Send message to the process stdin
   */
  send(message) {
    if (!this.process || !this.connected) {
      throw new Error('Transport not connected');
    }
    const data = JSON.stringify(message) + '\n';
    this.process.stdin.write(data);
  }

  /**
   * Close the transport and kill the process
   */
  async close() {
    await super.close();
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}

/**
 * SSE Transport for remote MCP servers
 */
export class SSETransport extends MCPTransport {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.headers = options.headers || {};
    this.eventSource = null;
    this.sessionUrl = null;
  }

  /**
   * Connect to the MCP server via SSE
   */
  async connect() {
    // Dynamic import for fetch if needed
    const fetchModule = await import('node-fetch');
    const fetch = fetchModule.default;

    // First, establish the SSE connection
    const sseUrl = new URL('/sse', this.url).toString();

    logger.info(`Connecting to MCP server via SSE: ${sseUrl}`);

    // Use EventSource-like implementation for Node.js
    return new Promise(async (resolve, reject) => {
      try {
        await retryOperation(async () => {
          const response = await fetch(sseUrl, {
            headers: {
              'Accept': 'text/event-stream',
              ...this.headers
            }
          });

          if (!response.ok) {
            throw new Error(`SSE connection failed: ${response.status}`);
          }

          // Handle SSE stream
          const reader = response.body;
          let buffer = '';

          reader.on('data', (chunk) => {
            buffer += chunk.toString();
            const events = this.parseSSEEvents(buffer);
            buffer = events.remaining;

            for (const event of events.parsed) {
              this.handleSSEEvent(event);
            }
          });

          reader.on('error', (error) => {
            logger.error('SSE connection error:', error);
            this.emit('error', error);
            if (!this.connected) {
              reject(error);
            }
          });

          reader.on('end', () => {
            logger.info('SSE connection closed');
            this.connected = false;
            this.emit('close');
          });

          // Get the session URL from the first event
          this.once('session', (sessionUrl) => {
            this.sessionUrl = sessionUrl;
            this.connected = true;
            resolve();
          });

          // Timeout if no session received
          setTimeout(() => {
            if (!this.connected) {
              reject(new Error('SSE connection timeout - no session received'));
            }
          }, 10000);
        }, { retries: 3 });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Parse SSE events from buffer
   */
  parseSSEEvents(buffer) {
    const events = [];
    const lines = buffer.split('\n');
    let remaining = '';
    let currentEvent = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this might be an incomplete event
      if (i === lines.length - 1 && line !== '') {
        remaining = line;
        continue;
      }

      if (line === '') {
        // Empty line marks end of event
        if (Object.keys(currentEvent).length > 0) {
          events.push(currentEvent);
          currentEvent = {};
        }
      } else if (line.startsWith('event:')) {
        currentEvent.type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentEvent.data = (currentEvent.data || '') + line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        currentEvent.id = line.slice(3).trim();
      }
    }

    return { parsed: events, remaining };
  }

  /**
   * Handle SSE event
   */
  handleSSEEvent(event) {
    if (event.type === 'endpoint') {
      // Session URL event
      this.emit('session', event.data);
    } else if (event.type === 'message' && event.data) {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        logger.debug(`Failed to parse SSE message: ${event.data}`);
      }
    }
  }

  /**
   * Send message via HTTP POST to the session endpoint
   */
  async send(message) {
    if (!this.sessionUrl || !this.connected) {
      throw new Error('Transport not connected');
    }

    const fetchModule = await import('node-fetch');
    const fetch = fetchModule.default;

    const fullUrl = new URL(this.sessionUrl, this.url).toString();

    await retryOperation(async () => {
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}`);
      }
    }, { retries: 3 });
  }

  /**
   * Close the SSE connection
   */
  async close() {
    await super.close();
    // EventSource cleanup would happen here
    this.sessionUrl = null;
  }
}

/**
 * Create appropriate transport based on configuration
 * @param {object} serverConfig - Server configuration from MCPServer model
 * @returns {MCPTransport} Transport instance
 */
export function createTransport(serverConfig) {
  if (serverConfig.transport === 'stdio') {
    return new StdioTransport(
      serverConfig.command || serverConfig.url,
      serverConfig.args || [],
      { env: serverConfig.env }
    );
  } else {
    const headers = serverConfig.getAuthHeaders ? serverConfig.getAuthHeaders() : {};
    return new SSETransport(serverConfig.url, { headers });
  }
}

export default {
  StdioTransport,
  SSETransport,
  createTransport
};