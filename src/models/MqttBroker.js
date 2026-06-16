import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

/**
 * MQTT Broker Connection Configuration
 * Stores settings for both the built-in broker and external connections
 */
const mqttBrokerSchema = new mongoose.Schema({
  // Unique identifier for this broker connection
  brokerId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Display name
  name: {
    type: String,
    required: true
  },

  // Type: 'internal' (built-in Aedes) or 'external' (remote broker)
  type: {
    type: String,
    enum: ['internal', 'external'],
    required: true
  },

  // Connection enabled/disabled
  enabled: {
    type: Boolean,
    default: true
  },

  // Connection settings (for external brokers)
  connection: {
    host: { type: String, default: 'localhost' },
    port: { type: Number, default: 1883 },
    protocol: { type: String, enum: ['mqtt', 'mqtts', 'ws', 'wss'], default: 'mqtt' },
    username: String,
    password: String,  // Will be encrypted
    clientId: String,
    keepalive: { type: Number, default: 60 },
    reconnectPeriod: { type: Number, default: 5000 },
    connectTimeout: { type: Number, default: 30000 }
  },

  // TLS settings
  tls: {
    enabled: { type: Boolean, default: false },
    rejectUnauthorized: { type: Boolean, default: true },
    ca: String,      // CA certificate
    cert: String,    // Client certificate
    key: String      // Client key
  },

  // Internal broker settings (only for type: 'internal')
  brokerSettings: {
    port: { type: Number, default: 1883 },
    wsPort: { type: Number, default: 8883 },  // WebSocket port
    requireAuth: { type: Boolean, default: false },
    maxConnections: { type: Number, default: 100 },
    allowedUsers: [{
      username: String,
      password: String,  // Hashed
      acl: [{
        topic: String,
        permissions: { type: String, enum: ['read', 'write', 'readwrite'], default: 'readwrite' }
      }]
    }]
  },

  // Topics to subscribe to (for external brokers)
  subscriptions: [{
    topic: String,       // Supports wildcards: home/+/temperature, sensors/#
    qos: { type: Number, enum: [0, 1, 2], default: 0 },
    handler: { type: String, enum: ['store', 'process', 'forward', 'ignore'], default: 'store' }
  }],

  // Connection status (runtime, not persisted on restart)
  status: {
    connected: { type: Boolean, default: false },
    lastConnected: Date,
    lastDisconnected: Date,
    lastError: String,
    clientCount: { type: Number, default: 0 },  // For internal broker
    messagesReceived: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 }
  },

  // Metadata
  description: String,
  tags: [String],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp on save
mqttBrokerSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Indexes
mqttBrokerSchema.index({ type: 1 });
mqttBrokerSchema.index({ enabled: 1 });

/**
 * Add a new subscription to the broker
 * @param {Object} subscription - The subscription object containing topic, qos, and handler
 */
mqttBrokerSchema.methods.addSubscription = async function(subscription) {
  try {
    this.subscriptions.push(subscription);
    await this.save();
    logger.info(`Subscription added: ${subscription.topic}`);
  } catch (error) {
    logger.error(`Failed to add subscription: ${error.message}`);
    throw error;
  }
};

/**
 * Remove a subscription from the broker
 * @param {String} topic - The topic of the subscription to remove
 */
mqttBrokerSchema.methods.removeSubscription = async function(topic) {
  try {
    this.subscriptions = this.subscriptions.filter(sub => sub.topic !== topic);
    await this.save();
    logger.info(`Subscription removed: ${topic}`);
  } catch (error) {
    logger.error(`Failed to remove subscription: ${error.message}`);
    throw error;
  }
};

/**
 * Update an existing subscription
 * @param {String} topic - The topic of the subscription to update
 * @param {Object} updates - The updates to apply to the subscription
 */
mqttBrokerSchema.methods.updateSubscription = async function(topic, updates) {
  try {
    const subscription = this.subscriptions.find(sub => sub.topic === topic);
    if (!subscription) {
      throw new Error(`Subscription not found for topic: ${topic}`);
    }
    Object.assign(subscription, updates);
    await this.save();
    logger.info(`Subscription updated: ${topic}`);
  } catch (error) {
    logger.error(`Failed to update subscription: ${error.message}`);
    throw error;
  }
};

export default mongoose.model('MqttBroker', mqttBrokerSchema);
