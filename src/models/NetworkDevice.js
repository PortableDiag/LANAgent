import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * NetworkDevice Schema - Persistent storage for discovered network devices
 * Acts as a "network contact book" that persists across restarts
 */
const NetworkDeviceSchema = new mongoose.Schema({
  // Core identification
  ip: {
    type: String,
    required: true,
    index: true
  },

  mac: {
    type: String,
    sparse: true,
    index: true
  },

  hostname: {
    type: String,
    trim: true
  },

  // User-friendly name (editable by user)
  name: {
    type: String,
    trim: true
  },

  // Device classification
  vendor: String,  // From MAC OUI lookup

  deviceType: {
    type: String,
    enum: ['computer', 'phone', 'tablet', 'router', 'switch', 'printer', 'camera', 'iot', 'server', 'nas', 'gaming', 'tv', 'speaker', 'unknown'],
    default: 'unknown'
  },

  os: {
    type: String,  // e.g., "Windows 11", "Linux", "iOS", "Android"
    trim: true
  },

  osVersion: String,

  // Discovery timestamps
  dateDiscovered: {
    type: Date,
    default: Date.now,
    index: true
  },

  lastSeen: {
    type: Date,
    default: Date.now,
    index: true
  },

  lastOnline: Date,  // Last time device responded to ping/arp

  // Current status
  online: {
    type: Boolean,
    default: false
  },

  // Services/ports discovered
  services: [{
    port: Number,
    protocol: { type: String, enum: ['tcp', 'udp'] },
    service: String,  // e.g., "ssh", "http", "https"
    version: String,
    lastSeen: Date
  }],

  // Open ports (quick reference)
  openPorts: [Number],

  // Network info
  subnet: String,  // e.g., "192.168.1.0/24"
  gateway: String,

  // User organization
  category: {
    type: String,
    enum: ['trusted', 'guest', 'iot', 'infrastructure', 'unknown', 'blocked'],
    default: 'unknown'
  },

  tags: [String],

  notes: {
    type: String,
    maxLength: 2000
  },

  // Wake-on-LAN support
  wolEnabled: {
    type: Boolean,
    default: false
  },

  // Monitoring preferences
  monitor: {
    type: Boolean,
    default: true  // Include in regular availability checks
  },

  alertOnOffline: {
    type: Boolean,
    default: false  // Alert when device goes offline
  },

  alertOnOnline: {
    type: Boolean,
    default: false  // Alert when device comes online
  },

  // Statistics
  stats: {
    timesDiscovered: { type: Number, default: 1 },
    uptimePercentage: Number,
    avgResponseTime: Number,  // in ms
    lastResponseTime: Number
  },

  // History of status changes
  statusHistory: [{
    status: { type: String, enum: ['online', 'offline'] },
    timestamp: { type: Date, default: Date.now },
    responseTime: Number
  }],

  // Additional metadata from scans
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },

  // Device lifecycle management
  lifecycleStatus: {
    type: String,
    enum: ['active', 'deprecated', 'retired'],
    default: 'active'
  }
}, {
  timestamps: true,
  collection: 'networkDevices'
});

// Compound index for efficient lookup
NetworkDeviceSchema.index({ ip: 1, mac: 1 });
NetworkDeviceSchema.index({ online: 1, lastSeen: -1 });
NetworkDeviceSchema.index({ category: 1, deviceType: 1 });
NetworkDeviceSchema.index({ 'services.port': 1, 'services.protocol': 1 });
NetworkDeviceSchema.index({ 'stats.uptimePercentage': 1 });

const normalizeMac = (mac) => {
  if (typeof mac !== 'string') return null;

  const hexadecimal = mac.replace(/[^a-f0-9]/gi, '').toUpperCase();
  if (hexadecimal.length !== 12 || !/^[A-F0-9]{12}$/.test(hexadecimal)) {
    return null;
  }

  return hexadecimal.match(/.{2}/g).join(':');
};

const retryDatabaseOperation = (operation) => retryOperation(operation, { retries: 3 });

const mergeUnique = (first = [], second = []) => {
  const values = [...first, ...second];
  const seen = new Set();

  return values.filter((value) => {
    const key = typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const mergeServices = (first = [], second = []) => {
  const merged = [...first];

  for (const service of second) {
    const existing = merged.find(
      (item) => item.port === service.port && item.protocol === service.protocol
    );

    if (!existing) {
      merged.push(service);
      continue;
    }

    existing.service = existing.service || service.service;
    existing.version = existing.version || service.version;
    if (!existing.lastSeen || (service.lastSeen && service.lastSeen > existing.lastSeen)) {
      existing.lastSeen = service.lastSeen;
    }
  }

  return merged;
};

// Methods
NetworkDeviceSchema.methods.markOnline = function(responseTime = null) {
  const wasOffline = !this.online;
  this.online = true;
  this.lastSeen = new Date();
  this.lastOnline = new Date();

  if (responseTime !== null) {
    this.stats.lastResponseTime = responseTime;
  }

  // Add to status history (keep last 100 entries)
  this.statusHistory.push({
    status: 'online',
    timestamp: new Date(),
    responseTime
  });

  if (this.statusHistory.length > 100) {
    this.statusHistory = this.statusHistory.slice(-100);
  }

  return { wasOffline, shouldAlert: wasOffline && this.alertOnOnline };
};

NetworkDeviceSchema.methods.markOffline = function() {
  const wasOnline = this.online;
  this.online = false;
  this.lastSeen = new Date();

  // Add to status history
  this.statusHistory.push({
    status: 'offline',
    timestamp: new Date()
  });

  if (this.statusHistory.length > 100) {
    this.statusHistory = this.statusHistory.slice(-100);
  }

  return { wasOnline, shouldAlert: wasOnline && this.alertOnOffline };
};

NetworkDeviceSchema.methods.updateServices = function(services) {
  const now = new Date();

  for (const svc of services) {
    const existing = this.services.find(s => s.port === svc.port && s.protocol === svc.protocol);

    if (existing) {
      existing.service = svc.service || existing.service;
      existing.version = svc.version || existing.version;
      existing.lastSeen = now;
    } else {
      this.services.push({
        ...svc,
        lastSeen: now
      });
    }
  }

  // Update openPorts quick reference
  this.openPorts = [...new Set(this.services.map(s => s.port))];
};

NetworkDeviceSchema.methods.getDisplayName = function() {
  return this.name || this.hostname || this.ip;
};

/**
 * Mark the device as deprecated if it hasn't been seen for a specified number of days
 * @param {number} days - Number of days to consider a device as deprecated
 */
NetworkDeviceSchema.methods.markAsDeprecated = function(days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  if (this.lastSeen < cutoff) {
    this.lifecycleStatus = 'deprecated';
  }
};

/**
 * Mark the device as retired if it hasn't been seen for a specified number of days
 * @param {number} days - Number of days to consider a device as retired
 */
NetworkDeviceSchema.methods.markAsRetired = function(days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  if (this.lastSeen < cutoff) {
    this.lifecycleStatus = 'retired';
  }
};

// Statics
NetworkDeviceSchema.statics.findOrCreateByIP = async function(ip, data = {}) {
  if (!ip || typeof ip !== 'string') {
    throw new TypeError('A valid IP address is required');
  }

  const normalizedMac = normalizeMac(data.mac);
  let device = await retryDatabaseOperation(() => this.findOne({ ip }));

  if (!device) {
    device = new this({
      ip,
      ...data,
      ...(normalizedMac ? { mac: normalizedMac } : {}),
      dateDiscovered: new Date()
    });
  } else {
    if (normalizedMac && !device.mac) device.mac = normalizedMac;
    if (data.hostname && !device.hostname) device.hostname = data.hostname;
    if (data.vendor && !device.vendor) device.vendor = data.vendor;

    device.lastSeen = new Date();
    device.stats.timesDiscovered = (device.stats.timesDiscovered || 0) + 1;
  }

  await retryDatabaseOperation(() => device.save());
  return device;
};

/**
 * Find or create a device using stable MAC identity before falling back to IP.
 * Known devices retain previous addresses in bounded metadata for DHCP changes.
 * @param {{ip: string, mac?: string, data?: object}} identity
 * @returns {Promise<import('mongoose').Document>}
 */
NetworkDeviceSchema.statics.findOrCreateByIdentity = async function({ ip, mac, data = {} } = {}) {
  if (!ip || typeof ip !== 'string') {
    throw new TypeError('A valid IP address is required');
  }

  const normalizedMac = normalizeMac(mac || data.mac);
  let device = normalizedMac
    ? await retryDatabaseOperation(() => this.findOne({ mac: normalizedMac }))
    : null;

  if (!device) {
    device = await retryDatabaseOperation(() => this.findOne({ ip }));
  }

  if (!device) {
    device = new this({
      ...data,
      ip,
      ...(normalizedMac ? { mac: normalizedMac } : {}),
      dateDiscovered: new Date(),
      lastSeen: new Date()
    });
  } else {
    if (normalizedMac && !device.mac) device.mac = normalizedMac;

    if (device.ip !== ip) {
      // metadata is a Map path with no default: records written by the network
      // scan never set it, so it is undefined on most existing documents.
      if (!device.metadata) device.metadata = new Map();
      const previousIps = device.metadata?.get('previousIps') || [];
      device.metadata.set(
        'previousIps',
        mergeUnique(previousIps, [device.ip]).slice(-20)
      );
      device.ip = ip;
    }

    if (data.hostname && !device.hostname) device.hostname = data.hostname;
    if (data.vendor && !device.vendor) device.vendor = data.vendor;
    if (data.subnet) device.subnet = data.subnet;
    if (data.gateway) device.gateway = data.gateway;

    device.lastSeen = new Date();
    device.stats.timesDiscovered = (device.stats.timesDiscovered || 0) + 1;
  }

  await retryDatabaseOperation(() => device.save());
  return device;
};

/**
 * Consolidate two duplicate device records into the target record.
 * User-defined settings and target identity are retained where possible.
 * @param {string|mongoose.Types.ObjectId} sourceId - Record to absorb
 * @param {string|mongoose.Types.ObjectId} targetId - Record to retain
 * @returns {Promise<import('mongoose').Document>}
 */
NetworkDeviceSchema.statics.mergeDevices = async function(sourceId, targetId) {
  if (!sourceId || !targetId || String(sourceId) === String(targetId)) {
    throw new TypeError('Distinct sourceId and targetId values are required');
  }

  const [source, target] = await retryDatabaseOperation(() => Promise.all([
    this.findById(sourceId),
    this.findById(targetId)
  ]));

  if (!source || !target) {
    throw new Error('Both source and target devices must exist');
  }

  target.tags = mergeUnique(target.tags, source.tags);
  target.services = mergeServices(target.services, source.services);
  target.openPorts = mergeUnique(target.openPorts, source.openPorts);
  target.statusHistory = mergeUnique(target.statusHistory, source.statusHistory)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-100);

  target.alertOnOffline = Boolean(target.alertOnOffline || source.alertOnOffline);
  target.alertOnOnline = Boolean(target.alertOnOnline || source.alertOnOnline);
  target.monitor = Boolean(target.monitor || source.monitor);
  target.stats.timesDiscovered =
    (target.stats.timesDiscovered || 0) + (source.stats.timesDiscovered || 0);

  const previousIps = [
    ...(target.metadata?.get('previousIps') || []),
    ...(source.metadata?.get('previousIps') || []),
    source.ip
  ].filter(Boolean);

  if (target.ip) {
    if (!target.metadata) target.metadata = new Map();
    target.metadata.set('previousIps', mergeUnique(previousIps, []).filter(ip => ip !== target.ip).slice(-20));
  }

  if (!target.mac && source.mac) target.mac = source.mac;
  if (!target.hostname && source.hostname) target.hostname = source.hostname;
  if (!target.vendor && source.vendor) target.vendor = source.vendor;
  if (!target.name && source.name) target.name = source.name;
  if (!target.notes && source.notes) target.notes = source.notes;

  if (source.lastSeen && (!target.lastSeen || source.lastSeen > target.lastSeen)) {
    target.lastSeen = source.lastSeen;
  }
  if (source.lastOnline && (!target.lastOnline || source.lastOnline > target.lastOnline)) {
    target.lastOnline = source.lastOnline;
  }

  await retryDatabaseOperation(() => target.save());
  await retryDatabaseOperation(() => this.deleteOne({ _id: source._id }));

  logger.info(`Merged network device ${sourceId} into ${targetId}`);
  return target;
};

NetworkDeviceSchema.statics.findByMAC = function(mac) {
  const normalizedMAC = normalizeMac(mac);
  return normalizedMAC ? this.findOne({ mac: normalizedMAC }) : this.findOne({ _id: null });
};

NetworkDeviceSchema.statics.getOnlineDevices = function() {
  return this.find({ online: true }).sort({ lastSeen: -1 });
};

NetworkDeviceSchema.statics.getDevicesForMonitoring = function() {
  return this.find({ monitor: true }).select('ip mac hostname name online alertOnOffline alertOnOnline statusHistory stats');
};

NetworkDeviceSchema.statics.getRecentlyDiscovered = function(hours = 24) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hours);
  return this.find({ dateDiscovered: { $gte: cutoff } }).sort({ dateDiscovered: -1 });
};

NetworkDeviceSchema.statics.getStaleDevices = function(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return this.find({ lastSeen: { $lt: cutoff } }).sort({ lastSeen: 1 });
};

NetworkDeviceSchema.statics.searchDevices = function(query) {
  const regex = new RegExp(query, 'i');
  return this.find({
    $or: [
      { ip: regex },
      { hostname: regex },
      { name: regex },
      { mac: regex },
      { vendor: regex },
      { notes: regex },
      { tags: { $in: [regex] } }
    ]
  });
};

export default mongoose.model('NetworkDevice', NetworkDeviceSchema);
