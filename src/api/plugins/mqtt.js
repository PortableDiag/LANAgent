import { BasePlugin } from '../core/basePlugin.js';
import mqttService from '../../services/mqtt/mqttService.js';
import eventEngine from '../../services/mqtt/eventEngine.js';
import MqttBroker from '../../models/MqttBroker.js';
import MqttDevice from '../../models/MqttDevice.js';
import MqttState from '../../models/MqttState.js';
import MqttHistory from '../../models/MqttHistory.js';
import EventRule from '../../models/EventRule.js';
import { logger } from '../../utils/logger.js';

/**
 * MQTT Plugin
 * Provides natural language interface for MQTT operations and automation rules
 * Note: Actual automation runs via Event Engine with NO AI in the hot path
 */
export default class MqttPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'mqtt';
    this.version = '1.0.0';
    this.description = 'Control IoT devices, query sensor states, and manage home automation rules via MQTT';

    this.commands = [
      {
        command: 'get-devices',
        description: 'Get list of all discovered MQTT devices with their current states',
        usage: 'get-devices({ type: "sensor", room: "living_room" })'
      },
      {
        command: 'get-device-state',
        description: 'Get the current state and recent history of a specific device',
        usage: 'get-device-state({ deviceId: "temperature_1", includeHistory: true })'
      },
      {
        command: 'send-command',
        description: 'Send a command to an MQTT device (turn on/off lights, etc.)',
        usage: 'send-command({ deviceId: "light_1", command: "ON" })'
      },
      {
        command: 'publish',
        description: 'Publish a message to an MQTT topic directly',
        usage: 'publish({ topic: "home/living_room/light", payload: "ON", retain: false })'
      },
      {
        command: 'get-topic-state',
        description: 'Get the current state of a specific MQTT topic',
        usage: 'get-topic-state({ topic: "home/+/temperature" })'
      },
      {
        command: 'get-rules',
        description: 'Get list of all automation rules',
        usage: 'get-rules({ enabled: true, triggerType: "mqtt" })'
      },
      {
        command: 'create-rule',
        description: 'Create a new automation rule (IF-THEN)',
        usage: 'create-rule({ name: "Motion light", triggerType: "mqtt", triggerTopic: "home/+/motion", actions: [...] })'
      },
      {
        command: 'update-rule',
        description: 'Update an existing automation rule',
        usage: 'update-rule({ ruleId: "rule_123", enabled: false })'
      },
      {
        command: 'delete-rule',
        description: 'Delete an automation rule',
        usage: 'delete-rule({ ruleId: "rule_123" })'
      },
      {
        command: 'trigger-rule',
        description: 'Manually trigger an automation rule for testing',
        usage: 'trigger-rule({ ruleId: "rule_123" })'
      },
      {
        command: 'get-brokers',
        description: 'Get list of configured MQTT brokers',
        usage: 'get-brokers()'
      },
      {
        command: 'get-status',
        description: 'Get MQTT service and Event Engine status',
        usage: 'get-status()'
      }
    ];

    this.settings = {
      enabled: true,
      priority: 50
    };
  }

  async initialize() {
    logger.info('MQTT plugin initialized');
    return true;
  }

  /**
   * Execute a plugin command
   */
  async execute(command, params = {}) {
    switch (command) {
      case 'get-devices':
        return this.getDevices(params);
      case 'get-device-state':
        return this.getDeviceState(params);
      case 'send-command':
        return this.sendCommand(params);
      case 'publish':
        return this.publish(params);
      case 'get-topic-state':
        return this.getTopicState(params);
      case 'get-rules':
        return this.getRules(params);
      case 'create-rule':
        return this.createRule(params);
      case 'update-rule':
        return this.updateRule(params);
      case 'delete-rule':
        return this.deleteRule(params);
      case 'trigger-rule':
        return this.triggerRule(params);
      case 'get-brokers':
        return this.getBrokers(params);
      case 'get-status':
        return this.getStatus(params);
      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  }

  /**
   * Get list of all discovered MQTT devices
   */
  async getDevices({ type, room, brokerId } = {}) {
    try {
      const filter = {};
      if (type) filter.type = type;
      if (room) filter['location.room'] = room;
      if (brokerId) filter.brokerId = brokerId;

      const devices = await MqttDevice.find(filter).lean();

      // Enrich with current states
      const enrichedDevices = await Promise.all(devices.map(async (device) => {
        let currentState = null;
        if (device.topics?.state) {
          const state = await MqttState.findOne({ topic: device.topics.state }).lean();
          currentState = state?.payload?.parsed ?? state?.payload?.raw;
        }

        return {
          deviceId: device.deviceId,
          name: device.name,
          type: device.type,
          room: device.location?.room,
          currentState,
          available: device.state?.available !== false,
          lastUpdated: device.state?.lastUpdated
        };
      }));

      return {
        success: true,
        count: enrichedDevices.length,
        devices: enrichedDevices
      };
    } catch (error) {
      logger.error('Error getting MQTT devices:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device state with optional history
   */
  async getDeviceState({ deviceId, includeHistory = false }) {
    try {
      const device = await MqttDevice.findOne({ deviceId }).lean();
      if (!device) {
        return { success: false, error: 'Device not found' };
      }

      let currentState = null;
      let history = [];

      if (device.topics?.state) {
        const state = await MqttState.findOne({ topic: device.topics.state }).lean();
        currentState = {
          value: state?.payload?.parsed ?? state?.payload?.raw,
          type: state?.payload?.type,
          lastUpdated: state?.receivedAt,
          updateCount: state?.stats?.updateCount
        };

        if (includeHistory) {
          history = await MqttHistory.getTimeSeries(device.topics.state, {
            limit: 100,
            aggregation: 'hour'
          });
        }
      }

      return {
        success: true,
        device: {
          deviceId: device.deviceId,
          name: device.name,
          type: device.type,
          room: device.location?.room,
          manufacturer: device.attributes?.manufacturer,
          model: device.attributes?.model
        },
        currentState,
        history: includeHistory ? history : undefined
      };
    } catch (error) {
      logger.error('Error getting device state:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send command to device
   */
  async sendCommand({ deviceId, command }) {
    try {
      await mqttService.sendDeviceCommand(deviceId, command);
      return {
        success: true,
        message: `Command sent to ${deviceId}: ${command}`
      };
    } catch (error) {
      logger.error('Error sending device command:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Publish to MQTT topic
   */
  async publish({ topic, payload, retain = false, brokerId }) {
    try {
      await mqttService.publish(topic, payload, { brokerId, retain });
      return {
        success: true,
        message: `Published to ${topic}`
      };
    } catch (error) {
      logger.error('Error publishing message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get topic state
   */
  async getTopicState({ topic }) {
    try {
      let states;
      if (topic.includes('+') || topic.includes('#')) {
        states = await MqttState.findByPattern(topic);
      } else {
        const state = await mqttService.getState(topic);
        states = state ? [state] : [];
      }

      return {
        success: true,
        count: states.length,
        states: states.map(s => ({
          topic: s.topic,
          value: s.payload?.parsed ?? s.payload?.raw,
          type: s.payload?.type,
          lastUpdated: s.receivedAt
        }))
      };
    } catch (error) {
      logger.error('Error getting topic state:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get automation rules
   */
  async getRules({ enabled, triggerType } = {}) {
    try {
      const filter = {};
      if (enabled !== undefined) filter.enabled = enabled;
      if (triggerType) filter.triggerType = triggerType;

      const rules = await EventRule.find(filter).sort({ priority: -1 }).lean();

      return {
        success: true,
        count: rules.length,
        rules: rules.map(r => ({
          ruleId: r.ruleId,
          name: r.name,
          description: r.description,
          enabled: r.enabled,
          triggerType: r.triggerType,
          triggerTopic: r.mqttTrigger?.topic,
          conditionCount: r.conditions?.length || 0,
          actionCount: r.actions?.length || 0,
          fireCount: r.stats?.fireCount || 0,
          lastFired: r.stats?.lastFiredAt
        }))
      };
    } catch (error) {
      logger.error('Error getting automation rules:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create automation rule
   */
  async createRule({ name, description, triggerType, triggerTopic, triggerCron, payloadFilter, actions, enabled = true }) {
    try {
      const ruleData = {
        ruleId: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name,
        description,
        enabled,
        triggerType,
        priority: 0
      };

      // Set up trigger
      if (triggerType === 'mqtt') {
        ruleData.mqttTrigger = {
          topic: triggerTopic,
          payloadFilter: payloadFilter ? {
            type: payloadFilter.type,
            value: payloadFilter.value,
            operator: payloadFilter.operator
          } : undefined
        };
      } else if (triggerType === 'schedule') {
        ruleData.scheduleTrigger = {
          cron: triggerCron,
          timezone: 'UTC'
        };
      }

      // Set up actions
      ruleData.actions = actions.map(a => {
        const action = { type: a.type };
        if (a.type === 'mqtt_publish') {
          action.mqttPublish = {
            topic: a.topic,
            payload: a.payload,
            retain: false
          };
        } else if (a.type === 'device_command') {
          action.deviceCommand = {
            deviceId: a.deviceId,
            command: a.command
          };
        } else if (a.type === 'notify') {
          action.notify = {
            channel: 'push',
            message: a.message
          };
        }
        return action;
      });

      const rule = await eventEngine.addRule(ruleData);

      return {
        success: true,
        message: `Created automation rule: ${name}`,
        ruleId: rule.ruleId
      };
    } catch (error) {
      logger.error('Error creating automation rule:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update automation rule
   */
  async updateRule({ ruleId, enabled, name, description }) {
    try {
      const updates = {};
      if (enabled !== undefined) updates.enabled = enabled;
      if (name) updates.name = name;
      if (description) updates.description = description;

      const rule = await eventEngine.updateRule(ruleId, updates);

      return {
        success: true,
        message: `Updated rule: ${rule.name}`,
        rule: {
          ruleId: rule.ruleId,
          name: rule.name,
          enabled: rule.enabled
        }
      };
    } catch (error) {
      logger.error('Error updating automation rule:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete automation rule
   */
  async deleteRule({ ruleId }) {
    try {
      await eventEngine.deleteRule(ruleId);
      return {
        success: true,
        message: `Deleted rule: ${ruleId}`
      };
    } catch (error) {
      logger.error('Error deleting automation rule:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Trigger rule manually
   */
  async triggerRule({ ruleId }) {
    try {
      await eventEngine.triggerRule(ruleId);
      return {
        success: true,
        message: `Triggered rule: ${ruleId}`
      };
    } catch (error) {
      logger.error('Error triggering rule:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get broker list
   */
  async getBrokers() {
    try {
      const brokers = await MqttBroker.find({}).lean();

      return {
        success: true,
        count: brokers.length,
        brokers: brokers.map(b => ({
          brokerId: b.brokerId,
          name: b.name,
          type: b.type,
          enabled: b.enabled,
          connected: b.status?.connected,
          host: b.type === 'external' ? b.connection?.host : 'localhost',
          port: b.type === 'external' ? b.connection?.port : b.brokerSettings?.port,
          clientCount: b.status?.clientCount,
          messagesReceived: b.status?.messagesReceived
        }))
      };
    } catch (error) {
      logger.error('Error getting brokers:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    try {
      const mqttStats = mqttService.getStats();
      const engineStats = eventEngine.getStats();

      return {
        success: true,
        mqtt: mqttStats,
        eventEngine: engineStats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error getting service status:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle natural language queries for MQTT/IoT control
   */
  async handleNaturalLanguage(query) {
    const lowerQuery = query.toLowerCase();

    // Device state queries
    if ((lowerQuery.includes('device') || lowerQuery.includes('sensor')) &&
        (lowerQuery.includes('list') || lowerQuery.includes('show') || lowerQuery.includes('get') || lowerQuery.includes('what'))) {

      // Filter by type if mentioned
      let type = null;
      if (lowerQuery.includes('light')) type = 'light';
      else if (lowerQuery.includes('sensor')) type = 'sensor';
      else if (lowerQuery.includes('switch')) type = 'switch';
      else if (lowerQuery.includes('climate') || lowerQuery.includes('thermostat')) type = 'climate';

      return await this.getDevices({ type });
    }

    // Get specific device state
    const deviceStateMatch = lowerQuery.match(/(?:what(?:'s| is)?|get|check)\s+(?:the\s+)?(?:state|status|value)\s+(?:of\s+)?(?:the\s+)?(.+?)(?:\s+device)?$/i);
    if (deviceStateMatch) {
      const deviceName = deviceStateMatch[1].trim();
      const devices = await MqttDevice.find({}).lean();
      const device = devices.find(d =>
        d.name.toLowerCase().includes(deviceName) ||
        d.deviceId.toLowerCase().includes(deviceName)
      );
      if (device) {
        return await this.getDeviceState({ deviceId: device.deviceId, includeHistory: false });
      }
    }

    // Temperature/sensor specific queries
    if (lowerQuery.includes('temperature') || lowerQuery.includes('humidity')) {
      const roomMatch = lowerQuery.match(/(?:in|for)\s+(?:the\s+)?(.+?)(?:\s+room)?$/i);
      const room = roomMatch ? roomMatch[1].trim() : null;

      const filter = { type: 'sensor' };
      if (room) filter['location.room'] = { $regex: room, $options: 'i' };

      const devices = await MqttDevice.find(filter).lean();
      const results = [];

      for (const device of devices) {
        if (device.topics?.state) {
          const state = await MqttState.findOne({ topic: device.topics.state }).lean();
          if (state) {
            results.push({
              name: device.name,
              room: device.location?.room,
              value: state.payload?.parsed ?? state.payload?.raw,
              unit: device.unit,
              lastUpdated: state.receivedAt
            });
          }
        }
      }

      return { success: true, sensors: results, count: results.length };
    }

    // Turn on/off commands
    const turnMatch = lowerQuery.match(/turn\s+(on|off)\s+(?:the\s+)?(.+)/i);
    if (turnMatch) {
      const command = turnMatch[1].toUpperCase();
      const deviceName = turnMatch[2].trim();

      const devices = await MqttDevice.find({}).lean();
      const device = devices.find(d =>
        d.name.toLowerCase().includes(deviceName) ||
        d.deviceId.toLowerCase().includes(deviceName)
      );

      if (device) {
        return await this.sendCommand({ deviceId: device.deviceId, command });
      }
      return { success: false, error: `Device "${deviceName}" not found` };
    }

    // Set commands (e.g., "set bedroom light to 50%")
    const setMatch = lowerQuery.match(/set\s+(?:the\s+)?(.+?)\s+to\s+(.+)/i);
    if (setMatch) {
      const deviceName = setMatch[1].trim();
      const value = setMatch[2].trim();

      const devices = await MqttDevice.find({}).lean();
      const device = devices.find(d =>
        d.name.toLowerCase().includes(deviceName) ||
        d.deviceId.toLowerCase().includes(deviceName)
      );

      if (device) {
        return await this.sendCommand({ deviceId: device.deviceId, command: value });
      }
      return { success: false, error: `Device "${deviceName}" not found` };
    }

    // Rule management
    if (lowerQuery.includes('rule') || lowerQuery.includes('automation')) {
      if (lowerQuery.includes('list') || lowerQuery.includes('show') || lowerQuery.includes('get')) {
        return await this.getRules({});
      }

      if (lowerQuery.includes('create') || lowerQuery.includes('add') || lowerQuery.includes('make')) {
        // Return guidance on creating rules
        return {
          success: true,
          message: 'To create an automation rule, provide: name, trigger (mqtt topic or schedule), conditions, and actions',
          example: {
            name: 'Motion Light',
            triggerType: 'mqtt',
            triggerTopic: 'home/+/motion',
            actions: [{ type: 'device_command', deviceId: 'light_1', command: 'ON' }]
          }
        };
      }
    }

    // Broker status
    if (lowerQuery.includes('broker') || lowerQuery.includes('mqtt status') || lowerQuery.includes('mqtt service')) {
      return await this.getStatus();
    }

    // Publish message
    const publishMatch = lowerQuery.match(/publish\s+['"]?(.+?)['"]?\s+to\s+(?:topic\s+)?['"]?([^'"]+)['"]?/i);
    if (publishMatch) {
      return await this.publish({
        topic: publishMatch[2].trim(),
        payload: publishMatch[1].trim()
      });
    }

    // Default response with capabilities
    return {
      success: true,
      message: "I can help with MQTT/IoT control. Try asking me to:",
      capabilities: [
        "List devices - 'show all devices' or 'list sensors'",
        "Get device state - 'what's the temperature in the bedroom'",
        "Control devices - 'turn on the living room light'",
        "Manage rules - 'show automation rules' or 'create a rule'",
        "Check status - 'show mqtt status'",
        "Publish messages - 'publish ON to topic home/light/command'"
      ]
    };
  }
}
