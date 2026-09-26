import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js';
import { MCPToken } from '../../models/MCPToken.js';
import { validateJsonSchema } from '../../utils/jsonUtils.js';
import { embeddingService } from '../embeddingService.js';
import { vectorStore } from '../vectorStore.js';

/**
 * MCP Server Service
 *
 * Exposes the agent to MCP clients (Claude Code, Cursor, Claude Desktop...) over
 * Streamable HTTP at POST /mcp/server, authenticated with an MCP token
 * (`Authorization: Bearer mcp_...`, managed under /mcp/api/tokens).
 *
 * The plugins expose hundreds of commands — far more tools than a client should load
 * into its context. So every token gets three meta tools instead:
 *   search_tools  find plugin commands by keyword / plugin
 *   call_tool     run one plugin command by name, with the token's permission checks
 *   ask_agent     a natural-language request through the full agent (routing, memory,
 *                 plugin chaining) — only for unrestricted tokens, since it can reach
 *                 any plugin
 * A token restricted to specific tools (allowedTools) also gets those tools directly.
 *
 * Stateless: each request builds a protocol server bound to the caller's token and a
 * transport with no session id, so nothing is held between requests and the token is
 * re-validated on every call.
 */
export class MCPServerService {
  constructor(agent = null) {
    this.agent = agent;
    this.enabled = true;
    this.endpoint = '/mcp/server';
  }

  /** Re-enable the endpoint (it is mounted on the web server; there is no separate port). */
  async start() {
    this.enabled = true;
    logger.info(`MCP server endpoint enabled at ${this.endpoint}`);
    return { success: true, endpoint: this.endpoint };
  }

  /** Disable the endpoint: requests get 503 until start() is called again. */
  async stop() {
    this.enabled = false;
    logger.info('MCP server endpoint disabled');
    return { success: true };
  }

  get running() {
    return this.enabled && !!this.agent?.apiManager;
  }

  /**
   * Every enabled plugin command, as an MCP tool definition.
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
          usage: command.usage,
          examples: command.examples,
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

  /** Can this token use natural-language ask_agent? Only when nothing restricts it. */
  canAskAgent(token) {
    return token.permissions.includes('*') && token.allowedTools.length === 0 && token.deniedTools.length === 0;
  }

  /** Tools this token may call, from the full exposed list. */
  toolsForToken(token) {
    return this.getExposedTools().filter(t => token.isToolAllowed(t.name, t.category));
  }

  /**
   * Run one plugin command for an already-validated token.
   */
  async executeTool(token, toolName, args = {}) {
    const toolDef = this.getExposedTools().find(t => t.name === toolName);
    if (!toolDef) {
      return { success: false, error: `Tool not found: ${toolName}. Use search_tools to find one.` };
    }

    if (!token.isToolAllowed(toolName, toolDef.category)) {
      return { success: false, error: 'Permission denied for this tool' };
    }

    const validation = this.validateParameters(args, toolDef.inputSchema);
    if (!validation.valid) {
      return { success: false, error: 'Invalid parameters', details: validation.errors };
    }

    // Executed directly, NOT through retryOperation.
    //
    // An MCP tool is whatever a plugin exposes — sending mail, running a command,
    // moving funds. Replaying one after a failure can repeat the side effect, and
    // nothing here knows which tools are idempotent. Opt-in retry belongs to the
    // plugin that knows whether its own operation is safe to repeat.
    try {
      const startTime = Date.now();
      const result = await this.agent.apiManager.executeAPI(toolDef.plugin, 'execute', {
        ...args,
        action: toolDef.action
      });
      logger.info(`MCP tool executed: ${toolName} by token ${token.name} (${Date.now() - startTime}ms)`);
      token.trackUsageAnalytics?.(toolName)?.catch?.(() => {});
      return { success: true, result };
    } catch (error) {
      logger.error(`MCP tool call failed: ${toolName}`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle incoming tool call from MCP client (token given as plaintext).
   * @param {string} tokenValue - Authentication token
   * @param {string} toolName - Tool name
   * @param {object} args - Tool arguments
   */
  async handleToolCall(tokenValue, toolName, args = {}) {
    const token = await MCPToken.validateToken(tokenValue);
    if (!token) {
      return { success: false, error: 'Invalid or expired token' };
    }
    return this.executeTool(token, toolName, args);
  }

  /**
   * Rank this token's tools for a query: the vector intent index first (the same embeddings
   * intent detection uses), then whole-word keyword matches weighted toward the tool name and
   * description over its examples. Tools the index does not rank still appear via keywords.
   */
  async searchTools(token, { query = '', plugin, limit = 25 } = {}) {
    let tools = this.toolsForToken(token);
    if (plugin) tools = tools.filter(t => t.plugin === plugin);
    const cap = Math.min(Number(limit) || 25, 100);
    const byName = new Map(tools.map(t => [t.name, t]));

    const ranked = [];
    const add = (t) => { if (t && !ranked.includes(t)) ranked.push(t); };

    if (query) {
      try {
        const embedding = await embeddingService.generateEmbedding(query);
        const results = await vectorStore.search(embedding, Math.max(cap, 15));
        for (const r of results || []) {
          const meta = r?.metadata || r;
          if (meta?.plugin && meta?.action) add(byName.get(`${meta.plugin}_${meta.action}`));
        }
      } catch (error) {
        logger.debug(`search_tools vector ranking unavailable: ${error.message}`);
      }

      const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
      const hasWord = (text, w) => new RegExp(`\\b${w}`, 'i').test(text || '');
      const keyword = tools.map(t => {
        const primary = `${t.name.replace(/[_-]/g, ' ')} ${t.description || ''}`;
        const secondary = (t.examples || []).join(' ');
        const score = words.reduce((sum, w) => sum + (hasWord(primary, w) ? 2 : hasWord(secondary, w) ? 0.5 : 0), 0);
        return { t, score };
      }).filter(x => x.score >= Math.min(2, words.length)).sort((a, b) => b.score - a.score);
      keyword.forEach(x => add(x.t));
    } else {
      tools.forEach(add);
    }

    return {
      total: ranked.length,
      tools: ranked.slice(0, cap).map(t => ({
        name: t.name,
        description: t.description,
        usage: t.usage,
        ...(Object.keys(t.inputSchema.properties).length ? { inputSchema: t.inputSchema } : {})
      }))
    };
  }

  /**
   * The MCP tool list a token sees.
   */
  listToolsFor(token) {
    const tools = [
      {
        name: 'search_tools',
        description: `Search ${process.env.AGENT_NAME || 'the agent'}'s plugin commands by keyword and/or plugin name. Returns tool names with descriptions and usage; run one with call_tool.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords, e.g. "docker containers" or "weather"' },
            plugin: { type: 'string', description: 'Restrict to one plugin, e.g. "docker"' },
            limit: { type: 'number', description: 'Max results (default 25, max 100)' }
          }
        }
      },
      {
        name: 'call_tool',
        description: 'Run one plugin command found with search_tools. `arguments` are the command\'s parameters (see its usage string).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name, e.g. "docker_list"' },
            arguments: { type: 'object', description: 'Command parameters' }
          },
          required: ['name']
        }
      }
    ];

    if (this.canAskAgent(token)) {
      tools.push({
        name: 'ask_agent',
        description: `Send a natural-language request to ${process.env.AGENT_NAME || 'the agent'}, exactly as if typed in its chat: it picks and chains plugins, uses memory, and replies in text.`,
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'The request, e.g. "what is using the most disk space?"' } },
          required: ['message']
        }
      });
    }

    // A token narrowed to specific tools gets them directly, too.
    if (token.allowedTools.length > 0) {
      for (const t of this.toolsForToken(token).slice(0, 100)) {
        tools.push({
          name: t.name,
          description: [t.description, t.usage && `Usage: ${t.usage}`].filter(Boolean).join('\n'),
          inputSchema: t.inputSchema
        });
      }
    }
    return tools;
  }

  async callToolFor(token, name, args = {}) {
    const text = (value) => ({
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    });

    if (name === 'search_tools') {
      return text(await this.searchTools(token, args));
    }

    if (name === 'ask_agent') {
      if (!this.canAskAgent(token)) return { ...text('ask_agent is not available to this token'), isError: true };
      const message = String(args.message || '').trim();
      if (!message) return { ...text('`message` is required'), isError: true };
      const result = await this.agent.processNaturalLanguage(message, {
        userId: `mcp:${token.name}`,
        interface: 'mcp'
      });
      const reply = typeof result === 'string' ? result : (result?.content ?? result?.caption ?? result?.message ?? result);
      return text(reply);
    }

    const target = name === 'call_tool' ? args.name : name;
    const targetArgs = name === 'call_tool' ? (args.arguments || {}) : args;
    const outcome = await this.executeTool(token, target, targetArgs);
    return outcome.success ? text(outcome.result) : { ...text(outcome), isError: true };
  }

  /** Protocol server bound to one validated token. */
  createProtocolServer(token) {
    const server = new Server(
      { name: (process.env.AGENT_NAME || 'lanagent').toLowerCase(), version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listToolsFor(token) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callToolFor(token, request.params.name, request.params.arguments || {}));
    return server;
  }

  /**
   * Express handler for POST /mcp/server (Streamable HTTP, stateless).
   */
  async handleHttpRequest(req, res) {
    const rpcError = (status, message) => res.status(status).json({
      jsonrpc: '2.0', error: { code: -32000, message }, id: null
    });

    if (!this.running) return rpcError(503, 'MCP server is disabled or the agent is not ready');
    if (req.method !== 'POST') {
      // Stateless mode has no server-initiated stream to GET and no session to DELETE
      res.setHeader('Allow', 'POST');
      return rpcError(405, 'Method not allowed');
    }

    const auth = req.headers.authorization || '';
    const tokenValue = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-mcp-token'];
    const token = tokenValue ? await MCPToken.validateToken(tokenValue) : null;
    if (!token) return rpcError(401, 'Invalid or missing MCP token');

    const server = this.createProtocolServer(token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP server request failed:', error);
      if (!res.headersSent) rpcError(500, 'Internal server error');
    }
  }

  /**
   * Get server status
   */
  getStatus() {
    return {
      running: this.running,
      endpoint: this.endpoint,
      transport: 'streamable-http',
      exposedToolCount: this.getExposedTools().length,
      implementation: 'streamable_http_stateless'
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
          endpoint: this.endpoint
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
 * Get the singleton MCP server instance. The web routes import this before the agent
 * exists, so a later call that supplies the agent attaches it to the same instance.
 */
export function getMCPServer(agent = null) {
  if (!serverInstance) {
    serverInstance = new MCPServerService(agent);
  } else if (agent && !serverInstance.agent) {
    serverInstance.agent = agent;
  }
  return serverInstance;
}

export default MCPServerService;
