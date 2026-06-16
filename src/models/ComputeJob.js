import mongoose from 'mongoose';

const computeJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['script', 'inference', 'transcode', 'batch'], default: 'script' },
  requesterFingerprint: { type: String, required: true },
  // Job spec
  command: { type: String, default: '' },
  input: { type: mongoose.Schema.Types.Mixed, default: null },
  maxDurationSeconds: { type: Number, default: 300 },
  maxMemoryMB: { type: Number, default: 512 },
  // Pricing
  pricePerMinute: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },
  paymentTxHash: { type: String, default: null },
  // Execution
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'timeout'],
    default: 'pending'
  },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: 0 },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: '' },
  // Direction
  isLocal: { type: Boolean, default: false },
  direction: { type: String, enum: ['provider', 'requester'], default: 'provider' },
  // Priority: 3=high, 2=medium, 1=low — numeric for correct sort ordering
  priority: { type: Number, default: 2, min: 1, max: 3 }
}, { timestamps: true });

computeJobSchema.index({ status: 1 });
computeJobSchema.index({ requesterFingerprint: 1, createdAt: -1 });
computeJobSchema.index({ priority: -1, status: 1 });

computeJobSchema.statics.getActiveJobs = function () {
  return this.find({ status: { $in: ['pending', 'running'] } }).sort({ priority: -1, createdAt: -1 });
};

computeJobSchema.statics.getJobHistory = function (limit = 50) {
  return this.find({}).sort({ createdAt: -1 }).limit(limit);
};

const ComputeJob = mongoose.model('ComputeJob', computeJobSchema);
export default ComputeJob;
