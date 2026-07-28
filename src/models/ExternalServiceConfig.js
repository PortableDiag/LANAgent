import mongoose from 'mongoose';
import { safeJsonStringify, validateJsonSchema } from '../utils/jsonUtils.js';
import { logger } from '../utils/logger.js';

const rateLimitSchema = new mongoose.Schema({
  maxPerAgent: { type: Number, default: 10 },
  windowMinutes: { type: Number, default: 15 }
}, { _id: false });

const externalServiceConfigSchema = new mongoose.Schema({
  serviceId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: true
  },
  price: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    default: 'BNB'
  },
  rateLimit: {
    type: rateLimitSchema,
    default: () => ({})
  },
  maxFileSize: {
    type: Number,
    default: 0
  },
  estimatedTime: {
    type: String,
    default: ''
  },
  inputFormat: {
    type: String,
    default: 'json'
  },
  outputFormat: {
    type: String,
    default: 'json'
  },
  totalRequests: {
    type: Number,
    default: 0
  },
  totalRevenue: {
    type: String,
    default: '0'
  },
  lastUsed: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

/**
 * Export service configuration as sanitized JSON
 * @param {string} serviceId - The ID of the service to export
 * @returns {object} Sanitized configuration object
 */
externalServiceConfigSchema.statics.exportConfiguration = async function(serviceId) {
  try {
    const config = await this.findOne({ serviceId });
    if (!config) {
      throw new Error(`Service with ID ${serviceId} not found`);
    }

    // Create a sanitized copy without sensitive fields
    const sanitizedConfig = {
      serviceId: config.serviceId,
      name: config.name,
      description: config.description,
      enabled: config.enabled,
      price: config.price,
      currency: config.currency,
      rateLimit: config.rateLimit,
      maxFileSize: config.maxFileSize,
      estimatedTime: config.estimatedTime,
      inputFormat: config.inputFormat,
      outputFormat: config.outputFormat,
      totalRequests: config.totalRequests,
      totalRevenue: config.totalRevenue,
      lastUsed: config.lastUsed,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt
    };

    return sanitizedConfig;
  } catch (error) {
    logger.error('Error exporting service configuration:', error);
    throw error;
  }
};

/**
 * Validate import payload against schema
 * @param {object} payload - The configuration payload to validate
 * @returns {object} Validation result
 */
externalServiceConfigSchema.statics.validateImportPayload = function(payload) {
  const schema = {
    type: 'object',
    properties: {
      serviceId: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      price: { type: 'string' },
      currency: { type: 'string' },
      rateLimit: {
        type: 'object',
        properties: {
          maxPerAgent: { type: 'number' },
          windowMinutes: { type: 'number' }
        },
        additionalProperties: false
      },
      maxFileSize: { type: 'number' },
      estimatedTime: { type: 'string' },
      inputFormat: { type: 'string' },
      outputFormat: { type: 'string' },
      totalRequests: { type: 'number' },
      totalRevenue: { type: 'string' },
      lastUsed: { type: 'string', format: 'date-time' }
    },
    required: ['serviceId', 'name', 'price'],
    additionalProperties: false
  };

  // jsonUtils.validateJsonSchema returns an ARRAY of error objects (empty = valid),
  // like every other caller in the codebase. importConfiguration expects a
  // { valid, errors } shape, so wrap it here.
  const errors = validateJsonSchema(payload, schema);
  return { valid: errors.length === 0, errors };
};

/**
 * Import service configuration from payload
 * @param {object} payload - The configuration payload to import
 * @param {object} options - Import options
 * @returns {object} Import result
 */
externalServiceConfigSchema.statics.importConfiguration = async function(payload, options = {}) {
  try {
    // Validate payload
    const validation = this.validateImportPayload(payload);
    if (!validation.valid) {
      throw new Error(`Invalid configuration payload: ${safeJsonStringify(validation.errors)}`);
    }

    const { maskFields = [] } = options;
    let processedPayload = { ...payload };

    // Apply field masking if specified
    if (Array.isArray(maskFields) && maskFields.length > 0) {
      maskFields.forEach(field => {
        if (processedPayload.hasOwnProperty(field)) {
          processedPayload[field] = '****';
        }
      });
    }

    // Check if service already exists
    const existingConfig = await this.findOne({ serviceId: processedPayload.serviceId });
    
    let result;
    if (existingConfig) {
      // Update existing configuration
      result = await this.findByIdAndUpdate(
        existingConfig._id,
        processedPayload,
        { new: true, runValidators: true }
      );
    } else {
      // Create new configuration
      const newConfig = new this(processedPayload);
      result = await newConfig.save();
    }

    return {
      success: true,
      action: existingConfig ? 'updated' : 'created',
      serviceId: result.serviceId,
      name: result.name
    };
  } catch (error) {
    logger.error('Error importing service configuration:', error);
    throw error;
  }
};

const ExternalServiceConfig = mongoose.model('ExternalServiceConfig', externalServiceConfigSchema);
export default ExternalServiceConfig;
