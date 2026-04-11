import mongoose from 'mongoose';

const knowledgePackSchema = new mongoose.Schema({
  // Identity
  packId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  version: {
    type: String,
    default: '1.0.0'
  },
  previousPackId: {
    type: String,
    default: null
  },

  // Authorship
  authorFingerprint: {
    type: String,
    required: true
  },
  authorName: {
    type: String,
    default: ''
  },

  // Descriptive
  summary: {
    type: String,
    maxlength: 500,
    default: ''
  },
  topic: {
    type: String,
    default: 'general'
  },
  tags: [{
    type: String
  }],
  categories: [{
    type: String
  }],

  // Manifest (lightweight preview sent before full transfer)
  manifest: {
    type: mongoose.Schema.Types.Mixed,
    default: { memoryCount: 0, totalContentSize: 0, memoryPreviews: [] }
  },

  // Content (full memories - only present after transfer complete)
  memories: [{
    type: {
      type: String,
      enum: ['knowledge', 'learned', 'preference', 'fact'],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    metadata: {
      tags: [String],
      category: String,
      importance: { type: Number, min: 1, max: 10, default: 5 },
      source: String,
      selectable: { type: Boolean, default: true }
    }
  }],

  // Transfer tracking
  direction: {
    type: String,
    enum: ['local', 'incoming', 'outgoing'],
    required: true
  },
  status: {
    type: String,
    enum: [
      'draft', 'published',           // local lifecycle
      'transferring',                   // incoming: chunks in progress
      'awaiting_approval',              // incoming: fully received, needs user review
      'evaluating',                     // incoming: AI safety review in progress
      'approved', 'rejected',           // incoming: user/AI decision
      'importing',                      // incoming: writing to memory system
      'imported',                       // incoming: complete
      'failed'                          // any stage failure
    ],
    default: 'draft'
  },
  totalChunks: { type: Number, default: 0 },
  receivedChunks: { type: Number, default: 0 },
  totalSize: { type: Number, default: 0 },
  peerFingerprint: { type: String, default: '' },

  // Security
  sha256: { type: String, default: '' },
  signature: { type: String, default: '' },
  signerFingerprint: { type: String, default: '' },
  signatureVerified: { type: Boolean, default: false },

  // Import results
  importResults: {
    total: { type: Number, default: 0 },
    imported: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    memoryIds: [String]
  },

  // AI evaluation
  aiEvaluation: {
    evaluated: { type: Boolean, default: false },
    useful: { type: Boolean, default: false },
    safe: { type: Boolean, default: false },
    reasoning: { type: String, default: '' },
    evaluatedAt: { type: Date, default: null }
  },

  // Pricing (0 = free/community, >0 = premium pack)
  price: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'SKYNET' },

  // Error info
  error: { type: String, default: '' },

  completedAt: { type: Date, default: null }
}, {
  timestamps: true
});

// Indexes
knowledgePackSchema.index({ status: 1 });
knowledgePackSchema.index({ direction: 1, status: 1 });
knowledgePackSchema.index({ topic: 1 });
knowledgePackSchema.index({ createdAt: -1 });
knowledgePackSchema.index({ authorFingerprint: 1 });
knowledgePackSchema.index({ categories: 1 });
knowledgePackSchema.index({ 'memories.metadata.category': 1 });
knowledgePackSchema.index({ 'memories.metadata.importance': 1 });
knowledgePackSchema.index({ 'memories.metadata.tags': 1 });

/**
 * Get all packs awaiting user approval
 */
knowledgePackSchema.statics.getPendingApprovals = function() {
  return this.find({
    status: { $in: ['awaiting_approval', 'evaluating'] },
    direction: 'incoming'
  }).sort({ createdAt: -1 });
};

/**
 * Get all published local packs
 */
knowledgePackSchema.statics.getPublished = function() {
  return this.find({ status: 'published', direction: 'local' }).sort({ createdAt: -1 });
};

/**
 * Get all imported packs
 */
knowledgePackSchema.statics.getImported = function() {
  return this.find({ status: 'imported', direction: 'incoming' }).sort({ createdAt: -1 });
};

/**
 * Get pack history
 */
knowledgePackSchema.statics.getHistory = function(limit = 50) {
  return this.find().sort({ createdAt: -1 }).limit(limit);
};

/**
 * Find knowledge packs by categories
 * @param {string[]} categories - Array of category names to filter by
 * @returns {Promise<Array>} - Array of knowledge packs matching the categories
 */
knowledgePackSchema.statics.findByCategories = function(categories) {
  return this.find({ categories: { $in: categories } }).sort({ createdAt: -1 });
};

/**
 * Find knowledge packs by memory metadata tags
 * @param {string[]} tags - Array of tags to filter by
 * @returns {Promise<Array>} - Array of knowledge packs containing memories with matching tags
 */
knowledgePackSchema.statics.findByMemoryTags = function(tags) {
  return this.find({ 'memories.metadata.tags': { $in: tags } }).sort({ createdAt: -1 });
};

/**
 * Find knowledge packs by memory importance level range
 * @param {number} minImportance - Minimum importance level (1-10)
 * @param {number} maxImportance - Maximum importance level (1-10)
 * @returns {Promise<Array>} - Array of knowledge packs containing memories within the importance range
 */
knowledgePackSchema.statics.findByImportanceRange = function(minImportance, maxImportance) {
  return this.find({ 
    'memories.metadata.importance': { 
      $gte: minImportance, 
      $lte: maxImportance 
    } 
  }).sort({ 'memories.metadata.importance': -1 });
};

/**
 * Find knowledge packs by memory content type
 * @param {string} contentType - Content type to filter by (knowledge, learned, preference, fact)
 * @returns {Promise<Array>} - Array of knowledge packs containing memories of the specified type
 */
knowledgePackSchema.statics.findByMemoryType = function(contentType) {
  return this.find({ 'memories.type': contentType }).sort({ createdAt: -1 });
};

/**
 * Find knowledge packs by multiple metadata criteria
 * @param {Object} criteria - Filtering criteria
 * @param {string[]} [criteria.categories] - Categories to filter by
 * @param {string[]} [criteria.tags] - Memory tags to filter by
 * @param {number} [criteria.minImportance] - Minimum importance level
 * @param {number} [criteria.maxImportance] - Maximum importance level
 * @param {string} [criteria.contentType] - Memory content type to filter by
 * @returns {Promise<Array>} - Array of knowledge packs matching all provided criteria
 */
knowledgePackSchema.statics.findByMetadata = function(criteria) {
  const query = {};
  
  if (criteria.categories && criteria.categories.length > 0) {
    query.categories = { $in: criteria.categories };
  }
  
  if (criteria.tags && criteria.tags.length > 0) {
    query['memories.metadata.tags'] = { $in: criteria.tags };
  }
  
  if (criteria.minImportance !== undefined || criteria.maxImportance !== undefined) {
    query['memories.metadata.importance'] = {};
    if (criteria.minImportance !== undefined) {
      query['memories.metadata.importance'].$gte = criteria.minImportance;
    }
    if (criteria.maxImportance !== undefined) {
      query['memories.metadata.importance'].$lte = criteria.maxImportance;
    }
  }
  
  if (criteria.contentType) {
    query['memories.type'] = criteria.contentType;
  }
  
  return this.find(query).sort({ createdAt: -1 });
};

export const KnowledgePack = mongoose.model('KnowledgePack', knowledgePackSchema);
