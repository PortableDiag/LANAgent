import mongoose from 'mongoose';

const memorySchema = new mongoose.Schema({
  // Context and conversation memory
  type: {
    type: String,
    enum: ['conversation', 'task', 'knowledge', 'system', 'preference', 'operation', 'summary', 'pattern'],
    required: true,
    index: true
  },
  
  // Content
  content: {
    type: String,
    required: true
  },
  
  // Embeddings for semantic search (stored here, searched via LanceDB)
  embedding: {
    type: [Number],
    select: false // Don't return embeddings by default to save bandwidth
  },
  
  // Metadata
  metadata: {
    userId: String,
    userName: String,
    chatId: String,
    taskId: mongoose.Schema.Types.ObjectId,
    tags: [String],
    category: String,
    importance: {
      type: Number,
      default: 5,
      min: 1,
      max: 10
    },
    source: String,
    relatedMemories: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Memory'
    }],
    // Contact-specific fields
    email: String,
    name: String,
    aliases: [String],
    phone: String,
    telegram: String,
    socialMedia: mongoose.Schema.Types.Mixed,
    relationship: String,
    firstContactDate: Date,
    lastContactDate: Date,
    isPermanent: Boolean
  },
  
  // Temporal information
  context: {
    previousMessage: String,
    nextMessage: String,
    conversationId: String,
    sessionId: String
  },
  
  // Usage tracking
  accessCount: {
    type: Number,
    default: 0
  },
  lastAccessedAt: Date,
  
  // Expiration
  expiresAt: Date,
  isPermanent: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
memorySchema.index({ 'metadata.tags': 1 });
memorySchema.index({ 'metadata.category': 1 });
memorySchema.index({ 'metadata.importance': -1 });
memorySchema.index({ createdAt: -1 });
memorySchema.index({ 'metadata.userId': 1, createdAt: -1 });
memorySchema.index({ 
  content: 'text', 
  'metadata.tags': 'text',
  'metadata.category': 'text' 
});

// Virtual for age
memorySchema.virtual('age').get(function() {
  return Date.now() - this.createdAt;
});

// Methods
memorySchema.methods.access = function() {
  this.accessCount++;
  this.lastAccessedAt = new Date();
  return this.save();
};

memorySchema.methods.addRelatedMemory = function(memoryId) {
  if (!this.metadata.relatedMemories || !this.metadata.relatedMemories.includes(memoryId)) {
    this.metadata.relatedMemories.push(memoryId);
  }
  return this.save();
};

// Static methods for common queries
memorySchema.statics.findByUser = function(userId, limit = 100) {
  return this.find({ 'metadata.userId': userId })
    .sort({ createdAt: -1 })
    .limit(limit);
};

memorySchema.statics.findByTags = function(tags, limit = 50) {
  return this.find({ 'metadata.tags': { $in: tags } })
    .sort({ 'metadata.importance': -1, createdAt: -1 })
    .limit(limit);
};

memorySchema.statics.findSimilar = async function(embedding, threshold = 0.7, limit = 10) {
  // NOTE: This method is deprecated. Vector similarity search is now handled
  // by MemoryVectorStore (LanceDB) via memoryManager.recall()
  // This fallback returns memories sorted by importance
  return this.find({})
    .sort({ 'metadata.importance': -1, createdAt: -1 })
    .limit(limit);
};

// Get memories with embeddings for vector store indexing
// Only indexes knowledge/learned types - NOT conversation history (which is temporal and gets cleared)
memorySchema.statics.getMemoriesWithEmbeddings = async function(limit = null) {
  const query = this.find({
    embedding: { $exists: true, $ne: [] },
    // Only index memory types meant for long-term semantic recall
    type: { $in: ['knowledge', 'learned', 'preference', 'fact'] }
  }).select('+embedding');

  if (limit) {
    query.limit(limit);
  }

  return query.exec();
};

memorySchema.statics.cleanupExpired = function() {
  return this.deleteMany({
    expiresAt: { $lt: new Date() },
    isPermanent: false
  });
};

/**
 * Aggregation pipeline to group memories by user and calculate statistics
 * @param {Object} matchCriteria - Optional criteria to filter memories before aggregation
 * @returns {Promise<Array>} Aggregated results with userId, averageImportance, totalAccessCount, memoryCount
 */
memorySchema.statics.aggregateMemoriesByUser = function(matchCriteria = {}) {
  const pipeline = [
    { $match: matchCriteria },
    { $group: {
      _id: '$metadata.userId',
      averageImportance: { $avg: '$metadata.importance' },
      totalAccessCount: { $sum: '$accessCount' },
      memoryCount: { $sum: 1 }
    }},
    { $sort: { memoryCount: -1 } }
  ];
  return this.aggregate(pipeline).exec();
};

export const Memory = mongoose.model('Memory', memorySchema);