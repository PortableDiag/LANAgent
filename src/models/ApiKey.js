import mongoose from 'mongoose';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const apiKeySchema = new mongoose.Schema({
  // The actual API key (hashed for security)
  keyHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // First 8 characters of the key for identification
  keyPrefix: {
    type: String,
    required: true,
    index: true
  },
  
  // User-assigned name for the key
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  // Optional description
  description: {
    type: String,
    trim: true,
    default: ''
  },
  
  // Key status
  status: {
    type: String,
    enum: ['active', 'suspended', 'revoked'],
    default: 'active',
    index: true
  },
  
  // Usage tracking
  usageCount: {
    type: Number,
    default: 0
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  lastUsedAt: {
    type: Date,
    default: null
  },
  
  expiresAt: {
    type: Date,
    default: null // null means no expiration
  },
  
  // Who created this key (system, user, agent)
  createdBy: {
    type: String,
    enum: ['user', 'agent', 'system'],
    default: 'user'
  },
  
  // Whether this is a system/agent key (hidden by default)
  isSystemKey: {
    type: Boolean,
    default: false
  },
  
  // Optional metadata
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  
  // Rate limiting (requests per minute)
  rateLimit: {
    type: Number,
    default: 100 // 100 requests per minute default
  },
  
  // Permissions/scopes (for future use)
  scopes: [{
    type: String,
    default: ['*'] // Full access by default
  }],
  
  // Alert configuration for usage monitoring
  alertConfig: {
    enabled: {
      type: Boolean,
      default: false
    },
    usageLimit: {
      type: Number,
      default: 1000 // Default threshold
    },
    notifyEmail: {
      type: String,
      default: ''
    },
    lastAlertSent: {
      type: Date,
      default: null
    }
  }
}, {
  timestamps: true
});

// Index for efficient queries
apiKeySchema.index({ status: 1, createdAt: -1 });
apiKeySchema.index({ keyPrefix: 1, status: 1 });

// Generate a new API key
apiKeySchema.statics.generateKey = function() {
  // Generate a 32-byte random key
  const buffer = crypto.randomBytes(32);
  // Convert to base64 and remove special characters for URL safety
  const key = buffer.toString('base64').replace(/[+/=]/g, '');
  // Prefix with 'la_' to identify as LANAgent key
  return `la_${key}`;
};

// Hash an API key for storage
apiKeySchema.statics.hashKey = function(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
};

// Get key prefix for display (first 8 chars after 'la_')
apiKeySchema.statics.getKeyPrefix = function(key) {
  return key.substring(0, 11) + '...'; // la_XXXXX...
};

// Normalize scopes: accepts string or array, trims/lowercases/dedupes; empty -> ['*'] (full access)
apiKeySchema.statics.normalizeScopes = function(scopes) {
  const arr = Array.isArray(scopes)
    ? scopes
    : (typeof scopes === 'string' ? scopes.split(',') : []);
  const normalized = Array.from(new Set(
    arr.map(s => (typeof s === 'string' ? s.trim().toLowerCase() : '')).filter(Boolean)
  ));
  return normalized.length > 0 ? normalized : ['*'];
};

// Internal: does a granted scope satisfy a required scope, with wildcard / namespace support?
//   '*'          matches anything
//   'a:*'        matches 'a', 'a:b', 'a:b:c'
//   required 'a:b:*' is satisfied by granted 'a:b' or 'a:b:read'
function scopeMatches(granted, required) {
  if (!granted || !required) return false;
  const g = String(granted).trim().toLowerCase();
  const r = String(required).trim().toLowerCase();
  if (g === '*' || r === '*' || g === r) return true;

  const gSegs = g.split(':');
  const rSegs = r.split(':');
  const gWild = gSegs[gSegs.length - 1] === '*';
  const rWild = rSegs[rSegs.length - 1] === '*';

  if (gWild) {
    const prefix = gSegs.slice(0, -1);
    if (rSegs.length < prefix.length) return false;
    return prefix.every((seg, i) => rSegs[i] === seg);
  }
  if (rWild) {
    const prefix = rSegs.slice(0, -1);
    if (gSegs.length < prefix.length) return false;
    return prefix.every((seg, i) => gSegs[i] === seg);
  }
  return false;
}

/**
 * Check if this key has the required scope(s). Wildcard and namespace aware.
 * @param {string|string[]} required - scope or list of scopes to check
 * @param {{mode?: 'any'|'all'}} [options] - 'any' (default): at least one matches; 'all': every required matches
 */
apiKeySchema.methods.hasScope = function(required, { mode = 'any' } = {}) {
  try {
    const have = this.constructor.normalizeScopes(this.scopes);
    const need = this.constructor.normalizeScopes(required);
    if (have.includes('*')) return true;
    const check = (req) => have.some(h => scopeMatches(h, req));
    return mode === 'all' ? need.every(check) : need.some(check);
  } catch (err) {
    logger.error('Error evaluating API key scopes', { error: err?.message, keyId: this?._id?.toString?.() });
    return false;
  }
};

// Normalize scopes before save to ensure canonical storage
apiKeySchema.pre('save', function(next) {
  if (this.isModified('scopes') || this.isNew) {
    this.scopes = this.constructor.normalizeScopes(this.scopes);
  }
  next();
});

// Increment usage count
apiKeySchema.methods.incrementUsage = async function() {
  this.usageCount += 1;
  this.lastUsedAt = new Date();
  await this.save();
};

// Check if key is valid (not expired, not revoked)
apiKeySchema.methods.isValid = function() {
  if (this.status !== 'active') {
    return false;
  }
  
  // Only check expiration if expiresAt is explicitly set (not null)
  if (this.expiresAt !== null && this.expiresAt !== undefined) {
    const now = new Date();
    if (this.expiresAt < now) {
      // Log expiration details for debugging
      console.debug(`API key ${this.name} expired:`, {
        expiresAt: this.expiresAt.toISOString(),
        now: now.toISOString(),
        expired: true
      });
      return false;
    }
  }
  
  return true;
};

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

export default ApiKey;