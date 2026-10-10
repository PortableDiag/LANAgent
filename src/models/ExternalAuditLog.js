import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { safeJsonStringify, safeJsonParse } from '../utils/jsonUtils.js';

const DEFAULT_REDACT_KEYS = ['password', 'authorization', 'token', 'apikey', 'secret', 'cookie', 'x-api-key'];
const MAX_AUDIT_BODY_BYTES = 10240;
const MAX_LOG_QUERY_LIMIT = 500;

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

function encodeAuditCursor(timestamp, id) {
  return Buffer.from(JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    id: String(id)
  }), 'utf8').toString('base64url');
}

function decodeAuditCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) {
    throw new TypeError('cursor must be a non-empty string');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('cursor is invalid');
  }

  const timestamp = new Date(parsed?.timestamp);
  if (!parsed?.id || Number.isNaN(timestamp.getTime()) || !mongoose.isValidObjectId(parsed.id)) {
    throw new TypeError('cursor is invalid');
  }

  return {
    timestamp,
    id: new mongoose.Types.ObjectId(parsed.id)
  };
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
  },
  // 'completed' (the response finished) or 'aborted' (the connection closed first).
  completionState: {
    type: String,
    default: 'completed'
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
 * Query audit logs using bounded cursor-based pagination and composable filters.
 * @param {Object} options - Query options
 * @param {Date|string} [options.startDate] - Inclusive lower timestamp bound
 * @param {Date|string} [options.endDate] - Inclusive upper timestamp bound
 * @param {string} [options.agentId] - Agent identifier
 * @param {string} [options.ip] - Client IP address
 * @param {string} [options.method] - HTTP method
 * @param {string} [options.path] - Request path
 * @param {number} [options.statusCode] - HTTP status code
 * @param {boolean} [options.success] - Whether the request succeeded
 * @param {string} [options.paymentTx] - Payment transaction identifier
 * @param {string} [options.cursor] - Cursor returned by a previous query
 * @param {number} [options.limit=100] - Maximum number of records to return
 * @param {boolean} [options.includeBodies=false] - Include sanitized request and response bodies
 * @returns {Promise<{logs: Array, nextCursor: string|null}>} Paginated audit logs
 */
externalAuditLogSchema.statics.queryLogs = async function({
  startDate,
  endDate,
  agentId,
  ip,
  method,
  path,
  statusCode,
  success,
  paymentTx,
  cursor,
  limit = 100,
  includeBodies = false
} = {}) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit < 1) {
    throw new TypeError('limit must be a positive number');
  }

  const boundedLimit = Math.min(Math.floor(numericLimit), MAX_LOG_QUERY_LIMIT);
  const query = {};

  if (startDate !== undefined || endDate !== undefined) {
    const timestamp = {};
    if (startDate !== undefined) {
      const value = new Date(startDate);
      if (Number.isNaN(value.getTime())) throw new TypeError('startDate is invalid');
      timestamp.$gte = value;
    }
    if (endDate !== undefined) {
      const value = new Date(endDate);
      if (Number.isNaN(value.getTime())) throw new TypeError('endDate is invalid');
      timestamp.$lte = value;
    }
    query.timestamp = timestamp;
  }

  for (const [key, value] of Object.entries({
    agentId,
    ip,
    method,
    path,
    statusCode,
    success,
    paymentTx
  })) {
    if (value !== undefined) query[key] = value;
  }

  if (cursor !== undefined) {
    const decoded = decodeAuditCursor(cursor);
    query.$or = [
      { timestamp: { $lt: decoded.timestamp } },
      { timestamp: decoded.timestamp, _id: { $lt: decoded.id } }
    ];
  }

  let request = this.find(query)
    .sort({ timestamp: -1, _id: -1 })
    .limit(boundedLimit + 1);

  if (!includeBodies) {
    request = request.select('-requestBody -responseBody');
  }

  const records = await request.lean().exec();
  const hasMore = records.length > boundedLimit;
  const logs = hasMore ? records.slice(0, boundedLimit) : records;

  return {
    logs,
    nextCursor: hasMore && logs.length > 0
      ? encodeAuditCursor(logs[logs.length - 1].timestamp, logs[logs.length - 1]._id)
      : null
  };
};

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

/**
 * Get top IP addresses by request volume
 * @param {Object} options - Aggregation options
 * @param {number} [options.days=30] - Number of days to look back
 * @param {number} [options.limit=10] - Maximum number of IPs to return
 * @returns {Promise<Array>} Array of IP addresses with request counts
 */
externalAuditLogSchema.statics.getTopIPAddresses = async function({ days = 30, limit = 10 } = {}) {
  const pipeline = [
    {
      $match: {
        ip: { $ne: null },
        timestamp: {
          $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        }
      }
    },
    {
      $group: {
        _id: "$ip",
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
        lastActivity: { $max: "$timestamp" }
      }
    },
    {
      $sort: { requestCount: -1 }
    },
    {
      $limit: limit
    }
  ];

  return await this.aggregate(pipeline).exec();
};

/**
 * Compute response-time percentiles (p50, p95, p99, ...) over a time window with
 * optional filters. `duration` is written by the external audit middleware.
 *
 * Tries MongoDB's $percentile accumulator (7.0+) first; if the server rejects it,
 * falls back to computing nearest-rank percentiles in JavaScript from the
 * matching durations. No version probe: the aggregation error is the probe.
 *
 * @param {Object} options
 * @param {Date|string} options.startDate - Start of the time window (inclusive)
 * @param {Date|string} options.endDate   - End of the time window (inclusive)
 * @param {string} [options.agentId]      - Filter by agent identifier
 * @param {string} [options.path]         - Filter by request path
 * @param {string} [options.method]       - Filter by HTTP method
 * @param {number[]} [options.percentiles=[50, 95, 99]] - Percentiles in (0, 100]
 * @returns {Promise<{count: number|null, percentiles: Object<number, number|null>}>}
 *   Each percentile maps to a duration in ms, or null when no requests matched
 *   (an empty window has no latency; 0 would read as "instant").
 */
externalAuditLogSchema.statics.getDurationPercentiles = async function({
  startDate,
  endDate,
  agentId,
  path,
  method,
  percentiles = [50, 95, 99]
} = {}) {
  if (!startDate || !endDate) {
    throw new TypeError('startDate and endDate are required');
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError('startDate and endDate must be valid dates');
  }
  if (!Array.isArray(percentiles) || percentiles.length === 0 ||
      !percentiles.every(p => typeof p === 'number' && p > 0 && p <= 100)) {
    throw new TypeError('percentiles must be a non-empty array of numbers in (0, 100]');
  }

  const matchFilter = {
    timestamp: { $gte: start, $lte: end },
    duration: { $type: 'number' }
  };
  if (agentId !== undefined) matchFilter.agentId = agentId;
  if (path !== undefined) matchFilter.path = path;
  if (method !== undefined) matchFilter.method = method;

  const empty = () => Object.fromEntries(percentiles.map(p => [p, null]));

  try {
    const [result] = await this.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          values: { $percentile: { input: '$duration', p: percentiles.map(p => p / 100), method: 'approximate' } }
        }
      }
    ]).exec();
    if (!result || !result.count) return { count: 0, percentiles: empty() };
    return {
      count: result.count,
      percentiles: Object.fromEntries(percentiles.map((p, i) => [p, result.values?.[i] ?? null]))
    };
  } catch (aggErr) {
    logger.warn('$percentile aggregation unavailable, computing percentiles in JS', { error: aggErr?.message });
  }

  const docs = await this.aggregate([
    { $match: matchFilter },
    { $project: { _id: 0, duration: 1 } },
    { $sort: { duration: 1 } }
  ]).exec();
  const sorted = docs.map(d => d.duration);
  const n = sorted.length;
  if (n === 0) return { count: 0, percentiles: empty() };
  return {
    count: n,
    percentiles: Object.fromEntries(percentiles.map(p => {
      const idx = Math.ceil((p / 100) * n) - 1; // nearest-rank
      return [p, sorted[Math.max(0, Math.min(idx, n - 1))]];
    }))
  };
};

const ExternalAuditLog = mongoose.model('ExternalAuditLog', externalAuditLogSchema);
export default ExternalAuditLog;
