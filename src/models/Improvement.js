import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const improvementSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    index: true
  },
  targetFile: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  priority: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  impact: {
    type: String,
    enum: ['major', 'moderate', 'minor'],
    default: 'moderate'
  },
  branchName: {
    type: String,
    required: true,
    unique: true
  },
  prUrl: {
    type: String,
    sparse: true
  },
  prNumber: {
    type: Number,
    sparse: true
  },
  status: {
    type: String,
    enum: ['proposed', 'in_progress', 'pr_created', 'merged', 'rejected', 'failed'],
    default: 'proposed',
    index: true
  },
  newCapabilities: [{
    type: String
  }],
  safeForProduction: {
    type: Boolean,
    default: false
  },
  errorMessage: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: {
    type: Date
  }
});

// Indexes for efficient queries
improvementSchema.index({ createdAt: -1 });
improvementSchema.index({ status: 1, createdAt: -1 });
improvementSchema.index({ type: 1, targetFile: 1 });

improvementSchema.methods.handleError = async function (operation) {
  try {
    await retryOperation(operation, { retries: 3 });
  } catch (error) {
    logger.error('Error in Improvement operation', {
      error: error.message,
      stack: error.stack,
      context: {
        type: this.type,
        targetFile: this.targetFile,
        branchName: this.branchName
      }
    });
    this.errorMessage = error.message;
    await this.save();
  }
};

improvementSchema.statics.healthCheck = async function () {
  try {
    const result = await this.findOne().sort({ createdAt: -1 }).exec();
    return { status: 'healthy', lastEntry: result ? result.createdAt : null };
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    return { status: 'unhealthy', error: error.message };
  }
};

const Improvement = mongoose.model('Improvement', improvementSchema);

export default Improvement;