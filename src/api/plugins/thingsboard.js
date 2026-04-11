import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

/**
 * ThingsBoard IoT Platform Plugin
 * 
 * Usage Examples:
 * - Natural language: "use thingsboard to get my devices"
 * - Command format: api thingsboard login
 * - Telegram: Just type naturally about thingsboard
 */
export default class ThingsBoardPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'thingsboard';
    this.version = '1.0.0';
    this.description = 'Open-source IoT platform for device management and data visualization';
    this.category = 'iot';
    this.commands = [
      {
        command: 'login',
        description: 'Authenticate with ThingsBoard server',
        usage: 'login [username] [password]'
      },
      {
        command: 'getDevices',
        description: 'Get list of tenant devices',
        usage: 'getDevices [pageSize] [page]'
      },
      {
        command: 'getDevice',
        description: 'Get device info by ID',
        usage: 'getDevice [deviceId]'
      },
      {
        command: 'createDevice',
        description: 'Create a new device',
        usage: 'createDevice [name] [type]'
      },
      {
        command: 'getTelemetry',
        description: 'Get device telemetry data',
        usage: 'getTelemetry [deviceId] [keys] [startTime] [endTime]'
      },
      {
        command: 'postTelemetry',
        description: 'Post telemetry data to device',
        usage: 'postTelemetry [deviceId] [data]'
      },
      {
        command: 'getAttributes',
        description: 'Get device attributes',
        usage: 'getAttributes [deviceId] [scope] [keys]'
      },
      {
        command: 'postAttributes',
        description: 'Post device attributes',
        usage: 'postAttributes [deviceId] [scope] [attributes]'
      },
      {
        command: 'sendRpcCommand',
        description: 'Send RPC command to device',
        usage: 'sendRpcCommand [deviceId] [method] [params]'
      },
      {
        command: 'createDeviceGroup',
        description: 'Create a new device group',
        usage: 'createDeviceGroup [name] [description]'
      },
      {
        command: 'updateDeviceGroup', 
        description: 'Update device group details',
        usage: 'updateDeviceGroup [groupId] [name] [description]'
      },
      {
        command: 'deleteDeviceGroup',
        description: 'Delete a device group',
        usage: 'deleteDeviceGroup [groupId]'
      },
      {
        command: 'getDeviceGroups',
        description: 'List all device groups',
        usage: 'getDeviceGroups'
      },
      {
        command: 'addDevicesToGroup',
        description: 'Add devices to a group',
        usage: 'addDevicesToGroup [groupId] [deviceIds...]'
      },
      {
        command: 'removeDevicesFromGroup',
        description: 'Remove devices from a group', 
        usage: 'removeDevicesFromGroup [groupId] [deviceIds...]'
      },
      {
        command: 'getDeviceGroupDevices',
        description: 'Get all devices in a group',
        usage: 'getDeviceGroupDevices [groupId]'
      }
    ];
    
    // Configuration
    this.baseUrl = process.env.THINGSBOARD_URL || 'http://localhost:9090';
    this.username = process.env.THINGSBOARD_USERNAME;
    this.password = process.env.THINGSBOARD_PASSWORD;
    this.token = null;
    this.tokenExpiry = null;
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'login':
          return await this.login(data.username, data.password);
          
        case 'getDevices':
          return await this.getDevices(data.pageSize, data.page);
          
        case 'getDevice':
          return await this.getDevice(data.deviceId);
          
        case 'createDevice':
          return await this.createDevice(data.name, data.type);
          
        case 'getTelemetry':
          return await this.getTelemetry(data.deviceId, data.keys, data.startTime, data.endTime);
          
        case 'postTelemetry':
          return await this.postTelemetry(data.deviceId, data.data);
          
        case 'getAttributes':
          return await this.getAttributes(data.deviceId, data.scope, data.keys);
          
        case 'postAttributes':
          return await this.postAttributes(data.deviceId, data.scope, data.attributes);
          
        case 'sendRpcCommand':
          return await this.sendRpcCommand(data.deviceId, data.method, data.params);
          
        case 'createDeviceGroup':
          return await this.createDeviceGroup(data.name, data.description);
          
        case 'updateDeviceGroup':
          return await this.updateDeviceGroup(data.groupId, data.name, data.description);
          
        case 'deleteDeviceGroup':
          return await this.deleteDeviceGroup(data.groupId);
          
        case 'getDeviceGroups':
          return await this.getDeviceGroups();
          
        case 'addDevicesToGroup':
          return await this.addDevicesToGroup(data.groupId, data.deviceIds);
          
        case 'removeDevicesFromGroup':
          return await this.removeDevicesFromGroup(data.groupId, data.deviceIds);
          
        case 'getDeviceGroupDevices':
          return await this.getDeviceGroupDevices(data.groupId);
          
        default:
          return { 
            success: false, 
            error: `Unknown action: ${action}. Use: ${this.commands.map(c => c.command).join(', ')}`
          };
      }
    } catch (error) {
      logger.error('ThingsBoard plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Authenticate with ThingsBoard and get JWT token
   */
  async login(username, password) {
    try {
      const user = username || this.username;
      const pass = password || this.password;
      
      if (!user || !pass) {
        return {
          success: false,
          error: 'Username and password required. Set THINGSBOARD_USERNAME and THINGSBOARD_PASSWORD or provide credentials.'
        };
      }
      
      const response = await axios.post(`${this.baseUrl}/api/auth/login`, {
        username: user,
        password: pass
      });
      
      this.token = response.data.token;
      this.tokenExpiry = Date.now() + (response.data.refreshTokenTtlSec || 86400) * 1000;
      
      // Store token for persistence
      await this.setState('thingsboard_token', this.token);
      await this.setState('thingsboard_token_expiry', this.tokenExpiry);
      
      return {
        success: true,
        message: 'Successfully authenticated with ThingsBoard',
        tokenValid: true
      };
    } catch (error) {
      logger.error('ThingsBoard login failed:', error);
      return {
        success: false,
        error: error.response?.data?.message || 'Authentication failed'
      };
    }
  }

  /**
   * Ensure we have a valid token
   */
  async ensureAuthenticated() {
    // Check if we have a stored token
    if (!this.token) {
      const storedToken = await this.getState('thingsboard_token');
      const storedExpiry = await this.getState('thingsboard_token_expiry');
      
      if (storedToken && storedExpiry && Date.now() < storedExpiry) {
        this.token = storedToken;
        this.tokenExpiry = storedExpiry;
      }
    }
    
    // Check if token is expired or missing
    if (!this.token || Date.now() >= this.tokenExpiry) {
      const result = await this.login();
      if (!result.success) {
        throw new Error('Authentication required. Please login first.');
      }
    }
    
    return this.token;
  }

  /**
   * Get list of tenant devices
   */
  async getDevices(pageSize = 10, page = 0) {
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.get(`${this.baseUrl}/api/tenant/devices`, {
        headers: { 'X-Authorization': `Bearer ${token}` },
        params: { pageSize, page }
      });
      
      return {
        success: true,
        devices: response.data.data,
        totalPages: response.data.totalPages,
        totalElements: response.data.totalElements,
        hasNext: response.data.hasNext
      };
    } catch (error) {
      logger.error('Failed to get devices:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get device by ID
   */
  async getDevice(deviceId) {
    this.validateParams({ deviceId }, {
      deviceId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.get(`${this.baseUrl}/api/device/${deviceId}`, {
        headers: { 'X-Authorization': `Bearer ${token}` }
      });
      
      return {
        success: true,
        device: response.data
      };
    } catch (error) {
      logger.error('Failed to get device:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Create a new device
   */
  async createDevice(name, type = 'default') {
    this.validateParams({ name }, {
      name: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const device = {
        name: name,
        type: type,
        label: name
      };
      
      const response = await axios.post(`${this.baseUrl}/api/device`, device, {
        headers: { 'X-Authorization': `Bearer ${token}` }
      });
      
      return {
        success: true,
        device: response.data,
        message: `Device '${name}' created successfully`
      };
    } catch (error) {
      logger.error('Failed to create device:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get device telemetry data
   */
  async getTelemetry(deviceId, keys, startTime, endTime) {
    this.validateParams({ deviceId }, {
      deviceId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const params = {
        keys: keys || '',
        startTs: startTime || Date.now() - 86400000, // Default: last 24 hours
        endTs: endTime || Date.now(),
        limit: 100
      };
      
      const response = await axios.get(
        `${this.baseUrl}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
        {
          headers: { 'X-Authorization': `Bearer ${token}` },
          params
        }
      );
      
      return {
        success: true,
        telemetry: response.data,
        deviceId: deviceId,
        timeRange: {
          start: new Date(params.startTs),
          end: new Date(params.endTs)
        }
      };
    } catch (error) {
      logger.error('Failed to get telemetry:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Post telemetry data to device
   */
  async postTelemetry(deviceId, data) {
    this.validateParams({ deviceId, data }, {
      deviceId: { required: true, type: 'string' },
      data: { required: true, type: 'object' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      // Get device access token first
      const deviceResponse = await axios.get(
        `${this.baseUrl}/api/device/${deviceId}/credentials`,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      const deviceToken = deviceResponse.data.credentialsId;
      
      // Post telemetry using device token
      await axios.post(
        `${this.baseUrl}/api/v1/${deviceToken}/telemetry`,
        data
      );
      
      return {
        success: true,
        message: 'Telemetry posted successfully',
        deviceId: deviceId,
        data: data
      };
    } catch (error) {
      logger.error('Failed to post telemetry:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get device attributes
   */
  async getAttributes(deviceId, scope = 'SHARED_SCOPE', keys) {
    this.validateParams({ deviceId }, {
      deviceId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      let url = `${this.baseUrl}/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/${scope}`;
      if (keys) {
        url += `?keys=${keys}`;
      }
      
      const response = await axios.get(url, {
        headers: { 'X-Authorization': `Bearer ${token}` }
      });
      
      return {
        success: true,
        attributes: response.data,
        deviceId: deviceId,
        scope: scope
      };
    } catch (error) {
      logger.error('Failed to get attributes:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Post device attributes
   */
  async postAttributes(deviceId, scope = 'SHARED_SCOPE', attributes) {
    this.validateParams({ deviceId, attributes }, {
      deviceId: { required: true, type: 'string' },
      attributes: { required: true, type: 'object' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      await axios.post(
        `${this.baseUrl}/api/plugins/telemetry/DEVICE/${deviceId}/${scope}`,
        attributes,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      return {
        success: true,
        message: 'Attributes posted successfully',
        deviceId: deviceId,
        scope: scope,
        attributes: attributes
      };
    } catch (error) {
      logger.error('Failed to post attributes:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Send RPC command to device
   */
  async sendRpcCommand(deviceId, method, params = {}) {
    this.validateParams({ deviceId, method }, {
      deviceId: { required: true, type: 'string' },
      method: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.post(
        `${this.baseUrl}/api/rpc/oneway/${deviceId}`,
        {
          method: method,
          params: params
        },
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      return {
        success: true,
        message: `RPC command '${method}' sent to device`,
        deviceId: deviceId,
        method: method,
        params: params
      };
    } catch (error) {
      logger.error('Failed to send RPC command:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Create a new device group
   */
  async createDeviceGroup(name, description = '') {
    this.validateParams({ name }, {
      name: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.post(
        `${this.baseUrl}/api/entityGroup`,
        {
          name: name,
          type: 'DEVICE',
          description: description
        },
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      return {
        success: true,
        group: response.data,
        message: `Device group '${name}' created successfully`
      };
    } catch (error) {
      logger.error('Failed to create device group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Update device group details
   */
  async updateDeviceGroup(groupId, name, description) {
    this.validateParams({ groupId }, {
      groupId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      // First get the existing group
      const getResponse = await axios.get(
        `${this.baseUrl}/api/entityGroup/${groupId}`,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      const group = getResponse.data;
      
      // Update fields if provided
      if (name) group.name = name;
      if (description !== undefined) group.description = description;
      
      const updateResponse = await axios.post(
        `${this.baseUrl}/api/entityGroup`,
        group,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      return {
        success: true,
        group: updateResponse.data,
        message: `Device group updated successfully`
      };
    } catch (error) {
      logger.error('Failed to update device group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Delete a device group
   */
  async deleteDeviceGroup(groupId) {
    this.validateParams({ groupId }, {
      groupId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      await axios.delete(
        `${this.baseUrl}/api/entityGroup/${groupId}`,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      return {
        success: true,
        message: `Device group '${groupId}' deleted successfully`
      };
    } catch (error) {
      logger.error('Failed to delete device group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get all device groups
   */
  async getDeviceGroups() {
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.get(
        `${this.baseUrl}/api/entityGroups/DEVICE?pageSize=1000&page=0`,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      const groups = response.data.data || [];
      
      return {
        success: true,
        groups: groups.map(group => ({
          id: group.id.id,
          name: group.name,
          description: group.description,
          type: group.type
        })),
        count: groups.length
      };
    } catch (error) {
      logger.error('Failed to get device groups:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Add devices to a group
   */
  async addDevicesToGroup(groupId, deviceIds) {
    this.validateParams({ groupId, deviceIds }, {
      groupId: { required: true, type: 'string' },
      deviceIds: { required: true, type: 'array' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      // Add each device to the group
      const results = await Promise.all(
        deviceIds.map(async (deviceId) => {
          try {
            await axios.post(
              `${this.baseUrl}/api/entities/DEVICE/${deviceId}/addToEntityGroup/${groupId}`,
              {},
              { headers: { 'X-Authorization': `Bearer ${token}` } }
            );
            return { deviceId, success: true };
          } catch (error) {
            return { 
              deviceId, 
              success: false, 
              error: error.response?.data?.message || error.message 
            };
          }
        })
      );
      
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success);
      
      return {
        success: succeeded > 0,
        message: `Added ${succeeded} device(s) to group`,
        succeeded: succeeded,
        failed: failed.length,
        failedDevices: failed
      };
    } catch (error) {
      logger.error('Failed to add devices to group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Remove devices from a group
   */
  async removeDevicesFromGroup(groupId, deviceIds) {
    this.validateParams({ groupId, deviceIds }, {
      groupId: { required: true, type: 'string' },
      deviceIds: { required: true, type: 'array' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      // Remove each device from the group
      const results = await Promise.all(
        deviceIds.map(async (deviceId) => {
          try {
            await axios.delete(
              `${this.baseUrl}/api/entities/DEVICE/${deviceId}/removeFromEntityGroup/${groupId}`,
              { headers: { 'X-Authorization': `Bearer ${token}` } }
            );
            return { deviceId, success: true };
          } catch (error) {
            return { 
              deviceId, 
              success: false, 
              error: error.response?.data?.message || error.message 
            };
          }
        })
      );
      
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success);
      
      return {
        success: succeeded > 0,
        message: `Removed ${succeeded} device(s) from group`,
        succeeded: succeeded,
        failed: failed.length,
        failedDevices: failed
      };
    } catch (error) {
      logger.error('Failed to remove devices from group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get all devices in a group
   */
  async getDeviceGroupDevices(groupId) {
    this.validateParams({ groupId }, {
      groupId: { required: true, type: 'string' }
    });
    
    try {
      const token = await this.ensureAuthenticated();
      
      const response = await axios.get(
        `${this.baseUrl}/api/entityGroup/${groupId}/entities?pageSize=1000&page=0`,
        { headers: { 'X-Authorization': `Bearer ${token}` } }
      );
      
      const devices = response.data.data || [];
      
      return {
        success: true,
        devices: devices.map(device => ({
          id: device.id.id,
          name: device.name,
          type: device.type,
          label: device.label
        })),
        count: devices.length
      };
    } catch (error) {
      logger.error('Failed to get devices in group:', error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  async getIntentMap() {
    return {
      'thingsboard': {
        priority: 0.8,
        handler: 'thingsboard',
        description: 'ThingsBoard IoT platform commands',
        examples: [
          'use thingsboard to get my devices',
          'thingsboard login',
          'show iot devices'
        ]
      }
    };
  }
}