import mongoose from 'mongoose';

/**
 * MQTT Device Registry
 * Stores discovered devices and their metadata
 * Supports Home Assistant MQTT Discovery protocol
 */
const mqttDeviceSchema = new mongoose.Schema({
  // Unique device identifier
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Associated broker
  brokerId: {
    type: String,
    required: true,
    index: true
  },

  // Device information
  name: {
    type: String,
    required: true
  },

  // Device type (sensor, switch, light, climate, etc.)
  type: {
    type: String,
    enum: ['sensor', 'binary_sensor', 'switch', 'light', 'climate', 'cover', 'fan', 'lock', 'vacuum', 'camera', 'media_player', 'other'],
    default: 'other'
  },

  // Discovery method
  discoveryMethod: {
    type: String,
    enum: ['manual', 'homeassistant', 'tasmota', 'zigbee2mqtt', 'auto'],
    default: 'manual'
  },

  // Home Assistant discovery config (if discovered via HA protocol)
  haDiscovery: {
    component: String,        // e.g., 'sensor', 'switch'
    objectId: String,         // Unique object ID
    discoveryTopic: String,   // Topic where discovery was found
    config: mongoose.Schema.Types.Mixed  // Full HA discovery payload
  },

  // Topics associated with this device
  topics: {
    state: String,           // Topic to read state from
    command: String,         // Topic to send commands to
    availability: String,    // Topic for online/offline status
    attributes: String       // Topic for additional attributes
  },

  // Current state
  state: {
    value: mongoose.Schema.Types.Mixed,
    lastUpdated: Date,
    available: { type: Boolean, default: true }
  },

  // Device attributes (manufacturer, model, firmware, etc.)
  attributes: {
    manufacturer: String,
    model: String,
    swVersion: String,
    hwVersion: String,
    identifiers: [String],
    connections: mongoose.Schema.Types.Mixed,
    viaDevice: String,       // Parent device ID
    customAttributes: mongoose.Schema.Types.Mixed
  },

  // Unit of measurement (for sensors)
  unit: String,

  // Device class (for HA compatibility)
  deviceClass: String,

  // Icon (for UI)
  icon: String,

  // Enabled for automation
  automationEnabled: {
    type: Boolean,
    default: true
  },

  // Tags for grouping/filtering
  tags: [String],

  // Room/location
  location: {
    room: String,
    floor: String,
    zone: String
  },

  // Lifecycle state for device fleet management
  lifecycleState: {
    type: String,
    enum: ['active', 'inactive', 'decommissioned'],
    default: 'active',
    index: true
  },

  // Metadata
  description: String,

  // Statistics
  stats: {
    messageCount: { type: Number, default: 0 },
    lastMessageAt: Date,
    errorCount: { type: Number, default: 0 },
    lastErrorAt: Date,
    lastError: String
  },

  // Device status history
  statusHistory: [{
    status: String,
    timestamp: { type: Date, default: Date.now },
    details: mongoose.Schema.Types.Mixed
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp on save
mqttDeviceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Indexes for efficient queries
mqttDeviceSchema.index({ brokerId: 1, type: 1 });
mqttDeviceSchema.index({ 'topics.state': 1 });
mqttDeviceSchema.index({ 'location.room': 1 });
mqttDeviceSchema.index({ tags: 1 });
mqttDeviceSchema.index({ automationEnabled: 1 });
mqttDeviceSchema.index({ 'statusHistory.timestamp': -1 });

// Virtual for full topic path
mqttDeviceSchema.virtual('stateTopic').get(function() {
  return this.topics?.state;
});

/**
 * Add a new status entry to the device's status history
 * @param {String} status - The new status of the device
 * @param {Object} details - Additional details about the status change
 */
mqttDeviceSchema.methods.addStatusHistory = async function(status, details = {}) {
  this.statusHistory.push({ status, details });
  await this.save();
};

/**
 * Retrieve the device's status history
 * @param {Number} limit - The maximum number of history entries to retrieve
 * @returns {Array} - An array of status history entries
 */
mqttDeviceSchema.methods.getStatusHistory = function(limit = 10) {
  return this.statusHistory.slice(-limit).reverse();
};

/**
 * Transition the device to a new lifecycle state
 * @param {String} newState - 'active', 'inactive', or 'decommissioned'
 */
mqttDeviceSchema.methods.transitionLifecycleState = async function(newState) {
  if (!['active', 'inactive', 'decommissioned'].includes(newState)) {
    throw new Error(`Invalid lifecycle state: ${newState}`);
  }
  this.lifecycleState = newState;
  this.statusHistory.push({ status: `Lifecycle: ${newState}`, details: {} });
  await this.save();
};

export default mongoose.model('MqttDevice', mqttDeviceSchema);