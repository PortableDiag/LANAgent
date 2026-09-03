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
  }]
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
