import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import mqtt from 'mqtt';
import { v4 as uuidv4 } from 'uuid';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';
import { GoveeEnhancements, GroupManagement } from './govee-enhancements.js';
import { GoveeAdvanced, ScheduleManagement } from './govee-advanced.js';

export default class GoveePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'govee';
    this.version = '1.0.0';
    this.description = 'Control and manage Govee smart home devices';
    this.commands = [
      {
        command: 'list',
        description: 'List all Govee devices',
        usage: 'list()',
        examples: ['list govee devices', 'show all govee lights', 'what govee devices do I have']
      },
      {
        command: 'status',
        description: 'Get device status',
        usage: 'status({ device: "device-id" })',
        examples: ['check living room light status', 'what is the status of bedroom light', 'is the kitchen light on']
      },
      {
        command: 'control',
        description: 'Control device capabilities',
        usage: 'control({ device: "device-id", capability: "on_off", value: 1 })',
        examples: ['control living room light capability', 'set bedroom light capability']
      },
      {
        command: 'power',
        description: 'Turn device on/off or toggle its power state',
        usage: 'power({ device: "device-id", state: "on|off|toggle" })',
        examples: ['turn on living room light', 'turn off bedroom light', 'switch on kitchen light', 'switch off bathroom light', 'turn on the living room right light', 'turn off the living room left light', 'power on desk lamp', 'power off ceiling fan', 'turn on master toilet light', 'turn on the toilet light', 'switch on toilet lights', 'turn on bathroom lights', 'toggle the master toilet light', 'toggle my lights']
      },
      {
        command: 'brightness',
        description: 'Set device brightness',
        usage: 'brightness({ device: "device-id", level: 50 })',
        examples: ['set living room light brightness to 80', 'make bedroom light brighter', 'dim the kitchen lights', 'brightness 50 for desk lamp']
      },
      {
        command: 'color',
        description: 'Set device color',
        usage: 'color({ device: "device-id", r: 255, g: 0, b: 0 })',
        examples: ['make living room light red', 'set bedroom light to blue', 'change kitchen light color to green', 'make the lights purple', 'turn my master toilet light green', 'turn the bedroom light blue', 'turn kitchen lights red', 'turn bathroom light purple', 'turn the light green', 'turn lights to blue color', 'turn my lights yellow', 'turn office light orange', 'set the master toilet light to bright white', 'set living room light to red', 'set the kitchen light to green', 'set my lights to purple', 'set all lights to white', 'set the light to warm white', 'set bathroom light to orange']
      },
      {
        command: 'temperature',
        description: 'Set color temperature',
        usage: 'temperature({ device: "device-id", kelvin: 5000 })',
        examples: ['make living room light warm', 'set cool white for bedroom light', 'change light temperature', 'warmer lighting in kitchen', 'set the light to 7k', 'set master toilet to cold white', 'set light to warm white', 'make it bright white', 'set to daylight', 'change to 5000k', 'set temperature to 6500 kelvin']
      },
      {
        command: 'scene',
        description: 'Apply a scene to device',
        usage: 'scene({ device: "device-id", scene: "Sunrise" })',
        examples: ['set sunset scene', 'apply sunrise scene to bedroom', 'activate party mode', 'use reading scene for desk lamp']
      },
      {
        command: 'scenes',
        description: 'Get available scenes for device',
        usage: 'scenes({ device: "device-id", sku: "device-sku" })',
        examples: ['what scenes are available', 'show me light scenes', 'list scenes for living room light']
      },
      {
        command: 'subscribe',
        description: 'Subscribe to device events',
        usage: 'subscribe({ devices: ["device-id"] })',
        examples: ['subscribe to device events', 'watch for device changes']
      },
      {
        command: 'unsubscribe',
        description: 'Unsubscribe from device events',
        usage: 'unsubscribe()',
        examples: ['unsubscribe from events', 'stop watching device changes']
      },
      {
        command: 'settings',
        description: 'Manage AI control settings',
        usage: 'settings({ aiControlEnabled: true })',
        examples: ['enable AI control', 'disable govee AI', 'change govee settings']
      },
      {
        command: 'group',
        description: 'Manage device groups',
        usage: 'group({ operation: "create|list|delete", name: "kitchen lights" })',
        examples: ['create kitchen lights group', 'list device groups', 'delete bedroom group']
      },
      {
        command: 'theme',
        description: 'Apply predefined themes',
        usage: 'theme({ device: "device-id", theme: "relax|party|movie|surprise" })',
        examples: ['set relax theme', 'surprise me with a theme', 'apply party theme to all lights']
      },
      {
        command: 'bulk',
        description: 'Control multiple devices at once',
        usage: 'bulk({ devices: "all|kitchen|bedroom", operation: "on|off|brightness", value: 50 })',
        examples: ['turn all lights on', 'set all kitchen lights to 50%', 'make the whole house bright']
      },
      {
        command: 'backup',
        description: 'Backup device settings and schedules',
        usage: 'backup({ type: "settings|schedules|all" })',
        examples: ['backup my govee settings', 'save device configurations', 'backup schedules']
      },
      {
        command: 'restore',
        description: 'Restore device settings from backup',
        usage: 'restore({ backup: backupData })',
        examples: ['restore govee settings', 'restore from backup']
      },
      {
        command: 'toggle',
        description: 'Toggle device features (nightlight, oscillation, etc.)',
        usage: 'toggle({ device: "device-id", feature: "nightlight|oscillation|air_deflector", state: "on|off" })',
        examples: ['enable nightlight mode', 'activate oscillation feature', 'toggle air deflector setting', 'switch nightlight feature on']
      },
      {
        command: 'segment',
        description: 'Control individual segments on light strips',
        usage: 'segment({ device: "device-id", segment: 0, color: { r: 255, g: 0, b: 0 }, brightness: 100 })',
        examples: ['set first segment to red', 'make segment 2 blue', 'dim segment 3']
      },
      {
        command: 'mode',
        description: 'Set device work mode',
        usage: 'mode({ device: "device-id", mode: "gear|fan|auto", value: 1 })',
        examples: ['set purifier to auto mode', 'change fan speed', 'set heater to high']
      },
      {
        command: 'schedules',
        description: 'Manage device schedules - create, update, delete, or list scheduled actions for smart home devices',
        usage: 'schedules({ operation: "list|create|update|delete", device: "device-name", time: "HH:MM", action: "on|off|color|brightness|scene", value: "color-name or level", repeat: "daily|weekdays|weekends|once" })',
        examples: [
          'list schedules', 'list my govee schedules',
          'create schedule for bedroom light at 7 PM',
          'set up a schedule for the kitchen lights to turn on at 7 PM daily',
          'schedule my toilet light to turn red at night',
          'turn off the bedroom lights at midnight on weekdays',
          'change my master toilet schedule to use red instead of blue',
          'edit the living room schedule to 8 PM instead of 7 PM',
          'instead of blue I want my toilet light to be red at night',
          'delete schedule for living room',
          'remove the kitchen light schedule'
        ]
      }
    ];

    // Initialize configuration
    this.config = {
      apiKey: process.env.GOVEE_API_KEY,
      baseUrl: 'https://openapi.api.govee.com/router/api/v1',
      baseUrlLegacy: 'https://developer-api.govee.com/v1', // For older endpoints
      mqttUrl: 'mqtts://mqtt.openapi.govee.com:8883',
      aiControlEnabled: true
    };

    // Device cache
    this.deviceCache = new Map();
    this.lastDeviceFetch = 0;
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes

    // MQTT client
    this.mqttClient = null;
    this.eventHandlers = new Map();

    // Rate limiting
    this.requestCount = 0;
    this.requestResetTime = Date.now() + 24 * 60 * 60 * 1000;
    this.maxRequests = 10000;
  }

  async initialize() {
    this.logger.info('Govee plugin initializing...');

    // Load persisted settings from database FIRST (config + credentials)
    await this.loadPersistedSettings();
    await this.loadStoredCredentials();

    if (!this.config.apiKey) {
      this.logger.error('Govee API key not configured. Please set GOVEE_API_KEY in your .env file or configure via settings');
      this.logger.info('Get your API key from: https://developer.govee.com/');
      return false;
    }

    this.logger.info('Govee plugin initialized with API key:', this.config.apiKey.substring(0, 8) + '...');
    this.logger.info('AI Control enabled:', this.config.aiControlEnabled);
    return true;
  }

  async execute(params) {
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['list', 'status', 'control', 'power', 'brightness', 'color', 
                'temperature', 'scene', 'scenes', 'subscribe', 'unsubscribe', 'settings',
                'group', 'theme', 'bulk', 'backup', 'restore', 'toggle', 'segment', 'mode', 'schedules']
      }
    });

    const { action } = params;

    // Check rate limiting
    if (!this.checkRateLimit()) {
      return {
        success: false,
        error: 'Rate limit exceeded. Please try again tomorrow.'
      };
    }

    try {
      switch (action) {
        case 'list':
          return await this.listDevices();
        case 'status':
          return await this.getDeviceStatus(params);
        case 'control':
          return await this.controlDevice(params);
        case 'power':
          return await this.setPower(params);
        case 'brightness':
          return await this.setBrightness(params);
        case 'color':
          return await this.setColor(params);
        case 'temperature':
          return await this.setTemperature(params);
        case 'scene':
          return await this.setScene(params);
        case 'scenes':
          return await this.getScenes(params);
        case 'subscribe':
          return await this.subscribeToEvents(params);
        case 'unsubscribe':
          return await this.unsubscribeFromEvents();
        case 'settings':
          return await this.updateSettings(params);
        case 'group':
          return await this.manageGroups(params);
        case 'theme':
          return await this.applyTheme(params);
        case 'bulk':
          return await this.bulkControl(params);
        case 'backup':
          return await this.backupSettings(params);
        case 'restore':
          return await this.restoreSettings(params);
        case 'toggle':
          return await this.toggleFeature(params);
        case 'segment':
          return await this.setSegmentColor(params);
        case 'mode':
          return await this.setWorkMode(params);
        case 'schedules':
          return await this.manageSchedules(params);
        default:
          return {
            success: false,
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      this.logger.error(`Govee plugin error in ${action}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  checkRateLimit() {
    // Reset counter if 24 hours have passed
    if (Date.now() > this.requestResetTime) {
      this.requestCount = 0;
      this.requestResetTime = Date.now() + 24 * 60 * 60 * 1000;
    }
    return this.requestCount < this.maxRequests;
  }

  async makeRequest(endpoint, method = 'GET', data = null, params = null) {
    this.requestCount++;
    
    let url = `${this.config.baseUrl}${endpoint}`;
    if (params) {
      const queryString = new URLSearchParams(params).toString();
      url = `${url}?${queryString}`;
    }
    
    const config = {
      method,
      url: url,
      headers: {
        'Govee-API-Key': this.config.apiKey,
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      config.data = {
        requestId: uuidv4(),
        payload: data
      };
    }

    this.logger.info(`Govee API Request: ${method} ${config.url}`);
    this.logger.debug('Request headers:', { 'Govee-API-Key': this.config.apiKey ? this.config.apiKey.substring(0, 8) + '...' : 'NOT SET' });
    if (data) {
      this.logger.info(`Request data: ${JSON.stringify(config.data)}`);
    }

    try {
      const response = await axios(config);
      
      this.logger.info(`Govee API Response: ${response.status}`);
      this.logger.debug(`Response data type: ${typeof response.data}`);
      this.logger.info(`Response data: ${JSON.stringify(response.data)}`);
      
      return response.data;
    } catch (error) {
      this.logger.error(`Govee API Request Error: ${error.message}`);
      if (error.response) {
        this.logger.error(`Response status: ${error.response.status}`);
        this.logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  async listDevices() {
    try {
      this.logger.info('listDevices called');
      
      // Check cache
      if (this.deviceCache.size > 0 && Date.now() - this.lastDeviceFetch < this.cacheTimeout) {
        this.logger.info(`Returning ${this.deviceCache.size} cached devices`);
        return {
          success: true,
          devices: Array.from(this.deviceCache.values()),
          cached: true
        };
      }

      this.logger.info('Fetching devices from Govee API...');

      const response = await this.makeRequest('/user/devices', 'GET');
      
      // Log the raw response for debugging
      this.logger.debug(`Raw devices response type: ${typeof response}`);
      this.logger.debug(`Raw devices response: ${JSON.stringify(response).substring(0, 500)}`);
      
      // Handle various response formats
      let devices = [];
      
      // If response is an array, it's the devices directly
      if (Array.isArray(response)) {
        devices = response;
      }
      // If response has a data property (standard Govee API response)
      else if (response && response.data && Array.isArray(response.data)) {
        devices = response.data;
        this.logger.info(`Govee API returned code ${response.code}: ${response.message}`);
      }
      // If response has a devices property
      else if (response && response.devices) {
        devices = response.devices;
      }
      // If response has numbered properties (weird format from earlier)
      else if (typeof response === 'object' && response['0'] === '[') {
        // Response is a string split into object properties
        const responseStr = Object.values(response).join('');
        this.logger.info('Govee response was in unusual format, reconstructing...');
        try {
          devices = JSON.parse(responseStr);
        } catch (e) {
          this.logger.error(`Failed to parse reconstructed response: ${e.message}`);
        }
      }
      
      this.logger.info(`Found ${devices.length} Govee devices`);
      
      // Log first few devices for debugging
      if (devices.length > 0) {
        this.logger.debug(`First device: ${devices[0].deviceName} (${devices[0].device})`);
        if (devices.length > 4) {
          this.logger.debug(`Fifth device: ${devices[4].deviceName} (${devices[4].device})`);
        }
      }
      
      // Update cache
      this.deviceCache.clear();
      devices.forEach(device => {
        this.deviceCache.set(device.device, device);
        this.logger.debug(`Cached device: ${device.deviceName} (${device.device})`);
      });
      this.lastDeviceFetch = Date.now();

      return {
        success: true,
        devices: devices,
        count: devices.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getDeviceStatus(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' }
    });

    // Resolve device name to ID if this is from AI
    let deviceId = params.device;
    if (params.fromAI) {
      const resolved = await this.resolveDeviceName(params.device);
      if (!resolved || (Array.isArray(resolved) && resolved.length === 0)) {
        return {
          success: false,
          error: `Device '${params.device}' not found. Please check the device name or try 'list devices' to see available devices.`,
          suggestion: 'You can also create an alias for this device for easier access.'
        };
      }
      // For status, just use the first device if multiple match
      deviceId = Array.isArray(resolved) ? resolved[0] : resolved;
    }

    // Check if SKU was provided directly
    let sku = params.sku;
    
    // If no SKU provided, try to get from cache
    if (!sku) {
      const cachedDevice = this.deviceCache.get(deviceId);
      if (cachedDevice && cachedDevice.sku) {
        sku = cachedDevice.sku;
      } else {
        this.logger.warn(`Device ${deviceId} not found in cache or missing SKU`);
        // Try to fetch devices again to update cache
        await this.listDevices();
        const updatedDevice = this.deviceCache.get(deviceId);
        if (updatedDevice && updatedDevice.sku) {
          sku = updatedDevice.sku;
        } else {
          return {
            success: false,
            status: { online: false },
            error: 'Device not found or missing SKU'
          };
        }
      }
    }

    try {
      const response = await this.makeRequest(`/device/state`, 'POST', {
        device: deviceId,
        sku: sku
      });

      // Parse the response - Govee returns data in payload
      const payload = response.payload || response;
      
      this.logger.info(`Device status response: ${JSON.stringify(payload)}`);
      
      const capabilities = payload.capabilities || [];
      
      // Find online status - check for 'online' instance
      const onlineStatus = capabilities.find(c => c.instance === 'online');
      let isOnline = true; // Default to online
      
      if (onlineStatus && onlineStatus.state) {
        isOnline = onlineStatus.state.value === true || onlineStatus.state.value === 1;
      }
      
      // Find power state
      const powerSwitch = capabilities.find(c => c.instance === 'powerSwitch');
      let powerValue = 0;
      
      if (powerSwitch && powerSwitch.state) {
        powerValue = powerSwitch.state.value;
        this.logger.info(`Power state for ${params.device}: ${powerValue}`);
      } else {
        this.logger.warn(`No powerSwitch found for ${params.device}`);
      }
      
      const isOn = powerValue === 1;

      return {
        success: true,
        status: {
          online: isOnline, // Will be true by default
          properties: [
            { on_off: isOn ? 1 : 0 }
          ]
        },
        capabilities: capabilities,
        _rawResponse: payload // For debugging
      };
    } catch (error) {
      return {
        success: false,
        status: {
          online: false
        },
        error: error.message
      };
    }
  }

  async controlDevice(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      capability: { required: true, type: 'string' },
      value: { required: true }
    });

    // Check AI control if this is from AI
    this.logger.info(`controlDevice params.fromAI: ${params.fromAI}, aiControlEnabled: ${this.config.aiControlEnabled}`);
    if (params.fromAI && !this.config.aiControlEnabled) {
      return {
        success: false,
        error: 'AI control is disabled. Enable it in the Govee settings.'
      };
    }

    // Resolve device name to ID if this is from AI
    let deviceIds = [params.device];
    if (params.fromAI) {
      this.logger.info(`Attempting to resolve device name: ${params.device}`);
      const resolved = await this.resolveDeviceName(params.device);
      if (!resolved || (Array.isArray(resolved) && resolved.length === 0)) {
        return {
          success: false,
          error: `Device '${params.device}' not found. Please check the device name or try 'list devices' to see available devices.`,
          suggestion: 'You can also create an alias for this device for easier access.'
        };
      }
      deviceIds = Array.isArray(resolved) ? resolved : [resolved];
    }

    // Handle multiple devices (e.g., when controlling "all")
    const results = [];
    const errors = [];
    
    for (const deviceId of deviceIds) {
      // Check if SKU was provided directly
      let sku = params.sku;
      
      // If no SKU provided, try to get from cache
      if (!sku) {
        const cachedDevice = this.deviceCache.get(deviceId);
        if (cachedDevice && cachedDevice.sku) {
          sku = cachedDevice.sku;
        } else {
          this.logger.warn(`Device ${deviceId} not found in cache for control`);
          // Try to fetch devices to update cache
          await this.listDevices();
          const updatedDevice = this.deviceCache.get(deviceId);
          if (updatedDevice && updatedDevice.sku) {
            sku = updatedDevice.sku;
          } else {
            errors.push(`Device ${deviceId} not found or missing SKU`);
            continue;
          }
        }
      }

      try {
        const response = await this.makeRequest(`/device/control`, 'POST', {
        device: deviceId,
        sku: sku,
        capability: {
          type: params.capability,
          instance: this.getCapabilityInstance(params.capability),
          value: params.value
        }
      });

        results.push({
          device: deviceId,
          success: true,
          response: response
        });
      } catch (error) {
        errors.push(`${deviceId}: ${error.message}`);
      }
    }

    // Return appropriate response based on results
    if (results.length === 0) {
      return {
        success: false,
        error: errors.join('; ')
      };
    } else if (deviceIds.length === 1) {
      // Single device - return simple response
      return results[0];
    } else {
      // Multiple devices - return summary
      return {
        success: errors.length === 0,
        controlled: results.length,
        total: deviceIds.length,
        results: results,
        errors: errors.length > 0 ? errors : undefined
      };
    }
  }

  getCapabilityInstance(capability) {
    const instances = {
      'devices.capabilities.on_off': 'powerSwitch',
      'devices.capabilities.range': 'brightness',
      'devices.capabilities.color_setting': 'colorRgb',
      'devices.capabilities.color_temperature_setting': 'colorTemperatureK',
      'devices.capabilities.dynamic_scene': 'lightScene',
      'devices.capabilities.music_setting': 'musicMode',
      'devices.capabilities.toggle': 'toggle',
      'devices.capabilities.segment_color_setting': 'segmentedColorRgb',
      'devices.capabilities.mode': 'mode',
      'devices.capabilities.work_mode': 'workMode'
    };
    return instances[capability] || capability;
  }

  async setPower(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      state: { required: true, type: 'string', enum: ['on', 'off', 'toggle'] }
    });

    this.logger.info(`setPower called with params:`, params);

    // Handle toggle by checking current device state
    let targetState = params.state;
    if (targetState === 'toggle') {
      try {
        const status = await this.getDeviceStatus({ device: params.device, fromAI: params.fromAI });
        if (status.success && status.status && status.status.properties) {
          const powerProp = status.status.properties.find(p => p.on_off !== undefined);
          const isCurrentlyOn = powerProp ? powerProp.on_off === 1 : false;
          targetState = isCurrentlyOn ? 'off' : 'on';
          this.logger.info(`Toggle: device '${params.device}' is currently ${isCurrentlyOn ? 'on' : 'off'}, switching to ${targetState}`);
        } else {
          // Default to 'on' if we can't determine current state
          targetState = 'on';
          this.logger.warn(`Toggle: could not determine state for '${params.device}', defaulting to 'on'`);
        }
      } catch (err) {
        targetState = 'on';
        this.logger.warn(`Toggle: error getting state for '${params.device}', defaulting to 'on': ${err.message}`);
      }
    }

    const result = await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.on_off',
      value: targetState === 'on' ? 1 : 0,
      fromAI: params.fromAI
    });

    // Format a user-friendly response
    if (result.success || (result.response && result.response.code === 200)) {
      const deviceName = params.fromAI ? params.device : result.device;
      return {
        success: true,
        message: `Successfully turned ${targetState} ${deviceName}`
      };
    } else {
      return {
        success: false,
        error: result.error || 'Failed to control device'
      };
    }
  }

  async setBrightness(params) {
    // Extract brightness level from various possible parameter names
    let level = params.level;
    
    // Check if brightness was provided instead of level
    if (!level && params.brightness) {
      // Handle percentage strings like "100%", "50%", etc.
      if (typeof params.brightness === 'string') {
        level = GoveeEnhancements.parsePercentage(params.brightness);
      } else {
        level = params.brightness;
      }
    }
    
    // Update params with the parsed level for validation
    const validationParams = { ...params, level };
    
    this.validateParams(validationParams, {
      device: { required: true, type: 'string' },
      level: { required: true, type: 'number', min: 1, max: 100 }
    });

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.range',
      value: level,
      fromAI: params.fromAI
    });
  }

  async setColor(params) {
    this.logger.info(`setColor called with params: ${JSON.stringify(params)}`);
    
    // First check if this is actually a temperature request
    if (params.color && !params.r) {
      const temperature = GoveeEnhancements.parseTemperature(params.color);
      if (temperature) {
        this.logger.info(`Detected temperature request: ${params.color} -> ${temperature}K`);
        // Redirect to setTemperature
        return await this.setTemperature({
          device: params.device,
          kelvin: temperature,
          fromAI: params.fromAI
        });
      }
      
      // Not a temperature, try parsing as color
      const colorRGB = GoveeEnhancements.parseColorName(params.color);
      if (colorRGB) {
        params.r = colorRGB.r;
        params.g = colorRGB.g;
        params.b = colorRGB.b;
        this.logger.info(`Parsed color '${params.color}' to RGB: ${JSON.stringify(colorRGB)}`);
      }
    }
    
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      r: { required: true, type: 'number', min: 0, max: 255 },
      g: { required: true, type: 'number', min: 0, max: 255 },
      b: { required: true, type: 'number', min: 0, max: 255 }
    });

    // Convert RGB to single integer value
    const colorValue = (params.r << 16) | (params.g << 8) | params.b;

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.color_setting',
      value: colorValue,
      fromAI: params.fromAI
    });
  }

  async setTemperature(params) {
    // Parse temperature from string if provided
    let kelvin = params.kelvin;
    
    // Check if temperature was provided as a string description
    if (!kelvin && params.temperature) {
      kelvin = GoveeEnhancements.parseTemperature(params.temperature);
    }
    
    // Update params with the parsed kelvin for validation
    const validationParams = { ...params, kelvin };
    
    this.validateParams(validationParams, {
      device: { required: true, type: 'string' },
      kelvin: { required: true, type: 'number', min: 2000, max: 9000 }
    });

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.color_temperature_setting',
      value: kelvin,
      fromAI: params.fromAI
    });
  }

  async setScene(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      scene: { required: true, type: 'string' }
    });

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.dynamic_scene',
      value: params.scene,
      fromAI: params.fromAI
    });
  }

  async getScenes(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      sku: { required: true, type: 'string' }
    });

    try {
      const allScenes = [];

      // Try to get light scenes (built-in scenes)
      try {
        const lightScenesResponse = await this.makeRequest(`/device/scenes`, 'POST', {
          device: params.device,
          sku: params.sku
        });

        if (lightScenesResponse.capabilities) {
          const lightScenes = lightScenesResponse.capabilities
            .filter(cap => cap.type === 'devices.capabilities.dynamic_scene')
            .flatMap(cap => {
              const options = cap.parameters?.options || [];
              return options.map(opt => ({
                name: opt.name,
                value: opt.value,
                instance: cap.instance || 'lightScene'
              }));
            });
          allScenes.push(...lightScenes);
        }
      } catch (lightErr) {
        this.logger.debug(`Light scenes not available: ${lightErr.message}`);
      }

      // Try to get DIY scenes (user-created scenes)
      try {
        const diyResponse = await this.makeRequest(`/device/diy-scenes`, 'POST', {
          device: params.device,
          sku: params.sku
        });

        if (diyResponse.capabilities) {
          const diyScenes = diyResponse.capabilities
            .filter(cap => cap.type === 'devices.capabilities.dynamic_scene')
            .flatMap(cap => {
              const options = cap.parameters?.options || [];
              return options.map(opt => ({
                name: opt.name,
                value: opt.value,
                instance: cap.instance || 'diyScene'
              }));
            });
          allScenes.push(...diyScenes);
        }
      } catch (diyErr) {
        this.logger.debug(`DIY scenes not available: ${diyErr.message}`);
      }

      return {
        success: true,
        scenes: allScenes
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async subscribeToEvents(params) {
    this.validateParams(params, {
      devices: { required: true, type: 'array' }
    });

    try {
      if (!this.mqttClient) {
        await this.connectMQTT();
      }

      const topics = params.devices.map(deviceId => `device/${deviceId}/state`);
      
      for (const topic of topics) {
        await new Promise((resolve, reject) => {
          this.mqttClient.subscribe(topic, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        this.logger.info(`Subscribed to Govee device events: ${topic}`);
      }

      return {
        success: true,
        subscribed: topics
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async connectMQTT() {
    const options = {
      username: this.config.apiKey,
      password: this.config.apiKey,
      rejectUnauthorized: false
    };

    this.mqttClient = mqtt.connect(this.config.mqttUrl, options);

    this.mqttClient.on('connect', () => {
      this.logger.info('Connected to Govee MQTT broker');
    });

    this.mqttClient.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        this.emit('device:update', {
          topic,
          data
        });
      } catch (error) {
        this.logger.error(`Failed to parse MQTT message: ${error.message}`);
      }
    });

    this.mqttClient.on('error', (error) => {
      this.logger.error(`MQTT Error: ${error.message}`);
    });
  }

  async unsubscribeFromEvents() {
    if (this.mqttClient) {
      this.mqttClient.end();
      this.mqttClient = null;
      return {
        success: true,
        message: 'Unsubscribed from all device events'
      };
    }
    return {
      success: true,
      message: 'No active subscriptions'
    };
  }

  async updateSettings(params) {
    if (params.aiControlEnabled !== undefined) {
      this.config.aiControlEnabled = params.aiControlEnabled;
      
      // Save to database
      await this.savePersistedSettings();
    }

    return {
      success: true,
      settings: {
        aiControlEnabled: this.config.aiControlEnabled
      }
    };
  }

  async resolveDeviceName(deviceName) {
    // Ensure we have fresh device list
    if (this.deviceCache.size === 0 || Date.now() - this.lastDeviceFetch > this.cacheTimeout) {
      await this.listDevices();
    }
    
    const deviceNameLower = deviceName.toLowerCase();
    
    // Handle special cases
    if (deviceNameLower === 'all' || deviceNameLower === 'all lights' || deviceNameLower === 'all devices') {
      return Array.from(this.deviceCache.keys());
    }
    
    // Check database for aliases first
    try {
      const { DeviceAlias } = await import('../../models/DeviceAlias.js');
      const resolvedName = await DeviceAlias.resolveAlias(deviceName, 'govee');
      if (resolvedName) {
        this.logger.info(`Resolved alias '${deviceName}' to '${resolvedName}'`);
        // Now look for the resolved name
        const resolvedNameLower = resolvedName.toLowerCase();
        for (const [deviceId, device] of this.deviceCache.entries()) {
          if (device.deviceName.toLowerCase() === resolvedNameLower) {
            return deviceId;
          }
        }
      }
    } catch (error) {
      this.logger.warn('Error checking device aliases:', error.message);
    }
    
    // Try exact match first (case insensitive)
    for (const [deviceId, device] of this.deviceCache.entries()) {
      if (device.deviceName.toLowerCase() === deviceNameLower) {
        return deviceId;
      }
    }
    
    // Try partial match
    for (const [deviceId, device] of this.deviceCache.entries()) {
      if (device.deviceName.toLowerCase().includes(deviceNameLower)) {
        return deviceId;
      }
    }
    
    // Try to match common patterns
    for (const [deviceId, device] of this.deviceCache.entries()) {
      const normalizedName = device.deviceName.toLowerCase()
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const normalizedSearch = deviceNameLower
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (normalizedName.includes(normalizedSearch)) {
        return deviceId;
      }
    }

    // Try matching after stripping common generic smart device words
    // e.g. "toilet light" → "toilet" which matches "Master Toilet"
    const genericWords = /\b(light|lights|lamp|lamps|bulb|bulbs|device|devices|smart|led|strip|strips)\b/gi;
    const strippedSearch = deviceNameLower.replace(genericWords, '').replace(/\s+/g, ' ').trim();
    if (strippedSearch && strippedSearch !== deviceNameLower) {
      for (const [deviceId, device] of this.deviceCache.entries()) {
        const devName = device.deviceName.toLowerCase();
        if (devName.includes(strippedSearch)) {
          this.logger.info(`Resolved '${deviceName}' to '${device.deviceName}' after stripping generic words`);
          return deviceId;
        }
      }
    }

    // Try word-overlap matching: check if any significant word from the search
    // term appears in a device name (for cases like "toilet light" → "Master Toilet")
    const searchWords = deviceNameLower.split(/\s+/).filter(w => w.length >= 3 && !w.match(genericWords));
    if (searchWords.length > 0) {
      let bestMatch = null;
      let bestOverlap = 0;
      for (const [deviceId, device] of this.deviceCache.entries()) {
        const devNameLower = device.deviceName.toLowerCase();
        const overlap = searchWords.filter(w => devNameLower.includes(w)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = { deviceId, deviceName: device.deviceName };
        }
      }
      if (bestMatch && bestOverlap > 0) {
        this.logger.info(`Resolved '${deviceName}' to '${bestMatch.deviceName}' via word-overlap matching (${bestOverlap} words matched)`);
        return bestMatch.deviceId;
      }
    }

    return null;
  }

  // New method: Manage device groups
  async manageGroups(params) {
    this.validateParams(params, {
      operation: { required: true, type: 'string', enum: ['create', 'list', 'delete', 'update', 'add_device', 'remove_device'] }
    });

    try {
      switch (params.operation) {
        case 'create':
          this.validateParams(params, {
            name: { required: true, type: 'string' },
            devices: { required: true, type: 'array' }
          });
          const group = await GroupManagement.createGroup(params.name, params.devices, params.description);
          return { success: true, group };

        case 'list':
          const groups = await GroupManagement.getGroups();
          return { success: true, groups };

        case 'delete':
          this.validateParams(params, { name: { required: true, type: 'string' } });
          await GroupManagement.deleteGroup(params.name);
          return { success: true, message: `Group '${params.name}' deleted` };

        case 'update':
          this.validateParams(params, { name: { required: true, type: 'string' } });
          const updated = await GroupManagement.updateGroup(params.name, params.updates);
          return { success: true, group: updated };

        default:
          return { success: false, error: `Unknown group operation: ${params.operation}` };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // New method: Apply themes
  async applyTheme(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      theme: { required: true, type: 'string' }
    });

    let selectedTheme;
    
    // Handle "surprise me" request
    if (params.theme === 'surprise' || params.theme === 'random') {
      const themeNames = Object.keys(GoveeEnhancements.themes);
      const randomIndex = Math.floor(Math.random() * themeNames.length);
      selectedTheme = GoveeEnhancements.themes[themeNames[randomIndex]];
      this.logger.info(`Surprise theme selected: ${selectedTheme.name}`);
    } else {
      selectedTheme = GoveeEnhancements.themes[params.theme];
      if (!selectedTheme) {
        return {
          success: false,
          error: `Unknown theme: ${params.theme}. Available themes: ${Object.keys(GoveeEnhancements.themes).join(', ')}`
        };
      }
    }

    // Apply theme settings
    const results = [];
    
    // Apply brightness if specified
    if (selectedTheme.brightness) {
      const brightResult = await this.setBrightness({
        device: params.device,
        level: selectedTheme.brightness,
        fromAI: params.fromAI
      });
      results.push({ setting: 'brightness', result: brightResult });
    }

    // Apply color if specified
    if (selectedTheme.color) {
      const colorResult = await this.setColor({
        device: params.device,
        ...selectedTheme.color,
        fromAI: params.fromAI
      });
      results.push({ setting: 'color', result: colorResult });
    }

    // Apply temperature if specified
    if (selectedTheme.temperature) {
      const tempResult = await this.setTemperature({
        device: params.device,
        kelvin: selectedTheme.temperature,
        fromAI: params.fromAI
      });
      results.push({ setting: 'temperature', result: tempResult });
    }

    // Apply scene if specified
    if (selectedTheme.scene) {
      const sceneResult = await this.setScene({
        device: params.device,
        scene: selectedTheme.scene,
        fromAI: params.fromAI
      });
      results.push({ setting: 'scene', result: sceneResult });
    }

    return {
      success: results.every(r => r.result.success),
      theme: selectedTheme.name,
      results
    };
  }

  // New method: Bulk device control
  async bulkControl(params) {
    this.validateParams(params, {
      devices: { required: true, type: 'string' },
      operation: { required: true, type: 'string', enum: ['on', 'off', 'brightness', 'color', 'temperature', 'theme'] }
    });

    // Resolve device group
    let deviceIds = [];
    
    // Check if it's a group name first
    const group = await GroupManagement.getGroup(params.devices);
    if (group) {
      deviceIds = group.devices.map(d => d.deviceId);
      this.logger.info(`Using device group '${params.devices}' with ${deviceIds.length} devices`);
    } else {
      // Try to resolve as a pattern
      const resolved = await this.resolveBulkDevices(params.devices);
      if (resolved && resolved.length > 0) {
        deviceIds = resolved;
      } else {
        return {
          success: false,
          error: `No devices found matching '${params.devices}'. Try 'all' for all devices, a group name, or a partial device name.`,
          availableGroups: await GroupManagement.getGroups().then(groups => groups.map(g => g.name))
        };
      }
    }

    // Execute bulk action
    const results = [];
    const errors = [];

    for (const deviceId of deviceIds) {
      try {
        let result;
        switch (params.operation) {
          case 'on':
          case 'off':
            result = await this.setPower({
              device: deviceId,
              state: params.operation,
              fromAI: params.fromAI
            });
            break;
          case 'brightness':
            result = await this.setBrightness({
              device: deviceId,
              level: params.value || 100,
              fromAI: params.fromAI
            });
            break;
          case 'color':
            result = await this.setColor({
              device: deviceId,
              r: params.r || 255,
              g: params.g || 255,
              b: params.b || 255,
              fromAI: params.fromAI
            });
            break;
          case 'temperature':
            result = await this.setTemperature({
              device: deviceId,
              kelvin: params.kelvin || 5000,
              fromAI: params.fromAI
            });
            break;
          case 'theme':
            result = await this.applyTheme({
              device: deviceId,
              theme: params.theme || 'relax',
              fromAI: params.fromAI
            });
            break;
        }
        
        if (result.success) {
          results.push({ device: deviceId, success: true });
        } else {
          errors.push({ device: deviceId, error: result.error });
        }
      } catch (error) {
        errors.push({ device: deviceId, error: error.message });
      }
    }

    return {
      success: errors.length === 0,
      total: deviceIds.length,
      succeeded: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  // Helper method: Resolve bulk device patterns
  async resolveBulkDevices(pattern) {
    // Ensure we have fresh device list
    if (this.deviceCache.size === 0 || Date.now() - this.lastDeviceFetch > this.cacheTimeout) {
      await this.listDevices();
    }

    // Use enhanced resolution from GoveeEnhancements
    const resolved = await GoveeEnhancements.resolveDeviceGroup(pattern, this.deviceCache);
    return resolved;
  }

  // Backup device settings and/or schedules
  async backupSettings(params) {
    this.validateParams(params, {
      type: { required: false, type: 'string', enum: ['settings', 'schedules', 'all'], default: 'all' }
    });

    const backupType = params.type || 'all';
    const result = {
      success: true,
      backups: {}
    };

    try {
      // Backup device settings
      if (backupType === 'settings' || backupType === 'all') {
        const devices = await this.listDevices();
        if (devices.success) {
          // Get current state for each device
          const deviceStates = [];
          for (const device of devices.devices) {
            try {
              const state = await this.getDeviceStatus({ 
                device: device.device, 
                sku: device.sku 
              });
              if (state.success) {
                // Add device ID and name to the state object
                state.device = device.device;
                state.deviceName = device.deviceName;
                deviceStates.push(state);
              }
            } catch (error) {
              this.logger.warn(`Failed to get state for device ${device.deviceName}:`, error);
            }
          }
          
          result.backups.settings = GoveeAdvanced.createBackup(deviceStates);
        }
      }

      // Backup schedules using Agenda
      if (backupType === 'schedules' || backupType === 'all') {
        try {
          result.backups.schedules = await ScheduleManagement.backupSchedules();
        } catch (error) {
          this.logger.warn('Schedule backup not available:', error.message);
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Restore device settings from backup
  async restoreSettings(params) {
    this.validateParams(params, {
      backup: { required: true, type: 'object' }
    });

    const backup = params.backup;
    let restoredCount = 0;
    const errors = [];

    try {
      // Restore device settings
      if (backup.devices) {
        const currentDevices = await this.listDevices();
        if (currentDevices.success) {
          const commands = GoveeAdvanced.generateRestoreCommands(
            backup, 
            currentDevices.devices
          );

          for (const cmd of commands) {
            try {
              const result = await this.controlDevice({
                device: cmd.device,
                capability: cmd.capability,
                value: cmd.value,
                fromAI: false
              });
              
              if (result.success) {
                restoredCount++;
              } else {
                errors.push(`${cmd.deviceName}: ${result.error}`);
              }
            } catch (error) {
              errors.push(`${cmd.deviceName}: ${error.message}`);
            }
          }
        }
      }

      // Restore schedules
      if (backup.schedules) {
        try {
          const scheduleResult = await ScheduleManagement.restoreSchedules(backup);
          if (scheduleResult.success) {
            restoredCount += scheduleResult.restoredCount;
          }
        } catch (error) {
          errors.push(`Schedules: ${error.message}`);
        }
      }

      return {
        success: errors.length === 0,
        restoredCount,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Toggle device features (nightlight, oscillation, etc.)
  async toggleFeature(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      feature: { required: true, type: 'string', enum: ['nightlight', 'oscillation', 'air_deflector'] },
      state: { required: true, type: 'string', enum: ['on', 'off'] }
    });

    // Map feature names to capability instances
    const featureMap = {
      'nightlight': 'nightlightToggle',
      'oscillation': 'oscillationToggle',
      'air_deflector': 'airDeflectorToggle'
    };

    const instance = featureMap[params.feature];
    const value = params.state === 'on' ? 1 : 0;

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.toggle',
      instance: instance,
      value: value,
      fromAI: params.fromAI
    });
  }

  // Control individual segments on light strips
  async setSegmentColor(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      segment: { required: false, type: 'number', default: 0 },
      color: { required: false, type: 'object' },
      brightness: { required: false, type: 'number', min: 0, max: 100 }
    });

    const segmentData = {
      segment: params.segment || 0
    };

    if (params.color) {
      this.validateParams(params.color, {
        r: { required: true, type: 'number', min: 0, max: 255 },
        g: { required: true, type: 'number', min: 0, max: 255 },
        b: { required: true, type: 'number', min: 0, max: 255 }
      });
      
      // Convert RGB to single value (0-16777215)
      segmentData.rgb = (params.color.r << 16) + (params.color.g << 8) + params.color.b;
    }

    if (params.brightness !== undefined) {
      segmentData.brightness = params.brightness;
    }

    return await this.controlDevice({
      device: params.device,
      capability: 'devices.capabilities.segment_color_setting',
      value: segmentData,
      fromAI: params.fromAI
    });
  }

  // Set device work mode (for appliances)
  async setWorkMode(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      mode: { required: true, type: 'string' },
      value: { required: false, type: 'number' }
    });

    // Get device info to check available modes
    const deviceId = this.resolveDeviceName(params.device);
    if (!deviceId) {
      return { success: false, error: 'Device not found' };
    }

    const device = this.deviceCache.get(deviceId);
    if (!device) {
      return { success: false, error: 'Device information not available' };
    }

    // Check if device supports work modes
    let capability = 'devices.capabilities.mode';
    if (params.mode === 'gear' || params.mode === 'fan' || params.mode === 'auto') {
      capability = 'devices.capabilities.work_mode';
    }

    return await this.controlDevice({
      device: params.device,
      capability: capability,
      instance: params.mode,
      value: params.value || 1,
      fromAI: params.fromAI
    });
  }

  async cleanup() {
    if (this.mqttClient) {
      this.mqttClient.end();
    }
  }

  async manageSchedules(params) {
    // AI schedule extraction uses 'deviceAction' to avoid collision with plugin dispatch 'action' field
    if (params.deviceAction) {
      params.action = params.deviceAction;
      delete params.deviceAction;
    }

    const { operation = 'list' } = params;

    switch (operation) {
      case 'list':
        return await this.listSchedules(params);
      case 'create':
        return await this.createSchedule(params);
      case 'delete':
        return await this.deleteSchedule(params);
      case 'update':
        return await this.updateSchedule(params);
      default:
        return {
          success: false,
          error: `Unknown schedule operation: ${operation}`
        };
    }
  }

  async listSchedules(params) {
    try {
      const schedules = await ScheduleManagement.listSchedules(params.device);
      return {
        success: true,
        schedules: schedules,
        count: schedules.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async createSchedule(params) {
    this.validateParams(params, {
      device: { required: true, type: 'string' },
      time: { required: true, type: 'string' },
      action: { required: true, type: 'string', enum: ['on', 'off', 'brightness', 'color', 'scene'] },
      repeat: { required: false, type: 'string', enum: ['once', 'daily', 'weekdays', 'weekends', 'custom'] },
      days: { required: false, type: 'array' },
      value: { required: false }
    });

    try {
      // Resolve device name
      let deviceId = params.device;
      let deviceName = params.device;
      
      // Check if the device param looks like a MAC address (contains colons)
      const looksLikeMac = params.device && params.device.includes(':');
      
      if (params.fromAI || looksLikeMac) {
        const resolved = await this.resolveDeviceName(params.device);
        if (!resolved || (Array.isArray(resolved) && resolved.length === 0)) {
          // If it's a MAC address, check the cache directly
          if (looksLikeMac && this.deviceCache.has(params.device)) {
            deviceId = params.device;
            const device = this.deviceCache.get(deviceId);
            deviceName = device.deviceName;
          } else {
            return {
              success: false,
              error: `Device '${params.device}' not found`
            };
          }
        } else {
          deviceId = Array.isArray(resolved) ? resolved[0] : resolved;
          
          // Get device name from cache
          const device = this.deviceCache.get(deviceId);
          if (device) {
            deviceName = device.deviceName;
          }
        }
      }

      const schedule = await ScheduleManagement.createSchedule({
        deviceId,
        deviceName,
        time: params.time,
        action: params.action,
        value: params.value,
        repeat: params.repeat || 'daily',
        days: params.days,
        enabled: params.enabled !== false
      });

      return {
        success: true,
        message: `Schedule created for ${deviceName}`,
        schedule
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deleteSchedule(params) {
    // If no scheduleId but device name is provided, find schedule by device
    if (!params.scheduleId && params.device) {
      try {
        const schedules = await ScheduleManagement.listSchedules();
        let targetName = params.device;
        if (params.fromAI) {
          const resolved = await this.resolveDeviceName(params.device);
          if (resolved) {
            const id = Array.isArray(resolved) ? resolved[0] : resolved;
            const dev = this.deviceCache.get(id);
            if (dev) targetName = dev.deviceName;
          }
        }
        const match = schedules.find(s =>
          s.deviceName?.toLowerCase().includes(targetName.toLowerCase())
        );
        if (match) {
          params.scheduleId = match.id;
          this.logger.info(`Resolved schedule for device '${params.device}' to scheduleId: ${match.id}`);
        } else {
          return {
            success: false,
            error: `No schedule found for device '${params.device}'. Use 'list schedules' to see existing schedules.`
          };
        }
      } catch (lookupError) {
        this.logger.error('Schedule lookup by device name failed:', lookupError.message);
      }
    }

    this.validateParams(params, {
      scheduleId: { required: true, type: 'string' }
    });

    try {
      await ScheduleManagement.deleteSchedule(params.scheduleId);
      return {
        success: true,
        message: 'Schedule deleted successfully'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateSchedule(params) {
    // If no scheduleId but device name is provided, find schedule by device
    if (!params.scheduleId && params.device) {
      try {
        const schedules = await ScheduleManagement.listSchedules();
        let targetName = params.device;
        if (params.fromAI) {
          const resolved = await this.resolveDeviceName(params.device);
          if (resolved) {
            const id = Array.isArray(resolved) ? resolved[0] : resolved;
            const dev = this.deviceCache.get(id);
            if (dev) targetName = dev.deviceName;
          }
        }
        const match = schedules.find(s =>
          s.deviceName?.toLowerCase().includes(targetName.toLowerCase())
        );
        if (match) {
          params.scheduleId = match.id;
          this.logger.info(`Resolved schedule for device '${params.device}' to scheduleId: ${match.id}`);
        } else {
          return {
            success: false,
            error: `No schedule found for device '${params.device}'. Use 'list schedules' to see existing schedules.`
          };
        }
      } catch (lookupError) {
        this.logger.error('Schedule lookup by device name failed:', lookupError.message);
      }
    }

    this.validateParams(params, {
      scheduleId: { required: true, type: 'string' }
    });

    try {
      const schedule = await ScheduleManagement.updateSchedule(params.scheduleId, params);
      return {
        success: true,
        message: 'Schedule updated successfully',
        schedule
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async loadPersistedSettings() {
    try {
      const record = await PluginSettings.findOne({
        pluginName: this.name,
        settingsKey: 'config'
      });
      
      if (record && record.settingsValue) {
        // Merge with defaults to ensure all properties exist
        this.config = { ...this.config, ...record.settingsValue };
        this.logger.info('Loaded persisted settings:', { aiControlEnabled: this.config.aiControlEnabled });
      }
    } catch (error) {
      this.logger.error(`Error loading persisted settings: ${error.message}`);
    }
  }

  async loadStoredCredentials() {
    try {
      const record = await PluginSettings.findOne({
        pluginName: this.name,
        settingsKey: 'credentials'
      });

      if (record && record.settingsValue && record.settingsValue.apiKey) {
        try {
          this.config.apiKey = decrypt(record.settingsValue.apiKey);
          this.logger.info('Loaded Govee API key from encrypted credentials store');
        } catch (decryptError) {
          this.logger.warn(`Failed to decrypt Govee API key: ${decryptError.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error loading stored credentials: ${error.message}`);
    }
  }

  async savePersistedSettings() {
    try {
      await PluginSettings.findOneAndUpdate(
        {
          pluginName: this.name,
          settingsKey: 'config'
        },
        {
          pluginName: this.name,
          settingsKey: 'config',
          settingsValue: {
            aiControlEnabled: this.config.aiControlEnabled
          }
        },
        {
          upsert: true,
          new: true
        }
      );
      this.logger.info('Saved persisted settings:', { aiControlEnabled: this.config.aiControlEnabled });
    } catch (error) {
      this.logger.error(`Error saving persisted settings: ${error.message}`);
    }
  }

  getIntents() {
    return [
      {
        intent: 'govee.list',
        examples: [
          'show govee devices',
          'list govee devices',
          'what govee devices do I have',
          'show my smart lights',
          'list my govee lights',
          'show govee bulbs'
        ],
        handler: async () => {
          return await this.execute({ action: 'list' });
        }
      },
      {
        intent: 'govee.power',
        examples: [
          'turn on the living room light',
          'turn off bedroom light',
          'switch on the lamp',
          'switch off all lights',
          'turn on all kitchen lights',
          'turn off the whole house',
          'switch on everything',
          'power on TV backlight',
          'kill the lights in the bedroom',
          'lights out everywhere',
          'activate all devices',
          'shut down all lights'
        ],
        handler: async (params) => {
          return await this.execute({ 
            action: 'power', 
            device: params.device, 
            state: params.state,
            fromAI: true 
          });
        }
      },
      {
        intent: 'govee.brightness',
        examples: [
          'dim the lights to 50%',
          'set brightness to 30',
          'make the lights brighter',
          'dim the bedroom light',
          'set all lights to 100%',
          'make the whole house bright',
          'set kitchen lights to 75 percent',
          'brighten up the living room',
          'lower the lights for movie time',
          'max brightness everywhere',
          'set mood lighting to 20%',
          'make it really dim in here'
        ],
        handler: async (params) => {
          this.logger.info(`Brightness handler called with params: ${JSON.stringify(params)}`);
          
          // Extract brightness level from various possible parameter names
          let level = params.level;
          
          // Check if brightness was extracted as "brightness" instead of "level"
          if (!level && params.brightness) {
            // Handle percentage strings like "100%", "50%", etc.
            if (typeof params.brightness === 'string') {
              level = GoveeEnhancements.parsePercentage(params.brightness);
              this.logger.info(`Parsed brightness percentage: ${params.brightness} -> ${level}`);
            } else {
              level = params.brightness;
            }
          }
          
          // Fall back to parsing from original input if needed
          if (!level && params.originalInput) {
            level = GoveeEnhancements.parsePercentage(params.originalInput);
            this.logger.info(`Parsed level from originalInput: ${params.originalInput} -> ${level}`);
          }
          
          this.logger.info(`Final level value: ${level}`);
          
          // Check if this is a bulk operation
          if (params.device && (params.device.includes('all') || params.device.includes('whole house'))) {
            return await this.execute({
              action: 'bulk',
              devices: params.device,
              operation: 'brightness',
              value: level || 100,
              fromAI: true
            });
          }
          return await this.execute({ 
            action: 'brightness', 
            device: params.device, 
            level: level,
            fromAI: true 
          });
        }
      },
      {
        intent: 'govee.color',
        examples: [
          'change the light to red',
          'set the color to blue',
          'make the lights green',
          'change bedroom light to purple',
          'paint the room orange',
          'set mood to pink',
          'make everything warm white',
          'cool blue for the office',
          'rainbow colors please',
          'turn my master toilet light green',
          'turn the bedroom light blue',
          'turn kitchen lights red',
          'turn bathroom light purple',
          'turn the light green',
          'turn lights to blue color',
          'turn my lights yellow',
          'turn office light orange',
          'set the master toilet light to bright white',
          'set living room light to red',
          'set bedroom lights to blue',
          'set the kitchen light to green',
          'set my lights to purple',
          'set all lights to white',
          'set the light to warm white',
          'set bathroom light to orange',
          'set the lights to yellow',
          'set office light to pink'
        ],
        handler: async (params) => {
          // Check if color name was provided instead of RGB
          if (params.color && !params.r) {
            const colorRGB = GoveeEnhancements.parseColorName(params.color);
            if (colorRGB) {
              params.r = colorRGB.r;
              params.g = colorRGB.g;
              params.b = colorRGB.b;
            }
          }
          
          // If still no RGB values, try to extract from original input
          if (!params.r && params.originalInput) {
            // Check for color names in the input
            const colorWords = Object.keys(GoveeEnhancements.colorNames);
            for (const colorName of colorWords) {
              if (params.originalInput.toLowerCase().includes(colorName)) {
                const colorRGB = GoveeEnhancements.colorNames[colorName];
                params.r = colorRGB.r;
                params.g = colorRGB.g;
                params.b = colorRGB.b;
                break;
              }
            }
          }
          
          return await this.execute({ 
            action: 'color', 
            device: params.device, 
            r: params.r || 255, 
            g: params.g || 255, 
            b: params.b || 255,
            fromAI: true 
          });
        }
      },
      {
        intent: 'govee.scene',
        examples: [
          'set the lights to sunrise',
          'apply movie scene',
          'change to party mode',
          'set romantic scene',
          'activate rainbow effect',
          'switch to candlelight',
          'enable disco lights',
          'set ocean waves pattern',
          'turn on fireplace mode'
        ],
        handler: async (params) => {
          // First get scenes if not provided
          if (!params.scene && params.device) {
            const device = this.deviceCache.get(params.device);
            if (device) {
              const scenesResult = await this.execute({ 
                action: 'scenes', 
                device: params.device, 
                sku: device.sku 
              });
              // Try to match scene name
              if (scenesResult.success && scenesResult.scenes.length > 0) {
                const sceneOptions = scenesResult.scenes[0].options || [];
                const matchedScene = sceneOptions.find(s => 
                  s.name.toLowerCase().includes(params.sceneName.toLowerCase())
                );
                if (matchedScene) {
                  params.scene = matchedScene.value;
                }
              }
            }
          }
          return await this.execute({ 
            action: 'scene', 
            device: params.device, 
            scene: params.scene,
            fromAI: true 
          });
        }
      },
      {
        intent: 'govee.theme',
        examples: [
          'surprise me with a theme',
          'set relax theme',
          'apply party theme to all lights',
          'make it romantic',
          'movie time theme',
          'energize the room',
          'create a cozy atmosphere',
          'set the mood for sleep',
          'make it feel like a spa',
          'transform into a nightclub',
          'give me something different'
        ],
        handler: async (params) => {
          // Map common phrases to themes
          let theme = params.theme;
          if (params.originalInput) {
            const input = params.originalInput.toLowerCase();
            if (input.includes('surprise') || input.includes('random')) theme = 'surprise';
            else if (input.includes('relax')) theme = 'relax';
            else if (input.includes('romantic')) theme = 'romance';
            else if (input.includes('party')) theme = 'party';
            else if (input.includes('movie')) theme = 'movie';
            else if (input.includes('energize')) theme = 'energize';
            else if (input.includes('sleep')) theme = 'sleep';
            else if (input.includes('focus') || input.includes('work')) theme = 'focus';
          }
          
          if (params.device && params.device.includes('all')) {
            return await this.execute({
              action: 'bulk',
              devices: params.device,
              operation: 'theme',
              theme: theme,
              fromAI: true
            });
          }
          
          return await this.execute({
            action: 'theme',
            device: params.device,
            theme: theme,
            fromAI: true
          });
        }
      },
      {
        intent: 'govee.bulk',
        examples: [
          'turn all lights on',
          'turn off all kitchen lights',
          'make the whole house bright',
          'dim all bedroom lights to 30%',
          'set all lights to blue',
          'turn everything off',
          'sync all devices to warm white',
          'party mode everywhere',
          'shut down the entire house',
          'wake up all rooms',
          'bedtime for all lights'
        ],
        handler: async (params) => {
          // Parse the action from the input
          const input = params.originalInput.toLowerCase();
          let action = 'on';
          let value = 100;
          
          if (input.includes('off')) action = 'off';
          else if (input.includes('on')) action = 'on';
          else if (input.includes('bright')) {
            action = 'brightness';
            value = 100;
          } else if (input.includes('dim')) {
            action = 'brightness';
            value = GoveeEnhancements.parsePercentage(input) || 30;
          }
          
          // Extract device pattern
          let devices = 'all';
          if (input.includes('kitchen')) devices = 'kitchen';
          else if (input.includes('bedroom')) devices = 'bedroom';
          else if (input.includes('living room')) devices = 'living room';
          else if (input.includes('whole house') || input.includes('everything')) devices = 'all';
          
          return await this.execute({
            action: 'bulk',
            devices: devices,
            action: action,
            value: value,
            fromAI: true
          });
        }
      }
    ];
  }

  async getAICapabilities() {
    if (!this.config.aiControlEnabled) {
      return {
        enabled: false,
        message: 'AI control is disabled for Govee devices'
      };
    }

    try {
      // Get current devices
      const result = await this.listDevices();
      if (!result.success || !result.devices || result.devices.length === 0) {
        return {
          enabled: true,
          devices: [],
          examples: [
            'turn on the living room light',
            'turn off all lights',
            'dim the bedroom light to 50%',
            'set the kitchen light to blue'
          ]
        };
      }

      // Create device name mapping
      const devices = result.devices.map(device => ({
        id: device.device,
        name: device.deviceName,
        type: device.type,
        model: device.sku,
        capabilities: device.capabilities ? device.capabilities.map(c => c.type) : []
      }));

      // Generate dynamic examples based on actual device names
      const examples = [];
      if (devices.length > 0) {
        const firstDevice = devices[0].name;
        examples.push(`turn on ${firstDevice}`);
        examples.push(`turn off ${firstDevice}`);
        
        // Add examples for multiple devices if they exist
        if (devices.length > 1) {
          examples.push('turn off all lights');
          examples.push('turn on all govee devices');
        }
        
        // Add brightness example if supported
        if (devices.some(d => d.capabilities.includes('devices.capabilities.range'))) {
          examples.push(`dim ${firstDevice} to 30%`);
        }
        
        // Add color example if supported
        if (devices.some(d => d.capabilities.includes('devices.capabilities.color_setting'))) {
          examples.push(`set ${firstDevice} to blue`);
        }
      }

      return {
        enabled: true,
        devices: devices,
        examples: examples,
        capabilities: [
          'Control Govee smart lights and devices by name',
          'Turn devices on/off',
          'Adjust brightness',
          'Change colors',
          'Set color temperature',
          'Apply scenes'
        ],
        notes: [
          'Device names are case-insensitive',
          'You can use partial matches (e.g., "kitchen" matches "Kitchen Light")',
          'Use "all" to control all devices at once'
        ]
      };
    } catch (error) {
      this.logger.error(`Error getting AI capabilities: ${error.message}`);
      return {
        enabled: true,
        error: 'Failed to fetch device list'
      };
    }
  }

  getUIConfig() {
    return {
      menuItem: {
        id: 'govee',
        title: 'Govee Devices',
        icon: 'fas fa-lightbulb',
        order: 70, // Position in G section (after Firewall, before Guests)
        section: 'main'
      },
      hasUI: true
    };
  }

  getUIContent() {
    return this.getUIHTML();
  }

  // Old initializeUI method - no longer used since JavaScript is embedded in HTML
  /*
  initializeUI(container, apiToken) {
    // This will be called after the content is loaded to set up event handlers
    console.log('[Govee Plugin] InitializeUI called, container:', container);
    
    // Initialize variables
    let devices = [];
    let settings = { aiControlEnabled: true };
    
    // Helper function for authenticated fetch
    async function fetchWithAuth(url, options = {}) {
        const token = localStorage.getItem('lanagent_token');
        console.log('[Govee] Fetching:', url, 'with token:', token ? 'present' : 'missing');
        return fetch(url, {
            ...options,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
    }
    
    // Load settings
    async function loadSettings() {
        try {
            console.log('[Govee] Loading settings...');
            const response = await fetchWithAuth('/api/govee/settings');
            const data = await response.json();
            if (data.success) {
                console.log('[Govee] Loaded settings:', data.settings);
                settings = data.settings;
                const toggle = container.querySelector('#ai-control-toggle');
                console.log('[Govee] Toggle element:', toggle);
                console.log('[Govee] Container:', container);
                console.log('[Govee] Setting toggle.checked to:', settings.aiControlEnabled);
                if (toggle) {
                    toggle.checked = settings.aiControlEnabled;
                    console.log('[Govee] Toggle.checked is now:', toggle.checked);
                } else {
                    console.error('[Govee] Toggle element not found!');
                }
            }
        } catch (error) {
            console.error('[Govee] Failed to load settings:', error);
        }
    }
    
    // Load devices
    async function loadDevices() {
        try {
            console.log('[Govee] Loading devices...');
            const response = await fetchWithAuth('/api/govee/devices');
            console.log('[Govee] Device response status:', response.status);
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ': ' + response.statusText);
            }
            const data = await response.json();
            
            if (data.success) {
                console.log('[Govee] Loaded', data.devices.length, 'devices');
                devices = data.devices;
                renderDevices();
            } else {
                console.error('[Govee] Failed to load devices:', data.error);
                showError(data.error || 'Failed to load devices');
            }
        } catch (error) {
            console.error('[Govee] Failed to load devices:', error);
            showError('Failed to load devices: ' + error.message);
        }
    }
    
    // Render devices
    function renderDevices() {
        const devicesContainer = container.querySelector('#devices-container');
        if (!devicesContainer) {
            console.error('[Govee] Devices container not found');
            return;
        }
        
        if (devices.length === 0) {
            devicesContainer.innerHTML = '<div class="no-devices">No devices found</div>';
            return;
        }
        
        devicesContainer.innerHTML = devices.map(device => `
            <div class="device-card" data-device="${device.device}">
                <div class="device-header">
                    <h3>${device.deviceName}</h3>
                    <button class="power-button" data-device="${device.device}">
                        <i class="fas fa-power-off"></i>
                    </button>
                </div>
                <div class="device-info">
                    <p>Model: ${device.sku}</p>
                    <p class="device-id">ID: ${device.device}</p>
                </div>
                <div class="device-controls">
                    <div class="loading">Loading controls...</div>
                </div>
            </div>
        `).join('');
    }
    
    // Show error
    function showError(message) {
        const devicesContainer = container.querySelector('#devices-container');
        if (devicesContainer) {
            devicesContainer.innerHTML = '<div class="error">' + message + '</div>';
        }
    }
    
    // Add event listeners
    const aiToggle = container.querySelector('#ai-control-toggle');
    if (aiToggle) {
        aiToggle.addEventListener('change', async () => {
            try {
                const aiControlEnabled = aiToggle.checked;
                const response = await fetchWithAuth('/api/govee/settings', {
                    method: 'POST',
                    body: JSON.stringify({ aiControlEnabled })
                });
                const data = await response.json();
                if (!data.success) {
                    alert('Failed to update settings: ' + (data.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('[Govee] Failed to update settings:', error);
                alert('Failed to update settings');
            }
        });
    }
    
    // Start initialization with a small delay to ensure DOM is ready
    console.log('[Govee] Starting initialization...');
    setTimeout(() => {
        loadSettings();
        loadDevices();
    }, 100);
    
    // Refresh devices every 30 seconds
    setInterval(loadDevices, 30000);
  }
  */

  getRoutes() {
    return [
      {
        method: 'GET',
        path: '/devices',
        handler: async (body, req) => {
          return await this.listDevices();
        }
      },
      {
        method: 'GET',
        path: '/device/:deviceId/status',
        handler: async (body, req) => {
          // Decode the device ID in case it was URL encoded
          const deviceId = decodeURIComponent(req.params.deviceId);
          return await this.getDeviceStatus({ 
            device: deviceId,
            sku: req.query.sku 
          });
        }
      },
      {
        method: 'POST',
        path: '/device/:deviceId/control',
        handler: async (body, req) => {
          // Decode the device ID in case it was URL encoded
          const deviceId = decodeURIComponent(req.params.deviceId);
          return await this.controlDevice({
            device: deviceId,
            capability: body.capability,
            value: body.value,
            sku: body.sku,
            fromAI: false // Direct UI control
          });
        }
      },
      {
        method: 'GET',
        path: '/device/:deviceId/scenes',
        handler: async (body, req) => {
          // Decode the device ID in case it was URL encoded
          const deviceId = decodeURIComponent(req.params.deviceId);
          return await this.getScenes({
            device: deviceId,
            sku: req.query.sku
          });
        }
      },
      {
        method: 'GET',
        path: '/settings',
        handler: async () => {
          // Load from persistent state
          const savedSettings = this.getState ? this.getState('settings') : null;
          if (savedSettings && savedSettings.aiControlEnabled !== undefined) {
            this.config.aiControlEnabled = savedSettings.aiControlEnabled;
          }
          return {
            success: true,
            settings: {
              aiControlEnabled: this.config.aiControlEnabled
            }
          };
        }
      },
      {
        method: 'POST',
        path: '/settings',
        handler: async (body) => {
          return await this.updateSettings(body);
        }
      },
      {
        method: 'GET',
        path: '/groups',
        handler: async () => {
          return { success: true, groups: await GroupManagement.getGroups() };
        }
      },
      {
        method: 'POST',
        path: '/groups',
        handler: async (body) => {
          return await this.manageGroups(body);
        }
      },
      {
        method: 'POST',
        path: '/bulk',
        handler: async (body) => {
          return await this.bulkControl(body);
        }
      },
      {
        method: 'POST',
        path: '/restore',
        handler: async (body) => {
          return await this.restoreSettings(body);
        }
      },
      {
        method: 'GET',
        path: '/schedules',
        handler: async () => {
          return await this.listSchedules({});
        }
      },
      {
        method: 'POST',
        path: '/schedules',
        handler: async (body) => {
          return await this.createSchedule(body);
        }
      },
      {
        method: 'PATCH',
        path: '/schedules/:scheduleId',
        handler: async (body, req) => {
          return await this.updateSchedule({ scheduleId: req.params.scheduleId, ...body });
        }
      },
      {
        method: 'DELETE',
        path: '/schedules/:scheduleId',
        handler: async (body, req) => {
          return await this.deleteSchedule({ scheduleId: req.params.scheduleId });
        }
      }
    ];
  }

  getUIHTML() {
    return `
<div class="govee-container">
    <style>
        .govee-container {
            padding: 20px;
            max-width: 1400px;
            margin: 0 auto;
        }
        .govee-container h1 {
            color: var(--text-primary);
            margin-bottom: 30px;
        }
        .settings-card {
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid var(--border);
        }
        .toggle-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .toggle-switch {
            position: relative;
            width: 50px;
            height: 28px;
        }
        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--border);
            transition: .4s;
            border-radius: 28px;
        }
        .slider:before {
            position: absolute;
            content: "";
            height: 20px;
            width: 20px;
            left: 4px;
            bottom: 4px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }
        input:checked + .slider {
            background-color: var(--accent);
        }
        input:checked + .slider:before {
            transform: translateX(22px);
        }
        .devices-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
        }
        .device-card {
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 20px;
            border: 1px solid var(--border);
            transition: border-color 0.3s;
        }
        .device-card:hover {
            border-color: var(--accent);
        }
        .device-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .device-header h3 {
            margin: 0;
            color: var(--text-primary);
        }
        .device-info {
            color: var(--text-secondary);
            font-size: 14px;
            margin-bottom: 20px;
        }
        .device-id {
            font-family: monospace;
            font-size: 12px;
            opacity: 0.7;
        }
        .device-controls {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .control-section {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .control-label {
            font-weight: 500;
            color: var(--text-primary);
            font-size: 14px;
        }
        .power-button {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 8px;
            width: 40px;
            height: 40px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.3s;
            font-size: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .power-button:hover {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .power-button.active {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .control-btn {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.3s;
            font-size: 14px;
            width: 100%;
            text-align: center;
            /* Mobile touch improvements */
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            user-select: none;
            -webkit-user-select: none;
        }
        .control-btn:hover, .control-btn:active {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .control-btn i {
            margin-right: 5px;
        }
        /* Mobile-specific button improvements */
        @media (max-width: 768px) {
            .control-btn {
                padding: 12px 16px;
                font-size: 16px;
                min-height: 44px;
            }
            .device-controls {
                gap: 8px;
            }
        }
        .brightness-slider {
            width: 100%;
            -webkit-appearance: none;
            appearance: none;
            height: 5px;
            border-radius: 5px;
            background: var(--border);
            outline: none;
        }
        .brightness-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: var(--accent);
            cursor: pointer;
        }
        .brightness-slider::-moz-range-thumb {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: var(--accent);
            cursor: pointer;
        }
        .color-picker {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .color-preset {
            width: 30px;
            height: 30px;
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid transparent;
            transition: border-color 0.3s;
        }
        .color-preset:hover {
            border-color: var(--accent);
        }
        .scene-selector {
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 8px;
            border-radius: 4px;
            width: 100%;
            font-size: 14px;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: var(--text-secondary);
        }
        .error {
            text-align: center;
            padding: 40px;
            color: var(--danger);
        }
        .status-dot {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--text-secondary);
            margin-right: 5px;
        }
        .status-dot.online {
            background: var(--danger); /* Red for online but off */
        }
        .status-dot.online.on {
            background: var(--success); /* Green for online and on */
        }
        @media (max-width: 768px) {
            .devices-grid {
                grid-template-columns: 1fr;
            }
        }
        .groups-list {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }
        .group-tag {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 8px 16px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.3s;
        }
        .group-tag:hover {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
            cursor: pointer;
        }
        .group-tag .device-count {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
        }
        .group-tag:hover .device-count {
            background: rgba(255,255,255,0.2);
            color: white;
        }
        .group-tag .delete-group {
            cursor: pointer;
            color: var(--danger);
            margin-left: 5px;
        }
        .group-tag .delete-group:hover {
            color: white;
        }
        .govee-button {
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 14px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            text-decoration: none;
        }
        .govee-button:hover {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }
        .govee-button:active {
            transform: translateY(0);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }
        .govee-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            background: var(--bg-secondary);
            color: var(--text-secondary);
        }
        .govee-button.primary {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .govee-button.primary:hover {
            background: var(--accent-hover, var(--accent));
            transform: translateY(-1px);
        }
        .govee-button.danger {
            background: var(--danger);
            color: white;
            border-color: var(--danger);
        }
        .govee-button.danger:hover {
            background: var(--danger-hover, var(--danger));
        }
    </style>

    <h1>Govee Devices</h1>

    <div class="settings-card">
        <div class="toggle-container">
            <div>
                <h3>AI Control</h3>
                <p style="color: var(--text-secondary); margin: 5px 0;">Allow AI assistant to control Govee devices</p>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" id="ai-control-toggle">
                <span class="slider"></span>
            </label>
        </div>
    </div>

    <div id="setup-instructions" class="settings-card" style="margin-bottom: 20px;">
        <h3>Setup Instructions</h3>
        <p style="color: var(--text-secondary); margin: 10px 0;">
            To use Govee devices with LANAgent:
        </p>
        <ol style="color: var(--text-secondary); margin: 10px 0; padding-left: 20px;">
            <li>Install the Govee Home app on your phone</li>
            <li>Add your Govee devices to the app (WiFi/Bluetooth)</li>
            <li>Get your API key from <a href="https://developer.govee.com/" target="_blank" style="color: var(--accent);">developer.govee.com</a></li>
            <li>Set GOVEE_API_KEY in your .env file</li>
            <li>Devices will appear here once they're added to your Govee account</li>
        </ol>
        <p style="color: var(--warning); margin: 10px 0;">
            <i class="fas fa-info-circle"></i> Note: Govee API only shows devices registered to your account, not local network discovery.
        </p>
    </div>

    ${GoveeAdvanced.getAdvancedFeaturesUI()}

    <div class="settings-card" style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3>Device Schedules</h3>
            <button class="govee-button" onclick="showCreateScheduleModal()">
                <i class="fas fa-clock"></i> Add Schedule
            </button>
        </div>
        <div id="schedules-container">
            <div class="loading">Loading schedules...</div>
        </div>
    </div>

    <div class="settings-card" style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3>Device Groups</h3>
            <button class="govee-button" onclick="showCreateGroupModal()" style="padding: 8px 16px;">
                <i class="fas fa-plus"></i> Create Group
            </button>
        </div>
        <div id="groups-container">
            <div class="loading">Loading groups...</div>
        </div>
    </div>

    <div id="devices-container" class="devices-grid">
        <div class="loading">Loading devices...</div>
    </div>
    
    ${GoveeEnhancements.getModalHTML()}
</div>

<script>
(function() {
    console.log('[Govee] Script starting...');
    
    // Initialize variables
    let devices = [];
    let settings = { aiControlEnabled: true };
    
    // Helper function for authenticated fetch
    async function fetchWithAuth(url, options = {}) {
        const token = localStorage.getItem('lanagent_token');
        console.log('[Govee] Fetching:', url, 'with token:', token ? 'present' : 'missing');
        return fetch(url, {
            ...options,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
    }
    
    // Load settings
    async function loadSettings() {
        try {
            console.log('[Govee] Loading settings...');
            const response = await fetchWithAuth('/api/govee/settings');
            const data = await response.json();
            if (data.success) {
                console.log('[Govee] Loaded settings:', data.settings);
                settings = data.settings;
                const toggle = document.querySelector('#ai-control-toggle');
                console.log('[Govee] Toggle element:', toggle);
                console.log('[Govee] Setting toggle.checked to:', settings.aiControlEnabled);
                if (toggle) {
                    toggle.checked = settings.aiControlEnabled;
                    console.log('[Govee] Toggle.checked is now:', toggle.checked);
                } else {
                    console.error('[Govee] Toggle element not found!');
                }
            }
        } catch (error) {
            console.error('[Govee] Failed to load settings:', error);
        }
    }
    
    // Load devices
    async function loadDevices() {
        try {
            console.log('[Govee] Loading devices...');
            const response = await fetchWithAuth('/api/govee/devices');
            const data = await response.json();
            
            if (data.success) {
                console.log('[Govee] Loaded', data.devices.length, 'devices');
                devices = data.devices;
                renderDevices();
                
                // Update schedule device select if modal is open
                const scheduleSelect = document.getElementById('schedule-device-select');
                if (scheduleSelect) {
                    const currentValue = scheduleSelect.value;
                    const availableDevices = devices.filter(d => d.controllable);
                    scheduleSelect.innerHTML = availableDevices.map(device => 
                        \`<option value="\${device.device}">\${device.deviceName}</option>\`
                    ).join('');
                    // Restore previous selection if still valid
                    if (currentValue && availableDevices.find(d => d.device === currentValue)) {
                        scheduleSelect.value = currentValue;
                    }
                }
            } else {
                showError(data.error || 'Failed to load devices');
            }
        } catch (error) {
            console.error('[Govee] Failed to load devices:', error);
            showError('Failed to load devices: ' + error.message);
        }
    }
    
    // Render devices
    function renderDevices() {
        const devicesContainer = document.querySelector('#devices-container');
        if (!devicesContainer) {
            console.error('[Govee] Devices container not found');
            return;
        }
        
        // Hide setup instructions if we have devices
        const setupInstructions = document.querySelector('#setup-instructions');
        if (setupInstructions) {
            setupInstructions.style.display = devices.length > 0 ? 'none' : 'block';
        }
        
        if (devices.length === 0) {
            devicesContainer.innerHTML = '<div class="no-devices">No devices found</div>';
            return;
        }
        
        devicesContainer.innerHTML = devices.map(device => {
            const capabilities = device.capabilities || device.properties?.capabilities || [];
            const hasColor = capabilities.some(c => c.type === 'devices.capabilities.color_setting' && c.instance === 'colorRgb');
            const hasBrightness = capabilities.some(c => c.type === 'devices.capabilities.range' && c.instance === 'brightness');
            const hasColorTemp = capabilities.some(c => c.type === 'devices.capabilities.color_setting' && c.instance === 'colorTemperatureK');
            
            return '<div class="device-card" data-device="' + device.device + '">' +
                '<div class="device-header">' +
                    '<h3>' + device.deviceName + '</h3>' +
                    '<button class="power-button" data-device="' + device.device + '">' +
                        '<i class="fas fa-power-off"></i>' +
                    '</button>' +
                '</div>' +
                '<div class="device-info">' +
                    '<p>Model: ' + device.sku + '</p>' +
                    '<p class="device-id">ID: ' + device.device + '</p>' +
                    '<div class="device-controls">' +
                        (hasColor ? '<button class="control-btn color-btn" data-device="' + device.device + '"><i class="fas fa-palette"></i> Color</button>' : '') +
                        (hasBrightness ? '<button class="control-btn brightness-btn" data-device="' + device.device + '"><i class="fas fa-sun"></i> Brightness</button>' : '') +
                        (hasColorTemp ? '<button class="control-btn temp-btn" data-device="' + device.device + '"><i class="fas fa-thermometer-half"></i> Temperature</button>' : '') +
                        '<button class="control-btn scenes-btn" data-device="' + device.device + '" data-sku="' + device.sku + '"><i class="fas fa-image"></i> Scenes</button>' +
                    '</div>' +
                '</div>' +
                '<div class="device-status">' +
                    '<span class="status-dot"></span>' +
                    '<span>Loading status...</span>' +
                '</div>' +
            '</div>';
        }).join('');
        
        // Add event listeners to control buttons
        setupDeviceControls();
        
        // Load status for each device
        devices.forEach(device => {
            loadDeviceStatus(device.device, device.sku);
        });
    }
    
    // Mobile-friendly tap handler to prevent double-firing
    function addTapHandler(element, handler) {
        let touchStarted = false;

        element.addEventListener('touchstart', (e) => {
            touchStarted = true;
        }, { passive: true });

        element.addEventListener('touchend', (e) => {
            if (touchStarted) {
                e.preventDefault();
                touchStarted = false;
                handler(e);
            }
        });

        element.addEventListener('click', (e) => {
            // Only fire click if it wasn't a touch event
            if (!touchStarted) {
                handler(e);
            }
            touchStarted = false;
        });
    }

    // Setup device control event listeners
    function setupDeviceControls() {
        // Power buttons
        document.querySelectorAll('.power-button').forEach(btn => {
            addTapHandler(btn, async (e) => {
                const deviceId = btn.dataset.device;
                console.log('[Govee] Toggling power for device:', deviceId);
                
                // Get current state from button
                const isOn = btn.classList.contains('active');
                const newState = isOn ? 0 : 1; // Toggle state
                
                try {
                    // Find device SKU from the device card
                    const deviceCard = btn.closest('.device-card');
                    const skuElement = deviceCard.querySelector('.device-info p');
                    const sku = skuElement ? skuElement.textContent.replace('Model: ', '') : null;
                    
                    const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/control', {
                        method: 'POST',
                        body: JSON.stringify({
                            capability: 'devices.capabilities.on_off',
                            value: newState,
                            sku: sku
                        })
                    });
                    
                    const data = await response.json();
                    if (data.success) {
                        // Update button state
                        if (newState === 1) {
                            btn.classList.add('active');
                        } else {
                            btn.classList.remove('active');
                        }
                        
                        // Show success toast
                        const event = new CustomEvent('showToast', {
                            detail: {
                                message: 'Device ' + (newState === 1 ? 'turned on' : 'turned off'),
                                type: 'success'
                            }
                        });
                        window.dispatchEvent(event);
                        
                        // Reload status after a moment
                        // Find device SKU from the device card
                        const deviceCard = btn.closest('.device-card');
                        const skuElement = deviceCard.querySelector('.device-info p');
                        const sku = skuElement ? skuElement.textContent.replace('Model: ', '') : null;
                        setTimeout(() => loadDeviceStatus(deviceId, sku), 1000);
                    } else {
                        throw new Error(data.error || 'Failed to control device');
                    }
                } catch (error) {
                    console.error('[Govee] Failed to control device:', error);
                    const event = new CustomEvent('showToast', {
                        detail: {
                            message: 'Failed to control device: ' + error.message,
                            type: 'error'
                        }
                    });
                    window.dispatchEvent(event);
                }
            });
        });
        
        // Color buttons
        document.querySelectorAll('.color-btn').forEach(btn => {
            addTapHandler(btn, () => {
                console.log('[Govee] Color button tapped for device:', btn.dataset.device);
                showColorControl(btn.dataset.device);
            });
        });

        // Brightness buttons
        document.querySelectorAll('.brightness-btn').forEach(btn => {
            addTapHandler(btn, () => {
                console.log('[Govee] Brightness button tapped for device:', btn.dataset.device);
                showBrightnessControl(btn.dataset.device);
            });
        });

        // Temperature buttons
        document.querySelectorAll('.temp-btn').forEach(btn => {
            addTapHandler(btn, () => {
                console.log('[Govee] Temperature button tapped for device:', btn.dataset.device);
                showTemperatureControl(btn.dataset.device);
            });
        });

        // Scene buttons
        document.querySelectorAll('.scenes-btn').forEach(btn => {
            addTapHandler(btn, () => {
                console.log('[Govee] Scenes button tapped for device:', btn.dataset.device);
                showSceneControl(btn.dataset.device, btn.dataset.sku);
            });
        });
    }
    
    // Load device status
    async function loadDeviceStatus(deviceId, sku) {
        try {
            const url = '/api/govee/device/' + encodeURIComponent(deviceId) + '/status' + (sku ? '?sku=' + encodeURIComponent(sku) : '');
            const response = await fetchWithAuth(url);
            const data = await response.json();
            
            if (data.success && data.status) {
                updateDeviceStatus(deviceId, data.status);
            }
        } catch (error) {
            console.error('[Govee] Failed to load status for device', deviceId, error);
        }
    }
    
    // Update device status in UI
    function updateDeviceStatus(deviceId, status) {
        const deviceCard = document.querySelector('.device-card[data-device="' + deviceId + '"]');
        if (!deviceCard) return;
        
        const statusEl = deviceCard.querySelector('.device-status');
        const statusDot = statusEl.querySelector('.status-dot');
        const statusText = statusEl.querySelector('span:last-child');
        
        if (status.online) {
            statusDot.classList.add('online');
            const powerState = status.properties?.find(p => p.on_off !== undefined)?.on_off;
            statusText.textContent = powerState === 1 ? 'On' : 'Off';
            
            // Update status dot color based on power state
            if (powerState === 1) {
                statusDot.classList.add('on');
            } else {
                statusDot.classList.remove('on');
            }
            
            // Update power button appearance
            const powerBtn = deviceCard.querySelector('.power-button');
            if (powerState === 1) {
                powerBtn.classList.add('active');
            } else {
                powerBtn.classList.remove('active');
            }
        } else {
            statusDot.classList.remove('online', 'on');
            statusText.textContent = 'Offline';
        }
    }
    
    // Show error message
    function showError(message) {
        const devicesContainer = document.querySelector('#devices-container');
        if (devicesContainer) {
            devicesContainer.innerHTML = '<div class="error">' + message + '</div>';
        }
    }
    
    // Add event listeners
    setTimeout(() => {
        console.log('[Govee] Setting up event listeners...');
        const aiToggle = document.querySelector('#ai-control-toggle');
        if (aiToggle) {
            console.log('[Govee] Found toggle, adding event listener');
            aiToggle.addEventListener('change', async () => {
                try {
                    const aiControlEnabled = aiToggle.checked;
                    const response = await fetchWithAuth('/api/govee/settings', {
                        method: 'POST',
                        body: JSON.stringify({ aiControlEnabled })
                    });
                    const data = await response.json();
                    if (data.success) {
                        // Show success toast
                        const event = new CustomEvent('showToast', {
                            detail: {
                                message: 'AI Control ' + (aiControlEnabled ? 'enabled' : 'disabled'),
                                type: 'success'
                            }
                        });
                        window.dispatchEvent(event);
                    } else {
                        throw new Error(data.error || 'Failed to update settings');
                    }
                } catch (error) {
                    console.error('[Govee] Failed to update settings:', error);
                    const event = new CustomEvent('showToast', {
                        detail: {
                            message: 'Failed to update settings',
                            type: 'error'
                        }
                    });
                    window.dispatchEvent(event);
                }
            });
        } else {
            console.error('[Govee] AI toggle not found!');
        }
        
        // Load initial data
        loadSettings();
        loadDevices();
        
        // Refresh devices every 30 seconds
        setInterval(loadDevices, 30000);
    }, 100);
    
    // Modal control functions
    window.closeGoveeModal = function() {
        document.getElementById('govee-control-modal').style.display = 'none';
    };
    
    window.showColorControl = async function(deviceId) {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Color Control';
        
        const colorPresets = ${JSON.stringify(GoveeEnhancements.colorPresets)};
        
        body.innerHTML = \`
            <div class="color-grid">
                \${colorPresets.map(preset => \`
                    <div class="color-option" 
                         style="background-color: rgb(\${preset.color.r}, \${preset.color.g}, \${preset.color.b})"
                         data-r="\${preset.color.r}" 
                         data-g="\${preset.color.g}" 
                         data-b="\${preset.color.b}"
                         title="\${preset.name}">
                    </div>
                \`).join('')}
            </div>
            <button class="apply-button" onclick="applyColor('\${deviceId}')">Apply Color</button>
        \`;
        
        // Add click handlers to color options
        setTimeout(() => {
            document.querySelectorAll('.color-option').forEach(option => {
                option.addEventListener('click', function() {
                    document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
                    this.classList.add('selected');
                });
            });
        }, 100);
        
        modal.style.display = 'flex';
    };
    
    window.applyColor = async function(deviceId) {
        const selected = document.querySelector('.color-option.selected');
        if (!selected) {
            alert('Please select a color');
            return;
        }
        
        const deviceCard = document.querySelector('.device-card[data-device="' + deviceId + '"]');
        const sku = deviceCard.querySelector('.device-info p').textContent.replace('Model: ', '');
        
        try {
            const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/control', {
                method: 'POST',
                body: JSON.stringify({
                    capability: 'devices.capabilities.color_setting',
                    value: (parseInt(selected.dataset.r) << 16) | (parseInt(selected.dataset.g) << 8) | parseInt(selected.dataset.b),
                    sku: sku
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Color applied', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to apply color');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showBrightnessControl = function(deviceId) {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Brightness Control';
        
        body.innerHTML = \`
            <div class="brightness-control">
                <div class="control-header">
                    <label>Brightness</label>
                    <span class="control-value" id="brightness-value">50%</span>
                </div>
                <div class="slider-container">
                    <input type="range" class="control-slider" id="brightness-slider" 
                           min="1" max="100" value="50" 
                           oninput="document.getElementById('brightness-value').textContent = this.value + '%'">
                </div>
            </div>
            <button class="apply-button" onclick="applyBrightness('\${deviceId}')">Apply Brightness</button>
        \`;
        
        modal.style.display = 'flex';
    };
    
    window.applyBrightness = async function(deviceId) {
        const slider = document.getElementById('brightness-slider');
        const deviceCard = document.querySelector('.device-card[data-device="' + deviceId + '"]');
        const sku = deviceCard.querySelector('.device-info p').textContent.replace('Model: ', '');
        
        try {
            const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/control', {
                method: 'POST',
                body: JSON.stringify({
                    capability: 'devices.capabilities.range',
                    value: parseInt(slider.value),
                    sku: sku
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Brightness set to ' + slider.value + '%', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to set brightness');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showTemperatureControl = function(deviceId) {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Color Temperature';
        
        const tempPresets = ${JSON.stringify(GoveeEnhancements.temperaturePresets)};
        
        body.innerHTML = \`
            <div class="temperature-control">
                <div class="control-header">
                    <label>Color Temperature</label>
                    <span class="control-value" id="temp-value">4000K</span>
                </div>
                <div class="slider-container">
                    <input type="range" class="control-slider" id="temp-slider" 
                           min="2000" max="9000" value="4000" step="100"
                           oninput="document.getElementById('temp-value').textContent = this.value + 'K'">
                </div>
                <div class="temperature-presets">
                    \${tempPresets.map(preset => \`
                        <button class="temp-preset" onclick="document.getElementById('temp-slider').value = \${preset.kelvin}; document.getElementById('temp-value').textContent = '\${preset.kelvin}K'">
                            \${preset.name}
                        </button>
                    \`).join('')}
                </div>
            </div>
            <button class="apply-button" onclick="applyTemperature('\${deviceId}')">Apply Temperature</button>
        \`;
        
        modal.style.display = 'flex';
    };
    
    window.applyTemperature = async function(deviceId) {
        const slider = document.getElementById('temp-slider');
        const deviceCard = document.querySelector('.device-card[data-device="' + deviceId + '"]');
        const sku = deviceCard.querySelector('.device-info p').textContent.replace('Model: ', '');
        
        try {
            const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/control', {
                method: 'POST',
                body: JSON.stringify({
                    capability: 'devices.capabilities.color_temperature_setting',
                    value: parseInt(slider.value),
                    sku: sku
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Temperature set to ' + slider.value + 'K', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to set temperature');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showSceneControl = async function(deviceId, sku) {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');

        title.textContent = 'Scene Selection';
        body.innerHTML = '<div class="loading">Loading scenes...</div>';
        modal.style.display = 'flex';

        try {
            const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/scenes?sku=' + encodeURIComponent(sku));
            const data = await response.json();
            console.log('[Govee] Scenes response:', data);

            // Scenes are now returned as a flat array with name, value, instance properties
            if (data.success && data.scenes && data.scenes.length > 0) {
                body.innerHTML = \`
                    <div class="scene-grid">
                        \${data.scenes.map(scene => \`
                            <div class="scene-option" onclick="applyScene('\${deviceId}', '\${scene.value}', '\${sku}', '\${scene.instance || 'lightScene'}')">
                                \${scene.name}
                            </div>
                        \`).join('')}
                    </div>
                \`;
            } else {
                body.innerHTML = '<div class="no-scenes"><p>No scenes available for this device.</p><p style="font-size: 12px; color: var(--text-secondary); margin-top: 10px;">Tip: You can create DIY scenes in the Govee app.</p></div>';
            }
        } catch (error) {
            console.error('[Govee] Failed to load scenes:', error);
            body.innerHTML = '<div class="error">Failed to load scenes: ' + error.message + '</div>';
        }
    };
    
    window.applyScene = async function(deviceId, sceneValue, sku, instance) {
        try {
            const response = await fetchWithAuth('/api/govee/device/' + encodeURIComponent(deviceId) + '/control', {
                method: 'POST',
                body: JSON.stringify({
                    capability: 'devices.capabilities.dynamic_scene',
                    instance: instance || 'lightScene',
                    value: sceneValue,
                    sku: sku
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Scene applied', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to apply scene');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    // Group Management Functions
    let groups = [];
    
    async function loadGroups() {
        try {
            const response = await fetchWithAuth('/api/govee/groups');
            const data = await response.json();
            if (data.success) {
                groups = data.groups || [];
                renderGroups();
            }
        } catch (error) {
            console.error('[Govee] Failed to load groups:', error);
        }
    }
    
    function renderGroups() {
        const container = document.getElementById('groups-container');
        if (!container) return;
        
        if (groups.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary);">No groups created yet. Create a group to control multiple devices at once!</p>';
            return;
        }
        
        container.innerHTML = \`
            <div class="groups-list">
                \${groups.map(group => \`
                    <div class="group-tag" onclick="controlGroup('\${group.name}')">
                        <span>\${group.name}</span>
                        <span class="device-count">\${group.devices.length}</span>
                        <i class="fas fa-times delete-group" onclick="deleteGroup('\${group.name}', event)"></i>
                    </div>
                \`).join('')}
            </div>
        \`;
    }
    
    window.showCreateGroupModal = function() {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Create Device Group';
        
        const availableDevices = devices.filter(d => d.controllable);
        
        body.innerHTML = \`
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Group Name</label>
                <input type="text" id="group-name-input" placeholder="e.g., Kitchen Lights" 
                       style="width: 100%; padding: 10px; background: var(--bg-primary); 
                              border: 1px solid var(--border); border-radius: 4px; 
                              color: var(--text-primary);">
            </div>
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Select Devices</label>
                <div style="max-height: 300px; overflow-y: auto;">
                    \${availableDevices.map(device => \`
                        <label style="display: flex; align-items: center; padding: 10px; 
                                      background: var(--bg-primary); margin-bottom: 5px; 
                                      border-radius: 4px; cursor: pointer;">
                            <input type="checkbox" value="\${device.device}" 
                                   data-name="\${device.deviceName}" 
                                   style="margin-right: 10px;">
                            <span style="color: var(--text-primary);">\${device.deviceName}</span>
                        </label>
                    \`).join('')}
                </div>
            </div>
            <button class="apply-button" onclick="createGroup()">Create Group</button>
        \`;
        
        modal.style.display = 'flex';
    };
    
    window.createGroup = async function() {
        const nameInput = document.getElementById('group-name-input');
        const groupName = nameInput.value.trim();
        
        if (!groupName) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Please enter a group name', type: 'error' }
            }));
            return;
        }
        
        const checkboxes = document.querySelectorAll('#modal-body input[type="checkbox"]:checked');
        if (checkboxes.length === 0) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Please select at least one device', type: 'error' }
            }));
            return;
        }
        
        const selectedDevices = Array.from(checkboxes).map(cb => ({
            deviceId: cb.value,
            deviceName: cb.dataset.name
        }));
        
        try {
            const response = await fetchWithAuth('/api/govee/groups', {
                method: 'POST',
                body: JSON.stringify({
                    operation: 'create',
                    name: groupName,
                    devices: selectedDevices
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Group created successfully', type: 'success' }
                }));
                closeGoveeModal();
                loadGroups();
            } else {
                throw new Error(data.error || 'Failed to create group');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.deleteGroup = async function(groupName, event) {
        event.stopPropagation();
        
        if (!confirm(\`Delete group "\${groupName}"?\`)) {
            return;
        }
        
        try {
            const response = await fetchWithAuth('/api/govee/groups', {
                method: 'POST',
                body: JSON.stringify({
                    operation: 'delete',
                    name: groupName
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Group deleted', type: 'success' }
                }));
                loadGroups();
            } else {
                throw new Error(data.error || 'Failed to delete group');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.controlGroup = function(groupName) {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = \`Control \${groupName}\`;
        
        body.innerHTML = \`
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                <button class="govee-button" onclick="controlGroupAction('\${groupName}', 'on')" 
                        style="padding: 20px;">
                    <i class="fas fa-power-off"></i> Turn On
                </button>
                <button class="govee-button" onclick="controlGroupAction('\${groupName}', 'off')" 
                        style="padding: 20px; background: var(--danger);">
                    <i class="fas fa-power-off"></i> Turn Off
                </button>
                <button class="govee-button" onclick="showGroupBrightness('\${groupName}')" 
                        style="padding: 20px;">
                    <i class="fas fa-sun"></i> Brightness
                </button>
                <button class="govee-button" onclick="showGroupColor('\${groupName}')" 
                        style="padding: 20px;">
                    <i class="fas fa-palette"></i> Color
                </button>
                <button class="govee-button" onclick="showGroupTheme('\${groupName}')" 
                        style="padding: 20px; grid-column: span 2;">
                    <i class="fas fa-magic"></i> Apply Theme
                </button>
            </div>
        \`;
        
        modal.style.display = 'flex';
    };
    
    window.controlGroupAction = async function(groupName, action) {
        try {
            const response = await fetchWithAuth('/api/govee/bulk', {
                method: 'POST',
                body: JSON.stringify({
                    devices: groupName,
                    operation: action
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: \`Group \${action === 'on' ? 'turned on' : 'turned off'}\`, type: 'success' }
                }));
                closeGoveeModal();
                setTimeout(loadDevices, 1000);
            } else {
                throw new Error(data.error || 'Failed to control group');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showGroupBrightness = function(groupName) {
        const body = document.getElementById('modal-body');
        
        body.innerHTML = \`
            <div class="brightness-control">
                <div class="control-header">
                    <label>Group Brightness</label>
                    <span class="control-value" id="brightness-value">50%</span>
                </div>
                <div class="slider-container">
                    <input type="range" class="control-slider" id="brightness-slider" 
                           min="1" max="100" value="50" 
                           oninput="document.getElementById('brightness-value').textContent = this.value + '%'">
                </div>
            </div>
            <button class="apply-button" onclick="applyGroupBrightness('\${groupName}')">Apply to Group</button>
        \`;
    };
    
    window.applyGroupBrightness = async function(groupName) {
        const slider = document.getElementById('brightness-slider');
        const brightness = parseInt(slider.value);
        
        try {
            const response = await fetchWithAuth('/api/govee/bulk', {
                method: 'POST',
                body: JSON.stringify({
                    devices: groupName,
                    operation: 'brightness',
                    value: brightness
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Group brightness updated', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to set brightness');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showGroupColor = function(groupName) {
        const body = document.getElementById('modal-body');
        const colorPresets = ${JSON.stringify(GoveeEnhancements.colorPresets)};
        
        body.innerHTML = \`
            <div class="color-grid">
                \${colorPresets.map(preset => \`
                    <div class="color-option" 
                         style="background-color: rgb(\${preset.color.r}, \${preset.color.g}, \${preset.color.b})"
                         data-r="\${preset.color.r}" 
                         data-g="\${preset.color.g}" 
                         data-b="\${preset.color.b}"
                         title="\${preset.name}">
                    </div>
                \`).join('')}
            </div>
            <button class="apply-button" onclick="applyGroupColor('\${groupName}')">Apply to Group</button>
        \`;
        
        // Add click handlers to color options
        setTimeout(() => {
            document.querySelectorAll('.color-option').forEach(option => {
                option.addEventListener('click', function() {
                    document.querySelectorAll('.color-option').forEach(opt => 
                        opt.classList.remove('selected'));
                    this.classList.add('selected');
                });
            });
        }, 100);
    };
    
    window.applyGroupColor = async function(groupName) {
        const selected = document.querySelector('.color-option.selected');
        if (!selected) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Please select a color', type: 'error' }
            }));
            return;
        }
        
        try {
            const response = await fetchWithAuth('/api/govee/bulk', {
                method: 'POST',
                body: JSON.stringify({
                    devices: groupName,
                    operation: 'color',
                    r: parseInt(selected.dataset.r),
                    g: parseInt(selected.dataset.g),
                    b: parseInt(selected.dataset.b)
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Group color updated', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to set color');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.showGroupTheme = function(groupName) {
        const body = document.getElementById('modal-body');
        const themes = ${JSON.stringify(Object.entries(GoveeEnhancements.themes).map(([key, theme]) => ({key, ...theme})))};
        
        body.innerHTML = \`
            <div class="scene-grid">
                <div class="scene-option" onclick="applyGroupTheme('\${groupName}', 'surprise')">
                    <i class="fas fa-random"></i> Surprise Me!
                </div>
                \${themes.map(theme => \`
                    <div class="scene-option" onclick="applyGroupTheme('\${groupName}', '\${theme.key}')">
                        \${theme.name}
                    </div>
                \`).join('')}
            </div>
        \`;
    };
    
    window.applyGroupTheme = async function(groupName, themeKey) {
        try {
            const response = await fetchWithAuth('/api/govee/bulk', {
                method: 'POST',
                body: JSON.stringify({
                    devices: groupName,
                    operation: 'theme',
                    theme: themeKey
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Theme applied to group', type: 'success' }
                }));
                closeGoveeModal();
            } else {
                throw new Error(data.error || 'Failed to apply theme');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    // Load groups when the page loads
    loadGroups();
    
    // Schedule Management Functions
    let schedules = [];
    
    async function loadSchedules() {
        try {
            const response = await fetchWithAuth('/api/govee/schedules');
            const data = await response.json();
            if (data.success) {
                schedules = data.schedules || [];
                renderSchedules();
            }
        } catch (error) {
            console.error('[Govee] Failed to load schedules:', error);
        }
    }
    
    function renderSchedules() {
        const container = document.getElementById('schedules-container');
        if (!container) return;
        
        if (schedules.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary);">No schedules created yet. Add a schedule to automate your devices!</p>';
            return;
        }
        
        container.innerHTML = \`
            <div style="display: flex; flex-direction: column; gap: 10px;">
                \${schedules.map(schedule => {
                    const device = devices.find(d => d.device === schedule.deviceId);
                    const deviceName = device ? device.deviceName : schedule.deviceName || 'Unknown Device';
                    const actionText = getScheduleActionText(schedule);
                    const timeText = formatScheduleTime(schedule);
                    const statusClass = schedule.disabled ? 'disabled' : (schedule.nextRunAt ? 'active' : 'inactive');
                    
                    return \`
                        <div class="schedule-item" style="background: var(--bg-primary); padding: 15px; border-radius: 8px; border: 1px solid var(--border);">
                            <div style="display: flex; justify-content: space-between; align-items: start;">
                                <div style="flex: 1;">
                                    <h4 style="margin: 0 0 5px 0; color: var(--text-primary);">\${deviceName}</h4>
                                    <p style="margin: 0 0 5px 0; color: var(--text-secondary); font-size: 14px;">
                                        <i class="fas fa-bolt"></i> \${actionText}
                                    </p>
                                    <p style="margin: 0; color: var(--text-secondary); font-size: 14px;">
                                        <i class="fas fa-clock"></i> \${timeText}
                                    </p>
                                    \${schedule.nextRunAt ? \`
                                        <p style="margin: 5px 0 0 0; color: var(--text-secondary); font-size: 12px;">
                                            Next run: \${new Date(schedule.nextRunAt).toLocaleString()}
                                        </p>
                                    \` : ''}
                                </div>
                                <div style="display: flex; gap: 10px; align-items: center;">
                                    <label class="toggle-switch" style="width: 40px; height: 24px;">
                                        <input type="checkbox" \${!schedule.disabled ? 'checked' : ''} 
                                               onchange="toggleSchedule('\${schedule.id}', this.checked)">
                                        <span class="slider" style="border-radius: 24px;"></span>
                                    </label>
                                    <button class="govee-button danger" onclick="deleteSchedule('\${schedule.id}')" 
                                            style="padding: 6px 12px; font-size: 12px;">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    \`;
                }).join('')}
            </div>
        \`;
    }
    
    function getScheduleActionText(schedule) {
        switch (schedule.action) {
            case 'on':
                return 'Turn on';
            case 'off':
                return 'Turn off';
            case 'brightness':
                return \`Set brightness to \${schedule.value}%\`;
            case 'color':
                return \`Set color to RGB(\${schedule.value.r}, \${schedule.value.g}, \${schedule.value.b})\`;
            case 'scene':
                return \`Apply scene: \${schedule.value}\`;
            default:
                return schedule.action;
        }
    }
    
    function formatScheduleTime(schedule) {
        const time = schedule.time || '';
        const timeStr = time.includes('T') ? new Date(time).toLocaleTimeString() : time;
        
        switch (schedule.repeat) {
            case 'once':
                return \`Once at \${timeStr}\`;
            case 'daily':
                return \`Daily at \${timeStr}\`;
            case 'weekdays':
                return \`Weekdays at \${timeStr}\`;
            case 'weekends':
                return \`Weekends at \${timeStr}\`;
            case 'custom':
                return \`\${schedule.days ? schedule.days.join(', ') : 'Custom'} at \${timeStr}\`;
            default:
                return timeStr;
        }
    }
    
    window.showCreateScheduleModal = function() {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Create Schedule';
        
        // Ensure devices are loaded
        if (!devices || devices.length === 0) {
            body.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No devices available. Please ensure devices are loaded.</p>';
            modal.style.display = 'flex';
            // Try to load devices
            loadDevices();
            return;
        }
        
        const availableDevices = devices.filter(d => d.controllable);
        
        if (availableDevices.length === 0) {
            body.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No controllable devices found.</p>';
            modal.style.display = 'flex';
            return;
        }
        
        body.innerHTML = \`
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Device</label>
                <select id="schedule-device-select" style="width: 100%; padding: 10px; background: var(--bg-primary); 
                        border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
                    \${availableDevices.map(device => \`
                        <option value="\${device.device}">\${device.deviceName}</option>
                    \`).join('')}
                </select>
            </div>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Action</label>
                <select id="schedule-action-select" onchange="updateScheduleValueInput()" 
                        style="width: 100%; padding: 10px; background: var(--bg-primary); 
                               border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
                    <option value="on">Turn On</option>
                    <option value="off">Turn Off</option>
                    <option value="brightness">Set Brightness</option>
                    <option value="color">Set Color</option>
                    <option value="scene">Apply Scene</option>
                </select>
            </div>
            
            <div id="schedule-value-container" style="margin-bottom: 20px; display: none;">
                <!-- Dynamic content based on action -->
            </div>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Time</label>
                <input type="time" id="schedule-time-input" 
                       style="width: 100%; padding: 10px; background: var(--bg-primary); 
                              border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
            </div>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Repeat</label>
                <select id="schedule-repeat-select" onchange="updateScheduleDaysInput()"
                        style="width: 100%; padding: 10px; background: var(--bg-primary); 
                               border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
                    <option value="daily">Daily</option>
                    <option value="once">Once</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekends">Weekends</option>
                    <option value="custom">Custom Days</option>
                </select>
            </div>
            
            <div id="schedule-days-container" style="margin-bottom: 20px; display: none;">
                <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Select Days</label>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                    \${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(day => \`
                        <label style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" value="\${day}" style="margin-right: 10px;">
                            <span style="color: var(--text-primary);">\${day}</span>
                        </label>
                    \`).join('')}
                </div>
            </div>
            
            <button class="apply-button" onclick="createSchedule()">Create Schedule</button>
        \`;
        
        modal.style.display = 'flex';
    };
    
    window.updateScheduleValueInput = function() {
        const action = document.getElementById('schedule-action-select').value;
        const container = document.getElementById('schedule-value-container');
        
        switch (action) {
            case 'on':
            case 'off':
                container.style.display = 'none';
                break;
            case 'brightness':
                container.style.display = 'block';
                container.innerHTML = \`
                    <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Brightness Level</label>
                    <input type="range" id="schedule-brightness-value" min="1" max="100" value="50"
                           style="width: 100%;" oninput="document.getElementById('brightness-display').textContent = this.value + '%'">
                    <span id="brightness-display" style="color: var(--text-secondary);">50%</span>
                \`;
                break;
            case 'color':
                container.style.display = 'block';
                const colorPresets = ${JSON.stringify(GoveeEnhancements.colorPresets)};
                container.innerHTML = \`
                    <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Select Color</label>
                    <div class="color-grid" style="grid-template-columns: repeat(3, 1fr); gap: 10px;">
                        \${colorPresets.map((preset, index) => \`
                            <div class="color-option" id="schedule-color-\${index}"
                                 style="background-color: rgb(\${preset.color.r}, \${preset.color.g}, \${preset.color.b});
                                        height: 40px; border-radius: 4px; cursor: pointer;"
                                 data-r="\${preset.color.r}" 
                                 data-g="\${preset.color.g}" 
                                 data-b="\${preset.color.b}"
                                 onclick="selectScheduleColor(\${index})">
                            </div>
                        \`).join('')}
                    </div>
                \`;
                break;
            case 'scene':
                container.style.display = 'block';
                container.innerHTML = \`
                    <label style="display: block; margin-bottom: 10px; color: var(--text-primary);">Scene Name</label>
                    <input type="text" id="schedule-scene-value" placeholder="e.g., Sunrise, Party"
                           style="width: 100%; padding: 10px; background: var(--bg-primary); 
                                  border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);">
                \`;
                break;
        }
    };
    
    window.updateScheduleDaysInput = function() {
        const repeat = document.getElementById('schedule-repeat-select').value;
        const container = document.getElementById('schedule-days-container');
        container.style.display = repeat === 'custom' ? 'block' : 'none';
    };
    
    window.selectScheduleColor = function(index) {
        document.querySelectorAll('#schedule-value-container .color-option').forEach((el, i) => {
            el.style.border = i === index ? '3px solid var(--accent)' : 'none';
        });
    };
    
    window.createSchedule = async function() {
        const device = document.getElementById('schedule-device-select').value;
        const action = document.getElementById('schedule-action-select').value;
        const time = document.getElementById('schedule-time-input').value;
        const repeat = document.getElementById('schedule-repeat-select').value;
        
        if (!time) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Please select a time', type: 'error' }
            }));
            return;
        }
        
        let value = null;
        switch (action) {
            case 'brightness':
                value = parseInt(document.getElementById('schedule-brightness-value').value);
                break;
            case 'color':
                const selected = document.querySelector('#schedule-value-container .color-option[style*="border"]');
                if (selected) {
                    value = {
                        r: parseInt(selected.dataset.r),
                        g: parseInt(selected.dataset.g),
                        b: parseInt(selected.dataset.b)
                    };
                } else {
                    window.dispatchEvent(new CustomEvent('showToast', {
                        detail: { message: 'Please select a color', type: 'error' }
                    }));
                    return;
                }
                break;
            case 'scene':
                value = document.getElementById('schedule-scene-value').value.trim();
                if (!value) {
                    window.dispatchEvent(new CustomEvent('showToast', {
                        detail: { message: 'Please enter a scene name', type: 'error' }
                    }));
                    return;
                }
                break;
        }
        
        let days = null;
        if (repeat === 'custom') {
            const checkedDays = Array.from(document.querySelectorAll('#schedule-days-container input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            if (checkedDays.length === 0) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Please select at least one day', type: 'error' }
                }));
                return;
            }
            days = checkedDays;
        }
        
        try {
            const response = await fetchWithAuth('/api/govee/schedules', {
                method: 'POST',
                body: JSON.stringify({
                    device,
                    action,
                    value,
                    time,
                    repeat,
                    days,
                    enabled: true
                })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Schedule created successfully', type: 'success' }
                }));
                closeGoveeModal();
                loadSchedules();
            } else {
                throw new Error(data.error || 'Failed to create schedule');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    window.toggleSchedule = async function(scheduleId, enabled) {
        try {
            const response = await fetchWithAuth('/api/govee/schedules/' + scheduleId, {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Schedule ' + (enabled ? 'enabled' : 'disabled'), type: 'success' }
                }));
            } else {
                throw new Error(data.error || 'Failed to update schedule');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
            // Revert the toggle
            const toggle = document.querySelector(\`input[onchange="toggleSchedule('\${scheduleId}', this.checked)"]\`);
            if (toggle) toggle.checked = !enabled;
        }
    };
    
    window.deleteSchedule = async function(scheduleId) {
        if (!confirm('Delete this schedule?')) return;
        
        try {
            const response = await fetchWithAuth('/api/govee/schedules/' + scheduleId, {
                method: 'DELETE'
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { message: 'Schedule deleted', type: 'success' }
                }));
                loadSchedules();
            } else {
                throw new Error(data.error || 'Failed to delete schedule');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
        }
    };
    
    // Load schedules when the page loads
    loadSchedules();
    
    ${GoveeAdvanced.getAdvancedJS()}
})();
</script>
`;
  }
}