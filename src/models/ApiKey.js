import mongoose from 'mongoose';
import crypto from 'crypto';

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