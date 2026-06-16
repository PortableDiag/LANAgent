import express from 'express';
import { authenticateToken } from './auth.js';
import mqttService from '../../services/mqtt/mqttService.js';
import eventEngine from '../../services/mqtt/eventEngine.js';
import MqttBroker from '../../models/MqttBroker.js';
import MqttDevice from '../../models/MqttDevice.js';
import MqttState from '../../models/MqttState.js';
import MqttHistory from '../../models/MqttHistory.js';
import EventRule from '../../models/EventRule.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * MQTT & Automation Web Interface Routes
 * Provides REST API for managing MQTT brokers, devices, and automation rules
 */

// ==================== Service Status ====================

// Get overall MQTT service status
router.get('/api/status', authenticateToken, async (req, res) => {
  try {
    const mqttStats = mqttService.getStats();
    const engineStats = eventEngine.getStats();

    const brokers = await MqttBroker.find({}).lean();
    const deviceCount = await MqttDevice.countDocuments();
    const ruleCount = await EventRule.countDocuments({ enabled: true });

    res.json({
      success: true,
      mqtt: {
        enabled: mqttService.enabled,
        ...mqttStats
      },
      eventEngine: {
        enabled: eventEngine.enabled,
        ...engineStats
      },
      brokerCount: brokers.length,
      connectedBrokers: brokers.filter(b => b.status?.connected).length,
      deviceCount,
      activeRuleCount: ruleCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('MQTT status API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Broker Management ====================

// Get all brokers
router.get('/api/brokers', authenticateToken, async (req, res) => {
  try {
    const brokers = await MqttBroker.find({}).lean();
    res.json({ success: true, brokers });
  } catch (error) {
    logger.error('Get brokers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single broker
router.get('/api/brokers/:brokerId', authenticateToken, async (req, res) => {
  try {
    const broker = await MqttBroker.findOne({ brokerId: req.params.brokerId }).lean();
    if (!broker) {
      return res.status(404).json({ success: false, error: 'Broker not found' });
    }
    res.json({ success: true, broker });
  } catch (error) {
    logger.error('Get broker error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create or update broker
router.post('/api/brokers', authenticateToken, async (req, res) => {
  try {
    const brokerData = req.body;
    if (!brokerData.brokerId) {
      brokerData.brokerId = `broker_${Date.now()}`;
    }

    const broker = await mqttService.saveBroker(brokerData);
    res.json({ success: true, broker });
  } catch (error) {
    logger.error('Save broker error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update broker
router.put('/api/brokers/:brokerId', authenticateToken, async (req, res) => {
  try {
    const broker = await MqttBroker.findOneAndUpdate(
      { brokerId: req.params.brokerId },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );

    if (!broker) {
      return res.status(404).json({ success: false, error: 'Broker not found' });
    }

    res.json({ success: true, broker });
  } catch (error) {
    logger.error('Update broker error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete broker
router.delete('/api/brokers/:brokerId', authenticateToken, async (req, res) => {
  try {
    await mqttService.deleteBroker(req.params.brokerId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete broker error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle broker enabled state
router.post('/api/brokers/:brokerId/toggle', authenticateToken, async (req, res) => {
  try {
    const broker = await MqttBroker.findOne({ brokerId: req.params.brokerId });
    if (!broker) {
      return res.status(404).json({ success: false, error: 'Broker not found' });
    }

    broker.enabled = !broker.enabled;
    await broker.save();

    // Connect or disconnect based on new state
    if (broker.enabled) {
      if (broker.type === 'internal') {
        await mqttService.startInternalBroker(broker);
      } else {
        await mqttService.connectExternalBroker(broker);
      }
    } else {
      if (broker.type === 'internal') {
        await mqttService.stopInternalBroker();
      } else {
        await mqttService.disconnectExternalBroker(broker.brokerId);
      }
    }

    res.json({ success: true, enabled: broker.enabled });
  } catch (error) {
    logger.error('Toggle broker error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Device Management ====================

// Get all devices
router.get('/api/devices', authenticateToken, async (req, res) => {
  try {
    const { type, room, brokerId, available } = req.query;
    const filter = {};

    if (type) filter.type = type;
    if (room) filter['location.room'] = room;
    if (brokerId) filter.brokerId = brokerId;
    if (available !== undefined) filter['state.available'] = available === 'true';

    const devices = await MqttDevice.find(filter).lean();

    // Enrich with current states
    const enrichedDevices = await Promise.all(devices.map(async (device) => {
      if (device.topics?.state) {
        const state = await MqttState.findOne({ topic: device.topics.state }).lean();
        device.currentState = state?.payload?.parsed ?? state?.payload?.raw;
        device.stateLastUpdated = state?.receivedAt;
      }
      return device;
    }));

    res.json({ success: true, devices: enrichedDevices });
  } catch (error) {
    logger.error('Get devices error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single device
router.get('/api/devices/:deviceId', authenticateToken, async (req, res) => {
  try {
    const device = await MqttDevice.findOne({ deviceId: req.params.deviceId }).lean();
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Get current state
    if (device.topics?.state) {
      const state = await MqttState.findOne({ topic: device.topics.state }).lean();
      device.currentState = state?.payload?.parsed ?? state?.payload?.raw;
      device.stateLastUpdated = state?.receivedAt;
    }

    res.json({ success: true, device });
  } catch (error) {
    logger.error('Get device error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update device
router.put('/api/devices/:deviceId', authenticateToken, async (req, res) => {
  try {
    const device = await MqttDevice.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );

    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    res.json({ success: true, device });
  } catch (error) {
    logger.error('Update device error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete device
router.delete('/api/devices/:deviceId', authenticateToken, async (req, res) => {
  try {
    await MqttDevice.deleteOne({ deviceId: req.params.deviceId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete device error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send command to device
router.post('/api/devices/:deviceId/command', authenticateToken, async (req, res) => {
  try {
    const { command } = req.body;
    await mqttService.sendDeviceCommand(req.params.deviceId, command);
    res.json({ success: true, message: 'Command sent' });
  } catch (error) {
    logger.error('Send device command error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get device history
router.get('/api/devices/:deviceId/history', authenticateToken, async (req, res) => {
  try {
    const { hours = 24, aggregation } = req.query;
    const device = await MqttDevice.findOne({ deviceId: req.params.deviceId }).lean();

    if (!device?.topics?.state) {
      return res.status(404).json({ success: false, error: 'Device has no state topic' });
    }

    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const history = await MqttHistory.getTimeSeries(device.topics.state, {
      startTime,
      aggregation: aggregation || null
    });

    res.json({ success: true, history });
  } catch (error) {
    logger.error('Get device history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Topic State ====================

// Get topic state
router.get('/api/state', authenticateToken, async (req, res) => {
  try {
    const { topic, pattern } = req.query;

    if (!topic && !pattern) {
      return res.status(400).json({ success: false, error: 'Topic or pattern required' });
    }

    let states;
    if (pattern) {
      states = await MqttState.findByPattern(pattern);
    } else {
      const state = await mqttService.getState(topic);
      states = state ? [state] : [];
    }

    res.json({ success: true, states });
  } catch (error) {
    logger.error('Get state error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all states (with pagination)
router.get('/api/states', authenticateToken, async (req, res) => {
  try {
    const { limit = 100, offset = 0, brokerId } = req.query;
    const filter = {};
    if (brokerId) filter.brokerId = brokerId;

    const states = await MqttState.find(filter)
      .sort({ receivedAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .lean();

    const total = await MqttState.countDocuments(filter);

    res.json({ success: true, states, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    logger.error('Get states error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Publishing ====================

// Publish message
router.post('/api/publish', authenticateToken, async (req, res) => {
  try {
    const { topic, payload, qos = 0, retain = false, brokerId } = req.body;

    if (!topic) {
      return res.status(400).json({ success: false, error: 'Topic required' });
    }

    await mqttService.publish(topic, payload, { qos, retain, brokerId });
    res.json({ success: true, message: 'Published' });
  } catch (error) {
    logger.error('Publish error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Automation Rules ====================

// Get all rules
router.get('/api/rules', authenticateToken, async (req, res) => {
  try {
    const { enabled, triggerType, category } = req.query;
    const filter = {};

    if (enabled !== undefined) filter.enabled = enabled === 'true';
    if (triggerType) filter.triggerType = triggerType;
    if (category) filter.category = category;

    const rules = await EventRule.find(filter).sort({ priority: -1 }).lean();
    res.json({ success: true, rules });
  } catch (error) {
    logger.error('Get rules error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single rule
router.get('/api/rules/:ruleId', authenticateToken, async (req, res) => {
  try {
    const rule = await EventRule.findOne({ ruleId: req.params.ruleId }).lean();
    if (!rule) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }
    res.json({ success: true, rule });
  } catch (error) {
    logger.error('Get rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create rule
router.post('/api/rules', authenticateToken, async (req, res) => {
  try {
    const ruleData = req.body;
    if (!ruleData.ruleId) {
      ruleData.ruleId = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    const rule = await eventEngine.addRule(ruleData);
    res.json({ success: true, rule });
  } catch (error) {
    logger.error('Create rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update rule
router.put('/api/rules/:ruleId', authenticateToken, async (req, res) => {
  try {
    const rule = await eventEngine.updateRule(req.params.ruleId, req.body);
    res.json({ success: true, rule });
  } catch (error) {
    logger.error('Update rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete rule
router.delete('/api/rules/:ruleId', authenticateToken, async (req, res) => {
  try {
    await eventEngine.deleteRule(req.params.ruleId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle rule enabled state
router.post('/api/rules/:ruleId/toggle', authenticateToken, async (req, res) => {
  try {
    const rule = await EventRule.findOne({ ruleId: req.params.ruleId });
    if (!rule) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    rule.enabled = !rule.enabled;
    await rule.save();

    // Reload rules in engine
    await eventEngine.loadRules();

    res.json({ success: true, enabled: rule.enabled });
  } catch (error) {
    logger.error('Toggle rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger rule manually
router.post('/api/rules/:ruleId/trigger', authenticateToken, async (req, res) => {
  try {
    await eventEngine.triggerRule(req.params.ruleId);
    res.json({ success: true, message: 'Rule triggered' });
  } catch (error) {
    logger.error('Trigger rule error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== History ====================

// Get message history
router.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const { topic, hours = 24, limit = 1000, aggregation } = req.query;

    if (!topic) {
      return res.status(400).json({ success: false, error: 'Topic required' });
    }

    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const history = await MqttHistory.getTimeSeries(topic, {
      startTime,
      limit: parseInt(limit),
      aggregation: aggregation || null
    });

    res.json({ success: true, history });
  } catch (error) {
    logger.error('Get history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get topic statistics
router.get('/api/history/stats', authenticateToken, async (req, res) => {
  try {
    const { topic, hours = 24 } = req.query;

    if (!topic) {
      return res.status(400).json({ success: false, error: 'Topic required' });
    }

    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const stats = await MqttHistory.getStatistics(topic, startTime, new Date());

    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
