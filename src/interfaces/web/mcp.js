import express from 'express';
import { authenticateToken } from './auth.js';
import { MCPServer } from '../../models/MCPServer.js';
import { MCPToken } from '../../models/MCPToken.js';
import { getMCPClient } from '../../services/mcp/mcpClient.js';
import { getMCPToolRegistry } from '../../services/mcp/mcpToolRegistry.js';
import { getMCPServer } from '../../services/mcp/mcpServer.js';
import { encrypt } from '../../utils/encryption.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

// Get service instances
const mcpClient = getMCPClient();
const toolRegistry = getMCPToolRegistry();
const mcpServer = getMCPServer();

/**
 * MCP Web Interface Routes
 * Provides REST API for managing MCP servers, tools, and tokens
 */

// ==================== Service Status ====================

// Get overall MCP service status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const serverStatus = await mcpClient.getStatus();
    const registryStats = toolRegistry.getStats();
    const mcpServerStatus = mcpServer.getStatus();

    const connectedCount = serverStatus.filter(s => s.connected).length;
    const totalToolCount = serverStatus.reduce((sum, s) => sum + (s.toolCount || 0), 0);

    res.json({
      success: true,
      client: {
        servers: serverStatus,
        connectedServers: connectedCount,
        totalServers: serverStatus.length
      },
      tools: {
        registered: registryStats.totalTools,
        byServer: registryStats.byServer,
        discovered: totalToolCount
      },
      server: mcpServerStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('MCP status API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Server Management ====================

// Get all servers
router.get('/api/servers', authenticateToken, async (req, res) => {
  try {
    const servers = await MCPServer.find({}).lean();
    res.json({
      success: true,
      servers: servers.map(s => ({
        id: s._id,
        name: s.name,
        url: s.url,
        transport: s.transport,
        command: s.command,
        enabled: s.enabled,
        autoConnect: s.autoConnect,
        status: s.status,
        authType: s.authType,
        toolCount: s.discoveredTools?.length || 0,
        lastConnected: s.lastConnected,
        lastError: s.lastError,
        description: s.description,
        tags: s.tags,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }))
    });
  } catch (error) {
    logger.error('Get MCP servers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single server
router.get('/api/servers/:id', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }
    res.json({ success: true, server: server.toDisplay() });
  } catch (error) {
    logger.error('Get MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create server
router.post('/api/servers', authenticateToken, async (req, res) => {
  try {
    const { name, url, transport = 'sse', command, args, authType = 'none', authCredentials, autoConnect = true, description, tags } = req.body;

    if (!name || !url) {
      return res.status(400).json({ success: false, error: 'name and url are required' });
    }

    // Check if server with this name already exists
    const existing = await MCPServer.findOne({ name });
    if (existing) {
      return res.status(400).json({ success: false, error: `Server with name "${name}" already exists` });
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
      tags,
      enabled: true,
      status: 'disconnected'
    };

    // Encrypt credentials if provided
    if (authCredentials) {
      serverData.authCredentials = encrypt(JSON.stringify(authCredentials));
    }

    const server = new MCPServer(serverData);
    await server.save();

    logger.info(`Added MCP server via API: ${name}`);

    // Auto-connect if enabled
    if (autoConnect) {
      try {
        await mcpClient.connect(server._id);
      } catch (error) {
        logger.warn(`Failed to auto-connect to ${name}: ${error.message}`);
      }
    }

    res.json({ success: true, server: server.toDisplay() });
  } catch (error) {
    logger.error('Create MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update server
router.put('/api/servers/:id', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    const updates = req.body;
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
    res.json({ success: true, server: server.toDisplay() });
  } catch (error) {
    logger.error('Update MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete server
router.delete('/api/servers/:id', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    // Disconnect first
    try {
      await mcpClient.disconnect(server._id);
    } catch (e) {
      // Ignore disconnect errors
    }

    // Unregister tools
    await toolRegistry.unregisterServerTools(server._id);

    // Delete server
    await MCPServer.findByIdAndDelete(server._id);

    logger.info(`Deleted MCP server: ${server.name}`);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Connection Management ====================

// Connect to server
router.post('/api/servers/:id/connect', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    const result = await mcpClient.connect(server._id);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Connect MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect from server
router.post('/api/servers/:id/disconnect', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    const result = await mcpClient.disconnect(server._id);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Disconnect MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test connection (without saving)
router.post('/api/servers/test', authenticateToken, async (req, res) => {
  try {
    const { url, transport = 'sse', command, args, authType, authCredentials } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    const config = {
      url,
      transport,
      command: transport === 'stdio' ? (command || url) : null,
      args: args || [],
      authType,
      getAuthHeaders: () => {
        if (!authCredentials || authType === 'none') return {};
        const headers = {};
        if (authType === 'bearer' && authCredentials.token) {
          headers['Authorization'] = `Bearer ${authCredentials.token}`;
        } else if (authType === 'apiKey' && authCredentials.headerName && authCredentials.value) {
          headers[authCredentials.headerName] = authCredentials.value;
        }
        return headers;
      }
    };

    const result = await mcpClient.testConnection(config);
    res.json(result);
  } catch (error) {
    logger.error('Test MCP connection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle server enabled state
router.post('/api/servers/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    server.enabled = !server.enabled;
    await server.save();

    // Connect or disconnect based on new state
    if (server.enabled && server.autoConnect) {
      try {
        await mcpClient.connect(server._id);
      } catch (e) {
        logger.warn(`Failed to auto-connect after enable: ${e.message}`);
      }
    } else if (!server.enabled) {
      try {
        await mcpClient.disconnect(server._id);
      } catch (e) {
        // Ignore
      }
    }

    res.json({ success: true, enabled: server.enabled });
  } catch (error) {
    logger.error('Toggle MCP server error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Tool Operations ====================

// Get server tools
router.get('/api/servers/:id/tools', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    res.json({
      success: true,
      server: server.name,
      tools: server.discoveredTools || [],
      count: server.discoveredTools?.length || 0
    });
  } catch (error) {
    logger.error('Get MCP server tools error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Discover/refresh tools from server
router.post('/api/servers/:id/discover', authenticateToken, async (req, res) => {
  try {
    const server = await MCPServer.findById(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    const tools = await mcpClient.discoverTools(server._id);

    res.json({
      success: true,
      server: server.name,
      tools,
      count: tools.length
    });
  } catch (error) {
    logger.error('Discover MCP tools error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all tools from all connected servers
router.get('/api/tools', authenticateToken, async (req, res) => {
  try {
    const tools = await mcpClient.getAllTools();
    res.json({
      success: true,
      tools,
      count: tools.length
    });
  } catch (error) {
    logger.error('Get all MCP tools error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Execute tool
router.post('/api/tools/execute', authenticateToken, async (req, res) => {
  try {
    const { serverId, serverName, toolName, args = {} } = req.body;

    if (!toolName) {
      return res.status(400).json({ success: false, error: 'toolName is required' });
    }

    // Find the tool
    const toolInfo = await mcpClient.findTool(
      serverName ? `${serverName}:${toolName}` : toolName
    );

    if (!toolInfo) {
      return res.status(404).json({ success: false, error: `Tool not found: ${toolName}` });
    }

    const { server, tool } = toolInfo;

    // Execute the tool
    const result = await mcpClient.executeTool(server._id, tool.name, args);

    res.json({
      success: true,
      server: server.name,
      tool: tool.name,
      result
    });
  } catch (error) {
    logger.error('Execute MCP tool error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync tools with intent system
router.post('/api/tools/sync', authenticateToken, async (req, res) => {
  try {
    const result = await toolRegistry.syncAllTools();
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Sync MCP tools error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Token Management ====================

// Get all tokens
router.get('/api/tokens', authenticateToken, async (req, res) => {
  try {
    const tokens = await MCPToken.find({}).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      tokens: tokens.map(t => ({
        id: t._id,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        permissions: t.permissions,
        allowedTools: t.allowedTools,
        deniedTools: t.deniedTools,
        expiresAt: t.expiresAt,
        lastUsed: t.lastUsed,
        usageCount: t.usageCount,
        active: t.active,
        createdBy: t.createdBy,
        description: t.description,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    logger.error('Get MCP tokens error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create token
router.post('/api/tokens', authenticateToken, async (req, res) => {
  try {
    const { name, permissions = ['*'], allowedTools = [], deniedTools = [], expiresIn, description } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const result = await MCPToken.generateToken({
      name,
      permissions,
      allowedTools,
      deniedTools,
      expiresIn,
      description,
      createdBy: 'api'
    });

    res.json({
      success: true,
      token: result.token, // Only shown once
      tokenInfo: result.doc.toDisplay()
    });
  } catch (error) {
    logger.error('Create MCP token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Revoke token
router.post('/api/tokens/:id/revoke', authenticateToken, async (req, res) => {
  try {
    const token = await MCPToken.findById(req.params.id);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }

    await token.revoke();
    res.json({ success: true });
  } catch (error) {
    logger.error('Revoke MCP token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete token
router.delete('/api/tokens/:id', authenticateToken, async (req, res) => {
  try {
    const token = await MCPToken.findById(req.params.id);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }

    await MCPToken.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete MCP token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cleanup expired tokens
router.post('/api/tokens/cleanup', authenticateToken, async (req, res) => {
  try {
    const count = await MCPToken.cleanupExpired();
    res.json({ success: true, deactivated: count });
  } catch (error) {
    logger.error('Cleanup MCP tokens error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
