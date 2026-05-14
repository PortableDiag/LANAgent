import { logger, createPluginLogger } from '../../utils/logger.js';
import { EventEmitter } from 'events';
import { validateInput, sanitizeString, sanitizePath, commonSchemas } from '../../utils/validation.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';

/**
 * Base Plugin Class - Foundation for all LANAgent plugins
 * 
 * Provides common functionality including service access, memory management,
 * command execution, AI integration, parameter validation, and event handling.
 * All plugins should extend this class to inherit standard capabilities.
 * 
 * @extends EventEmitter
 * @example
 * class MyPlugin extends BasePlugin {
 *   constructor(agent) {
 *     super(agent);
 *     this.name = 'my-plugin';
 *     this.version = '1.0.0';
 *     this.description = 'Example plugin implementation';
 *   }
 *   
 *   async execute(params) {
 *     this.validateParams(params, { action: { required: true, type: 'string' } });
 *     return { success: true, result: 'Plugin executed successfully' };
 *   }
 * }
 */
export class BasePlugin extends EventEmitter {
  /**
   * Create a new plugin instance with agent integration
   * 
   * @param {import('../../core/agent.js').Agent} agent - LANAgent instance
   */
  constructor(agent) {
    super();
    this.agent = agent;
    this.name = 'unnamed';
    this.version = '0.0.0';
    this.description = 'No description';
    this.config = {};
    this.state = {};
    // Logger will be set when plugin name is set
    this._logger = logger;
  }
  
  /**
   * Set the plugin name and update logger
   * @param {string} value - Plugin name
   */
  set name(value) {
    this._name = value;
    // Create a plugin-specific logger with its own log file
    this.logger = createPluginLogger(value);
  }
  
  /**
   * Get the plugin name
   * @returns {string} Plugin name
   */
  get name() {
    return this._name || 'unnamed';
  }

  /**
   * Initialize the plugin - override in subclass for setup logic
   * 
   * @async
   * @returns {Promise<void>}
   */
  async initialize() {
    // Override in subclass if needed
  }

  /**
   * Main execution method - must be implemented by all plugins
   * 
   * @abstract
   * @async
   * @param {Object} params - Plugin execution parameters
   * @returns {Promise<Object>} Plugin execution result with success/error status
   * @throws {Error} When not implemented by plugin subclass
   */
  async execute(params) {
    throw new Error('execute() method must be implemented by plugin');
  }

  /**
   * Cleanup when plugin is unloaded - override for teardown logic
   * 
   * @async
   * @returns {Promise<void>}
   */
  async cleanup() {
    // Override in subclass if needed
  }

  /**
   * Access agent services by name
   * 
   * @param {string} serviceName - Name of the service to retrieve
   * @returns {Object|undefined} The requested service instance
   */
  getService(serviceName) {
    return this.agent.services.get(serviceName);
  }

  /**
   * Access agent interfaces by name
   * 
   * @param {string} interfaceName - Name of the interface to retrieve
   * @returns {Object|undefined} The requested interface instance
   */
  getInterface(interfaceName) {
    return this.agent.interfaces.get(interfaceName);
  }

  /**
   * Execute system commands via SystemExecutor
   * 
   * @async
   * @param {string} command - Shell command to execute
   * @param {boolean} [requiresApproval=false] - Whether command needs approval
   * @returns {Promise<Object>} Command execution result
   * @throws {Error} When SystemExecutor is not available
   */
  async executeCommand(command, requiresApproval = false) {
    if (!this.agent.systemExecutor) {
      throw new Error('SystemExecutor not available');
    }
    
    return await this.agent.systemExecutor.execute(command, this.name, requiresApproval);
  }

  /**
   * Store data in agent's memory system
   * 
   * @async
   * @param {string} key - Memory key identifier
   * @param {*} value - Data to store
   * @param {Object} [metadata={}] - Additional metadata
   * @returns {Promise<Object>} Storage result
   * @throws {Error} When MemoryManager is not available
   */
  async storeMemory(key, value, metadata = {}) {
    if (!this.agent.memoryManager) {
      throw new Error('MemoryManager not available');
    }
    
    return await this.agent.memoryManager.store({
      plugin: this.name,
      key,
      value,
      metadata,
      timestamp: Date.now()
    });
  }

  /**
   * Retrieve data from agent's memory system
   * 
   * @async
   * @param {string} key - Memory key to retrieve
   * @returns {Promise<*>} Retrieved data or null if not found
   * @throws {Error} When MemoryManager is not available
   */
  async getMemory(key) {
    if (!this.agent.memoryManager) {
      throw new Error('MemoryManager not available');
    }
    
    return await this.agent.memoryManager.retrieve({
      plugin: this.name,
      key
    });
  }

  /**
   * Send notifications via Telegram interface
   * 
   * @async
   * @param {string} message - Notification message
   * @param {Object} [options={}] - Notification options
   * @returns {Promise<Object>} Send result
   * @throws {Error} When Telegram interface is not available
   */
  async notify(message, options = {}) {
    const telegram = this.getInterface('telegram');
    if (!telegram) {
      throw new Error('Telegram interface not available');
    }
    
    return await telegram.sendNotification(message, options);
  }

  /**
   * Process text using AI provider with plugin context
   * 
   * @async
   * @param {string} prompt - Text prompt for AI processing
   * @param {Object} [context={}] - Additional context for AI
   * @returns {Promise<Object>} AI response
   * @throws {Error} When AI Provider Manager or active provider is not available
   */
  async processWithAI(prompt, context = {}) {
    if (!this.agent.providerManager) {
      throw new Error('AI Provider Manager not available');
    }
    
    const provider = this.agent.providerManager.activeProvider;
    if (!provider) {
      throw new Error('No active AI provider');
    }
    
    return await provider.chat([
      { role: 'system', content: `You are assisting the ${this.name} plugin.` },
      { role: 'user', content: prompt }
    ], context);
  }

  /**
   * Get configuration value with optional default
   * 
   * @param {string} key - Configuration key
   * @param {*} [defaultValue=null] - Default value if key not found
   * @returns {*} Configuration value or default
   */
  getConfig(key, defaultValue = null) {
    return this.config[key] !== undefined ? this.config[key] : defaultValue;
  }

  /**
   * Update configuration value and emit change event
   *
   * @param {string} key - Configuration key
   * @param {*} value - New configuration value
   * @fires BasePlugin#config:changed
   */
  setConfig(key, value) {
    this.config[key] = value;
    this.emit('config:changed', { key, value });
  }

  /**
   * Return a sanitized snapshot of this.config for status / debug surfaces.
   * Filters out anything that looks like a credential by key name AND
   * scrubs primitive secret-shaped strings nested inside objects. Plugins
   * that need richer redaction can override.
   *
   * Subclasses MAY define `this.safeConfigKeys = ['fieldA', 'fieldB']`
   * to opt into an explicit allow-list (most secure). When unset, the
   * deny-list pattern below applies.
   */
  getPluginConfig() {
    const denyPattern = /key|secret|token|password|credential|apikey|privatekey|seed|mnemonic|webhook/i;
    const scrub = (val, depth = 0) => {
      if (depth > 4 || val == null) return val;
      if (Array.isArray(val)) return val.map(v => scrub(v, depth + 1));
      if (typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) {
          if (denyPattern.test(k)) {
            out[k] = v == null ? null : '[redacted]';
          } else {
            out[k] = scrub(v, depth + 1);
          }
        }
        return out;
      }
      return val;
    };

    let snapshot;
    if (Array.isArray(this.safeConfigKeys) && this.safeConfigKeys.length) {
      snapshot = {};
      for (const k of this.safeConfigKeys) {
        if (k in this.config) snapshot[k] = this.config[k];
      }
    } else {
      snapshot = scrub(this.config);
    }
    return {
      success: true,
      plugin: this.name,
      version: this.version,
      enabled: this.enabled !== false,
      config: snapshot
    };
  }

  /**
   * Get plugin state value with optional default
   * 
   * @param {string} key - State key
   * @param {*} [defaultValue=null] - Default value if key not found
   * @returns {*} State value or default
   */
  getState(key, defaultValue = null) {
    return this.state[key] !== undefined ? this.state[key] : defaultValue;
  }

  /**
   * Update plugin state and emit change event
   * 
   * @param {string} key - State key
   * @param {*} value - New state value
   * @fires BasePlugin#state:changed
   */
  setState(key, value) {
    this.state[key] = value;
    this.emit('state:changed', { key, value });
  }

  /**
   * Schedule tasks using cron expressions (future integration)
   * 
   * @param {string} cronExpression - Cron schedule expression
   * @param {string} taskName - Name of the scheduled task
   * @param {Function} callback - Task execution callback
   * @todo Integrate with actual cron service
   */
  schedule(cronExpression, taskName, callback) {
    // This would integrate with a cron service when implemented
    this.logger.info(`Scheduled task ${taskName} with expression: ${cronExpression}`);
  }

  /**
   * Validate plugin parameters against schema
   * 
   * @param {Object} params - Parameters to validate
   * @param {Object} schema - Validation schema
   * @param {Object} schema.key - Parameter validation rules
   * @param {boolean} [schema.key.required] - Whether parameter is required
   * @param {string} [schema.key.type] - Expected parameter type
   * @param {Array} [schema.key.enum] - Valid enum values
   * @param {number} [schema.key.min] - Minimum value (for numbers)
   * @param {number} [schema.key.max] - Maximum value (for numbers)
   * @param {string} [schema.key.pattern] - RegExp pattern (for strings)
   * @returns {boolean} True if validation passes
   * @throws {Error} When validation fails with detailed error messages
   * 
   * @example
   * this.validateParams({ action: 'list', limit: 10 }, {
   *   action: { required: true, type: 'string', enum: ['list', 'create'] },
   *   limit: { type: 'number', min: 1, max: 100 }
   * });
   */
  validateParams(params, schema) {
    // Convert old schema format to new format if needed
    const validationSchema = {
      required: [],
      properties: {}
    };
    
    for (const [key, rules] of Object.entries(schema)) {
      if (rules.required) {
        validationSchema.required.push(key);
      }
      validationSchema.properties[key] = rules;
    }
    
    // Use the new validation utility
    const { valid, errors } = validateInput(params, validationSchema);
    
    if (!valid) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    
    return true;
  }
  
  /**
   * Sanitize parameters for safe usage
   * 
   * @param {Object} params - Parameters to sanitize
   * @param {Object} [options={}] - Sanitization options per field
   * @returns {Object} Sanitized parameters
   */
  sanitizeParams(params, options = {}) {
    const sanitized = {};
    
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // Check if it's a path parameter
        if (key.includes('path') || key.includes('file') || key.includes('dir')) {
          sanitized[key] = sanitizePath(value);
        } else {
          // Apply string sanitization with field-specific options
          sanitized[key] = sanitizeString(value, options[key] || {});
        }
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }
  
  /**
   * Get common validation schemas
   *
   * @returns {Object} Common validation schemas
   */
  getCommonSchemas() {
    return commonSchemas;
  }

  /**
   * Load plugin credentials from database or environment variables
   *
   * Credentials are loaded with the following priority:
   * 1. Encrypted credentials stored in PluginSettings (MongoDB)
   * 2. Environment variables as fallback
   *
   * @async
   * @param {Array<Object>} credentialDefs - Array of credential definitions
   * @param {string} credentialDefs[].key - The credential key (e.g., 'apiKey')
   * @param {string} credentialDefs[].envVar - Environment variable name fallback
   * @param {boolean} [credentialDefs[].required=false] - Whether credential is required
   * @returns {Promise<Object>} Object containing credential values
   * @throws {Error} When required credentials are missing
   *
   * @example
   * const credentials = await this.loadCredentials([
   *   { key: 'apiKey', envVar: 'HERE_API_KEY', required: true },
   *   { key: 'secretKey', envVar: 'HERE_SECRET_KEY', required: false }
   * ]);
   * // Returns: { apiKey: 'decrypted-value', secretKey: 'from-env-or-null' }
   */
  async loadCredentials(credentialDefs) {
    const credentials = {};
    const missing = [];

    try {
      // Try to load from PluginSettings first (credentials stored under settingsKey='credentials')
      const settings = await PluginSettings.findOne({ pluginName: this.name, settingsKey: 'credentials' });
      const storedCredentials = settings?.settingsValue || {};

      for (const def of credentialDefs) {
        const { key, envVar, required = false } = def;
        let value = null;

        // Check stored credentials first (encrypted in DB)
        if (storedCredentials[key]) {
          try {
            value = decrypt(storedCredentials[key]);
          } catch (decryptError) {
            this.logger.warn(`Failed to decrypt credential ${key}, falling back to env var`);
          }
        }

        // Fall back to environment variable (check primary + alternates)
        if (!value && envVar) {
          value = process.env[envVar] || null;
        }
        if (!value && def.altEnvVars) {
          for (const alt of def.altEnvVars) {
            value = process.env[alt] || null;
            if (value) break;
          }
        }

        credentials[key] = value;

        // Track missing required credentials
        if (required && !value) {
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        throw new Error(`Missing required credentials: ${missing.join(', ')}`);
      }

      return credentials;
    } catch (error) {
      if (error.message.includes('Missing required credentials')) {
        throw error;
      }
      // If DB access fails, fall back to env vars only
      this.logger.warn(`Failed to load credentials from DB, using env vars only: ${error.message}`);

      for (const def of credentialDefs) {
        const { key, envVar, required = false } = def;
        const value = envVar ? process.env[envVar] || null : null;
        credentials[key] = value;

        if (required && !value) {
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        throw new Error(`Missing required credentials: ${missing.join(', ')}`);
      }

      return credentials;
    }
  }

  /**
   * Check if plugin has all required credentials configured
   *
   * @async
   * @param {Array<Object>} credentialDefs - Array of credential definitions
   * @returns {Promise<Object>} Status object with configured flags
   *
   * @example
   * const status = await this.checkCredentials([
   *   { key: 'apiKey', envVar: 'HERE_API_KEY', required: true }
   * ]);
   * // Returns: { configured: true, credentials: { apiKey: true } }
   */
  async checkCredentials(credentialDefs) {
    const result = { configured: true, credentials: {} };

    try {
      const settings = await PluginSettings.findOne({ pluginName: this.name });
      const storedCredentials = settings?.credentials || {};

      for (const def of credentialDefs) {
        const { key, envVar, required = false } = def;
        const hasStored = !!storedCredentials[key];
        const hasEnv = envVar ? !!process.env[envVar] : false;
        const hasCredential = hasStored || hasEnv;

        result.credentials[key] = hasCredential;

        if (required && !hasCredential) {
          result.configured = false;
        }
      }

      return result;
    } catch (error) {
      this.logger.warn(`Failed to check credentials: ${error.message}`);

      // Fall back to env var check only
      for (const def of credentialDefs) {
        const { key, envVar, required = false } = def;
        const hasEnv = envVar ? !!process.env[envVar] : false;
        result.credentials[key] = hasEnv;

        if (required && !hasEnv) {
          result.configured = false;
        }
      }

      return result;
    }
  }

  /**
   * Get HTTP routes for this plugin
   * 
   * @returns {Array} Array of route definitions
   */
  getRoutes() {
    // Override this method in plugins that need HTTP endpoints
    return [];
  }

  /**
   * Get UI configuration for this plugin
   * 
   * @returns {Object|null} UI configuration including menu item and custom UI
   */
  getUIConfig() {
    // Override this method in plugins that need UI integration
    // Return format:
    // {
    //   menuItem: {
    //     id: 'plugin-id',
    //     title: 'Plugin Title',
    //     icon: 'fas fa-icon',
    //     order: 100, // Used for alphabetical positioning
    //     section: 'main' // or 'advanced', 'system', etc.
    //   },
    //   hasUI: true, // If plugin provides custom UI
    //   contentLoader: async (container, apiToken) => {
    //     // Optional: Custom initialization after content loads
    //   }
    // }
    return null;
  }

  /**
   * Get HTML content for plugin's UI page
   * This content will be injected into the main dashboard
   * and should use the existing theme CSS variables
   * 
   * @returns {string} HTML content for the plugin page
   */
  getUIContent() {
    // Override this method to provide custom UI content
    // Use the theme CSS variables for consistent styling:
    // --bg-primary, --bg-secondary, --text-primary, etc.
    return `
      <div class="plugin-default">
        <h2>${this.name}</h2>
        <p>This plugin does not provide a custom UI.</p>
      </div>
    `;
  }
}