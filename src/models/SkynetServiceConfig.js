import mongoose from 'mongoose';

/**
 * SkynetServiceConfig - Per-operation configuration for Skynet P2P paid services.
 *
 * Controls which plugin operations are available to Skynet peers,
 * their SKYNET token price (0 = free), and per-peer rate limits.
 */
const skynetRateLimitSchema = new mongoose.Schema({
  maxPerPeer: { type: Number, default: 5 },
  windowMinutes: { type: Number, default: 15 }
}, { _id: false });

const skynetServiceConfigSchema = new mongoose.Schema({
  serviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  pluginName: {
    type: String,
    required: true
  },
  action: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    default: 'general'
  },
  skynetEnabled: {
    type: Boolean,
    default: false
  },
  skynetPrice: {
    type: Number,
    default: 0  // 0 = free
  },
  rateLimit: {
    type: skynetRateLimitSchema,
    default: () => ({})
  },
  totalRequests: {
    type: Number,
    default: 0
  },
  totalRevenue: {
    type: Number,
    default: 0
  },
  lastUsed: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

/**
 * Get all enabled Skynet services as a catalog
 */
skynetServiceConfigSchema.statics.getCatalog = async function() {
  const services = await this.find({ skynetEnabled: true });
  return services.map(s => ({
    serviceId: s.serviceId,
    name: s.name,
    description: s.description,
    category: s.category,
    price: s.skynetPrice,
    rateLimit: s.rateLimit
  }));
};

/**
 * Check if a service is enabled and get its config
 */
skynetServiceConfigSchema.statics.getServiceConfig = async function(serviceId) {
  return this.findOne({ serviceId, skynetEnabled: true });
};

/**
 * Record a service execution
 */
skynetServiceConfigSchema.statics.recordExecution = async function(serviceId, skynetPrice) {
  return this.findOneAndUpdate(
    { serviceId },
    {
      $inc: { totalRequests: 1, totalRevenue: skynetPrice || 0 },
      $set: { lastUsed: new Date() }
    },
    { new: true }
  );
};

const SkynetServiceConfig = mongoose.model('SkynetServiceConfig', skynetServiceConfigSchema);
export default SkynetServiceConfig;
