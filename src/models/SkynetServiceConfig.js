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

/**
 * Get service usage statistics grouped by category
 */
skynetServiceConfigSchema.statics.getServiceUsageStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: {
          category: "$category",
          serviceId: "$serviceId",
          name: "$name"
        },
        totalRequests: { $sum: "$totalRequests" },
        totalRevenue: { $sum: "$totalRevenue" },
        lastUsed: { $max: "$lastUsed" }
      }
    },
    {
      $group: {
        _id: "$_id.category",
        services: {
          $push: {
            serviceId: "$_id.serviceId",
            name: "$_id.name",
            totalRequests: "$totalRequests",
            totalRevenue: "$totalRevenue",
            lastUsed: "$lastUsed"
          }
        },
        categoryTotalRequests: { $sum: "$totalRequests" },
        categoryTotalRevenue: { $sum: "$totalRevenue" }
      }
    },
    {
      $project: {
        _id: 0,
        category: "$_id",
        services: 1,
        categoryTotalRequests: 1,
        categoryTotalRevenue: 1
      }
    }
  ]);

  return stats;
};

/**
 * Get top services by revenue
 * @param {Object} options - Options object
 * @param {number} options.limit - Maximum number of services to return (default: 10)
 */
skynetServiceConfigSchema.statics.getTopServicesByRevenue = async function({ limit = 10 } = {}) {
  return this.find({ skynetEnabled: true })
    .sort({ totalRevenue: -1 })
    .limit(limit)
    .select({
      serviceId: 1,
      name: 1,
      description: 1,
      category: 1,
      totalRequests: 1,
      totalRevenue: 1,
      lastUsed: 1
    });
};

const SkynetServiceConfig = mongoose.model('SkynetServiceConfig', skynetServiceConfigSchema);
export default SkynetServiceConfig;
