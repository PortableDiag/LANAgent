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
  },
  // serviceIds of other services this one requires (not a mongoose ref —
  // services are keyed by serviceId, not _id, so populate can't resolve them)
  dependencies: {
    type: [String],
    default: []
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
      dependencies: config.dependencies,
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
      lastUsed: { type: 'string', format: 'date-time' },
      dependencies: {
        type: 'array',
        items: { type: 'string' }
      }
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

/**
 * Validate service dependencies
 * @param {Array<string>} dependencies - Array of service IDs to validate
 * @returns {object} Validation result with valid flag and errors if any
 */
externalServiceConfigSchema.statics.validateDependencies = async function(dependencies) {
  try {
    if (!Array.isArray(dependencies) || dependencies.length === 0) {
      return { valid: true, errors: [] };
    }

    // Find all dependent services
    const services = await this.find({ 
      serviceId: { $in: dependencies } 
    }).select('serviceId enabled');

    const foundServices = services.map(s => s.serviceId);
    const missingServices = dependencies.filter(id => !foundServices.includes(id));
    const disabledServices = services
      .filter(s => !s.enabled)
      .map(s => s.serviceId);

    const errors = [];
    if (missingServices.length > 0) {
      errors.push(`Missing services: ${missingServices.join(', ')}`);
    }
    if (disabledServices.length > 0) {
      errors.push(`Disabled services: ${disabledServices.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      details: {
        found: foundServices,
        missing: missingServices,
        disabled: disabledServices
      }
    };
  } catch (error) {
    logger.error('Error validating dependencies:', error);
    throw error;
  }
};

/**
 * Check service dependency chain for a given service
 * @param {string} serviceId - The ID of the service to check
 * @returns {object} Check result with valid flag and dependency chain
 */
externalServiceConfigSchema.statics.checkDependencies = async function(serviceId) {
  try {
    const service = await this.findOne({ serviceId });
    if (!service) {
      throw new Error(`Service with ID ${serviceId} not found`);
    }

    const onPath = new Set();   // current DFS path — membership here means a cycle
    const verified = new Set(); // fully-checked nodes — skip on diamond re-visits
    const chain = [];

    const traverseDependencies = async (svcId) => {
      if (verified.has(svcId)) return;
      if (onPath.has(svcId)) {
        throw new Error(`Circular dependency detected at service ${svcId}`);
      }

      onPath.add(svcId);
      chain.push(svcId);

      const svc = await this.findOne({ serviceId: svcId });
      if (!svc) {
        throw new Error(`Dependency service ${svcId} not found`);
      }

      if (!svc.enabled) {
        throw new Error(`Dependency service ${svcId} is disabled`);
      }

      // Recursively check dependencies
      if (svc.dependencies && svc.dependencies.length > 0) {
        for (const depId of svc.dependencies) {
          await traverseDependencies(depId);
        }
      }

      onPath.delete(svcId);
      verified.add(svcId);
    };

    await traverseDependencies(serviceId);

    return {
      valid: true,
      serviceId,
      chain
    };
  } catch (error) {
    logger.error('Error checking dependencies:', error);
    return {
      valid: false,
      serviceId,
      error: error.message,
      chain: []
    };
  }
};

const ExternalServiceConfig = mongoose.model('ExternalServiceConfig', externalServiceConfigSchema);
export default ExternalServiceConfig;
