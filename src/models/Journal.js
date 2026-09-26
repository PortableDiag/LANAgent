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

/**
 * Search journal content using text relevance and composable filters.
 *
 * The legacy numeric limit and skip arguments remain supported:
 * searchContent(userId, text, limit, skip)
 *
 * @param {string} userId - User ID
 * @param {string} searchText - Text to search for
 * @param {Object|number} options - Search options or legacy limit
 * @param {number} options.limit - Maximum number of results
 * @param {number} options.skip - Number of results to skip
 * @param {'active'|'closed'} options.status - Journal status
 * @param {'text'|'voice'} options.source - Entry source
 * @param {string|string[]} options.tags - Tags that must be present
 * @param {Date|string} options.startDate - Inclusive creation date
 * @param {Date|string} options.endDate - Inclusive creation date
 * @param {boolean} options.includeCount - Include total matching count
 * @returns {Array|Object} Matching journals, optionally with total count
 */
journalSchema.statics.searchContent = async function(userId, searchText, options = {}, legacySkip = 0) {
  let normalizedOptions;

  if (typeof options === 'number') {
    normalizedOptions = {
      limit: options,
      skip: legacySkip
    };
  } else if (options && typeof options === 'object' && !Array.isArray(options)) {
    normalizedOptions = { ...options };
  } else {
    throw new TypeError('Search options must be an object');
  }

  const {
    limit = 20,
    skip = 0,
    status,
    source,
    tags,
    startDate,
    endDate,
    includeCount = false
  } = normalizedOptions;

  if (typeof searchText !== 'string' || !searchText.trim()) {
    throw new TypeError('searchText must be a non-empty string');
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative integer');
  }

  if (!Number.isInteger(skip) || skip < 0) {
    throw new RangeError('skip must be a non-negative integer');
  }

  if (status !== undefined && !['active', 'closed'].includes(status)) {
    throw new RangeError('status must be active or closed');
  }

  if (source !== undefined && !['text', 'voice'].includes(source)) {
    throw new RangeError('source must be text or voice');
  }

  const normalizedTags = tags === undefined
    ? undefined
    : (Array.isArray(tags) ? tags : [tags]);

  if (normalizedTags && (
    normalizedTags.length === 0 ||
    normalizedTags.some(tag => typeof tag !== 'string' || !tag.trim())
  )) {
    throw new TypeError('tags must be a non-empty string or array of strings');
  }

  const dateFilter = {};
  let normalizedStartDate;
  let normalizedEndDate;

  if (startDate !== undefined) {
    normalizedStartDate = new Date(startDate);
    if (Number.isNaN(normalizedStartDate.getTime())) {
      throw new RangeError('startDate must be a valid date');
    }
    dateFilter.$gte = normalizedStartDate;
  }

  if (endDate !== undefined) {
    normalizedEndDate = new Date(endDate);
    if (Number.isNaN(normalizedEndDate.getTime())) {
      throw new RangeError('endDate must be a valid date');
    }
    dateFilter.$lte = normalizedEndDate;
  }

  if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
    throw new RangeError('startDate must not be later than endDate');
  }

  if (typeof includeCount !== 'boolean') {
    throw new TypeError('includeCount must be a boolean');
  }

  const query = {
    userId,
    $text: { $search: searchText.trim() }
  };

  if (status !== undefined) query.status = status;
  if (source !== undefined) query['entries.source'] = source;
  if (normalizedTags !== undefined) query.tags = { $all: normalizedTags };
  if (Object.keys(dateFilter).length > 0) query.createdAt = dateFilter;

  const cacheKey = `searchContent:${JSON.stringify({
    userId,
    searchText: searchText.trim(),
    limit,
    skip,
    status: status ?? null,
    source: source ?? null,
    tags: normalizedTags ?? null,
    startDate: normalizedStartDate ? normalizedStartDate.toISOString() : null,
    endDate: normalizedEndDate ? normalizedEndDate.toISOString() : null,
    includeCount
  })}`;

  const cached = this.cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = await retryOperation(() => this.find(query)
    .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
    .skip(skip)
    .limit(limit), { context: 'Journal.searchContent' });

  let response = result;

  if (includeCount) {
    const total = await retryOperation(() => this.countDocuments(query), {
      context: 'Journal.searchContent.count'
    });
    response = { results: result, total };
  }

  this.cache.set(cacheKey, response);
  return response;
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
 * @param {number} limit - Number of journals per page
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

// Invalidate all cached search and pagination results whenever a journal changes.
// Query middleware: `this` is the Query and `this.model` is the Model. Document
// middleware (save): `this` is the document, `this.model` is a lookup FUNCTION with
// no cache, so the Model must be reached through `this.constructor`.
journalSchema.post('save', function() {
  this.constructor?.cache?.flushAll();
});
journalSchema.post(['findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'], function() {
  this.model?.cache?.flushAll();
});

export const Journal = mongoose.model('Journal', journalSchema);
