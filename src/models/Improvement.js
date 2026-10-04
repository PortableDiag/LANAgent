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

/**
 * Valid lifecycle transitions for improvement statuses.
 * Maps each status to the list of statuses it can transition to.
 */
improvementSchema.statics.transitionMap = {
  proposed: ['in_progress'],
  in_progress: ['pr_created', 'failed'],
  pr_created: ['merged', 'rejected', 'failed'],
  merged: [],
  rejected: [],
  failed: []
};

/**
 * Atomically transition an improvement to a new status, enforcing valid lifecycle transitions.
 * Sets completedAt timestamp for terminal states (merged, rejected, failed).
 * Uses findOneAndUpdate with a status condition to prevent concurrent illegal transitions.
 * @param {string} improvementId - The improvement document ID.
 * @param {string} newStatus - The target status.
 * @returns {Promise<Object|null>} The updated document, or null if the transition is invalid.
 */
improvementSchema.statics.transitionStatus = async function (improvementId, newStatus) {
  // Determine which current statuses are allowed to transition to newStatus
  const allowedFrom = [];
  for (const [from, tos] of Object.entries(this.transitionMap)) {
    if (tos.includes(newStatus)) {
      allowedFrom.push(from);
    }
  }

  if (allowedFrom.length === 0) {
    // No valid transition to this status from any status
    return null;
  }

  // completedAt is only written for terminal states. Putting `completedAt: undefined`
  // in $set would leave behaviour up to Mongoose's undefined handling.
  const $set = { status: newStatus };
  if (['merged', 'rejected', 'failed'].includes(newStatus)) $set.completedAt = new Date();
  const update = { $set };

  try {
    const updatedDoc = await retryOperation(
      async () => {
        return await this.findOneAndUpdate(
          { _id: improvementId, status: { $in: allowedFrom } },
          update,
          { new: true }
        );
      },
      { retries: 3 }
    );
    return updatedDoc;
  } catch (error) {
    logger.error('Transition status failed', {
      error: error.message,
      improvementId,
      newStatus,
      allowedFrom
    });
    return null;
  }
};

/**
 * Bring pr_created improvements in line with what happened to their pull requests.
 *
 * selfModification creates every Improvement with status 'pr_created' and nothing
 * else ever moved it, so ImprovementMetrics (merged count, success rate) read 0
 * merged forever. The caller supplies the PR numbers the git host reports as
 * merged and as closed; a closed PR that was not merged was rejected.
 *
 * @param {{merged?: Iterable<number>, closed?: Iterable<number>}} prStates
 * @returns {Promise<{merged: number, rejected: number}>} Transitions applied.
 */
improvementSchema.statics.reconcilePullRequestStates = async function ({ merged = [], closed = [] } = {}) {
  const mergedSet = new Set([...merged].map(Number).filter(Number.isInteger));
  const rejectedSet = new Set([...closed].map(Number).filter(n => Number.isInteger(n) && !mergedSet.has(n)));
  const counts = { merged: 0, rejected: 0 };
  if (mergedSet.size === 0 && rejectedSet.size === 0) return counts;

  const pending = await this.find(
    { status: 'pr_created', prNumber: { $in: [...mergedSet, ...rejectedSet] } },
    { _id: 1, prNumber: 1 }
  ).lean();

  for (const doc of pending) {
    const target = mergedSet.has(doc.prNumber) ? 'merged' : 'rejected';
    if (await this.transitionStatus(doc._id, target)) counts[target] += 1;
  }
  return counts;
};

const Improvement = mongoose.model('Improvement', improvementSchema);

export default Improvement;
