import { EventEmitter } from 'events';
import { logger, pluginLogger } from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * API Manager - Handles dynamic loading and management of API plugins
 */
export class APIManager extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.apis = new Map();
    this.apiPath = path.join(__dirname, '..', 'plugins');
    this.initialized = false;
    this.defaultTimeout = 30000; // Default timeout for plugin execution in ms
  }

  async initialize() {
    try {
      logger.info('Initializing API Manager...');
      
      // Create plugins directory if it doesn't exist
      await fs.mkdir(this.apiPath, { recursive: true });
      
      // Load all API plugins
      await this.loadAllPlugins();
      
      this.initialized = true;
      pluginLogger.info(`API Manager initialized with ${this.apis.size} plugins`);
    } catch (error) {
      logger.error('Failed to initialize API Manager:', error);
      throw error;
    }
  }

  async loadAllPlugins() {
    try {
      const files = await fs.readdir(this.apiPath);
      const pluginFiles = files.filter(f => 
        f.endsWith('.js') && 
        !f.includes('templates') && 
        !f.includes('template') &&
        !f.includes('-enhancements') &&
        !f.includes('-advanced') &&
        !f.includes('-helper') &&
        !f.includes('-providers')
      );
      
      for (const file of pluginFiles) {
        try {
          await this.loadPlugin(file);
        } catch (error) {
          pluginLogger.error(`Failed to load plugin ${file}:`, error);
        }
      }
    } catch (error) {
      logger.warn('No plugins directory found, creating it...');
      await fs.mkdir(this.apiPath, { recursive: true });
    }
  }

  async loadPlugin(filename) {
    const pluginPath = path.join(this.apiPath, filename);
    const pluginName = path.basename(filename, '.js');
    
    try {
      // Dynamic import of the plugin
      const module = await import(pluginPath);
      const PluginClass = module.default || module[Object.keys(module)[0]];
      
      if (!PluginClass || typeof PluginClass !== 'function') {
        throw new Error(`Invalid plugin export in ${filename}`);
      }
      
      // Create instance of the plugin
      const plugin = new PluginClass(this.agent);
      
      // Validate plugin interface
      if (!plugin.name || !plugin.version || !plugin.execute) {
        throw new Error(`Plugin ${filename} missing required properties (name, version, execute)`);
      }
      
      // Initialize plugin if it has an init method
      if (plugin.initialize) {
        try {
          await plugin.initialize();
        } catch (initError) {
          // If only missing credentials, register as disabled so users can add keys via UI
          if (initError.message.includes('Missing required credentials')) {
            this.apis.set(plugin.name, {
              instance: plugin,
              filename: filename,
              loaded: Date.now(),
              enabled: false,
              calls: 0,
              errors: 0,
              lastError: initError.message,
              lastCall: null,
              timeout: plugin.timeout || this.defaultTimeout,
              error: initError.message
            });
            pluginLogger.warn(`Plugin ${plugin.name} v${plugin.version} registered (disabled — ${initError.message}). Add credentials via Settings.`);
            return;
          }
          throw initError;
        }
      }

      // Register the plugin
      this.apis.set(plugin.name, {
        instance: plugin,
        filename: filename,
        loaded: Date.now(),
        enabled: true,
        calls: 0,
        errors: 0,
        lastError: null,
        lastCall: null,
        timeout: plugin.timeout || this.defaultTimeout
      });

      pluginLogger.info(`Loaded API plugin: ${plugin.name} v${plugin.version}`);
      this.emit('plugin:loaded', plugin.name);

    } catch (error) {
      logger.error(`Failed to load plugin ${filename}:`, error);
      throw error;
    }
  }

  async unloadPlugin(name) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }
    
    // Call cleanup if available
    if (plugin.instance.cleanup) {
      await plugin.instance.cleanup();
    }
    
    this.apis.delete(name);
    logger.info(`Unloaded plugin: ${name}`);
    this.emit('plugin:unloaded', name);
  }

  async reloadPlugin(name) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }
    
    const filename = plugin.filename;
    await this.unloadPlugin(name);
    await this.loadPlugin(filename);
    logger.info(`Reloaded plugin: ${name}`);
  }

  async executeAPI(name, method, params = {}) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      throw new Error(`API plugin ${name} not found`);
    }
    
    if (!plugin.enabled) {
      throw new Error(`API plugin ${name} is disabled`);
    }
    
    plugin.calls++;
    plugin.lastCall = Date.now();
    
    try {
      // Check if method exists
      if (!plugin.instance[method] && method !== 'execute') {
        throw new Error(`Method ${method} not found in plugin ${name}`);
      }
      
      // Execute the method with timeout protection
      const execution = method === 'execute'
        ? plugin.instance.execute(params)
        : plugin.instance[method](params);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timeout for ${name}.${method} (${plugin.timeout}ms)`)), plugin.timeout)
      );
      const result = await Promise.race([execution, timeout]);
      
      this.emit('plugin:executed', { name, method, success: true });
      return result;
      
    } catch (error) {
      plugin.errors++;
      plugin.lastError = {
        message: error.message,
        timestamp: Date.now(),
        method: method
      };
      
      logger.error(`API ${name}.${method} error:`, error);
      this.emit('plugin:error', { name, method, error });
      throw error;
    }
  }

  getPluginList() {
    const plugins = [];
    for (const [name, info] of this.apis) {
      plugins.push({
        name: name,
        enabled: info.enabled,
        version: info.instance.version,
        description: info.instance.description || 'No description',
        methods: this.getPluginMethods(info.instance),
        commands: info.instance.commands || [],
        stats: {
          calls: info.calls,
          errors: info.errors,
          uptime: Date.now() - info.loaded,
          lastCall: info.lastCall
        }
      });
    }
    return plugins;
  }

  getPluginMethods(plugin) {
    const methods = [];
    const proto = Object.getPrototypeOf(plugin);
    const propNames = Object.getOwnPropertyNames(proto);
    
    for (const prop of propNames) {
      if (prop !== 'constructor' && 
          prop !== 'initialize' && 
          prop !== 'cleanup' &&
          typeof plugin[prop] === 'function') {
        methods.push({
          name: prop,
          description: plugin[`${prop}Description`] || 'No description'
        });
      }
    }
    
    return methods;
  }

  getPlugin(name) {
    const plugin = this.apis.get(name);
    return plugin ? plugin.instance : null;
  }

  hasPlugin(name) {
    return this.apis.has(name);
  }

  async enablePlugin(name) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }
    
    if (plugin.enabled) {
      return { success: true, message: `Plugin ${name} is already enabled` };
    }
    
    plugin.enabled = true;
    logger.info(`Enabled plugin: ${name}`);
    this.emit('plugin:enabled', name);
    
    return { success: true, message: `Plugin ${name} enabled` };
  }

  async disablePlugin(name) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }
    
    if (!plugin.enabled) {
      return { success: true, message: `Plugin ${name} is already disabled` };
    }
    
    plugin.enabled = false;
    logger.info(`Disabled plugin: ${name}`);
    this.emit('plugin:disabled', name);
    
    return { success: true, message: `Plugin ${name} disabled` };
  }

  getPluginStatus(name) {
    const plugin = this.apis.get(name);
    if (!plugin) {
      return null;
    }
    
    return {
      name: name,
      enabled: plugin.enabled,
      version: plugin.instance.version,
      description: plugin.instance.description,
      stats: {
        calls: plugin.calls,
        errors: plugin.errors,
        uptime: Date.now() - plugin.loaded,
        lastCall: plugin.lastCall
      }
    };
  }

  // Create a new plugin from template
  async createPlugin(name, template = 'basic') {
    const filename = `${name}.js`;
    const filepath = path.join(this.apiPath, filename);
    
    // Check if plugin already exists
    let exists = false;
    try {
      await fs.access(filepath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`Plugin ${name} already exists`);
    }
    
    // Generate plugin code based on template
    const pluginCode = this.generatePluginTemplate(name, template);
    
    // Write the plugin file
    await fs.writeFile(filepath, pluginCode, 'utf8');
    
    // Load the new plugin
    await this.loadPlugin(filename);
    
    logger.info(`Created and loaded new plugin: ${name}`);
    return this.getPlugin(name);
  }

  generatePluginTemplate(name, template) {
    const className = name.charAt(0).toUpperCase() + name.slice(1) + 'Plugin';
    
    const templates = {
      basic: `import { BasePlugin } from '../core/basePlugin.js';

export default class ${className} extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = '${name}';
    this.version = '1.0.0';
    this.description = '${name} API plugin';
  }

  async execute(params) {
    // Main execution logic here
    return {
      success: true,
      message: 'Plugin executed successfully',
      data: params
    };
  }

  // Add more methods as needed
  async customMethod(params) {
    return {
      success: true,
      result: 'Custom method result'
    };
  }
}`,

      service: `import { BasePlugin } from '../core/basePlugin.js';

export default class ${className} extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = '${name}';
    this.version = '1.0.0';
    this.description = '${name} service plugin';
    this.running = false;
  }

  async initialize() {
    // Setup code here
    this.logger.info(\`\${this.name} plugin initialized\`);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.logger.info(\`\${this.name} service started\`);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.logger.info(\`\${this.name} service stopped\`);
  }

  async execute(params) {
    const { action } = params;
    
    switch (action) {
      case 'start':
        return await this.start();
      case 'stop':
        return await this.stop();
      case 'status':
        return { running: this.running };
      default:
        throw new Error(\`Unknown action: \${action}\`);
    }
  }

  async cleanup() {
    await this.stop();
  }
}`
    };
    
    return templates[template] || templates.basic;
  }
}

// Export singleton instance factory
export function createAPIManager(agent) {
  return new APIManager(agent);
}