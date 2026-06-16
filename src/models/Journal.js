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
  return this.save();
};

journalSchema.methods.close = function(summary = '') {
  this.status = 'closed';
  this.summary = summary;
  this.metadata.closedAt = new Date();
  this.metadata.sessionDuration = this.metadata.closedAt - this.createdAt;
  return this.save();
};

journalSchema.methods.getFullText = function() {
  return this.entries.map(e => e.content).join('\n\n');
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

export const Journal = mongoose.model('Journal', journalSchema);
