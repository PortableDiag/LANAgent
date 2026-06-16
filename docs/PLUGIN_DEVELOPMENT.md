# LANAgent Plugin Development Guide

This guide provides comprehensive instructions for developing plugins for LANAgent. Plugins extend the agent's capabilities by adding new features, integrations, and commands.

## Table of Contents

1. [Plugin Architecture](#plugin-architecture)
2. [Creating a Plugin](#creating-a-plugin)
3. [Plugin Structure](#plugin-structure)
4. [Required Methods](#required-methods)
5. [Available Helper Methods](#available-helper-methods)
6. [Parameter Validation](#parameter-validation)
7. [State Management](#state-management)
8. [AI Intent Integration](#ai-intent-integration)
9. [Error Handling](#error-handling)
10. [Testing Plugins](#testing-plugins)
11. [Plugin Examples](#plugin-examples)
12. [Best Practices](#best-practices)
13. [Publishing Plugins](#publishing-plugins)

## Plugin Architecture

LANAgent uses a modular plugin system where each plugin:
- Extends the `BasePlugin` class
- Lives in `/src/api/plugins/` directory
- Is automatically loaded on startup if enabled
- Has access to all agent services and interfaces
- Can respond to natural language commands via AI intent detection

## Creating a Plugin

### Step 1: Create Plugin File

Create a new file in `/src/api/plugins/` with your plugin name:

```bash
touch /src/api/plugins/myplugin.js
```

### Step 2: Basic Plugin Structure

```javascript
import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';

export default class MyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'myplugin';          // Unique plugin identifier
    this.version = '1.0.0';           // Semantic versioning
    this.description = 'My awesome plugin that does X'; // Clear description

    // Commands array - automatically indexed for vector intent detection
    this.commands = [
      {
        command: 'action1',
        description: 'Perform the first action',
        usage: 'action1({ param: "value" })',
        examples: ['do action one', 'run the first action'],
        offerAsService: true  // Expose as a paid P2P service via Skynet
      },
      {
        command: 'action2',
        description: 'Perform the second action',
        usage: 'action2({ id: 123 })',
        examples: ['do action two on item 123'],
        offerAsService: true
      },
      {
        command: 'configure',
        description: 'Update plugin settings',
        usage: 'configure({ option: "value" })',
        offerAsService: false  // Internal/admin — never expose as paid service
      }
    ];

    // Plugin state
    this.config = {};
    this.initialized = false;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    // Load saved config from PluginSettings cache
    const savedConfig = await PluginSettings.getCached(this.name, 'config');
    if (savedConfig) {
      Object.assign(this.config, savedConfig);
    }

    // Setup code: validate config, test connections, etc.

    this.initialized = true;
    this.logger.info(`${this.name} plugin initialized`);
  }

  async execute(params) {
    const { action, ...data } = params;

    // Validate action against commands
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: this.commands.map(c => c.command)
      }
    });

    // Handle AI parameter extraction for natural language commands
    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'action1':
          return await this.doAction1(data);
        case 'action2':
          return await this.doAction2(data);
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    await PluginSettings.clearCache(this.name);
    this.initialized = false;
  }
}
```

## Plugin Structure

### Constructor

The constructor should:
- Call `super(agent)` first
- Set plugin metadata (name, version, description)
- Define the `commands` array (used for vector intent indexing and AI matching)
- Initialize plugin-specific properties
- NOT perform async operations (use `initialize()` instead)

```javascript
constructor(agent) {
  super(agent);
  this.name = 'myplugin';
  this.version = '1.0.0';
  this.description = 'Clear, concise description';

  // Commands for vector intent detection (required for NL matching)
  this.commands = [
    {
      command: 'search',
      description: 'Search for items by keyword',
      usage: 'search({ query: "term", limit: 10 })',
      examples: ['search for something', 'find items matching X']
    }
  ];

  // Plugin state
  this.config = {};
  this.initialized = false;
  this.client = null;
}
```

### Initialize Method

The `initialize()` method is called when the plugin is loaded and should:
- Load configuration from environment or database
- Establish connections to external services
- Set up event listeners
- Perform async setup operations

```javascript
async initialize() {
  try {
    // Load configuration
    const apiKey = process.env.MYPLUGIN_API_KEY;
    if (!apiKey) {
      this.logger.warn('MyPlugin API key not configured');
      return;
    }
    
    // Connect to service
    this.client = new MyServiceClient(apiKey);
    await this.client.connect();
    
    // Load saved state
    const savedState = await this.loadState();
    if (savedState) {
      this.config = savedState.config;
    }
    
    this.logger.info('MyPlugin initialized successfully');
  } catch (error) {
    this.logger.error('MyPlugin initialization failed:', error);
    throw error;
  }
}
```

## Required Methods

### execute(params)

The main entry point for plugin actions:

```javascript
async execute(params) {
  const { action, ...data } = params;
  
  // Always validate parameters first
  this.validateParams(params, {
    action: {
      required: true,
      type: 'string',
      enum: this.getAvailableActions()
    }
  });
  
  // Handle actions
  try {
    switch (action) {
      case 'search':
        return await this.search(data);
      case 'create':
        return await this.create(data);
      case 'update':
        return await this.update(data);
      case 'delete':
        return await this.delete(data);
      default:
        return {
          success: false,
          error: `Unknown action: ${action}`
        };
    }
  } catch (error) {
    this.logger.error(`Action ${action} failed:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}
```

### commands Array (Constructor)

Define available commands as an array in the constructor. Each command object is automatically indexed for vector intent detection:

```javascript
// In constructor:
this.commands = [
  {
    command: 'search',         // Action name (used in execute switch)
    description: 'Search for items by keyword',  // Rich description for AI matching
    usage: 'search({ query: "term", limit: 10 })',  // Parameter format
    examples: [                // Natural language examples for better NL matching
      'search for widgets',
      'find items matching keyword'
    ]
  },
  {
    command: 'create',
    description: 'Create a new item with specified properties',
    usage: 'create({ name: "Widget", type: "basic" })',
    examples: ['create a new widget called Kitchen Timer']
  }
];
```

**Note:** The legacy `getCommands()` method (returning `{ 'action': 'description' }`) is still supported but the `commands` array is preferred as it enables vector intent indexing and natural language examples.

## Available Helper Methods

BasePlugin provides many useful methods:

### Notifications

```javascript
// Send notification to user
await this.notify('Operation completed successfully! ✅');

// With priority
await this.notify('⚠️ Warning: Low disk space', 'warning');
```

### Paid Service Flag (`offerAsService`)

Each command in your plugin's `this.commands` array can include an `offerAsService` boolean to control whether the command is exposed as a paid P2P service via the Skynet economy.

```javascript
this.commands = [
  {
    command: 'search',
    description: 'Search for data',
    offerAsService: true   // ← Exposed as paid P2P service
  },
  {
    command: 'configure',
    description: 'Update settings',
    offerAsService: false  // ← Internal only, never exposed
  }
];
```

**Rules:**
- `offerAsService: true` — command will appear in P2P service catalog when synced
- `offerAsService: false` — command will never appear, even if the plugin category is eligible
- **No flag set** — command will be included by default UNLESS it matches the server-side blocklist (admin actions, settings, version checks, destructive operations)

**Server-side blocklist** (automatically excluded regardless of flag):
- Settings/config operations: `configure`, `settings`, `updateSettings`, `setPreferences`, `getPreferences`
- Version/update operations: `version`, `update`, `upgrade`, `showVersion`
- Diagnostics: `status`, `health`, `ping`, `test`, `debug`, `stats`
- Destructive: `delete`, `remove`, `purge`, `clear`, `wipe`
- Pattern matches: anything matching "update/set/view...settings/config/preferences" or "update...yt-dlp/ffmpeg"

**Best practice:** Always set the flag explicitly on every command. This makes your intent clear and prevents surprises when the blocklist changes.

**Eligible plugin categories** (only these plugins can offer P2P services):
`anime`, `aviationstack`, `ffmpeg`, `here`, `huggingface`, `ipstack`, `lyrics`, `mediastack`, `music`, `nasa`, `news`, `numverify`, `scraper`, `weatherstack`, `websearch`, `whois`, `ytdlp`

Plugins outside these categories (e.g., system admin, email, crypto) are never exposed as P2P services regardless of the flag.

### Command Execution

```javascript
// Execute system command
const result = await this.executeCommand('ls -la');
console.log(result.output);

// With approval requirement
const dangerousCmd = await this.executeCommand('rm -rf temp/', true);
```

### Memory Storage

```javascript
// Store data
await this.storeMemory('last_search', searchResults, {
  category: 'search',
  expires: Date.now() + 3600000 // 1 hour
});

// Retrieve data
const lastSearch = await this.getMemory('last_search');

// Store in agent's general memory
await this.agent.memoryManager.remember(
  'The user prefers metric units',
  { category: 'preference', importance: 0.8 }
);
```

### AI Processing

```javascript
// Use AI to process text
const summary = await this.processWithAI(
  `Summarize this article in 2 sentences: ${articleText}`
);

// Generate content
const email = await this.processWithAI(
  `Write a professional email about ${topic}`
);
```

### State Management

```javascript
// Set plugin state (persisted)
this.setState('isConfigured', true);
this.setState('settings', { theme: 'dark', language: 'en' });

// Get state
const isConfigured = this.getState('isConfigured');
const settings = this.getState('settings');

// Save to database (for complex data)
await this.saveState({ 
  config: this.config,
  cache: Array.from(this.cache.entries())
});

// Load from database
const saved = await this.loadState();
```

### Access Other Services

```javascript
// Get other plugins
const emailPlugin = this.agent.apiManager.getPlugin('email');
const result = await emailPlugin.execute({
  action: 'send',
  to: 'user@example.com',
  subject: 'Alert from MyPlugin',
  text: 'Something important happened!'
});

// Access agent interfaces
const telegram = this.getInterface('telegram');
await telegram.sendMessage('Status update from MyPlugin');

// Access agent services  
const scheduler = this.getService('scheduler');
await scheduler.scheduleJob('myPlugin:dailyTask', '0 9 * * *', async () => {
  await this.performDailyTask();
});
```

## Parameter Validation

Always validate input parameters:

```javascript
async createItem(data) {
  // Validate parameters
  this.validateParams(data, {
    name: {
      required: true,
      type: 'string',
      minLength: 1,
      maxLength: 100
    },
    type: {
      required: true,
      type: 'string',
      enum: ['type1', 'type2', 'type3']
    },
    priority: {
      required: false,
      type: 'number',
      min: 1,
      max: 10
    },
    tags: {
      required: false,
      type: 'array',
      items: { type: 'string' }
    },
    metadata: {
      required: false,
      type: 'object'
    }
  });
  
  // Parameters are now validated
  // Proceed with logic...
}
```

### Validation Schema Options

```javascript
{
  fieldName: {
    required: true/false,        // Is field required?
    type: 'string',              // string, number, boolean, array, object
    enum: ['opt1', 'opt2'],      // Allowed values
    minLength: 1,                // For strings
    maxLength: 100,              // For strings
    min: 0,                      // For numbers
    max: 100,                    // For numbers
    pattern: /^[A-Z]+$/,         // Regex pattern
    items: { type: 'string' },   // For arrays
    properties: { ... }          // For nested objects
  }
}
```

## State Management

### Persistent State with Automatic Caching (Recommended)

LANAgent provides a built-in PluginSettings model with automatic caching using node-cache for optimal performance:

```javascript
import { PluginSettings } from '../../models/PluginSettings.js';

// Save configuration with automatic caching
async saveConfig(config) {
  this.config = config;
  // Cache is automatically updated when saved
  await PluginSettings.setCached(this.name, 'config', config);
  this.emit('configChanged', config);
}

// Load configuration with caching (5-minute default TTL)
async initialize() {
  const savedConfig = await PluginSettings.getCached(this.name, 'config');
  if (savedConfig) {
    this.config = savedConfig;
  }
}

// Store API credentials with custom TTL (10 minutes)
async saveApiCredentials(credentials) {
  await PluginSettings.setCached(this.name, 'apiCredentials', {
    apiKey: credentials.apiKey,
    endpoint: credentials.endpoint,
    lastRefresh: new Date()
  });
}

// Retrieve with custom TTL
const credentials = await PluginSettings.getCached(this.name, 'apiCredentials', 600);

// Clear all cached settings for your plugin
await PluginSettings.clearCache(this.name);

// Get cache statistics
const stats = PluginSettings.getCacheStats();
console.log(`Cache hits: ${stats.hits}, misses: ${stats.misses}`);
```

Benefits of PluginSettings caching:
- **Automatic cache invalidation** when settings are updated
- **Reduced database queries** for frequently accessed settings
- **Configurable TTL** for different types of data
- **Built-in encryption** for sensitive data (passwords, API keys)
- **Zero configuration** - just use getCached/setCached methods

### Legacy State Management (Still Supported)

```javascript
// Save configuration that persists across restarts
async saveConfig(config) {
  this.config = config;
  this.setState('config', config);
  this.emit('configChanged', config);
}

// Load on initialize
async initialize() {
  const savedConfig = this.getState('config');
  if (savedConfig) {
    this.config = savedConfig;
  }
}
```

### Temporary State (In-Memory Cache)

For in-memory caching with automatic TTL expiry, prefer `NodeCache` (already a project dependency):

```javascript
import NodeCache from 'node-cache';

// In constructor:
this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5-min TTL

// Usage:
this.cache.set('user:123', userData);          // Uses default TTL
this.cache.set('token', tokenData, 3600);      // Custom 1-hour TTL
const user = this.cache.get('user:123');       // Returns undefined if expired
this.cache.del('user:123');                    // Manual invalidation
this.cache.flushAll();                         // Clear all
```

**Note:** `new Map()` is still fine for simple key-value storage without TTL needs, but NodeCache is preferred when data should expire automatically.

## AI Intent Integration

LANAgent uses a sophisticated Vector Intent Detection system with OpenAI embeddings for semantic understanding of natural language commands.

### 1. Define Commands with Rich Metadata

Your plugin's `commands` array is automatically indexed for vector search:

```javascript
export default class MyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'myplugin';
    this.description = 'Plugin for managing widgets';
    
    // Commands are automatically indexed for vector intent detection
    this.commands = [
      {
        command: 'create',
        description: 'Create a new widget',
        usage: 'create({ name: "Widget Name", type: "basic" })'
      },
      {
        command: 'list',
        description: 'List all widgets with optional filtering',
        usage: 'list({ type: "advanced", status: "active" })'
      },
      {
        command: 'control',
        description: 'Control widget state and settings',
        usage: 'control({ widget: "name", action: "activate", value: 100 })'
      }
    ];
  }
}
```

### 2. Implement getAICapabilities() for Dynamic Intents

For plugins with dynamic content (like device names), implement this method:

```javascript
async getAICapabilities() {
  // Return dynamic examples based on current state
  const widgets = await this.getWidgets();
  
  return {
    enabled: true,
    dynamicExamples: widgets.map(widget => ({
      plugin: this.name,
      action: 'control',
      example: `control the ${widget.name}`,
      description: `Control ${widget.name} (${widget.type})`
    })),
    // Static examples for when no widgets exist
    examples: [
      'create a new widget called Kitchen Timer',
      'list all active widgets',
      'deactivate the Living Room widget',
      'set Office Widget to maximum'
    ]
  };
}
```

### 3. Handle Natural Language Parameters

Vector intent detection will pass raw parameters that need AI extraction:

```javascript
async execute(params) {
  const { action, ...data } = params;
  
  // Vector detection sets this flag when parameters need extraction
  if (params.needsParameterExtraction && this.agent.providerManager) {
    const extractionPrompt = `Extract parameters from: "${params.originalInput}"
    For action: ${action}
    Expected format: { widget: "name", setting: "value" }`;
    
    const response = await this.agent.providerManager.generateResponse(extractionPrompt);
    const extracted = JSON.parse(response.content);
    Object.assign(data, extracted);
  }
  
  // Now process with extracted parameters
  return await this.performAction(action, data);
}
```

### 4. Vector Intent Indexing

**Important**: Currently, intent indexing is NOT automatic. After adding or modifying a plugin:

```bash
# Manually trigger reindexing via API
curl -X POST http://localhost/api/vector-intent/index \
  -H "X-API-Key: your-api-key"
```

### 5. Complete Example: Smart Device Plugin

```javascript
import { BasePlugin } from '../core/basePlugin.js';

export default class SmartDevicePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'smartdevice';
    this.version = '1.0.0';
    this.description = 'Control smart home devices with natural language';
    
    // Rich command definitions for vector indexing
    this.commands = [
      {
        command: 'power',
        description: 'Turn devices on or off',
        usage: 'power({ device: "Living Room Light", state: "on" })'
      },
      {
        command: 'brightness',
        description: 'Adjust device brightness',
        usage: 'brightness({ device: "Bedroom Lamp", level: 50 })'
      },
      {
        command: 'scene',
        description: 'Apply predefined scenes',
        usage: 'scene({ name: "Movie Night" })'
      }
    ];
    
    this.devices = new Map();
  }
  
  async initialize() {
    this.logger.info('SmartDevice plugin initializing...');
    await this.loadDevices();
  }
  
  // Provide dynamic capabilities based on current devices
  async getAICapabilities() {
    const devices = Array.from(this.devices.values());
    
    return {
      enabled: true,
      // Dynamic examples for each device
      dynamicExamples: devices.flatMap(device => [
        {
          plugin: this.name,
          action: 'power',
          example: `turn on the ${device.name}`,
          description: `Power control for ${device.name}`
        },
        {
          plugin: this.name,
          action: 'brightness',
          example: `dim the ${device.name} to 30%`,
          description: `Brightness control for ${device.name}`
        }
      ]),
      // General examples
      examples: [
        'turn off all lights',
        'set brightness to 50%',
        'activate movie night scene'
      ]
    };
  }
  
  async execute(params) {
    const { action, ...data } = params;
    
    // Handle parameter extraction for vector-matched intents
    if (params.needsParameterExtraction) {
      const extracted = await this.extractParameters(params.originalInput, action);
      Object.assign(data, extracted);
    }
    
    switch (action) {
      case 'power':
        return await this.setPower(data);
      case 'brightness':
        return await this.setBrightness(data);
      case 'scene':
        return await this.applyScene(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  async extractParameters(input, action) {
    const prompt = `Extract parameters from: "${input}"
    Action: ${action}
    Available devices: ${Array.from(this.devices.keys()).join(', ')}
    
    Return JSON with appropriate parameters for the action.`;
    
    const response = await this.agent.providerManager.generateResponse(prompt, {
      temperature: 0.3,
      maxTokens: 200
    });
    
    return JSON.parse(response.content);
  }
  
  // Helper to resolve device names (supports aliases)
  async resolveDevice(name) {
    // Check for exact match
    if (this.devices.has(name)) {
      return this.devices.get(name);
    }
    
    // Check aliases
    const { DeviceAlias } = await import('../../models/DeviceAlias.js');
    const resolved = await DeviceAlias.resolveAlias(name, this.name);
    if (resolved && this.devices.has(resolved)) {
      return this.devices.get(resolved);
    }
    
    // Fuzzy match
    const nameLower = name.toLowerCase();
    for (const [deviceName, device] of this.devices) {
      if (deviceName.toLowerCase().includes(nameLower)) {
        return device;
      }
    }
    
    return null;
  }
}
```

### 6. Best Practices for Vector Intent Detection

1. **Rich Descriptions**: Write detailed command descriptions
2. **Meaningful Names**: Use descriptive action names
3. **Dynamic Content**: Implement getAICapabilities() for dynamic items
4. **Parameter Flexibility**: Design for natural language extraction
5. **Alias Support**: Consider implementing device/item aliases
6. **Error Messages**: Provide helpful suggestions when items aren't found

### 7. Testing Vector Intent Matching

```javascript
// Test how your plugin's intents match
async testIntentMatching() {
  const testPhrases = [
    'turn on the kitchen light',
    'make the bedroom dimmer',
    'switch off everything',
    'activate movie mode'
  ];
  
  for (const phrase of testPhrases) {
    const result = await vectorIntentDetector.detectIntent(phrase);
    this.logger.info(`"${phrase}" → ${result?.plugin}:${result?.action} (${result?.confidence})`);
  }
}
```

## Plugin-Specific Logging

Each plugin can create a dedicated log file in `logs/plugins/` using `createPluginLogger()`. This keeps plugin logs separate from the main activity log for easier debugging.

```javascript
import { createPluginLogger } from '../../utils/logger.js';

export default class MyPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'myplugin';
    // Creates logs/plugins/myplugin.log with same format as main logs
    this.pluginLogger = createPluginLogger('myplugin');
  }

  async execute(params) {
    this.pluginLogger.info('Processing request', { action: params.action });
    // Plugin-specific logs go to logs/plugins/myplugin.log
    // Errors still go to the main errors.log automatically
  }
}
```

Log files rotate at 10MB with 3 kept files. Use `this.pluginLogger` for plugin-specific debug output and `this.logger` (inherited from BasePlugin) for general activity logging.

## Error Handling

### Retry Logic for External APIs

Use the built-in `retryOperation` utility for external API calls that may fail transiently:

```javascript
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';

async fetchFromAPI(endpoint) {
  return await retryOperation(async () => {
    const response = await axios.get(`${this.config.baseUrl}${endpoint}`, {
      headers: { 'X-Api-Key': this.config.apiKey },
      timeout: 10000
    });
    return response.data;
  }, { retries: 3 });
}
```

### Proper Error Responses

```javascript
async riskyOperation(data) {
  try {
    // Validate first
    this.validateParams(data, { /* schema */ });

    // Try operation with retry
    const result = await retryOperation(() => this.externalAPI.call(data), { retries: 3 });
    
    // Success response
    return {
      success: true,
      data: result,
      message: 'Operation completed successfully'
    };
    
  } catch (error) {
    // Log full error internally
    this.logger.error('Operation failed:', error);
    
    // Return user-friendly error
    return {
      success: false,
      error: error.message || 'Operation failed',
      code: error.code || 'UNKNOWN_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
  }
}
```

### Graceful Degradation

```javascript
async initialize() {
  try {
    // Try primary connection
    await this.connectPrimary();
  } catch (error) {
    this.logger.warn('Primary connection failed, trying fallback...');
    try {
      // Try fallback
      await this.connectFallback();
    } catch (fallbackError) {
      this.logger.error('All connections failed');
      // Plugin can still load but with limited functionality
      this.setState('connectionStatus', 'offline');
    }
  }
}
```

## Testing Plugins

### Unit Test Example

```javascript
// __tests__/myplugin.test.js
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import MyPlugin from '../src/api/plugins/myplugin.js';

describe('MyPlugin', () => {
  let plugin;
  let mockAgent;
  
  beforeEach(() => {
    mockAgent = {
      config: { name: 'TestAgent' },
      memoryManager: {
        store: jest.fn(),
        recall: jest.fn()
      },
      systemExecutor: {
        execute: jest.fn()
      }
    };
    
    plugin = new MyPlugin(mockAgent);
  });
  
  test('initializes correctly', async () => {
    process.env.MYPLUGIN_API_KEY = 'test-key';
    await plugin.initialize();
    expect(plugin.isConnected).toBe(true);
  });
  
  test('validates parameters', () => {
    expect(() => {
      plugin.execute({ action: 'invalid' });
    }).toThrow();
  });
  
  test('searches successfully', async () => {
    const result = await plugin.execute({
      action: 'search',
      query: 'test'
    });
    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
  });
});
```

### Integration Test Example

```javascript
// Test with real agent
import { Agent } from '../src/core/agent.js';

test('plugin integrates with agent', async () => {
  const agent = new Agent();
  await agent.initialize();
  
  // Test natural language
  const response = await agent.processNaturalLanguage(
    'search for documentation in myplugin'
  );
  
  expect(response).toContain('results');
});
```

## Plugin Examples

### Simple Plugin (Weather)

```javascript
import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { retryOperation } from '../../utils/retryUtils.js';
import axios from 'axios';

export default class WeatherPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'weather';
    this.version = '1.0.0';
    this.description = 'Get weather information for any location';

    this.commands = [
      {
        command: 'current',
        description: 'Get current weather conditions for a location',
        usage: 'current({ location: "London" })',
        examples: ['what is the weather in London', 'current temperature in NYC']
      },
      {
        command: 'forecast',
        description: 'Get multi-day weather forecast for a location',
        usage: 'forecast({ location: "Tokyo", days: 5 })',
        examples: ['5 day forecast for Tokyo', 'will it rain tomorrow in Paris']
      }
    ];

    this.config = { apiKey: null, cacheTimeout: 600 };
    this.initialized = false;
  }

  async initialize() {
    const savedConfig = await PluginSettings.getCached(this.name, 'config');
    if (savedConfig) Object.assign(this.config, savedConfig);

    this.config.apiKey = this.config.apiKey || process.env.OPENWEATHER_API_KEY;
    if (!this.config.apiKey) {
      this.logger.warn('Weather API key not configured');
      return;
    }

    this.initialized = true;
    this.logger.info('Weather plugin initialized');
  }

  async execute(params) {
    const { action, ...data } = params;

    if (!this.initialized) {
      return { success: false, error: 'Weather service not configured' };
    }

    this.validateParams(params, {
      action: { required: true, type: 'string', enum: this.commands.map(c => c.command) }
    });

    if (params.needsParameterExtraction && this.agent.providerManager) {
      const extracted = await this.extractParameters(params.originalInput, action);
      Object.assign(data, extracted);
    }

    try {
      switch (action) {
        case 'current': return await this.getCurrentWeather(data);
        case 'forecast': return await this.getForecast(data);
        default: throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  async getCurrentWeather(data) {
    this.validateParams(data, {
      location: { required: true, type: 'string' }
    });

    // Check cache first
    const cacheKey = `weather_${data.location.toLowerCase()}`;
    const cached = await PluginSettings.getCached(this.name, cacheKey, this.config.cacheTimeout);
    if (cached) return { success: true, ...cached, cached: true };

    const weather = await retryOperation(async () => {
      const response = await axios.get(
        'https://api.openweathermap.org/data/2.5/weather',
        { params: { q: data.location, appid: this.config.apiKey, units: 'metric' } }
      );
      return response.data;
    }, { retries: 3 });

    const result = {
      location: weather.name,
      temperature: weather.main.temp,
      description: weather.weather[0].description,
      humidity: weather.main.humidity,
      wind: weather.wind
    };

    await PluginSettings.setCached(this.name, cacheKey, result);
    return { success: true, ...result };
  }
}
```

### Complex Plugin (Database)

```javascript
import { BasePlugin } from '../core/basePlugin.js';
import { MongoClient } from 'mongodb';

export default class DatabasePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'database';
    this.version = '1.0.0';
    this.description = 'MongoDB database operations';
    this.client = null;
    this.db = null;
  }
  
  async initialize() {
    try {
      const uri = process.env.CUSTOM_MONGODB_URI || process.env.MONGODB_URI;
      this.client = new MongoClient(uri);
      await this.client.connect();
      this.db = this.client.db('custom_data');
      this.logger.info('Database plugin connected');
    } catch (error) {
      this.logger.error('Database connection failed:', error);
    }
  }
  
  async cleanup() {
    if (this.client) {
      await this.client.close();
    }
  }
  
  async execute(params) {
    if (!this.db) {
      return { success: false, error: 'Database not connected' };
    }
    
    const { action, ...data } = params;
    
    switch (action) {
      case 'insert':
        return await this.insert(data);
      case 'find':
        return await this.find(data);
      case 'update':
        return await this.update(data);
      case 'delete':
        return await this.delete(data);
      case 'aggregate':
        return await this.aggregate(data);
      default:
        return { success: false, error: 'Unknown action' };
    }
  }
  
  async insert(data) {
    this.validateParams(data, {
      collection: { required: true, type: 'string' },
      document: { required: true, type: 'object' }
    });
    
    try {
      const collection = this.db.collection(data.collection);
      const result = await collection.insertOne({
        ...data.document,
        createdAt: new Date(),
        createdBy: 'agent'
      });
      
      await this.notify(`📝 Document inserted into ${data.collection}`);
      
      return {
        success: true,
        insertedId: result.insertedId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // ... more methods
}
```

## Web UI Requirements

### Plugin Toggle Confirmation

The Plugins page in the web UI includes a toggle switch to enable/disable each plugin. Because accidentally disabling a core plugin can break the bot, a confirmation modal **must** be shown before any plugin is toggled on or off.

- The confirmation is implemented as an in-page modal dialog (not `window.confirm()`, which browsers may silently suppress).
- The modal is defined in `index.html` as `#plugin-confirm-modal` and triggered by the `confirmPluginToggle()` method in `app.js`.
- If the user cancels, the toggle switch reverts to its previous state.
- The confirm button label and style change based on the action: "Enable" (primary) or "Disable" (danger).

**If you add new plugin management UI or toggle functionality, always wire it through the existing confirmation modal.** Do not use native `confirm()` or `alert()` dialogs — they are unreliable in modern browsers and embedded webviews.

## Best Practices

### 1. Configuration Management

```javascript
// Use environment variables for sensitive data
const apiKey = process.env.MYPLUGIN_API_KEY;

// Allow runtime configuration
async setConfig(data) {
  this.validateParams(data, {
    setting: { required: true, type: 'string' },
    value: { required: true }
  });
  
  this.config[data.setting] = data.value;
  await this.saveState({ config: this.config });
  
  return {
    success: true,
    message: `Setting '${data.setting}' updated`
  };
}
```

### 2. Rate Limiting

```javascript
// Implement rate limiting for API calls
class RateLimiter {
  constructor(maxCalls, timeWindow) {
    this.maxCalls = maxCalls;
    this.timeWindow = timeWindow;
    this.calls = [];
  }
  
  async checkLimit() {
    const now = Date.now();
    this.calls = this.calls.filter(time => now - time < this.timeWindow);
    
    if (this.calls.length >= this.maxCalls) {
      throw new Error('Rate limit exceeded');
    }
    
    this.calls.push(now);
  }
}

// In plugin
this.rateLimiter = new RateLimiter(60, 60000); // 60 calls per minute

async apiCall() {
  await this.rateLimiter.checkLimit();
  // Make API call
}
```

### 3. Caching

```javascript
// Use PluginSettings for persistent cached data
import { PluginSettings } from '../../models/PluginSettings.js';

// Store frequently accessed settings with automatic caching
await PluginSettings.setCached(this.name, 'weatherCache', {
  [location]: weatherData,
  lastUpdated: Date.now()
});

// Retrieve with custom TTL (10 minutes)
const cachedWeather = await PluginSettings.getCached(this.name, 'weatherCache', 600);
if (cachedWeather && cachedWeather[location]) {
  return cachedWeather[location];
}

// For temporary in-memory caching, use NodeCache (preferred over Map)
import NodeCache from 'node-cache';

// In constructor:
this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Helper for cache-or-fetch pattern
async getCachedData(key, fetchFunction, ttl = 300) {
  const cached = this.cache.get(key);
  if (cached !== undefined) return cached;

  const fresh = await fetchFunction();
  this.cache.set(key, fresh, ttl);
  return fresh;
}

// Usage example combining both approaches
async getWeather(location) {
  // First check PluginSettings cache (persistent)
  const settings = await PluginSettings.getCached(this.name, 'weatherData', 600);
  if (settings && settings[location]) {
    return settings[location];
  }
  
  // Then check memory cache (temporary)
  const memCached = await this.getCachedData(
    `weather:${location}`,
    () => this.fetchWeatherFromAPI(location),
    600000 // 10 minutes
  );
  
  // Store in PluginSettings for persistence
  await PluginSettings.setCached(this.name, 'weatherData', {
    ...settings,
    [location]: memCached
  });
  
  return memCached;
}
```

### 4. Logging

```javascript
// Use appropriate log levels
this.logger.debug('Detailed debug information');
this.logger.info('Normal operation information');
this.logger.warn('Warning - non-critical issue');
this.logger.error('Error occurred:', error);

// Structured logging
this.logger.info('API call completed', {
  action: 'search',
  duration: endTime - startTime,
  resultCount: results.length
});
```

### 5. Security

```javascript
// Validate and sanitize all inputs
import { sanitizeString, sanitizePath } from '../../utils/validation.js';

async readFile(data) {
  // Sanitize path to prevent directory traversal
  const safePath = sanitizePath(data.path);
  
  // Validate against whitelist
  if (!this.isPathAllowed(safePath)) {
    throw new Error('Access denied');
  }
  
  // Proceed safely
  return await fs.readFile(safePath, 'utf-8');
}

// Never expose sensitive data
async getStatus() {
  return {
    connected: this.isConnected,
    version: this.version,
    // DON'T include: apiKey, passwords, tokens
  };
}
```

## Publishing Plugins

### 1. Documentation

Create a README.md for your plugin:

```markdown
# MyPlugin for LANAgent

Description of what your plugin does.

## Installation

1. Copy `myplugin.js` to `/src/api/plugins/`
2. Set environment variables:
   ```bash
   export MYPLUGIN_API_KEY=your-api-key
   ```
3. Restart LANAgent

## Configuration

- `MYPLUGIN_API_KEY` - Required. API key for service
- `MYPLUGIN_TIMEOUT` - Optional. Request timeout (default: 5000ms)

## Commands

- `search <query>` - Search for items
- `create <name>` - Create new item
- `configure <setting> <value>` - Update configuration

## Examples

Natural language commands:
- "Search for documentation in myplugin"
- "Create a new project called Website"
- "Configure myplugin timeout to 10 seconds"

## Error Codes

- `AUTH_FAILED` - Invalid API key
- `RATE_LIMITED` - Too many requests
- `NOT_FOUND` - Resource not found
```

### 2. Package Structure

```
myplugin/
├── myplugin.js           # Main plugin file
├── README.md             # Documentation
├── package.json          # Dependencies
├── __tests__/           
│   └── myplugin.test.js  # Tests
└── examples/
    └── usage.js          # Example usage
```

### 3. Testing Checklist

Before publishing, ensure:

- [ ] All actions work correctly
- [ ] Parameter validation is comprehensive
- [ ] Error handling is graceful
- [ ] Memory/connections are cleaned up properly
- [ ] Natural language commands work
- [ ] Documentation is complete
- [ ] No hardcoded secrets
- [ ] Rate limiting is implemented (if using external APIs)
- [ ] Caching is used appropriately
- [ ] Logs use appropriate levels
- [ ] Plugin toggle confirmation works (in-page modal, not native confirm())

### 4. Submitting to LANAgent

1. Fork the LANAgent repository
2. Add your plugin to `/src/api/plugins/`
3. Update `/docs/AVAILABLE_PLUGINS.md`
4. Create a pull request with:
   - Plugin file(s)
   - Tests
   - Documentation
   - Example usage

## Conclusion

Plugins are the primary way to extend LANAgent's capabilities. By following this guide and best practices, you can create robust, secure, and user-friendly plugins that integrate seamlessly with the agent's natural language interface.

For more examples, check the existing plugins in `/src/api/plugins/`. Each demonstrates different patterns and integrations that you can learn from and adapt for your own plugins.