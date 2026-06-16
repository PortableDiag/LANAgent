import mongoose from 'mongoose';

/**
 * MQTT State Store
 * Stores the latest state for each topic
 * Provides fast lookups for current device states
 */
const mqttStateSchema = new mongoose.Schema({
  // Topic path (unique key)
  topic: {
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

  // Associated device (if known)
  deviceId: {
    type: String,
    sparse: true,
    index: true
  },

  // Current payload
  payload: {
    raw: String,              // Raw string payload
    parsed: mongoose.Schema.Types.Mixed,  // Parsed JSON (if applicable)
    type: { type: String, enum: ['string', 'json', 'number', 'boolean', 'binary'], default: 'string' }
  },

  // QoS level of last message
  qos: {
    type: Number,
    enum: [0, 1, 2],
    default: 0
  },

  // Retain flag
  retained: {
    type: Boolean,
    default: false
  },

  // Timestamps
  receivedAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // Previous value (for change detection)
  previousPayload: {
    raw: String,
    parsed: mongoose.Schema.Types.Mixed,
    changedAt: Date
  },

  // Statistics
  stats: {
    updateCount: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    changeCount: { type: Number, default: 0 }  // Times the value actually changed
  },

  // Metadata extracted from topic
  topicMetadata: {
    segments: [String],       // Topic split by /
    baseTopic: String,        // First segment
    leafTopic: String         // Last segment
  }
});

// Pre-save hook to parse topic metadata
mqttStateSchema.pre('save', function(next) {
  if (this.topic) {
    const segments = this.topic.split('/');
    this.topicMetadata = {
      segments,
      baseTopic: segments[0],
      leafTopic: segments[segments.length - 1]
    };
  }
  next();
});

// Indexes for efficient queries
mqttStateSchema.index({ 'topicMetadata.baseTopic': 1 });
mqttStateSchema.index({ brokerId: 1, receivedAt: -1 });

// Static method to update state with change tracking
mqttStateSchema.statics.updateState = async function(topic, brokerId, payload, options = {}) {
  const { qos = 0, retained = false, deviceId = null } = options;

  // Parse payload
  let parsed = null;
  let payloadType = 'string';
  const raw = typeof payload === 'string' ? payload : payload.toString();

  try {
    parsed = JSON.parse(raw);
    payloadType = 'json';
  } catch {
    // Not JSON, check other types
    if (!isNaN(raw) && raw.trim() !== '') {
      parsed = parseFloat(raw);
      payloadType = 'number';
    } else if (raw === 'true' || raw === 'false') {
      parsed = raw === 'true';
      payloadType = 'boolean';
    }
  }

  const now = new Date();

  // Find existing state
  const existing = await this.findOne({ topic });

  if (existing) {
    // Check if value changed
    const valueChanged = existing.payload.raw !== raw;

    const update = {
      payload: { raw, parsed, type: payloadType },
      qos,
      retained,
      receivedAt: now,
      $inc: { 'stats.updateCount': 1 }
    };

    if (valueChanged) {
      update.previousPayload = {
        raw: existing.payload.raw,
        parsed: existing.payload.parsed,
        changedAt: existing.receivedAt
      };
      update.$inc['stats.changeCount'] = 1;
    }

    if (deviceId) {
      update.deviceId = deviceId;
    }

    return this.findOneAndUpdate({ topic }, update, { new: true });
  } else {
    // Create new state
    return this.create({
      topic,
      brokerId,
      deviceId,
      payload: { raw, parsed, type: payloadType },
      qos,
      retained,
      receivedAt: now,
      stats: {
        updateCount: 1,
        firstSeenAt: now,
        changeCount: 0
      }
    });
  }
};

// Static method to get states by topic pattern
mqttStateSchema.statics.findByPattern = async function(pattern) {
  // Convert MQTT wildcard pattern to regex
  // + matches single level, # matches multiple levels
  const regexPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // Escape regex chars
    .replace(/\\\+/g, '[^/]+')                // + = single level
    .replace(/\\#/g, '.*');                   // # = multi level

  return this.find({ topic: { $regex: `^${regexPattern}$` } });
};

// Static method for batch updates (high-throughput scenarios)
mqttStateSchema.statics.batchUpdateStates = async function(updates) {
  const bulkOps = updates.map(update => {
    const { topic, brokerId, payload, options = {} } = update;
    const { qos = 0, retained = false, deviceId = null } = options;

    // Parse payload
    let parsed = null;
    let payloadType = 'string';
    const raw = typeof payload === 'string' ? payload : payload.toString();

    try {
      parsed = JSON.parse(raw);
      payloadType = 'json';
    } catch {
      if (!isNaN(raw) && raw.trim() !== '') {
        parsed = parseFloat(raw);
        payloadType = 'number';
      } else if (raw === 'true' || raw === 'false') {
        parsed = raw === 'true';
        payloadType = 'boolean';
      }
    }

    const now = new Date();
    const segments = topic.split('/');

    return {
      updateOne: {
        filter: { topic },
        update: {
          $set: {
            brokerId,
            payload: { raw, parsed, type: payloadType },
            qos,
            retained,
            receivedAt: now,
            deviceId,
            topicMetadata: {
              segments,
              baseTopic: segments[0],
              leafTopic: segments[segments.length - 1]
            }
          },
          $inc: { 'stats.updateCount': 1 },
          $setOnInsert: {
            'stats.firstSeenAt': now,
            'stats.changeCount': 0
          }
        },
        upsert: true
      }
    };
  });

  return this.bulkWrite(bulkOps);
};

export default mongoose.model('MqttState', mqttStateSchema);
