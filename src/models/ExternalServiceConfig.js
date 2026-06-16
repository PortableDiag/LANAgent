import mongoose from 'mongoose';

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

const ExternalServiceConfig = mongoose.model('ExternalServiceConfig', externalServiceConfigSchema);
export default ExternalServiceConfig;
