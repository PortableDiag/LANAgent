import mongoose from 'mongoose';

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

const ExternalAuditLog = mongoose.model('ExternalAuditLog', externalAuditLogSchema);
export default ExternalAuditLog;
