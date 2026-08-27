import { logger } from '../../utils/logger.js';
import { MCPToken } from '../../models/MCPToken.js';
import { validateJsonSchema } from '../../utils/jsonUtils.js';

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
  // Deliberately uncached. The submitted version memoised this list for five
  // minutes, which means a plugin the operator just DISABLED keeps appearing as
  // an exposed tool until the entry expires. Building the list is a walk over
  // already-loaded plugin objects — there is no cost here worth trading a stale
  // permission surface for.
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
          category: plugin.category || 'general',
          action: command.command,
          inputSchema: this.generateInputSchema(command),
          permissions: command.permissions || ['user'],
          executionMetadata: {
            timeout: command.timeout || 30000,
            retryAttempts: command.retryAttempts || 0
          }
        });
      }
    }

    return tools;
  }

  /**
   * Generate JSON Schema for a command's parameters
   */
  generateInputSchema(command) {
    // Enhanced schema generation with actual parameter definitions
    const schema = {
      type: 'object',
      properties: {},
      required: []
    };

    if (command.parameters && Array.isArray(command.parameters)) {
      for (const param of command.parameters) {
        schema.properties[param.name] = {
          type: param.type || 'string',
          description: param.description || ''
        };

        if (param.required) {
          schema.required.push(param.name);
        }

        // Add additional constraints if defined
        if (param.enum) {
          schema.properties[param.name].enum = param.enum;
        }

        if (param.pattern) {
          schema.properties[param.name].pattern = param.pattern;
        }

        if (param.minimum !== undefined) {
          schema.properties[param.name].minimum = param.minimum;
        }

        if (param.maximum !== undefined) {
          schema.properties[param.name].maximum = param.maximum;
        }
      }
    }

    return schema;
  }

  /**
   * Validate parameters against command schema
   * @param {object} args - Arguments to validate
   * @param {object} schema - JSON Schema to validate against
   * @returns {object} Validation result
   */
  validateParameters(args, schema) {
    try {
      // validateJsonSchema returns an ARRAY OF ERRORS, not { valid, errors }.
      // Reading `result.valid` off an array yields undefined, which is falsy, so
      // the caller's `if (!validation.valid)` fired on every single call and
      // every MCP tool invocation came back "Invalid parameters" — including the
      // valid ones. An empty array is the success case.
      const errors = validateJsonSchema(args ?? {}, schema ?? {});
      const list = Array.isArray(errors) ? errors : [];
      return {
        valid: list.length === 0,
        errors: list.map(e => (typeof e === 'string' ? e : e?.message ?? String(e)))
      };
    } catch (error) {
      logger.error('Parameter validation error:', error);
      return {
        valid: false,
        errors: [error.message]
      };
    }
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

    // Get tool definition for schema validation
    const tools = this.getExposedTools();
    const toolDef = tools.find(t => t.name === toolName);
    
    if (!toolDef) {
      return {
        success: false,
        error: 'Tool not found'
      };
    }

    // Validate parameters
    const validation = this.validateParameters(args, toolDef.inputSchema);
    if (!validation.valid) {
      return {
        success: false,
        error: 'Invalid parameters',
        details: validation.errors
      };
    }

    // Executed directly, NOT through retryOperation.
    //
    // An MCP tool is whatever a plugin exposes — sending mail, running a command,
    // moving funds. Replaying one after a failure can repeat the side effect, and
    // nothing here knows which tools are idempotent. The submitted version passed
    // `retries: retryAttempts || 0` believing that made it opt-in, but
    // retryUtils.js:158 resolves `dynamicParams.retries || retries`, so a caller
    // asking for zero does not reliably get zero. Opt-in retry belongs to the
    // plugin that knows whether its own operation is safe to repeat.
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

  /**
   * Get tools with filtering capabilities
   * @param {Object} filters - Filter criteria
   * @param {string} [filters.category] - Filter by category
   * @param {string} [filters.plugin] - Filter by plugin name
   * @param {string} [filters.permission] - Filter by permission level
   * @returns {Array} Filtered tools
   */
  getToolsWithFilters(filters = {}) {
    let tools = this.getExposedTools();

    if (filters.category) {
      tools = tools.filter(tool => tool.category === filters.category);
    }

    if (filters.plugin) {
      tools = tools.filter(tool => tool.plugin === filters.plugin);
    }

    if (filters.permission) {
      tools = tools.filter(tool => 
        tool.permissions && tool.permissions.includes(filters.permission)
      );
    }

    return tools;
  }

  /**
   * Health check endpoint
   * @returns {object} Health status
   */
  getHealthStatus() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      components: {
        server: {
          status: this.running ? 'up' : 'down',
          port: this.port
        },
        tools: {
          status: 'up',
          count: this.getExposedTools().length
        }
      }
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
