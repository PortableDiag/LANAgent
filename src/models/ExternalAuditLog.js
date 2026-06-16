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

const ExternalAuditLog = mongoose.model('ExternalAuditLog', externalAuditLogSchema);
export default ExternalAuditLog;
