import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const journalEntrySchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
  },
  source: {
    type: String,
    enum: ['text', 'voice'],
    default: 'text'
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const journalSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true
  },
  entries: [journalEntrySchema],
  summary: {
    type: String,
    default: ''
  },
  extractedMemories: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Memory'
  }],
  mood: String,
  tags: [String],
  metadata: {
    entryCount: {
      type: Number,
      default: 0
    },
    totalWordCount: {
      type: Number,
      default: 0
    },
    sessionDuration: Number,
    closedAt: Date
  }
}, {
  timestamps: true
});

// Indexes
journalSchema.index({ userId: 1, createdAt: -1 });
journalSchema.index({ userId: 1, status: 1 });
journalSchema.index({ tags: 1 });
journalSchema.index({
  'entries.content': 'text',
  title: 'text',
  summary: 'text'
});

// Cache for query results (5 min TTL)
journalSchema.statics.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Instance methods
journalSchema.methods.addEntry = function(content, source = 'text') {
  this.entries.push({ content, source, timestamp: new Date() });
  this.metadata.entryCount = this.entries.length;
  this.metadata.totalWordCount = this.entries.reduce(
    (sum, e) => sum + e.content.split(/\s+/).length, 0
  );
  // Writing entries invalidates the paginated read caches (per-journal and
  // per-user list), otherwise stale entries/counts are served for up to the TTL.
  this.constructor.cache.flushAll();
  return this.save();
};

journalSchema.methods.close = function(summary = '') {
  this.status = 'closed';
  this.summary = summary;
  this.metadata.closedAt = new Date();
  this.metadata.sessionDuration = this.metadata.closedAt - this.createdAt;
  this.constructor.cache.flushAll();
  return this.save();
};

journalSchema.methods.getFullText = function() {
  return this.entries.map(e => e.content).join('\n\n');
};

/**
 * Paginate journal entries for virtual scrolling
 * @param {number} page - Page number (0-indexed)
 * @param {number} limit - Number of entries per page
 * @returns {Object} Paginated entries with metadata
 */
journalSchema.methods.paginateEntries = function(page = 0, limit = 50) {
  const startIndex = page * limit;
  const endIndex = startIndex + limit;
  const totalEntries = this.entries.length;
  
  // Return paginated results
  return {
    entries: this.entries.slice(startIndex, endIndex),
    pagination: {
      page,
      limit,
      total: totalEntries,
      hasNext: endIndex < totalEntries,
      hasPrev: page > 0
    }
  };
};

// Static methods
journalSchema.statics.findActiveSession = function(userId) {
  return this.findOne({ userId, status: 'active' });
};

journalSchema.statics.findByDateRange = function(userId, startDate, endDate) {
  return this.find({
    userId,
    createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) }
  }).sort({ createdAt: -1 });
};

journalSchema.statics.searchContent = async function(userId, searchText, limit = 20, skip = 0) {
  const cacheKey = `searchContent:${userId}:${searchText}:${limit}:${skip}`;
  const cached = this.cache.get(cacheKey);
  if (cached) return cached;

  const result = await retryOperation(() => this.find({
    userId,
    $text: { $search: searchText }
  })
  .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
  .skip(skip)
  .limit(limit), { context: 'Journal.searchContent' });

  this.cache.set(cacheKey, result);
  return result;
};

journalSchema.statics.findRecent = async function(userId, limit = 10, skip = 0) {
  const cacheKey = `findRecent:${userId}:${limit}:${skip}`;
  const cached = this.cache.get(cacheKey);
  if (cached) return cached;

  const result = await retryOperation(() => this.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit), { context: 'Journal.findRecent' });

  this.cache.set(cacheKey, result);
  return result;
};

/**
 * Find journal entries with pagination for virtual scrolling support
 * @param {string} userId - User ID
 * @param {number} page - Page number (0-indexed)
 * @param {number} limit - Number of entries per page
 * @returns {Object} Paginated journals with entries
 */
journalSchema.statics.paginateEntries = async function(userId, page = 0, limit = 10) {
  const cacheKey = `paginateEntries:${userId}:${page}:${limit}`;
  const cached = this.cache.get(cacheKey);
  if (cached) return cached;

  const skip = page * limit;
  
  // First get the journal documents with only metadata (not entries)
  const journals = await retryOperation(() => 
    this.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-entries'), 
    { context: 'Journal.paginateEntries.find' }
  );

  // Then get count for pagination metadata
  const totalJournals = await retryOperation(() => 
    this.countDocuments({ userId }), 
    { context: 'Journal.paginateEntries.count' }
  );

  const result = {
    journals,
    pagination: {
      page,
      limit,
      total: totalJournals,
      hasNext: (skip + limit) < totalJournals,
      hasPrev: page > 0
    }
  };

  this.cache.set(cacheKey, result);
  return result;
};

/**
 * Get paginated entries for a specific journal with virtual scrolling support
 * @param {string} journalId - Journal ID
 * @param {number} page - Page number (0-indexed)
 * @param {number} limit - Number of entries per page
 * @returns {Object} Paginated entries with metadata
 */
journalSchema.statics.getPaginatedJournalEntries = async function(journalId, page = 0, limit = 50) {
  const cacheKey = `journalEntries:${journalId}:${page}:${limit}`;
  const cached = this.cache.get(cacheKey);
  if (cached) return cached;

  const skip = page * limit;

  // DB-side slice returns ONLY the requested window (indexed from 0), so we must
  // NOT re-slice it with page*limit — that was the double-slice bug that returned
  // [] for every page > 0. Build the metadata inline and get the true entry count
  // via $size (avoids loading the whole entries array just to count it).
  const journal = await retryOperation(() =>
    this.findById(journalId)
      .select('entries')
      .slice('entries', [skip, limit]),
    { context: 'Journal.getPaginatedJournalEntries' }
  );

  if (!journal) {
    throw new Error('Journal not found');
  }

  const [countDoc] = await retryOperation(() =>
    this.aggregate([
      { $match: { _id: journal._id } },
      { $project: { total: { $size: { $ifNull: ['$entries', []] } } } }
    ]),
    { context: 'Journal.getPaginatedJournalEntries.count' }
  );
  const total = countDoc ? countDoc.total : journal.entries.length;

  const result = {
    entries: journal.entries,
    pagination: {
      page,
      limit,
      total,
      hasNext: skip + journal.entries.length < total,
      hasPrev: page > 0
    }
  };
  this.cache.set(cacheKey, result);
  return result;
};

export const Journal = mongoose.model('Journal', journalSchema);
