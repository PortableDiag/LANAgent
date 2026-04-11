import { logger } from '../../utils/logger.js';
import { MCPToken } from '../../models/MCPToken.js';

/**
 * MCP Server Service (Framework)
 * Exposes LANAgent plugins as MCP tools to external clients
 *
 * This is a framework stub for future implementation.
 * Full server mode will expose enabled plugins via MCP protocol.
 */
export class MCPServerService {
  constructor(agent = null) {
    this.agent = agent;
    this.running = false;
    this.port = null;
    this.exposedTools = new Map();
  }

  /**
   * Start the MCP server
   * @param {number} port - Port to listen on
   */
  async start(port = 3001) {
    if (this.running) {
      return { success: false, error: 'Server already running' };
    }

    logger.info(`MCP Server mode is not yet fully implemented`);
    logger.info(`Future: Will expose LANAgent plugins on port ${port}`);

    // Framework stub - full implementation in future version
    this.port = port;
    this.running = false; // Will be true when fully implemented

    return {
      success: false,
      message: 'MCP Server mode is a framework stub - not yet fully implemented',
      port
    };
  }

  /**
   * Stop the MCP server
   */
  async stop() {
    if (!this.running) {
      return { success: true, message: 'Server not running' };
    }

    // Framework stub
    this.running = false;
    this.port = null;

    logger.info('MCP Server stopped');
    return { success: true };
  }

  /**
   * Get list of tools that would be exposed
   * Based on enabled plugins
   */
  getExposedTools() {
    if (!this.agent?.apiManager) {
      return [];
    }

    const tools = [];
    const plugins = this.agent.apiManager.apis;

    for (const [pluginName, pluginWrapper] of plugins) {
      if (!pluginWrapper.enabled) continue;

      const plugin = pluginWrapper.instance;
      if (!plugin.commands) continue;

      for (const command of plugin.commands) {
        tools.push({
          name: `${pluginName}_${command.command}`,
          description: command.description,
          plugin: pluginName,
          action: command.command,
          inputSchema: this.generateInputSchema(command)
        });
      }
    }

    return tools;
  }

  /**
   * Generate JSON Schema for a command's parameters
   */
  generateInputSchema(command) {
    // Basic schema - would be enhanced with actual parameter definitions
    return {
      type: 'object',
      properties: {},
      required: []
    };
  }

  /**
   * Handle incoming tool call from MCP client
   * @param {string} tokenValue - Authentication token
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   */
  async handleToolCall(tokenValue, toolName, args = {}) {
    // Validate token
    const token = await MCPToken.validateToken(tokenValue);
    if (!token) {
      return {
        success: false,
        error: 'Invalid or expired token'
      };
    }

    // Parse tool name (format: pluginName_action)
    const parts = toolName.split('_');
    if (parts.length < 2) {
      return {
        success: false,
        error: 'Invalid tool name format'
      };
    }

    const pluginName = parts[0];
    const action = parts.slice(1).join('_');

    // Check permissions
    const plugin = this.agent?.apiManager?.apis?.get(pluginName);
    const category = plugin?.instance?.category || 'general';

    if (!token.isToolAllowed(toolName, category)) {
      return {
        success: false,
        error: 'Permission denied for this tool'
      };
    }

    // Execute via API manager
    try {
      const startTime = Date.now();
      const result = await this.agent.apiManager.execute(pluginName, {
        action,
        ...args
      });
      const executionTime = Date.now() - startTime;
      logger.debug(`MCP tool executed: ${toolName} (${executionTime}ms)`);

      return {
        success: true,
        result
      };
    } catch (error) {
      logger.error(`MCP tool call failed: ${toolName}`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get server status
   */
  getStatus() {
    return {
      running: this.running,
      port: this.port,
      exposedToolCount: this.getExposedTools().length,
      implementation: 'framework_stub'
    };
  }
}

// Singleton instance
let serverInstance = null;

/**
 * Get the singleton MCP server instance
 */
export function getMCPServer(agent = null) {
  if (!serverInstance) {
    serverInstance = new MCPServerService(agent);
  }
  return serverInstance;
}

export default MCPServerService;
