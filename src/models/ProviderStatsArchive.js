import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

// Schema for archived monthly provider statistics
const providerStatsArchiveSchema = new mongoose.Schema({
  // Period identification
  year: {
    type: Number,
    required: true
  },
  month: {
    type: Number,  // 1-12
    required: true
  },
  periodStart: {
    type: Date,
    required: true
  },
  periodEnd: {
    type: Date,
    required: true
  },

  // Provider breakdown
  providers: [{
    provider: {
      type: String,
      enum: ['openai', 'anthropic', 'gab', 'huggingface', 'xai', 'ollama', 'bitnet']
    },
    totalRequests: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    avgResponseTime: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    successRate: { type: Number, default: 100 },

    // Model breakdown within provider
    models: [{
      model: String,
      requests: { type: Number, default: 0 },
      tokens: { type: Number, default: 0 },
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
      avgResponseTime: { type: Number, default: 0 }
    }],

    // Error categorization
    errorDetails: [{
      type: { type: String, enum: ['network', 'authentication', 'data_validation', 'other'], required: true },
      description: { type: String, required: true },
      count: { type: Number, default: 0 }
    }]
  }],

  // Totals across all providers
  totals: {
    requests: { type: Number, default: 0 },
    tokens: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    avgResponseTime: { type: Number, default: 0 },
    errors: { type: Number, default: 0 }
  },

  // Metadata
  archivedAt: {
    type: Date,
    default: Date.now
  },
  archiveType: {
    type: String,
    enum: ['auto', 'manual'],
    default: 'auto'
  },
  notes: String

}, {
  timestamps: true
});

// Compound index for unique month/year combinations
providerStatsArchiveSchema.index({ year: 1, month: 1 }, { unique: true });
providerStatsArchiveSchema.index({ periodStart: -1 });

// Static method to create archive from current TokenUsage data
providerStatsArchiveSchema.statics.createArchive = async function(archiveType = 'auto', notes = '') {
  const TokenUsage = mongoose.model('TokenUsage');

  // Get current date info
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  // Calculate period (previous month if auto-archive on 1st, current if manual)
  let periodYear = year;
  let periodMonth = month;

  if (archiveType === 'auto') {
    // Auto-archive is for the previous month
    periodMonth = month - 1;
    if (periodMonth === 0) {
      periodMonth = 12;
      periodYear = year - 1;
    }
  }

  const periodStart = new Date(periodYear, periodMonth - 1, 1);
  const periodEnd = new Date(periodYear, periodMonth, 0, 23, 59, 59, 999);

  // Check if archive already exists for this period
  const existing = await this.findOne({ year: periodYear, month: periodMonth });
  if (existing) {
    throw new Error(`Archive already exists for ${periodYear}-${String(periodMonth).padStart(2, '0')}`);
  }

  // Get aggregated stats by provider
  const providerStats = await TokenUsage.aggregate([
    {
      $match: archiveType === 'manual' ? {} : {
        createdAt: { $gte: periodStart, $lte: periodEnd }
      }
    },
    {
      $group: {
        _id: { provider: '$provider', model: '$model', errorType: '$errorType', errorDescription: '$errorDescription' },
        requests: { $sum: 1 },
        tokens: { $sum: '$totalTokens' },
        promptTokens: { $sum: '$promptTokens' },
        completionTokens: { $sum: '$completionTokens' },
        cost: { $sum: '$cost' },
        avgResponseTime: { $avg: '$responseTime' },
        errors: { $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] } }
      }
    }
  ]);

  // Organize by provider
  const providerMap = {};
  let grandTotals = {
    requests: 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    responseTimeSum: 0,
    responseTimeCount: 0,
    errors: 0
  };

  for (const stat of providerStats) {
    const { provider, model, errorType, errorDescription } = stat._id;

    if (!providerMap[provider]) {
      providerMap[provider] = {
        provider,
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalCost: 0,
        responseTimeSum: 0,
        responseTimeCount: 0,
        errors: 0,
        models: [],
        errorDetails: []
      };
    }

    const p = providerMap[provider];
    p.totalRequests += stat.requests;
    p.totalTokens += stat.tokens;
    p.promptTokens += stat.promptTokens;
    p.completionTokens += stat.completionTokens;
    p.totalCost += stat.cost;
    p.responseTimeSum += stat.avgResponseTime * stat.requests;
    p.responseTimeCount += stat.requests;
    p.errors += stat.errors;

    p.models.push({
      model,
      requests: stat.requests,
      tokens: stat.tokens,
      promptTokens: stat.promptTokens,
      completionTokens: stat.completionTokens,
      cost: stat.cost,
      avgResponseTime: stat.avgResponseTime
    });

    if (errorType && errorDescription) {
      const existingError = p.errorDetails.find(e => e.type === errorType && e.description === errorDescription);
      if (existingError) {
        existingError.count += stat.errors;
      } else {
        p.errorDetails.push({
          type: errorType,
          description: errorDescription,
          count: stat.errors
        });
      }
    }

    // Grand totals
    grandTotals.requests += stat.requests;
    grandTotals.tokens += stat.tokens;
    grandTotals.promptTokens += stat.promptTokens;
    grandTotals.completionTokens += stat.completionTokens;
    grandTotals.cost += stat.cost;
    grandTotals.responseTimeSum += stat.avgResponseTime * stat.requests;
    grandTotals.responseTimeCount += stat.requests;
    grandTotals.errors += stat.errors;
  }

  // Calculate averages and format providers array
  const providers = Object.values(providerMap).map(p => ({
    provider: p.provider,
    totalRequests: p.totalRequests,
    totalTokens: p.totalTokens,
    promptTokens: p.promptTokens,
    completionTokens: p.completionTokens,
    totalCost: p.totalCost,
    avgResponseTime: p.responseTimeCount > 0 ? p.responseTimeSum / p.responseTimeCount : 0,
    errors: p.errors,
    successRate: p.totalRequests > 0 ? ((p.totalRequests - p.errors) / p.totalRequests) * 100 : 100,
    models: p.models,
    errorDetails: p.errorDetails
  }));

  // Create the archive document
  const archive = new this({
    year: periodYear,
    month: periodMonth,
    periodStart,
    periodEnd,
    providers,
    totals: {
      requests: grandTotals.requests,
      tokens: grandTotals.tokens,
      promptTokens: grandTotals.promptTokens,
      completionTokens: grandTotals.completionTokens,
      cost: grandTotals.cost,
      avgResponseTime: grandTotals.responseTimeCount > 0
        ? grandTotals.responseTimeSum / grandTotals.responseTimeCount
        : 0,
      errors: grandTotals.errors
    },
    archiveType,
    notes
  });

  await archive.save();
  return archive;
};

// Get all archives sorted by date
providerStatsArchiveSchema.statics.getArchives = async function(limit = 12) {
  return this.find({})
    .sort({ year: -1, month: -1 })
    .limit(limit);
};

// Get archive for specific month
providerStatsArchiveSchema.statics.getArchiveByMonth = async function(year, month) {
  return this.findOne({ year, month });
};

// Get usage trends over time
providerStatsArchiveSchema.statics.getUsageTrends = async function(months = 6) {
  const archives = await this.find({})
    .sort({ year: -1, month: -1 })
    .limit(months);

  return archives.map(a => ({
    period: `${a.year}-${String(a.month).padStart(2, '0')}`,
    year: a.year,
    month: a.month,
    totals: a.totals,
    providers: a.providers.map(p => ({
      provider: p.provider,
      requests: p.totalRequests,
      tokens: p.totalTokens,
      cost: p.totalCost
    }))
  })).reverse(); // Chronological order
};

/**
 * Analyze provider performance trends over time.
 * @param {number} months - Number of months to analyze.
 * @returns {Promise<Array>} - Detailed provider performance analytics.
 */
providerStatsArchiveSchema.statics.analyzeProviderPerformance = async function(months = 6) {
  const archives = await this.find({})
    .sort({ year: -1, month: -1 })
    .limit(months);

  return archives.map(a => ({
    period: `${a.year}-${String(a.month).padStart(2, '0')}`,
    year: a.year,
    month: a.month,
    providers: a.providers.map(p => ({
      provider: p.provider,
      avgResponseTime: p.avgResponseTime,
      errorRate: p.errors / p.totalRequests,
      responseTimeDistribution: this.calculateResponseTimeDistribution(p.models),
      errorRateFluctuation: this.calculateErrorRateFluctuation(p.errorDetails)
    }))
  })).reverse(); // Chronological order
};

/**
 * Calculate response time distribution for models.
 * @param {Array} models - List of models with response times.
 * @returns {Object} - Distribution of response times.
 */
providerStatsArchiveSchema.statics.calculateResponseTimeDistribution = function(models) {
  const distribution = {};
  models.forEach(model => {
    const time = Math.floor(model.avgResponseTime / 100) * 100; // Group by 100ms
    if (!distribution[time]) {
      distribution[time] = 0;
    }
    distribution[time] += model.requests;
  });
  return distribution;
};

/**
 * Calculate error rate fluctuation.
 * @param {Array} errorDetails - List of error details.
 * @returns {Object} - Fluctuation of error rates.
 */
providerStatsArchiveSchema.statics.calculateErrorRateFluctuation = function(errorDetails) {
  const fluctuation = {};
  errorDetails.forEach(error => {
    if (!fluctuation[error.type]) {
      fluctuation[error.type] = 0;
    }
    fluctuation[error.type] += error.count;
  });
  return fluctuation;
};

export const ProviderStatsArchive = mongoose.model('ProviderStatsArchive', providerStatsArchiveSchema);