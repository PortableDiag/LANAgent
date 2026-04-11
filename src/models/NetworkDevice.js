import mongoose from 'mongoose';

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

// Statics
NetworkDeviceSchema.statics.findOrCreateByIP = async function(ip, data = {}) {
  let device = await this.findOne({ ip });

  if (!device) {
    device = new this({
      ip,
      dateDiscovered: new Date(),
      ...data
    });
  } else {
    // Update with new data
    if (data.mac && !device.mac) device.mac = data.mac;
    if (data.hostname && !device.hostname) device.hostname = data.hostname;
    if (data.vendor && !device.vendor) device.vendor = data.vendor;

    device.lastSeen = new Date();
    device.stats.timesDiscovered = (device.stats.timesDiscovered || 0) + 1;
  }

  await device.save();
  return device;
};

NetworkDeviceSchema.statics.findByMAC = function(mac) {
  const normalizedMAC = mac.toUpperCase().replace(/[:-]/g, ':');
  return this.findOne({ mac: normalizedMAC });
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
