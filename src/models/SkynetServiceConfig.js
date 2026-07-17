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
  tags: {
    type: [String],
    default: []
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
 * @param {Object} options - Options object
 * @param {string[]} options.tags - Array of tags to filter by
 * @param {string} options.tagOperator - Operator for tag filtering ('AND' or 'OR')
 */
skynetServiceConfigSchema.statics.getCatalog = async function(options = {}) {
  const { tags, tagOperator = 'OR' } = options;
  let query = { skynetEnabled: true };
  
  if (tags && Array.isArray(tags) && tags.length > 0) {
    if (tagOperator === 'AND') {
      query.tags = { $all: tags };
    } else {
      query.tags = { $in: tags };
    }
  }
  
  const services = await this.find(query);
  return services.map(s => ({
    serviceId: s.serviceId,
    name: s.name,
    description: s.description,
    category: s.category,
    tags: s.tags,
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
 * Find services by tags with AND/OR matching
 * @param {string[]} tags - Array of tags to search for
 * @param {string} operator - Matching operator ('AND' or 'OR')
 * @returns {Array} Array of matching service configurations
 */
skynetServiceConfigSchema.statics.findServicesByTags = async function(tags, operator = 'OR') {
  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return [];
  }

  let query = {};
  if (operator === 'AND') {
    query.tags = { $all: tags };
  } else {
    query.tags = { $in: tags };
  }

  return this.find(query);
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
        tags: { $first: "$tags" },
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
            tags: "$tags",
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

  // Group services by tags within each category
  const result = stats.map(categoryStat => {
    const tagGroups = {};
    
    categoryStat.services.forEach(service => {
      if (service.tags && service.tags.length > 0) {
        service.tags.forEach(tag => {
          if (!tagGroups[tag]) {
            tagGroups[tag] = {
              tagName: tag,
              services: [],
              tagTotalRequests: 0,
              tagTotalRevenue: 0
            };
          }
          tagGroups[tag].services.push(service);
          tagGroups[tag].tagTotalRequests += service.totalRequests;
          tagGroups[tag].tagTotalRevenue += service.totalRevenue;
        });
      }
    });
    
    return {
      ...categoryStat,
      tagGroups: Object.values(tagGroups)
    };
  });

  return result;
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
      tags: 1,
      totalRequests: 1,
      totalRevenue: 1,
      lastUsed: 1
    });
};

const SkynetServiceConfig = mongoose.model('SkynetServiceConfig', skynetServiceConfigSchema);
export default SkynetServiceConfig;
