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

/**
 * Traverse memory relationships to build a graph of connected memories
 * @param {string} memoryId - The ID of the starting memory
 * @param {number} maxHops - Maximum number of relationship hops to traverse (default: 3)
 * @param {Set} visited - Set of visited memory IDs to prevent cycles
 * @returns {Promise<Object>} Graph representation of related memories
 */
memorySchema.statics.traverseRelationships = async function(memoryId, maxHops = 3, visited = new Set()) {
  memoryId = memoryId.toString();
  if (maxHops <= 0 || visited.has(memoryId)) {
    return { nodes: [], edges: [] };
  }

  visited.add(memoryId);

  const memory = await this.findById(memoryId);
  if (!memory) {
    return { nodes: [], edges: [] };
  }

  const graph = {
    nodes: [{ id: memory._id.toString(), content: memory.content, type: memory.type }],
    edges: []
  };

  if (memory.metadata.relatedMemories && memory.metadata.relatedMemories.length > 0) {
    for (const relatedMemory of memory.metadata.relatedMemories) {
      if (relatedMemory) {
        const relatedId = relatedMemory._id ? relatedMemory._id.toString() : relatedMemory.toString();
        graph.edges.push({
          source: memoryId,
          target: relatedId
        });

        const subGraph = await this.traverseRelationships(relatedId, maxHops - 1, visited);
        graph.nodes = [...graph.nodes, ...subGraph.nodes];
        graph.edges = [...graph.edges, ...subGraph.edges];
      }
    }
  }

  // Remove duplicate nodes and edges
  const uniqueNodes = Array.from(new Map(graph.nodes.map(node => [node.id, node])).values());
  const uniqueEdges = Array.from(new Map(graph.edges.map(edge => [`${edge.source}-${edge.target}`, edge])).values());

  return { nodes: uniqueNodes, edges: uniqueEdges };
};

/**
 * Create a relationship between two memories
 * @param {string} sourceMemoryId - The ID of the source memory
 * @param {string} targetMemoryId - The ID of the target memory
 * @returns {Promise<Object>} Updated source memory document
 */
memorySchema.statics.createRelationship = async function(sourceMemoryId, targetMemoryId) {
  if (sourceMemoryId.toString() === targetMemoryId.toString()) {
    throw new Error('Cannot create relationship to self');
  }

  const sourceMemory = await this.findById(sourceMemoryId);
  const targetMemory = await this.findById(targetMemoryId);

  if (!sourceMemory) {
    throw new Error(`Source memory with ID ${sourceMemoryId} not found`);
  }

  if (!targetMemory) {
    throw new Error(`Target memory with ID ${targetMemoryId} not found`);
  }

  // Add target to source's related memories if not already present
  if (!sourceMemory.metadata.relatedMemories) {
    sourceMemory.metadata.relatedMemories = [];
  }

  const alreadyRelated = sourceMemory.metadata.relatedMemories
    .some(id => id.toString() === targetMemoryId.toString());
  if (!alreadyRelated) {
    sourceMemory.metadata.relatedMemories.push(targetMemoryId);
    await sourceMemory.save();
  }

  return sourceMemory;
};

export const Memory = mongoose.model('Memory', memorySchema);
