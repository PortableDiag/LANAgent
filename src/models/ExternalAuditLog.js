import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { safeJsonStringify, safeJsonParse } from '../utils/jsonUtils.js';

const DEFAULT_REDACT_KEYS = ['password', 'authorization', 'token', 'apikey', 'secret', 'cookie', 'x-api-key'];
const MAX_AUDIT_BODY_BYTES = 10240;

function sanitizeAuditPayload(value) {
  if (value === null || value === undefined) return null;

  let str;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'object') {
    str = safeJsonStringify(value);
  } else {
    str = String(value);
  }
  if (!str) return null;

  const parsed = safeJsonParse(str, null);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const redacted = { ...parsed };
    for (const key of Object.keys(redacted)) {
      if (DEFAULT_REDACT_KEYS.includes(key.toLowerCase())) {
        redacted[key] = '[REDACTED]';
      }
    }
    const reStr = safeJsonStringify(redacted);
    if (reStr) str = reStr;
  }

  const bytes = new TextEncoder().encode(str);
  if (bytes.byteLength <= MAX_AUDIT_BODY_BYTES) return str;

  // Step back to the last valid UTF-8 codepoint boundary (continuation bytes are 10xxxxxx)
  let end = MAX_AUDIT_BODY_BYTES;
  const isContinuation = b => (b & 0b11000000) === 0b10000000;
  while (end > 0 && isContinuation(bytes[end]) && MAX_AUDIT_BODY_BYTES - end < 4) {
    end--;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, end));
}

const externalAuditLogSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },
  method: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  agentId: {
    type: String,
    default: null
  },
  ip: {
    type: String,
    default: null
  },
  statusCode: {
    type: Number,
    default: 0
  },
  duration: {
    type: Number,
    default: 0
  },
  paymentTx: {
    type: String,
    default: null
  },
  success: {
    type: Boolean,
    default: true
  },
  requestBody: {
    type: String,
    default: null
  },
  responseBody: {
    type: String,
    default: null
  }
}, {
  timestamps: false
});

// 90-day TTL
externalAuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound indexes for common query patterns
externalAuditLogSchema.index({ agentId: 1, timestamp: -1 });
externalAuditLogSchema.index({ statusCode: 1, path: 1 });
externalAuditLogSchema.index({ ip: 1, method: 1 });

externalAuditLogSchema.pre('save', function(next) {
  try {
    if (typeof this.duration === 'number' && this.duration < 0) this.duration = 0;
    this.requestBody = sanitizeAuditPayload(this.requestBody);
    this.responseBody = sanitizeAuditPayload(this.responseBody);
    next();
  } catch (err) {
    logger.error('ExternalAuditLog pre-save sanitization failed', { error: err?.message });
    next();
  }
});

/**
 * Get daily aggregates of audit logs within a date range
 * @param {Object} options - Aggregation options
 * @param {Date} options.startDate - Start date for aggregation
 * @param {Date} options.endDate - End date for aggregation
 * @returns {Promise<Array>} Array of daily aggregation results
 */
externalAuditLogSchema.statics.getDailyAggregates = async function({ startDate, endDate }) {
  const pipeline = [
    {
      $match: {
        timestamp: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$timestamp"
          }
        },
        count: { $sum: 1 },
        avgDuration: { $avg: "$duration" },
        successCount: {
          $sum: {
            $cond: [{ $eq: ["$success", true] }, 1, 0]
          }
        },
        failureCount: {
          $sum: {
            $cond: [{ $eq: ["$success", false] }, 1, 0]
          }
        }
      }
    },
    {
      $sort: { _id: 1 }
    }
  ];

  return await this.aggregate(pipeline).exec();
};

/**
 * Get distribution of status codes for a specific agent or all agents
 * @param {Object} options - Aggregation options
 * @param {string} [options.agentId] - Agent ID to filter by (optional)
 * @param {number} [options.days=30] - Number of days to look back
 * @returns {Promise<Array>} Array of status code distribution results
 */
externalAuditLogSchema.statics.getStatusCodeDistribution = async function({ agentId, days = 30 }) {
  const matchCondition = {
    timestamp: {
      $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    }
  };

  if (agentId) {
    matchCondition.agentId = agentId;
  }

  const pipeline = [
    {
      $match: matchCondition
    },
    {
      $group: {
        _id: "$statusCode",
        count: { $sum: 1 }
      }
    },
    {
      $sort: { count: -1 }
    }
  ];

  return await this.aggregate(pipeline).exec();
};

/**
 * Get agent activity summary
 * @param {Object} options - Aggregation options
 * @param {number} [options.days=30] - Number of days to look back
 * @returns {Promise<Array>} Array of agent activity summary results
 */
externalAuditLogSchema.statics.getAgentActivitySummary = async function({ days = 30 }) {
  const pipeline = [
    {
      $match: {
        agentId: { $ne: null },
        timestamp: {
          $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        }
      }
    },
    {
      $group: {
        _id: "$agentId",
        requestCount: { $sum: 1 },
        avgDuration: { $avg: "$duration" },
        successCount: {
          $sum: {
            $cond: [{ $eq: ["$success", true] }, 1, 0]
          }
        },
        failureCount: {
          $sum: {
            $cond: [{ $eq: ["$success", false] }, 1, 0]
          }
        },
        uniqueIPs: { $addToSet: "$ip" },
        lastActivity: { $max: "$timestamp" }
      }
    },
    {
      $project: {
        _id: 1,
        requestCount: 1,
        avgDuration: 1,
        successCount: 1,
        failureCount: 1,
        uniqueIPCount: { $size: "$uniqueIPs" },
        lastActivity: 1
      }
    },
    {
      $sort: { requestCount: -1 }
    }
  ];

  return await this.aggregate(pipeline).exec();
};

const ExternalAuditLog = mongoose.model('ExternalAuditLog', externalAuditLogSchema);
export default ExternalAuditLog;
