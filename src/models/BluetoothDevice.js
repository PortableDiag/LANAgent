import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

// Module-level cache for Bluetooth device queries
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

const bluetoothDeviceSchema = new mongoose.Schema({
  // Device identification
  macAddress: {
    type: String,
    required: true,
    unique: true,
    index: true,
    uppercase: true,
    validate: {
      validator: function(v) {
        return /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i.test(v);
      },
      message: 'Invalid MAC address format'
    }
  },
  name: { type: String, required: true },
  alias: { type: String, default: '' },  // User-defined friendly name

  // Device properties
  deviceType: {
    type: String,
    enum: ['audio', 'input', 'phone', 'computer', 'network', 'peripheral', 'imaging', 'wearable', 'toy', 'health', 'other'],
    default: 'other'
  },
  icon: String,              // Device icon from bluetoothctl
  deviceClass: String,       // Bluetooth device class (hex)
  uuid: [String],            // Service UUIDs

  // Pairing status
  paired: { type: Boolean, default: false, index: true },
  trusted: { type: Boolean, default: false },
  blocked: { type: Boolean, default: false },

  // Connection status
  connected: { type: Boolean, default: false, index: true },
  lastConnectedAt: Date,
  lastDisconnectedAt: Date,
  lastSeenAt: { type: Date, default: Date.now, index: true },

  // Signal strength (from scans)
  rssi: Number,
  lastRssiUpdate: Date,

  // Auto-connect settings
  autoConnect: { type: Boolean, default: false },

  // Connection history (last 50 entries)
  connectionHistory: [{
    action: {
      type: String,
      enum: ['connect', 'disconnect', 'pair', 'unpair', 'trust', 'untrust', 'block', 'unblock', 'scan_discovered']
    },
    timestamp: { type: Date, default: Date.now },
    success: { type: Boolean, default: true },
    error: String,
    initiatedBy: { type: String, enum: ['user', 'auto', 'system'], default: 'user' }
  }],

  // Statistics
  stats: {
    totalConnections: { type: Number, default: 0 },
    totalDisconnections: { type: Number, default: 0 },
    totalConnectionTime: { type: Number, default: 0 },  // seconds
    avgConnectionDuration: Number,
    lastConnectionDuration: Number
  },

  // Metadata
  discoveredAt: { type: Date, default: Date.now },
  manufacturer: String,
  modalias: String,
  tags: [String],
  notes: String,

  // Device grouping for organization
  group: { type: String, default: '', index: true }
}, {
  timestamps: true
});

// Indexes
bluetoothDeviceSchema.index({ paired: 1, connected: 1 });
bluetoothDeviceSchema.index({ name: 'text', alias: 'text' });
// Compound index for getConnectedDevices() query optimization
bluetoothDeviceSchema.index({ connected: 1, lastConnectedAt: -1 });

// Virtual for display name
bluetoothDeviceSchema.virtual('displayName').get(function() {
  return this.alias || this.name || this.macAddress;
});

// Pre-save: limit connection history to 50 entries
bluetoothDeviceSchema.pre('save', function(next) {
  if (this.connectionHistory && this.connectionHistory.length > 50) {
    this.connectionHistory = this.connectionHistory.slice(-50);
  }
  next();
});

// Static methods

/**
 * Invalidate cache for device queries
 */
bluetoothDeviceSchema.statics.invalidateCache = function() {
  cache.del('pairedDevices');
  cache.del('connectedDevices');
};

/**
 * Get all paired devices (with caching)
 */
bluetoothDeviceSchema.statics.getPairedDevices = async function() {
  const cached = cache.get('pairedDevices');
  if (cached !== undefined) {
    return cached;
  }
  const devices = await this.find({ paired: true }).sort({ lastSeenAt: -1 }).lean();
  cache.set('pairedDevices', devices);
  return devices;
};

/**
 * Get currently connected devices (with caching)
 */
bluetoothDeviceSchema.statics.getConnectedDevices = async function() {
  const cached = cache.get('connectedDevices');
  if (cached !== undefined) {
    return cached;
  }
  const devices = await this.find({ connected: true }).sort({ lastConnectedAt: -1 }).lean();
  cache.set('connectedDevices', devices);
  return devices;
};

/**
 * Find device by name, alias, or partial match
 */
bluetoothDeviceSchema.statics.findByNameOrAlias = async function(search) {
  if (!search) return null;

  const searchLower = search.toLowerCase();

  // Try exact MAC address match first
  if (/^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i.test(search)) {
    return this.findOne({ macAddress: search.toUpperCase() });
  }

  // Try exact name or alias match
  let device = await this.findOne({
    $or: [
      { name: { $regex: `^${search}$`, $options: 'i' } },
      { alias: { $regex: `^${search}$`, $options: 'i' } }
    ]
  });

  if (device) return device;

  // Try partial match
  device = await this.findOne({
    $or: [
      { name: { $regex: search, $options: 'i' } },
      { alias: { $regex: search, $options: 'i' } }
    ]
  });

  return device;
};

/**
 * Update or create device from scan (with retry and cache invalidation)
 */
bluetoothDeviceSchema.statics.upsertFromScan = async function(deviceData) {
  const { macAddress, name, rssi, paired, connected, ...rest } = deviceData;

  const update = {
    name: name || 'Unknown Device',
    lastSeenAt: new Date(),
    ...rest
  };

  if (rssi !== undefined) {
    update.rssi = rssi;
    update.lastRssiUpdate = new Date();
  }

  // Handle paired/connected - only set if explicitly provided
  if (paired !== undefined) update.paired = paired;
  if (connected !== undefined) update.connected = connected;

  // Build setOnInsert - only include fields not in $set
  const setOnInsert = { discoveredAt: new Date() };
  if (paired === undefined) setOnInsert.paired = false;
  if (connected === undefined) setOnInsert.connected = false;

  const device = await retryOperation(async () => {
    return this.findOneAndUpdate(
      { macAddress: macAddress.toUpperCase() },
      {
        $set: update,
        $setOnInsert: setOnInsert
      },
      { upsert: true, new: true }
    );
  });

  // Invalidate cache when devices change
  this.invalidateCache();

  return device;
};

/**
 * Record connection event (with retry and cache invalidation)
 */
bluetoothDeviceSchema.statics.recordEvent = async function(macAddress, action, success = true, error = null, initiatedBy = 'user') {
  const update = {
    $push: {
      connectionHistory: {
        $each: [{ action, success, error, initiatedBy }],
        $slice: -50
      }
    },
    lastSeenAt: new Date()
  };

  // Update specific fields based on action
  if (action === 'connect' && success) {
    update.$set = { connected: true, lastConnectedAt: new Date() };
    update.$inc = { 'stats.totalConnections': 1 };
  } else if (action === 'disconnect') {
    update.$set = { connected: false, lastDisconnectedAt: new Date() };
    update.$inc = { 'stats.totalDisconnections': 1 };
  } else if (action === 'pair' && success) {
    update.$set = { ...(update.$set || {}), paired: true };
  } else if (action === 'unpair' && success) {
    update.$set = { ...(update.$set || {}), paired: false, trusted: false };
  } else if (action === 'trust' && success) {
    update.$set = { ...(update.$set || {}), trusted: true };
  } else if (action === 'untrust' && success) {
    update.$set = { ...(update.$set || {}), trusted: false };
  } else if (action === 'block' && success) {
    update.$set = { ...(update.$set || {}), blocked: true };
  } else if (action === 'unblock' && success) {
    update.$set = { ...(update.$set || {}), blocked: false };
  }

  const result = await retryOperation(async () => {
    return this.findOneAndUpdate(
      { macAddress: macAddress.toUpperCase() },
      update,
      { new: true }
    );
  });

  // Invalidate cache when device status changes
  this.invalidateCache();

  return result;
};

/**
 * Get recently seen devices (from scans)
 */
bluetoothDeviceSchema.statics.getRecentlySeen = async function(minutes = 5) {
  const since = new Date(Date.now() - minutes * 60 * 1000);
  return this.find({ lastSeenAt: { $gte: since } })
    .sort({ rssi: -1 })  // Strongest signal first
    .lean();
};

/**
 * Cleanup old unpaired devices not seen recently (with retry and cache invalidation)
 */
bluetoothDeviceSchema.statics.cleanup = async function(daysNotSeen = 30) {
  const cutoff = new Date(Date.now() - daysNotSeen * 24 * 60 * 60 * 1000);
  const result = await retryOperation(async () => {
    return this.deleteMany({
      paired: false,
      lastSeenAt: { $lt: cutoff }
    });
  });

  // Invalidate cache after cleanup
  this.invalidateCache();

  return result.deletedCount;
};

/**
 * Convert RSSI to distance using the log-distance path loss model
 * Formula: distance = 10^((txPower - rssi) / (10 * n))
 *
 * @param {number} rssi - Measured RSSI in dBm
 * @param {number} txPower - RSSI at 1 meter distance (typically -59 to -65 dBm for Bluetooth)
 * @param {number} pathLossExponent - Environment factor (2=free space, 2.5-3=indoor, 4=obstructed)
 * @returns {number} - Estimated distance in meters
 */
bluetoothDeviceSchema.statics.rssiToDistance = function(rssi, txPower = -59, pathLossExponent = 2.5) {
  if (rssi === 0 || rssi === undefined) {
    return -1; // Cannot calculate
  }

  // Log-distance path loss model
  const ratio = (txPower - rssi) / (10 * pathLossExponent);
  const distance = Math.pow(10, ratio);

  return Math.round(distance * 100) / 100; // Round to 2 decimal places
};

/**
 * Trilateration algorithm to estimate position from 3+ reference points
 * Uses least squares method for over-determined systems (>3 points)
 *
 * @param {Array} points - Array of { x, y, z, distance } objects (reference point positions and distances)
 * @returns {Object} - Estimated position { x, y, z } in meters
 */
bluetoothDeviceSchema.statics.trilaterate = function(points) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('At least 3 reference points required for trilateration');
  }

  // Validate points have required properties
  for (const p of points) {
    if (p.x === undefined || p.y === undefined || p.distance === undefined) {
      throw new Error('Each point must have x, y, and distance properties');
    }
  }

  // For 2D trilateration (most common for indoor positioning)
  // Using the first point as reference origin for linearization
  const p1 = points[0];
  const n = points.length;

  // Build matrix A and vector b for least squares: Ax = b
  // From the circle equations: (x-xi)^2 + (y-yi)^2 = di^2
  // Linearized by subtracting equation 1 from each subsequent equation
  const A = [];
  const b = [];

  for (let i = 1; i < n; i++) {
    const pi = points[i];

    // Coefficients for the linear equation
    const ax = 2 * (pi.x - p1.x);
    const ay = 2 * (pi.y - p1.y);

    // Right side of the equation
    const bi = (p1.distance * p1.distance) - (pi.distance * pi.distance) -
               (p1.x * p1.x) + (pi.x * pi.x) -
               (p1.y * p1.y) + (pi.y * pi.y);

    A.push([ax, ay]);
    b.push(bi);
  }

  // Solve using least squares: x = (A^T * A)^-1 * A^T * b
  // For 2x2 case (2 unknowns: x, y)

  // Calculate A^T * A
  let atA00 = 0, atA01 = 0, atA11 = 0;
  let atb0 = 0, atb1 = 0;

  for (let i = 0; i < A.length; i++) {
    atA00 += A[i][0] * A[i][0];
    atA01 += A[i][0] * A[i][1];
    atA11 += A[i][1] * A[i][1];
    atb0 += A[i][0] * b[i];
    atb1 += A[i][1] * b[i];
  }

  // Calculate inverse of A^T * A (2x2 matrix)
  const det = atA00 * atA11 - atA01 * atA01;

  if (Math.abs(det) < 1e-10) {
    throw new Error('Trilateration failed: points may be collinear');
  }

  const invDet = 1 / det;
  const inv00 = atA11 * invDet;
  const inv01 = -atA01 * invDet;
  const inv11 = atA00 * invDet;

  // Calculate result: (A^T * A)^-1 * A^T * b
  const x = inv00 * atb0 + inv01 * atb1;
  const y = inv01 * atb0 + inv11 * atb1;

  // For z coordinate, if provided, use weighted average based on distance
  let z = 0;
  if (points.some(p => p.z !== undefined)) {
    let weightSum = 0;
    for (const p of points) {
      if (p.z !== undefined && p.distance > 0) {
        const weight = 1 / (p.distance * p.distance); // Inverse square weighting
        z += p.z * weight;
        weightSum += weight;
      }
    }
    if (weightSum > 0) {
      z = z / weightSum;
    }
  }

  return {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100
  };
};

/**
 * Estimate device position based on RSSI readings from multiple access points
 *
 * @param {Array} accessPoints - Array of { macAddress, x, y, z, rssi, txPower } objects
 *   - macAddress: MAC address of the access point (for reference)
 *   - x, y, z: Known position of the access point in meters
 *   - rssi: RSSI reading from the device at this access point
 *   - txPower: Optional TX power (default -59 dBm)
 * @param {Object} options - Optional configuration
 *   - pathLossExponent: Environment factor (default 2.5 for indoor)
 * @returns {Object} - Estimated position and metadata
 */
bluetoothDeviceSchema.statics.estimateDevicePosition = function(accessPoints, options = {}) {
  if (!Array.isArray(accessPoints) || accessPoints.length < 3) {
    throw new Error('At least 3 access points with RSSI readings required for position estimation');
  }

  const pathLossExponent = options.pathLossExponent || 2.5;

  // Convert RSSI to distance for each access point
  const points = accessPoints.map(ap => {
    const txPower = ap.txPower || -59;
    const distance = this.rssiToDistance(ap.rssi, txPower, pathLossExponent);

    return {
      macAddress: ap.macAddress,
      x: ap.x,
      y: ap.y,
      z: ap.z || 0,
      rssi: ap.rssi,
      distance
    };
  });

  // Filter out invalid distances
  const validPoints = points.filter(p => p.distance > 0 && p.distance < 100);

  if (validPoints.length < 3) {
    throw new Error(`Only ${validPoints.length} valid distance measurements - need at least 3`);
  }

  // Perform trilateration
  const position = this.trilaterate(validPoints);

  // Calculate confidence based on consistency of measurements
  const distances = validPoints.map(p => p.distance);
  const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
  const variance = distances.reduce((a, d) => a + Math.pow(d - avgDistance, 2), 0) / distances.length;
  const stdDev = Math.sqrt(variance);

  // Lower std dev relative to avg distance = higher confidence
  const confidenceScore = Math.max(0, Math.min(100, 100 - (stdDev / avgDistance) * 100));

  return {
    position,
    confidence: Math.round(confidenceScore),
    accessPointsUsed: validPoints.length,
    averageDistance: Math.round(avgDistance * 100) / 100,
    measurements: validPoints.map(p => ({
      macAddress: p.macAddress,
      rssi: p.rssi,
      estimatedDistance: p.distance
    }))
  };
};

export const BluetoothDevice = mongoose.model('BluetoothDevice', bluetoothDeviceSchema);
export default BluetoothDevice;
