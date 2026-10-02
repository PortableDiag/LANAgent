import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { MCPServer } from '../../models/MCPServer.js';
import { createTransport } from './mcpTransport.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * MCP Client Service
 * Manages connections to external MCP servers
 */
export class MCPClientService extends EventEmitter {
  constructor(agent = null) {
    super();
    this.agent = agent;
    this.connections = new Map(); // serverId -> { transport, capabilities }
    this.pendingConnections = new Map(); // normalized serverId -> { promise, token }
    this.reconnectTimers = new Map();
    this.initialized = false;
    this.shuttingDown = false;
  }

  /**
   * Initialize the MCP client service
   * Auto-connects to servers with autoConnect enabled
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    logger.info('Initializing MCP Client Service');

    try {
      await this.initializeAutoConnect();
      this.initialized = true;
      logger.info('MCP Client Service initialized');
    } catch (error) {
      logger.error('Failed to initialize MCP Client Service:', error);
    }
  }

  /**
   * Connect to all servers with autoConnect enabled
   */
  async initializeAutoConnect() {
    try {
      const servers = await MCPServer.getAutoConnect();
      logger.info(`Found ${servers.length} MCP servers with autoConnect enabled`);

      const results = await Promise.allSettled(
        servers.map(server => this.connect(server._id))
      );

      const connected = results.filter(r => r.status === 'fulfilled').length;
      logger.info(`Auto-connected to ${connected}/${servers.length} MCP servers`);
    } catch (error) {
      logger.error('Error during MCP auto-connect:', error);
    }
  }

  /**
   * Connect to an MCP server
   * @param {string} serverId - Server ID
   * @returns {object} Connection result
   */
  async connect(serverId) {
    const normalizedServerId = String(serverId);

    // Check if already connected
    if (this.connections.has(normalizedServerId)) {
      const existing = this.connections.get(normalizedServerId);
      if (existing.transport?.connected) {
        return { success: true, message: 'Already connected' };
      }
    }

    if (this.shuttingDown) {
      throw new Error('MCP client service is shutting down');
    }

    // Share the complete connection attempt with concurrent callers.
    const pending = this.pendingConnections.get(normalizedServerId);
    if (pending) {
      return pending.promise;
    }

    let transport = null;
    let storedConnection = false;
    // Set when a failed or cancelled attempt closes its own transport: the 'close'
    // that follows must not run handleDisconnect (it would overwrite the 'error'
    // status with 'disconnected' and schedule a reconnect for an attempt that
    // never connected).
    let abandoned = false;

    // cancel() closes the attempt's transport, which rejects its in-flight
    // request at once — otherwise disconnect()/cleanup() would wait out the
    // 30 s initialize timeout of a server that never answers.
    const token = {
      cancelled: false,
      cancel: () => {
        token.cancelled = true;
        if (transport && !storedConnection) {
          abandoned = true;
          transport.close().catch(() => {});
        }
      }
    };

    const promise = (async () => {
      const server = await MCPServer.getCached(normalizedServerId);
      if (!server) {
        throw new Error(`MCP server not found: ${normalizedServerId}`);
      }

      const ensureAttemptIsActive = () => {
        if (
          token.cancelled ||
          this.shuttingDown ||
          this.pendingConnections.get(normalizedServerId)?.token !== token
        ) {
          throw new Error('MCP connection attempt cancelled');
        }
      };

      logger.info(`Connecting to MCP server: ${server.name}`);
      await server.updateStatus('connecting');
      ensureAttemptIsActive();

      try {
        // Create transport
        transport = createTransport(server);

        // Set up event handlers
        transport.on('error', (error) => {
          logger.error(`MCP server ${server.name} error:`, error);
          if (!abandoned) this.handleDisconnect(normalizedServerId, error.message);
        });

        transport.on('close', () => {
          if (abandoned) return;
          logger.info(`MCP server ${server.name} disconnected`);
          this.handleDisconnect(normalizedServerId);
        });

        transport.on('notification', (notification) => {
          if (!abandoned) this.handleNotification(normalizedServerId, notification);
        });

        // Connect
        await transport.connect();
        ensureAttemptIsActive();

        // Initialize MCP session
        const initResult = await transport.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: { listChanged: true }
          },
          clientInfo: {
            name: 'LANAgent',
            version: '2.9.0'
          }
        });
        ensureAttemptIsActive();

        // Send initialized notification
        transport.notify('notifications/initialized');

        // Store connection
        this.connections.set(normalizedServerId, {
          transport,
          capabilities: initResult.capabilities,
          serverInfo: initResult.serverInfo
        });
        storedConnection = true;

        // Update status
        await server.updateStatus('connected');

        // Discover tools
        await this.discoverTools(normalizedServerId);

        logger.info(`Connected to MCP server: ${server.name}`);
        this.emit('connected', {
          serverId: normalizedServerId,
          serverName: server.name
        });

        return {
          success: true,
          serverInfo: initResult.serverInfo,
          capabilities: initResult.capabilities
        };
      } catch (error) {
        // A connection that was stored stays stored, as before: only tool discovery
        // failed after it, and the session itself is usable.
        if (!token.cancelled && !this.shuttingDown) {
          logger.error(`Failed to connect to MCP server ${server.name}:`, error);
          await server.updateStatus('error', error.message);
        } else if (!storedConnection) {
          // Cancelled by disconnect()/cleanup(): don't leave the record at 'connecting'.
          try {
            await server.updateStatus('disconnected');
          } catch (statusError) {
            logger.debug(`Error updating cancelled MCP server status: ${statusError.message}`);
          }
        }

        throw error;
      } finally {
        if (!storedConnection && transport) {
          abandoned = true;
          try {
            await transport.close();
          } catch (error) {
            logger.debug(`Error closing failed MCP transport: ${error.message}`);
          }
        }
      }
    })();

    this.pendingConnections.set(normalizedServerId, { promise, token });

    try {
      return await promise;
    } finally {
      const current = this.pendingConnections.get(normalizedServerId);
      if (current?.token === token) {
        this.pendingConnections.delete(normalizedServerId);
      }
    }
  }

  /**
   * Disconnect from an MCP server
   * @param {string} serverId - Server ID
   */
  async disconnect(serverId) {
    const normalizedServerId = String(serverId);

    // Invalidate and wait for an in-flight attempt so it cannot repopulate
    // this.connections after the disconnect begins.
    const pending = this.pendingConnections.get(normalizedServerId);
    if (pending) {
      pending.token.cancel();
      try {
        await pending.promise;
      } catch (error) {
        logger.debug(`Pending MCP connection ended during disconnect: ${error.message}`);
      }
    }

    const connection = this.connections.get(normalizedServerId);
    if (!connection) {
      return { success: true, message: 'Not connected' };
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(normalizedServerId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(normalizedServerId);
    }

    try {
      await connection.transport.close();
    } catch (error) {
      logger.debug(`Error closing transport: ${error.message}`);
    }

    this.connections.delete(normalizedServerId);

    // Update server status
    const server = await MCPServer.getCached(normalizedServerId);
    if (server) {
      await server.updateStatus('disconnected');
    }

    logger.info(`Disconnected from MCP server: ${normalizedServerId}`);
    this.emit('disconnected', { serverId: normalizedServerId });

    return { success: true };
  }

  /**
   * Handle unexpected disconnect
   */
  handleDisconnect(serverId, error = null) {
    const normalizedServerId = String(serverId);
    this.connections.delete(normalizedServerId);

    // Update status
    MCPServer.getCached(normalizedServerId).then(server => {
      if (server) {
        server.updateStatus('disconnected', error);
      }
    });

    this.emit('disconnected', { serverId: normalizedServerId, error });

    // Schedule reconnect if autoConnect
    if (!this.shuttingDown) {
      this.scheduleReconnect(normalizedServerId);
    }
  }

  /**
   * Schedule automatic reconnection
   */
  scheduleReconnect(serverId, delay = 30000) {
    const normalizedServerId = String(serverId);

    if (this.shuttingDown) {
      return;
    }

    // Clear existing timer
    const existing = this.reconnectTimers.get(normalizedServerId);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule reconnect
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(normalizedServerId);

      if (this.shuttingDown) {
        return;
      }

      const server = await MCPServer.getCached(normalizedServerId);
      if (server?.enabled && server?.autoConnect) {
        logger.info(`Attempting to reconnect to MCP server: ${server.name}`);
        try {
          await this.connect(normalizedServerId);
        } catch (error) {
          // Exponential backoff
          if (!this.shuttingDown) {
            this.scheduleReconnect(normalizedServerId, Math.min(delay * 2, 300000));
          }
        }
      }
    }, delay);

    this.reconnectTimers.set(normalizedServerId, timer);
  }

  /**
   * Handle server notification
   */
  handleNotification(serverId, notification) {
    const normalizedServerId = String(serverId);
    logger.debug(`MCP notification from ${normalizedServerId}:`, notification);
    this.emit('notification', { serverId: normalizedServerId, ...notification });

    // Handle specific notifications
    if (notification.method === 'notifications/tools/list_changed') {
      this.discoverTools(normalizedServerId);
    }
  }

  /**
   * Discover tools from a connected server
   * @param {string} serverId - Server ID
   */
  async discoverTools(serverId) {
    const normalizedServerId = String(serverId);
    const connection = this.connections.get(normalizedServerId);
    if (!connection) {
      throw new Error('Server not connected');
    }

    const server = await MCPServer.getCached(normalizedServerId);
    if (!server) {
      throw new Error('Server not found');
    }

    try {
      const result = await connection.transport.request('tools/list');
      const tools = result.tools || [];

      // Update server with discovered tools
      await server.updateTools(tools);

      logger.info(`Discovered ${tools.length} tools from MCP server: ${server.name}`);
      this.emit('tools_discovered', { serverId: normalizedServerId, tools });

      return tools;
    } catch (error) {
      logger.error(`Failed to discover tools from ${server.name}:`, error);
      throw error;
    }
  }

  /**
   * Execute a tool on a connected server
   * @param {string} serverId - Server ID
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   */
  async executeTool(serverId, toolName, args = {}) {
    const normalizedServerId = String(serverId);
    const connection = this.connections.get(normalizedServerId);
    if (!connection) {
      throw new Error('Server not connected');
    }

    const server = await MCPServer.getCached(normalizedServerId);
    logger.info(`Executing MCP tool: ${server?.name}/${toolName}`);

    try {
      const result = await retryOperation(() => connection.transport.request('tools/call', {
        name: toolName,
        arguments: args
      }), { retries: 3, context: `MCP tool ${toolName}` });

      logger.debug(`Tool ${toolName} result:`, result);
      return result;
    } catch (error) {
      logger.error(`Tool execution failed: ${toolName}`, error);
      throw error;
    }
  }

  /**
   * Test connection to a server (without saving)
   * @param {object} config - Server configuration
   */
  async testConnection(config) {
    let transport = null;

    try {
      transport = createTransport(config);
      await transport.connect();

      const result = await transport.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'LANAgent-Test',
          version: '2.9.0'
        }
      });

      return {
        success: true,
        serverInfo: result.serverInfo,
        capabilities: result.capabilities
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    } finally {
      if (transport) {
        try {
          await transport.close();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Get connection status for all servers
   */
  async getStatus() {
    const servers = await MCPServer.find({});
    const status = [];

    for (const server of servers) {
      const connection = this.connections.get(server._id.toString());
      status.push({
        id: server._id,
        name: server.name,
        enabled: server.enabled,
        status: server.status,
        connected: !!connection?.transport?.connected,
        toolCount: server.discoveredTools?.length || 0,
        lastConnected: server.lastConnected,
        lastError: server.lastError
      });
    }

    return status;
  }

  /**
   * Get list of all available tools from connected servers
   */
  async getAllTools() {
    const tools = [];
    const servers = await MCPServer.find({ status: 'connected' });

    for (const server of servers) {
      for (const tool of server.discoveredTools || []) {
        tools.push({
          serverId: server._id,
          serverName: server.name,
          name: tool.name,
          fullName: `${server.name}:${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema
        });
      }
    }

    return tools;
  }

  /**
   * Find a tool by name (with optional server prefix)
   * @param {string} toolName - Tool name (e.g., "read_file" or "filesystem:read_file")
   */
  async findTool(toolName) {
    const servers = await MCPServer.find({ status: 'connected' });

    // Check if server prefix is provided
    const parts = toolName.split(':');
    if (parts.length === 2) {
      const [serverName, name] = parts;
      const server = servers.find(s => s.name === serverName);
      if (server) {
        const tool = server.discoveredTools?.find(t => t.name === name);
        if (tool) {
          return { server, tool };
        }
      }
    }

    // Search all servers for the tool
    for (const server of servers) {
      const tool = server.discoveredTools?.find(t => t.name === toolName);
      if (tool) {
        return { server, tool };
      }
    }

    return null;
  }

  /**
   * Cleanup - disconnect all servers
   */
  async cleanup() {
    logger.info('Cleaning up MCP Client Service');
    this.shuttingDown = true;

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Invalidate and await all pending connection attempts before disconnecting
    // established connections. This prevents late completions from repopulating
    // this.connections after shutdown.
    const pendingAttempts = Array.from(this.pendingConnections.values());
    for (const pending of pendingAttempts) {
      pending.token.cancel();
    }
    await Promise.allSettled(pendingAttempts.map(({ promise }) => promise));

    // Disconnect all servers
    const serverIds = Array.from(this.connections.keys());
    await Promise.allSettled(
      serverIds.map(id => this.disconnect(id))
    );

    this.initialized = false;
    this.shuttingDown = false;
    logger.info('MCP Client Service cleaned up');
  }
}

// Singleton instance
let clientInstance = null;

/**
 * Get the singleton MCP client instance
 */
export function getMCPClient(agent = null) {
  if (!clientInstance) {
    clientInstance = new MCPClientService(agent);
  }
  return clientInstance;
}

export default MCPClientService;
