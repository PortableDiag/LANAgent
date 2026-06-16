import { BasePlugin } from '../core/basePlugin.js';
import { MCPServer } from '../../models/MCPServer.js';
import { MCPToken } from '../../models/MCPToken.js';
import { getMCPClient } from '../../services/mcp/mcpClient.js';
import { getMCPToolRegistry } from '../../services/mcp/mcpToolRegistry.js';
import { getMCPServer } from '../../services/mcp/mcpServer.js';
import { encrypt } from '../../utils/encryption.js';

/**
 * MCP Plugin - Model Context Protocol Integration
 *
 * Provides client and server functionality for MCP:
 * - Client Mode: Connect to external MCP servers, discover tools, execute them
 * - Server Mode (Framework): Expose LANAgent plugins as MCP tools
 *
 * Tools from connected MCP servers are automatically registered with the
 * LANAgent intent system for natural language discovery.
 */
export default class MCPPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'mcp';
    this.version = '1.0.0';
    this.description = 'Model Context Protocol client and server for AI tool integration';
    this.category = 'integration';

    this.commands = [
      // Server management
      {
        command: 'listServers',
        description: 'List configured MCP servers',
        usage: 'listServers()',
        examples: [
          'list mcp servers',
          'show my mcp connections',
          'what mcp servers are configured',
          'show all mcp server connections'
        ]
      },
      {
        command: 'addServer',
        description: 'Add a new MCP server connection',
        usage: 'addServer({ name: "filesystem", url: "npx @anthropic/mcp-server-filesystem /tmp", transport: "stdio" })',
        examples: [
          'add mcp server',
          'connect to new mcp server',
          'add an mcp server named filesystem',
          'configure new mcp connection'
        ]
      },
      {
        command: 'updateServer',
        description: 'Update MCP server configuration',
        usage: 'updateServer({ id: "...", name: "new-name" })',
        examples: [
          'update mcp server settings',
          'modify mcp server configuration',
          'change mcp server details'
        ]
      },
      {
        command: 'removeServer',
        description: 'Remove an MCP server',
        usage: 'removeServer({ id: "..." })',
        examples: [
          'remove mcp server',
          'delete mcp connection',
          'disconnect and remove mcp server'
        ]
      },

      // Connection management
      {
        command: 'connect',
        description: 'Connect to an MCP server',
        usage: 'connect({ id: "..." })',
        examples: [
          'connect to mcp server',
          'start mcp connection',
          'connect to filesystem mcp',
          'activate mcp server connection'
        ]
      },
      {
        command: 'disconnect',
        description: 'Disconnect from an MCP server',
        usage: 'disconnect({ id: "..." })',
        examples: [
          'disconnect from mcp server',
          'stop mcp connection',
          'disconnect from filesystem mcp',
          'close mcp server connection'
        ]
      },
      {
        command: 'reconnect',
        description: 'Reconnect to an MCP server',
        usage: 'reconnect({ id: "..." })',
        examples: [
          'reconnect to mcp server',
          'restart mcp connection',
          'reconnect filesystem mcp'
        ]
      },
      {
        command: 'testConnection',
        description: 'Test MCP server connectivity',
        usage: 'testConnection({ url: "...", transport: "sse" })',
        examples: [
          'test mcp connection',
          'check if mcp server is reachable',
          'verify mcp server connectivity'
        ]
      },

      // Tool operations
      {
        command: 'discoverTools',
        description: 'Discover tools from connected MCP servers',
        usage: 'discoverTools({ id: "..." })',
        examples: [
          'discover mcp tools',
          'what tools does the mcp server have',
          'list mcp tools',
          'refresh mcp tool list'
        ]
      },
      {
        command: 'listTools',
        description: 'List all available MCP tools',
        usage: 'listTools()',
        examples: [
          'show all mcp tools',
          'what mcp tools are available',
          'list tools from mcp servers'
        ]
      },
      {
        command: 'executeTool',
        description: 'Execute a tool on an MCP server',
        usage: 'executeTool({ serverName: "filesystem", toolName: "read_file", args: { path: "/tmp/test.txt" } })',
        examples: [
          'run mcp tool',
          'execute mcp read_file',
          'use filesystem read_file',
          'run read_file on mcp server'
        ]
      },
      {
        command: 'syncIntents',
        description: 'Sync MCP tools with intent system',
        usage: 'syncIntents()',
        examples: [
          'sync mcp intents',
          'register mcp tools',
          'update mcp tool intents',
          'refresh mcp intent registration'
        ]
      },

      // Token management (for server mode)
      {
        command: 'listTokens',
        description: 'List MCP access tokens',
        usage: 'listTokens()',
        examples: [
          'list mcp tokens',
          'show mcp access tokens',
          'what mcp tokens exist'
        ]
      },
      {
        command: 'createToken',
        description: 'Create a new MCP access token',
        usage: 'createToken({ name: "client-1", permissions: ["*"], expiresIn: 86400000 })',
        examples: [
          'create mcp token',
          'generate mcp access token',
          'make new mcp token'
        ]
      },
      {
        command: 'revokeToken',
        description: 'Revoke an MCP access token',
        usage: 'revokeToken({ id: "..." })',
        examples: [
          'revoke mcp token',
          'disable mcp access token',
          'delete mcp token'
        ]
      },

      // Status
      {
        command: 'getStatus',
        description: 'Get MCP service status',
        usage: 'getStatus()',
        examples: [
          'mcp status',
          'show mcp connection status',
          'get mcp service status',
          'how are mcp connections'
        ]
      }
    ];

    // Services will be initialized in initialize()
    this.mcpClient = null;
    this.toolRegistry = null;
    this.mcpServer = null;
    this.initialized = false;
  }

  async initialize() {
    this.logger.info('Initializing MCP plugin...');

    try {
      // Get service instances
      this.mcpClient = getMCPClient(this.agent);
      this.toolRegistry = getMCPToolRegistry(this.agent);
      this.mcpServer = getMCPServer(this.agent);

      // Initialize client service (auto-connects to servers)
      await this.mcpClient.initialize();

      // Set up event handlers
      this.mcpClient.on('connected', async ({ serverId }) => {
        // Auto-register tools when a server connects
        await this.toolRegistry.registerServerTools(serverId);
      });

      this.mcpClient.on('disconnected', async ({ serverId }) => {
        // Unregister tools when a server disconnects
        await this.toolRegistry.unregisterServerTools(serverId);
      });

      this.mcpClient.on('tools_discovered', async ({ serverId, tools }) => {
        this.logger.info(`Tools discovered from server ${serverId}: ${tools.length} tools`);
      });

      this.initialized = true;
      this.logger.info('MCP plugin initialized');
    } catch (error) {
      this.logger.error('Failed to initialize MCP plugin:', error);
      // Don't throw - plugin can still function with limited capability
    }
  }

  async execute(params) {
    const { action, ...data } = params;

    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    try {
      switch (action) {
        // Server management
        case 'listServers':
          return await this.listServers();
        case 'addServer':
          return await this.addServer(data);
        case 'updateServer':
          return await this.updateServer(data);
        case 'removeServer':
          return await this.removeServer(data);

        // Connection management
        case 'connect':
          return await this.connect(data);
        case 'disconnect':
          return await this.disconnect(data);
        case 'reconnect':
          return await this.reconnect(data);
        case 'testConnection':
          return await this.testConnection(data);

        // Tool operations
        case 'discoverTools':
          return await this.discoverTools(data);
        case 'listTools':
          return await this.listTools();
        case 'executeTool':
          return await this.executeTool(data);
        case 'syncIntents':
          return await this.syncIntents();

        // Token management
        case 'listTokens':
          return await this.listTokens();
        case 'createToken':
          return await this.createToken(data);
        case 'revokeToken':
          return await this.revokeToken(data);

        // Status
        case 'getStatus':
          return await this.getStatus();

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`MCP action ${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ==================== Server Management ====================

  async listServers() {
    const servers = await MCPServer.find({});
    return {
      success: true,
      servers: servers.map(s => s.toDisplay())
    };
  }

  async addServer(data) {
    const { name, url, transport = 'sse', command, args, authType = 'none', authCredentials, autoConnect = true, description } = data;

    if (!name || !url) {
      return { success: false, error: 'name and url are required' };
    }

    // Check if server with this name already exists
    const existing = await MCPServer.findOne({ name });
    if (existing) {
      return { success: false, error: `Server with name "${name}" already exists` };
    }

    const serverData = {
      name,
      url,
      transport,
      command: transport === 'stdio' ? (command || url) : null,
      args: args || [],
      authType,
      autoConnect,
      description,
      enabled: true,
      status: 'disconnected'
    };

    // Encrypt credentials if provided
    if (authCredentials) {
      serverData.authCredentials = encrypt(JSON.stringify(authCredentials));
    }

    const server = new MCPServer(serverData);
    await server.save();

    this.logger.info(`Added MCP server: ${name}`);

    // Auto-connect if enabled
    if (autoConnect) {
      try {
        await this.mcpClient.connect(server._id);
      } catch (error) {
        this.logger.warn(`Failed to auto-connect to ${name}: ${error.message}`);
      }
    }

    return {
      success: true,
      server: server.toDisplay(),
      message: `MCP server "${name}" added successfully`
    };
  }

  async updateServer(data) {
    const { id, name: serverName, ...updates } = data;

    // Find server by ID or name
    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    // Update allowed fields
    const allowedFields = ['name', 'url', 'transport', 'command', 'args', 'enabled', 'autoConnect', 'authType', 'authCredentials', 'description', 'tags'];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === 'authCredentials' && updates[field]) {
          server[field] = encrypt(JSON.stringify(updates[field]));
        } else {
          server[field] = updates[field];
        }
      }
    }

    await server.save();

    return {
      success: true,
      server: server.toDisplay(),
      message: `Server "${server.name}" updated`
    };
  }

  async removeServer(data) {
    const { id, name: serverName } = data;

    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    // Disconnect first if connected
    try {
      await this.mcpClient.disconnect(server._id);
    } catch (e) {
      // Ignore disconnect errors
    }

    // Unregister tools
    await this.toolRegistry.unregisterServerTools(server._id);

    // Delete server
    await MCPServer.findByIdAndDelete(server._id);

    this.logger.info(`Removed MCP server: ${server.name}`);

    return {
      success: true,
      message: `Server "${server.name}" removed`
    };
  }

  // ==================== Connection Management ====================

  async connect(data) {
    const { id, name: serverName } = data;

    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    const result = await this.mcpClient.connect(server._id);

    return {
      success: true,
      ...result,
      message: `Connected to "${server.name}"`
    };
  }

  async disconnect(data) {
    const { id, name: serverName } = data;

    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    const result = await this.mcpClient.disconnect(server._id);

    return {
      success: true,
      ...result,
      message: `Disconnected from "${server.name}"`
    };
  }

  async reconnect(data) {
    const { id, name: serverName } = data;

    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    await this.mcpClient.disconnect(server._id);
    const result = await this.mcpClient.connect(server._id);

    return {
      success: true,
      ...result,
      message: `Reconnected to "${server.name}"`
    };
  }

  async testConnection(data) {
    const { url, transport = 'sse', command, args, authType, authCredentials } = data;

    if (!url) {
      return { success: false, error: 'url is required' };
    }

    const config = {
      url,
      transport,
      command: transport === 'stdio' ? (command || url) : null,
      args: args || [],
      authType,
      getAuthHeaders: () => {
        if (!authCredentials || authType === 'none') return {};
        // Build auth headers based on type
        const headers = {};
        if (authType === 'bearer' && authCredentials.token) {
          headers['Authorization'] = `Bearer ${authCredentials.token}`;
        } else if (authType === 'apiKey' && authCredentials.headerName && authCredentials.value) {
          headers[authCredentials.headerName] = authCredentials.value;
        }
        return headers;
      }
    };

    const result = await this.mcpClient.testConnection(config);

    return {
      success: result.success,
      ...result
    };
  }

  // ==================== Tool Operations ====================

  async discoverTools(data) {
    const { id, name: serverName } = data;

    let server;
    if (id) {
      server = await MCPServer.findById(id);
    } else if (serverName) {
      server = await MCPServer.findOne({ name: serverName });
    } else {
      // Discover from all connected servers
      const tools = await this.mcpClient.getAllTools();
      return {
        success: true,
        tools,
        count: tools.length
      };
    }

    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    const tools = await this.mcpClient.discoverTools(server._id);

    return {
      success: true,
      server: server.name,
      tools,
      count: tools.length
    };
  }

  async listTools() {
    const tools = await this.mcpClient.getAllTools();
    return {
      success: true,
      tools,
      count: tools.length
    };
  }

  async executeTool(data) {
    const { serverId, serverName, toolName, args = {} } = data;

    if (!toolName) {
      return { success: false, error: 'toolName is required' };
    }

    // Find the tool
    const toolInfo = await this.mcpClient.findTool(
      serverName ? `${serverName}:${toolName}` : toolName
    );

    if (!toolInfo) {
      return { success: false, error: `Tool not found: ${toolName}` };
    }

    const { server, tool } = toolInfo;

    // Execute the tool
    const result = await this.mcpClient.executeTool(server._id, tool.name, args);

    return {
      success: true,
      server: server.name,
      tool: tool.name,
      result
    };
  }

  async syncIntents() {
    const result = await this.toolRegistry.syncAllTools();

    return {
      success: true,
      ...result,
      message: `Synced ${result.totalRegistered} MCP tools with intent system`
    };
  }

  // ==================== Token Management ====================

  async listTokens() {
    const tokens = await MCPToken.getActive();
    return {
      success: true,
      tokens: tokens.map(t => t.toDisplay())
    };
  }

  async createToken(data) {
    const { name, permissions = ['*'], allowedTools = [], deniedTools = [], expiresIn, description } = data;

    if (!name) {
      return { success: false, error: 'name is required' };
    }

    const result = await MCPToken.generateToken({
      name,
      permissions,
      allowedTools,
      deniedTools,
      expiresIn,
      description,
      createdBy: 'plugin'
    });

    return {
      success: true,
      token: result.token, // Only shown once
      tokenInfo: result.doc.toDisplay(),
      message: `Token created. Save this token - it won't be shown again: ${result.token}`
    };
  }

  async revokeToken(data) {
    const { id, name: tokenName } = data;

    let token;
    if (id) {
      token = await MCPToken.findById(id);
    } else if (tokenName) {
      token = await MCPToken.findOne({ name: tokenName, active: true });
    } else {
      return { success: false, error: 'id or name required' };
    }

    if (!token) {
      return { success: false, error: 'Token not found' };
    }

    await token.revoke();

    return {
      success: true,
      message: `Token "${token.name}" revoked`
    };
  }

  // ==================== Status ====================

  async getStatus() {
    const serverStatus = await this.mcpClient.getStatus();
    const registryStats = this.toolRegistry.getStats();
    const mcpServerStatus = this.mcpServer.getStatus();

    const connectedCount = serverStatus.filter(s => s.connected).length;
    const totalToolCount = serverStatus.reduce((sum, s) => sum + (s.toolCount || 0), 0);

    return {
      success: true,
      client: {
        initialized: this.initialized,
        servers: serverStatus,
        connectedServers: connectedCount,
        totalServers: serverStatus.length
      },
      tools: {
        registered: registryStats.totalTools,
        byServer: registryStats.byServer,
        discovered: totalToolCount
      },
      server: mcpServerStatus
    };
  }

  // ==================== Cleanup ====================

  async cleanup() {
    this.logger.info('Cleaning up MCP plugin...');

    if (this.mcpClient) {
      await this.mcpClient.cleanup();
    }

    if (this.toolRegistry) {
      await this.toolRegistry.clearAll();
    }

    this.initialized = false;
    this.logger.info('MCP plugin cleaned up');
  }

  // ==================== Plugin Info ====================

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
