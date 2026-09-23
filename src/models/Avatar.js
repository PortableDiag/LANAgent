import mongoose from 'mongoose';
import { jsonClone } from '../utils/jsonUtils.js';
import { logger } from '../utils/logger.js';

const AvatarSchema = new mongoose.Schema({
  avatarId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  owner: {
    type: String,
    index: true
  },
  name: {
    type: String,
    default: ''
  },
  agentName: {
    type: String,
    index: true
  },
  agentId: {
    type: Number,
    default: 0
  },
  nftTokenId: {
    type: Number,
    default: null,
    index: true
  },
  nftTxHash: String,
  baseModelPath: String,
  bakedModelPath: String,
  thumbnailPath: String,
  ipfsCIDs: {
    model: String,
    thumbnail: String,
    metadata: String,
    customizations: String
  },
  customizations: {
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    face: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    outfit: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    accessories: {
      type: [String],
      default: []
    },
    effects: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    expression: {
      type: String,
      default: 'neutral'
    }
  },
  unlockedItems: [{
    _id: false,
    itemId: String,
    unlockedAt: {
      type: Date,
      default: Date.now
    },
    achievement: String
  }],
  sourceType: {
    type: String,
    enum: ['photo', 'prompt', 'template']
  },
  sourceHash: String,
  polyCount: Number,
  hasRig: {
    type: Boolean,
    default: false
  },
  hasMorphTargets: {
    type: Boolean,
    default: false
  },
  format: {
    type: String,
    default: 'glb'
  },
  version: {
    type: Number,
    default: 1
  },
  versions: [{
    version: Number,
    state: mongoose.Schema.Types.Mixed,
    timestamp: {
      type: Date,
      default: Date.now
    },
    reason: String
  }],
  optimizationScores: {
    performance: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    quality: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    compression: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    overall: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    lastAnalyzed: {
      type: Date,
      default: null
    }
  }
}, {
  timestamps: true
});

AvatarSchema.index({ owner: 1, createdAt: -1 });
AvatarSchema.index({ agentName: 1, createdAt: -1 });
// nftTokenId: field-level index: true already creates this index

// How many historical versions a single avatar keeps.
//
// Every entry embeds a full clone of the document, in the SAME document, so an
// uncapped array walks straight into MongoDB's 16 MB per-document ceiling — and
// it fails on save, at which point the avatar can no longer be written at all.
// Twenty is deep enough to undo a bad session and shallow enough that the worst
// case stays far below the limit.
const MAX_VERSIONS = 20;

// Fields a snapshot must never carry, and therefore never restore.
//
// The submitted version kept two separate exclusion lists — one when snapshotting
// (`versions`) and one when restoring (`_id`, `avatarId`, `versions`) — which is
// how `__v`, `createdAt` and `updatedAt` ended up restorable. Rolling those back
// resets mongoose's optimistic-concurrency counter and fights `timestamps: true`.
// One list, used by both, cannot drift.
const NON_VERSIONED_FIELDS = new Set([
  '_id', '__v', 'avatarId', 'versions', 'version', 'createdAt', 'updatedAt'
]);

/**
 * Capture the restorable state of this document.
 * @returns {Object} A plain clone carrying only fields a rollback may write.
 */
AvatarSchema.methods._snapshotState = function () {
  const state = jsonClone(this.toObject());
  for (const key of NON_VERSIONED_FIELDS) delete state[key];
  return state;
};

/**
 * Push a version onto the history, trimming to MAX_VERSIONS.
 * @private
 */
AvatarSchema.methods._pushVersion = function (reason) {
  const versionDoc = {
    version: this.version,
    state: this._snapshotState(),
    timestamp: new Date(),
    reason
  };
  this.versions.push(versionDoc);
  if (this.versions.length > MAX_VERSIONS) {
    this.versions.splice(0, this.versions.length - MAX_VERSIONS);
  }
  return versionDoc;
};

/**
 * Save a version of the current avatar state.
 * @param {string} reason - Reason for saving this version
 * @returns {Promise<Object>} The saved version document
 */
AvatarSchema.methods.saveVersion = async function(reason = 'Manual save') {
  const versionDoc = this._pushVersion(reason);
  this.version += 1;
  await this.save();

  logger.info(`Saved version ${versionDoc.version} for avatar ${this.avatarId}`);

  return versionDoc;
};

/**
 * Get the version history for this avatar, newest first.
 *
 * `versions` is an embedded array on this document, not a separate collection, so
 * it is already loaded — the submitted version re-read the document from the
 * database on every call, which cost a round trip and threw on a document that
 * had not been saved yet (findById returns null).
 *
 * @returns {Promise<Array>} Array of version documents
 */
AvatarSchema.methods.getVersionHistory = async function() {
  return [...this.versions].sort((a, b) => b.version - a.version);
};

/**
 * Roll the avatar back to a specific version.
 *
 * Version numbers are MONOTONIC. The submitted version set the new version to
 * `versionNumber + 1`, which reissues a number the history already contains —
 * rolling a v5 avatar back to v2 produced a second v3, and getVersion(3) then
 * returned whichever came first. A restore is a new version, not a return to an
 * old one; `reason` records what it was restored from.
 *
 * @param {number} versionNumber - The version number to roll back to
 * @returns {Promise<Object>} The restored avatar document
 */
AvatarSchema.methods.rollbackToVersion = async function(versionNumber) {
  const versionToRestore = this.versions.find(v => v.version === versionNumber);

  if (!versionToRestore) {
    throw new Error(`Version ${versionNumber} not found for avatar ${this.avatarId}`);
  }

  // Snapshot where we are before overwriting it, so a rollback is itself undoable.
  this._pushVersion(`Auto-save before rollback to version ${versionNumber}`);

  const restoredState = versionToRestore.state || {};
  for (const key of Object.keys(restoredState)) {
    if (NON_VERSIONED_FIELDS.has(key)) continue;   // belt and braces; snapshots exclude these
    this[key] = restoredState[key];
  }

  this.version += 1;
  await this.save();

  logger.info(`Rolled back avatar ${this.avatarId} to version ${versionNumber} (now version ${this.version})`);

  return this;
};

/**
 * Get a specific version of the avatar.
 * @param {number} versionNumber - The version number to retrieve
 * @returns {Promise<Object|null>} The version document or null if not found
 */
AvatarSchema.methods.getVersion = async function(versionNumber) {
  return this.versions.find(v => v.version === versionNumber) || null;
};

// Scoring weights for the optimization heuristic. These are rules of thumb for
// real-time VRM playback, not measurements — they are here, named, so a future
// tuning pass edits one table instead of hunting magic numbers in branches.
const OPT = {
  polyCount: { heavy: 50000, high: 25000, moderate: 10000, thin: 5000, minimal: 1000 },
  complexity: { high: 10, moderate: 5 },
  compressible: { large: 30000, medium: 15000 }
};

/**
 * Total number of customization knobs set on this avatar.
 * @returns {number}
 * @private
 */
AvatarSchema.methods._customizationComplexity = function () {
  const c = this.customizations || {};
  return Object.keys(c.body || {}).length +
    Object.keys(c.face || {}).length +
    Object.keys(c.outfit || {}).length +
    (Array.isArray(c.accessories) ? c.accessories.length : 0);
};

/**
 * Score this avatar for runtime performance, visual quality and remaining
 * compression headroom, and list the concrete actions worth taking.
 *
 * Synchronous and side-effect free: it reads fields already loaded on this
 * document and touches neither the database nor `this`. The submitted version
 * wrapped the arithmetic in `retryOperation` (nothing here can fail
 * transiently, and a retry would have re-run the embedded `save()`), memoised
 * it in a module-level NodeCache with no invalidation (so editing an avatar's
 * customizations served the pre-edit scores for five more minutes, shared
 * across every document in the process), and saved the document from inside a
 * method named "analyze". Use `updateOptimizationScores()` to persist.
 *
 * `polyCount` is optional on the schema. When it is unset the poly-based
 * penalties are skipped rather than silently evaluating false, which would
 * have scored an unmeasured model identically to a well-optimised one.
 *
 * @returns {{performance:number, quality:number, compression:number, overall:number, lastAnalyzed:Date, recommendations:Array<Object>}}
 */
AvatarSchema.methods.analyzeOptimizationOpportunities = function () {
  const complexity = this._customizationComplexity();
  const polyCount = Number.isFinite(this.polyCount) ? this.polyCount : null;
  const recommendations = [];

  // Performance: start perfect, deduct for everything the GPU has to chew on.
  let performance = 100;
  if (polyCount !== null) {
    if (polyCount > OPT.polyCount.heavy) performance -= 30;
    else if (polyCount > OPT.polyCount.high) performance -= 15;
    else if (polyCount > OPT.polyCount.moderate) performance -= 5;
  }
  if (this.hasRig) performance -= 10;
  if (this.hasMorphTargets) performance -= 15;
  if (complexity > OPT.complexity.high) performance -= 20;
  else if (complexity > OPT.complexity.moderate) performance -= 10;

  // Quality: rig and morph targets buy expressiveness; too few polys cost it.
  let quality = 70;
  if (this.hasMorphTargets) quality += 20;
  if (this.hasRig) quality += 10;
  if (polyCount !== null) {
    if (polyCount < OPT.polyCount.minimal) quality -= 20;
    else if (polyCount < OPT.polyCount.thin) quality -= 10;
  }

  // Compression: how much size there is left to win, not how good it is now.
  let compression = 50;
  if (this.format === 'glb') compression += 20;
  else if (this.format === 'gltf') compression += 10;
  if (polyCount !== null) {
    if (polyCount > OPT.compressible.large) compression += 20;
    else if (polyCount > OPT.compressible.medium) compression += 10;
  }
  if (complexity > 8) compression += 15;
  else if (complexity > 4) compression += 5;

  const clamp = (n) => Math.max(0, Math.min(100, n));
  performance = clamp(performance);
  quality = clamp(quality);
  compression = clamp(compression);

  if (polyCount === null) {
    recommendations.push({
      type: 'performance',
      priority: 'low',
      message: 'polyCount is not recorded, so poly-based scoring was skipped.',
      action: 'Record polyCount when the model is imported or baked'
    });
  } else if (polyCount > OPT.polyCount.heavy) {
    recommendations.push({
      type: 'performance',
      priority: 'high',
      message: 'High polygon count detected. Consider decimation to improve performance.',
      action: `Reduce polyCount to under ${OPT.polyCount.heavy.toLocaleString('en-US')} for better frame rates`
    });
  }

  if (!this.hasRig && Array.isArray(this.customizations?.accessories) && this.customizations.accessories.length > 0) {
    recommendations.push({
      type: 'quality',
      priority: 'medium',
      message: 'Accessories detected without rig. Consider adding skeletal structure for better animation.',
      action: 'Add rig to support accessory animations'
    });
  }

  if (this.hasMorphTargets && !this.hasRig) {
    recommendations.push({
      type: 'quality',
      priority: 'medium',
      message: 'Morph targets detected without rig. Combining both can significantly enhance expressiveness.',
      action: 'Consider adding a skeletal rig to complement morph targets'
    });
  }

  if (this.format !== 'glb' && ((polyCount !== null && polyCount > 20000) || complexity > OPT.complexity.moderate)) {
    recommendations.push({
      type: 'compression',
      priority: 'high',
      message: 'Model could benefit from GLB format compression.',
      action: 'Convert to GLB format for better compression and faster loading'
    });
  }

  if (complexity > OPT.complexity.high) {
    recommendations.push({
      type: 'performance',
      priority: 'high',
      message: 'High customization complexity detected.',
      action: 'Simplify customizations or optimize individual components'
    });
  }

  return {
    performance,
    quality,
    compression,
    overall: Math.round((performance + quality + compression) / 3),
    lastAnalyzed: new Date(),
    recommendations
  };
};

/**
 * Run the optimization analysis and persist the scores on this document.
 * Mirrors `saveVersion()`: the method that mutates is the method that saves.
 * @returns {Promise<Object>} The analysis, including recommendations (which are not persisted)
 */
AvatarSchema.methods.updateOptimizationScores = async function () {
  const analysis = this.analyzeOptimizationOpportunities();

  this.optimizationScores = {
    performance: analysis.performance,
    quality: analysis.quality,
    compression: analysis.compression,
    overall: analysis.overall,
    lastAnalyzed: analysis.lastAnalyzed
  };

  await this.save();
  logger.info(`Completed optimization analysis for avatar ${this.avatarId} (overall ${analysis.overall})`);

  return analysis;
};

AvatarSchema.statics.getByOwner = function (owner) {
  return this.find({ owner }).sort({ createdAt: -1 });
};

AvatarSchema.statics.getByAgent = function (agentName) {
  return this.find({ agentName }).sort({ createdAt: -1 });
};

AvatarSchema.statics.getGallery = function (limit = 20, filters = {}) {
  const query = {};
  if (filters.owner) query.owner = filters.owner;
  if (filters.createdAfter || filters.createdBefore) {
    query.createdAt = {};
    if (filters.createdAfter) query.createdAt.$gte = new Date(filters.createdAfter);
    if (filters.createdBefore) query.createdAt.$lte = new Date(filters.createdBefore);
  }
  return this.find(query).sort({ createdAt: -1 }).limit(limit);
};

export const Avatar = mongoose.model('Avatar', AvatarSchema);
