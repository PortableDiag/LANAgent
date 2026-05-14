/**
 * AI Plugin Template - Optimized for automated plugin generation
 * This template is designed for the Plugin Development Service to use when creating new plugins
 * 
 * PLACEHOLDER MARKERS:
 * {{PLUGIN_NAME}} - Lowercase plugin identifier (e.g., "weather")
 * {{PLUGIN_VERSION}} - Semantic version (e.g., "1.0.0")
 * {{PLUGIN_DESCRIPTION}} - One-line description of plugin functionality
 * {{PLUGIN_COMMANDS}} - JSON array of command objects with command, description, usage, examples
 * {{PLUGIN_CONFIG}} - Initial configuration object
 * {{PLUGIN_INITIALIZE}} - Initialization code (API connections, setup, etc.)
 * {{PLUGIN_HANDLERS}} - Case statements for each command
 * {{PLUGIN_METHODS}} - Additional methods specific to this plugin
 * {{API_KEY_NAME}} - Environment variable name for API key if needed
 * {{API_ENDPOINT}} - Base API endpoint if needed
 * 
 * HELPER FILES:
 * - For complex plugins, create helper files: {{PLUGIN_NAME}}-feature.js
 * - Import helpers at top: import { Helper } from './{{PLUGIN_NAME}}-helpers.js';
 * 
 * MONGODB MODELS:
 * - For data persistence, create models in src/models/
 * - Example: import { PluginData } from '../../models/PluginData.js';
 * 
 * PLUGIN SETTINGS:
 * - Use PluginSettings for cached configuration storage
 * - getCached() for reading, setCached() for writing
 * - Automatic cache invalidation on updates
 */

import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';

export default class {{PLUGIN_NAME}}Plugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = '{{PLUGIN_NAME}}';
    this.version = '{{PLUGIN_VERSION}}';
    this.description = '{{PLUGIN_DESCRIPTION}}';
    
    // Commands array for vector intent detection
    // Each command will be automatically indexed when the plugin is enabled
    // Include 'examples' array for better natural language matching
    this.commands = [
      ...{{PLUGIN_COMMANDS}},
      {
        command: 'getPluginConfig',
        description: 'Return a sanitized snapshot of this plugin\'s current configuration (credentials redacted)',
        usage: 'getPluginConfig',
        examples: ['getPluginConfig', 'show plugin config', 'what is this plugin configured with']
      }
    ];
    
    // Plugin configuration
    this.config = {{PLUGIN_CONFIG}};
    
    // Plugin state
    this.initialized = false;
    this.cache = new Map();
  }
  
  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);
    
    try {
      // Load cached configuration
      const savedConfig = await PluginSettings.getCached(this.name, 'config');
      if (savedConfig) {
        Object.assign(this.config, savedConfig);
        this.logger.info('Loaded cached configuration');
      }
      
      {{PLUGIN_INITIALIZE}}
      
      // Save initial configuration
      await PluginSettings.setCached(this.name, 'config', this.config);
      
      this.initialized = true;
      this.logger.info(`${this.name} plugin initialized successfully`);
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.name} plugin:`, error);
      throw error;
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
    
    // Handle AI parameter extraction for vector-matched intents
    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput || params.input, action);
      Object.assign(data, extracted);
    }
    
    try {
      switch (action) {
        {{PLUGIN_HANDLERS}}
        case 'getPluginConfig':
          return this.getPluginConfig();
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    For {{PLUGIN_NAME}} plugin action: ${action}

    Return JSON with appropriate parameters based on the action.`;

    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });

    // Use safeJsonParse to avoid throwing on malformed JSON
    const parsed = safeJsonParse(response.content, {});
    if (!parsed || Object.keys(parsed).length === 0) {
      this.logger.warn('Failed to parse AI parameters from response');
    }
    return parsed;
  }
  
  async getAICapabilities() {
    // Return dynamic capabilities based on plugin state
    return {
      enabled: true,
      examples: this.commands.map(cmd => 
        `${cmd.command} using ${this.name}`
      )
    };
  }
  
  {{PLUGIN_METHODS}}
  
  /**
   * Example methods using PluginSettings for caching
   */
  async saveApiCredentials(credentials) {
    // Store sensitive API credentials with encryption
    await PluginSettings.setCached(this.name, 'apiCredentials', {
      apiKey: credentials.apiKey,
      endpoint: credentials.endpoint,
      lastUpdated: new Date()
    });
  }
  
  async getApiCredentials() {
    // Retrieve cached credentials with 10-minute TTL
    return await PluginSettings.getCached(this.name, 'apiCredentials', 600);
  }
  
  async saveUserPreference(userId, preferences) {
    // Store user-specific preferences
    await PluginSettings.setCached(this.name, `user_${userId}_prefs`, preferences);
  }
  
  async getUserPreference(userId) {
    // Get user preferences with default 5-minute cache
    return await PluginSettings.getCached(this.name, `user_${userId}_prefs`);
  }
  
  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.cache.clear();
    // Clear plugin-specific cache entries
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }
  
  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }

  /**
   * Web UI Integration - Optional menu item and page
   * Implement these methods if your plugin needs a web dashboard page
   */

  /**
   * Register menu item for web dashboard sidebar
   * @returns {Object} UI configuration with menuItem and hasUI flag
   */
  getUIConfig() {
    // Return null or omit this method if plugin doesn't need a web UI
    return {
      menuItem: {
        id: '{{PLUGIN_NAME}}',
        title: '{{PLUGIN_TITLE}}',  // Display name in sidebar
        icon: 'fas fa-puzzle-piece', // FontAwesome icon class
        order: 100,  // Position in menu (lower = higher)
        section: 'main'
      },
      hasUI: true
    };
  }

  /**
   * Return HTML content for plugin's web dashboard page
   * @returns {string} HTML string with styles, content, and scripts
   */
  getUIContent() {
    return `
      <style>
        /* Plugin-specific styles - auto-prefixed to avoid conflicts */
        .{{PLUGIN_NAME}}-card {
          background: var(--card-bg);
          border-radius: 8px;
          padding: 1.5rem;
          margin-bottom: 1rem;
        }
      </style>

      <div class="plugin-header">
        <h2>{{PLUGIN_TITLE}}</h2>
      </div>

      <div class="plugin-content">
        <div class="{{PLUGIN_NAME}}-card">
          <h3>Plugin Content</h3>
          <p>Add your plugin UI here</p>
        </div>
      </div>

      <script>
        // Plugin JavaScript - runs when tab is loaded
        (function() {
          const apiToken = localStorage.getItem('lanagent_token');

          async function callPluginAPI(action, data = {}) {
            const response = await fetch('/api/plugin', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + apiToken,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                plugin: '{{PLUGIN_NAME}}',
                action: action,
                ...data
              })
            });
            return response.json();
          }

          // Initialize plugin UI
          console.log('[{{PLUGIN_NAME}}] UI initialized');
        })();
      </script>
    `;
  }
}