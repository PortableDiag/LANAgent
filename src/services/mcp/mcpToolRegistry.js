import { logger } from '../../utils/logger.js';
import { embeddingService } from '../embeddingService.js';
import { vectorStore } from '../vectorStore.js';
import { MCPServer } from '../../models/MCPServer.js';
import { retryOperation } from '../../utils/retryUtils.js';
import NodeCache from 'node-cache';

/**
 * MCP Tool Registry
 * Syncs MCP tools with LANAgent's vector intent system
 */
export class MCPToolRegistry {
  constructor(agent = null) {
    this.agent = agent;
    this.registeredTools = new Map(); // intentId -> { serverId, serverName, tool, version, history }
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  }

  /**
   * Generate intent ID for an MCP tool
   * Format: mcp_${serverName}_${toolName}
   */
  getIntentId(serverName, toolName) {
    // Sanitize names for ID
    const safeName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `mcp_${safeName}_${safeTool}`;
  }

  /**
   * Convert MCP tool to LANAgent intent format
   */
  convertToIntent(serverId, serverName, tool) {
    const intentId = this.getIntentId(serverName, tool.name);

    // Generate examples from tool description and schema
    const examples = this.generateExamples(serverName, tool);

    return {
      id: intentId,
      name: `${serverName} ${tool.name}`,
      description: tool.description || `Execute ${tool.name} on MCP server ${serverName}`,
      plugin: 'mcp',
      action: 'executeTool',
      examples,
      type: 'mcp_tool',
      category: 'integration',
      metadata: {
        serverId: serverId.toString(),
        serverName,
        toolName: tool.name,
        inputSchema: tool.inputSchema
      }
    };
  }

  /**
   * Generate natural language examples for an MCP tool
   */
  generateExamples(serverName, tool) {
    const examples = [];
    const toolName = tool.name;
    const description = tool.description || '';

    // Basic examples
    examples.push(`use ${serverName} ${toolName}`);
    examples.push(`run ${toolName} on ${serverName}`);
    examples.push(`execute ${serverName}:${toolName}`);
    examples.push(`${toolName} via mcp ${serverName}`);

    // Generate examples from description
    if (description) {
      // Extract key words/phrases
      const words = description.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['that', 'this', 'with', 'from', 'into'].includes(w));

      // Add examples with key words
      const uniqueWords = [...new Set(words)].slice(0, 3);
      for (const word of uniqueWords) {
        examples.push(`${word} using ${serverName}`);
      }
    }

    // Generate examples from input schema parameters
    if (tool.inputSchema?.properties) {
      const params = Object.keys(tool.inputSchema.properties).slice(0, 3);
      if (params.length > 0) {
        examples.push(`${toolName} with ${params.join(' and ')}`);
      }
    }

    return examples;
  }

  /**
   * Generate embedding for an MCP tool intent
   */
  async generateToolEmbedding(intent) {
    try {
      const parts = [];

      parts.push(`MCP Tool: ${intent.name}`);
      parts.push(`Description: ${intent.description}`);
      parts.push(`Server: ${intent.metadata.serverName}`);
      parts.push(`Tool: ${intent.metadata.toolName}`);
      parts.push(`Category: ${intent.category}`);

      // Add examples for better matching
      if (intent.examples?.length > 0) {
        parts.push(`Examples: ${intent.examples.join(', ')}`);
        parts.push(`User might say: ${intent.examples.join(', ')}`);
      }

      // Add schema info
      if (intent.metadata.inputSchema?.properties) {
        const props = Object.keys(intent.metadata.inputSchema.properties);
        parts.push(`Parameters: ${props.join(', ')}`);
      }

      const text = parts.join(' | ');
      const embedding = await embeddingService.generateEmbedding(text);

      return {
        id: intent.id,
        embedding,
        metadata: {
          name: intent.name,
          description: intent.description,
          plugin: intent.plugin,
          action: intent.action,
          category: intent.category,
          type: intent.type,
          examples: intent.examples,
          enabled: true,
          mcpServerId: intent.metadata.serverId,
          mcpServerName: intent.metadata.serverName,
          mcpToolName: intent.metadata.toolName,
          mcpInputSchema: intent.metadata.inputSchema
        }
      };
    } catch (error) {
      logger.error(`Failed to generate embedding for MCP tool ${intent.id}:`, error);
      throw error;
    }
  }

  /**
   * Register a single MCP tool with the intent system
   */
  async registerTool(serverId, serverName, tool, version = '1.0.0') {
    const intent = this.convertToIntent(serverId, serverName, tool);
    const intentId = intent.id;

    try {
      // Generate embedding
      const embedding = await this.generateToolEmbedding(intent);

      // Store in vector database
      await vectorStore.addIntents([embedding]);

      // Track registration with versioning
      const existingTool = this.registeredTools.get(intentId);
      if (existingTool) {
        existingTool.history.push({ version: existingTool.version, tool: existingTool.tool });
        existingTool.version = version;
        existingTool.tool = tool;
      } else {
        this.registeredTools.set(intentId, {
          serverId: serverId.toString(),
          serverName,
          tool,
          version,
          history: []
        });
      }

      // Update the server's tool with the registered intent ID
      const server = await MCPServer.findById(serverId);
      if (server) {
        const toolIndex = server.discoveredTools.findIndex(t => t.name === tool.name);
        if (toolIndex >= 0) {
          server.discoveredTools[toolIndex].registeredIntent = intentId;
          await server.save();
        }
      }

      logger.info(`Registered MCP tool intent: ${intentId} with version: ${version}`);
      return { success: true, intentId };

    } catch (error) {
      logger.error(`Failed to register MCP tool ${tool.name}:`, error);
      throw error;
    }
  }

  /**
   * Rollback to a previous version of a tool
   */
  async rollbackTool(intentId, targetVersion) {
    const toolData = this.registeredTools.get(intentId);
    if (!toolData) {
      throw new Error(`Tool with intent ID ${intentId} not found`);
    }

    const historyEntry = toolData.history.find(entry => entry.version === targetVersion);
    if (!historyEntry) {
      throw new Error(`Version ${targetVersion} not found in history for tool ${intentId}`);
    }

    // Re-register the tool with the target version
    await this.registerTool(toolData.serverId, toolData.serverName, historyEntry.tool, targetVersion);
    logger.info(`Rolled back tool ${intentId} to version ${targetVersion}`);
    return { success: true, intentId, version: targetVersion };
  }

  /**
   * Register all tools from a server
   */
  async registerServerTools(serverId) {
    const server = await MCPServer.findById(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const tools = server.discoveredTools || [];
    if (tools.length === 0) {
      logger.info(`No tools to register for server: ${server.name}`);
      return { success: true, registered: 0 };
    }

    logger.info(`Registering ${tools.length} tools from MCP server: ${server.name}`);

    const errors = [];
    const registerPromises = tools.map(tool => 
      retryOperation(() => this.registerTool(serverId, server.name, tool), { retries: 3 })
        .then(() => ({ success: true }))
        .catch(error => {
          errors.push({ tool: tool.name, error: error.message });
          return { success: false };
        })
    );

    const results = await Promise.all(registerPromises);
    const registered = results.filter(result => result.success).length;

    logger.info(`Registered ${registered}/${tools.length} tools from ${server.name}`);

    return {
      success: errors.length === 0,
      registered,
      total: tools.length,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Unregister all tools from a server
   */
  async unregisterServerTools(serverId) {
    const server = await MCPServer.findById(serverId);
    const serverName = server?.name || serverId.toString();

    // Find all intents for this server
    const intentIds = Array.from(this.registeredTools.entries())
      .filter(([_, data]) => data.serverId === serverId.toString())
      .map(([id]) => id);

    if (intentIds.length === 0) {
      logger.info(`No registered tools found for server: ${serverName}`);
      return { success: true, removed: 0 };
    }

    try {
      // Delete from vector store
      await vectorStore.deleteIntents(intentIds);

      // Remove from registry
      intentIds.forEach(id => this.registeredTools.delete(id));

      // Clear registered intent IDs in server
      if (server) {
        for (const tool of server.discoveredTools) {
          tool.registeredIntent = null;
        }
        await server.save();
      }

      logger.info(`Unregistered ${intentIds.length} tools from server: ${serverName}`);

      return {
        success: true,
        removed: intentIds.length
      };

    } catch (error) {
      logger.error(`Failed to unregister tools for server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Sync all MCP tools with the intent system
   * Called during initialization or full re-index
   */
  async syncAllTools() {
    logger.info('Syncing all MCP tools with intent system');

    // Get all connected servers
    const servers = await MCPServer.find({ status: 'connected' });

    let totalRegistered = 0;
    const results = [];

    for (const server of servers) {
      try {
        const result = await this.registerServerTools(server._id);
        totalRegistered += result.registered;
        results.push({
          server: server.name,
          ...result
        });
      } catch (error) {
        results.push({
          server: server.name,
          success: false,
          error: error.message
        });
      }
    }

    logger.info(`Synced ${totalRegistered} MCP tools from ${servers.length} servers`);

    return {
      success: true,
      totalRegistered,
      servers: results
    };
  }

  /**
   * Get registry statistics
   */
  getStats() {
    const byServer = {};
    for (const [_, data] of this.registeredTools) {
      byServer[data.serverName] = (byServer[data.serverName] || 0) + 1;
    }

    return {
      totalTools: this.registeredTools.size,
      byServer
    };
  }

  /**
   * Find registered tool by intent ID
   */
  getToolByIntentId(intentId) {
    return this.registeredTools.get(intentId);
  }

  /**
   * Clear all registered tools
   */
  async clearAll() {
    const intentIds = Array.from(this.registeredTools.keys());

    if (intentIds.length > 0) {
      try {
        await vectorStore.deleteIntents(intentIds);
      } catch (error) {
        logger.error('Failed to clear MCP tools from vector store:', error);
      }
    }

    this.registeredTools.clear();
    logger.info('Cleared all registered MCP tools');
  }
}

// Singleton instance
let registryInstance = null;

/**
 * Get the singleton MCP tool registry instance
 */
export function getMCPToolRegistry(agent = null) {
  if (!registryInstance) {
    registryInstance = new MCPToolRegistry(agent);
  }
  return registryInstance;
}

export default MCPToolRegistry;
