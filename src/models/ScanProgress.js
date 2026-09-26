import mongoose from 'mongoose';

const ScanProgressSchema = new mongoose.Schema({
  // Scan session info
  scanId: {
    type: String,
    required: true,
    index: true
  },
  sessionScanId: {
    type: String,
    required: true,
    index: true
  },
  
  // File tracking
  filePath: {
    type: String,
    required: true,
    index: true
  },
  relativePath: {
    type: String,
    required: true
  },
  
  // File chunking info
  isChunked: {
    type: Boolean,
    default: false
  },
  chunkIndex: {
    type: Number,
    default: 0 // 0 for whole file, 1+ for chunks
  },
  totalChunks: {
    type: Number,
    default: 1
  },
  chunkStartLine: {
    type: Number,
    default: 1
  },
  chunkEndLine: {
    type: Number
  },
  
  // Content info
  fileSize: {
    type: Number,
    required: true
  },
  lineCount: {
    type: Number,
    required: true
  },
  
  // Processing status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    default: 'pending',
    index: true
  },
  
  // Priority field for scan prioritization
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'critical'],
    default: 'normal',
    index: true
  },
  
  // AI provider info
  aiProvider: {
    type: String,
    required: true
  },
  aiModel: {
    type: String,
    required: true
  },
  contextLimit: {
    type: Number,
    required: true
  },
  
  // Results
  bugsFound: {
    type: Number,
    default: 0
  },
  bugIds: [{
    type: String
  }],
  
  // Processing metadata
  processingTime: {
    type: Number // milliseconds
  },
  tokenCount: {
    type: Number
  },
  errorMessage: {
    type: String
  },
  
  // Timestamps
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'scan_progress'
});

// Indexes for efficient querying
ScanProgressSchema.index({ scanId: 1, filePath: 1, chunkIndex: 1 }, { unique: true });
ScanProgressSchema.index({ status: 1, createdAt: -1 });
ScanProgressSchema.index({ aiProvider: 1, status: 1 });
ScanProgressSchema.index({ priority: 1, createdAt: 1 });

/**
 * Get scan progress summary for a specific scan ID
 * @param {string} scanId - The scan SESSION id (matched against sessionScanId; each
 *   row's own scanId is a per-file/chunk key and would select at most one row)
 * @returns {Object} Summary of scan progress including completion status, processing times, and bug detection rates
 */
ScanProgressSchema.statics.getScanProgressSummary = async function(scanId) {
  const pipeline = [
    {
      $match: {
        sessionScanId: scanId
      }
    },
    {
      $group: {
        _id: null,
        totalFiles: { $sum: 1 },
        completedFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'completed'] }, 1, 0]
          }
        },
        failedFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'failed'] }, 1, 0]
          }
        },
        pendingFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
          }
        },
        processingFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'processing'] }, 1, 0]
          }
        },
        skippedFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0]
          }
        },
        totalBugsFound: { $sum: '$bugsFound' },
        totalProcessingTime: { $sum: '$processingTime' },
        avgProcessingTime: { $avg: '$processingTime' },
        totalFileSize: { $sum: '$fileSize' },
        totalLines: { $sum: '$lineCount' },
        providers: { $addToSet: '$aiProvider' },
        models: { $addToSet: '$aiModel' }
      }
    },
    {
      $project: {
        _id: 0,
        totalFiles: 1,
        completedFiles: 1,
        failedFiles: 1,
        pendingFiles: 1,
        processingFiles: 1,
        skippedFiles: 1,
        completionRate: {
          $cond: [
            { $eq: ['$totalFiles', 0] },
            0,
            { $multiply: [{ $divide: ['$completedFiles', '$totalFiles'] }, 100] }
          ]
        },
        failureRate: {
          $cond: [
            { $eq: ['$totalFiles', 0] },
            0,
            { $multiply: [{ $divide: ['$failedFiles', '$totalFiles'] }, 100] }
          ]
        },
        totalBugsFound: 1,
        bugDetectionRate: {
          $cond: [
            { $eq: ['$totalFiles', 0] },
            0,
            { $divide: ['$totalBugsFound', '$totalFiles'] }
          ]
        },
        totalProcessingTime: 1,
        // $avg returns null (not 0) when every processingTime is null, which is
        // the normal state for a scan that has queued files but not timed any yet.
        // Coalesce so callers always get a number and don't have to special-case it.
        avgProcessingTime: { $ifNull: ['$avgProcessingTime', 0] },
        totalFileSize: 1,
        totalLines: 1,
        providers: 1,
        models: 1
      }
    }
  ];

  const result = await this.aggregate(pipeline);
  return result.length > 0 ? result[0] : {
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    pendingFiles: 0,
    processingFiles: 0,
    skippedFiles: 0,
    completionRate: 0,
    failureRate: 0,
    totalBugsFound: 0,
    bugDetectionRate: 0,
    totalProcessingTime: 0,
    avgProcessingTime: 0,
    totalFileSize: 0,
    totalLines: 0,
    providers: [],
    models: []
  };
};

/**
 * Update the priority of a specific scan
 * @param {string} scanId - The ID of the scan
 * @param {string} filePath - The path of the file within the scan
 * @param {string} priority - The new priority level (low, normal, high, critical)
 * @returns {Object} The updated scan document
 */
ScanProgressSchema.statics.updatePriority = async function(scanId, filePath, priority) {
  if (!['low', 'normal', 'high', 'critical'].includes(priority)) {
    throw new Error('Invalid priority level. Must be one of: low, normal, high, critical');
  }

  const result = await this.findOneAndUpdate(
    { scanId, filePath },
    { priority },
    { new: true }
  );

  if (!result) {
    throw new Error(`Scan with ID ${scanId} and file path ${filePath} not found`);
  }

  return result;
};

// Rank for each priority label. `priority` is a STRING enum, so a plain
// `.sort({ priority: -1 })` orders it LEXICOGRAPHICALLY, not by importance:
// that yields normal → low → high → critical, putting the most urgent bucket
// LAST. The submitted comment claimed "critical (4) -> high (3) -> normal (2)
// -> low (1)", which is what the code would do if the field held numbers. It
// does not. Ordering therefore has to be computed, not assumed.
const PRIORITY_RANK = { critical: 4, high: 3, normal: 2, low: 1 };
const DEFAULT_PRIORITY_RANK = PRIORITY_RANK.normal;

/**
 * Get all queued scans ordered by priority and creation time.
 *
 * Documents written before the `priority` field existed have no value for it —
 * a schema `default` applies to new documents only, never retroactively — so
 * they are ranked as `normal`, which is what the default would have given them.
 *
 * @returns {Array} Scans ordered critical first, then oldest first
 */
ScanProgressSchema.statics.getQueuedScansByPriority = async function() {
  return this.aggregate([
    { $match: { status: 'pending' } },
    {
      $addFields: {
        _priorityRank: {
          $switch: {
            branches: [
              { case: { $eq: ['$priority', 'critical'] }, then: PRIORITY_RANK.critical },
              { case: { $eq: ['$priority', 'high'] },     then: PRIORITY_RANK.high },
              { case: { $eq: ['$priority', 'low'] },      then: PRIORITY_RANK.low }
            ],
            default: DEFAULT_PRIORITY_RANK
          }
        }
      }
    },
    { $sort: { _priorityRank: -1, createdAt: 1 } },
    { $project: { _priorityRank: 0 } }
  ]);
};

/**
 * Get scans by priority level
 * @param {string} priority - The priority level to filter by
 * @returns {Array} Array of scans with the specified priority
 */
ScanProgressSchema.statics.getScansByPriority = async function(priority) {
  if (!['low', 'normal', 'high', 'critical'].includes(priority)) {
    throw new Error('Invalid priority level. Must be one of: low, normal, high, critical');
  }

  return await this.find({ priority })
    .sort({ createdAt: 1 })
    .lean();
};

/**
 * Get priority statistics for a specific scan ID
 * @param {string} scanId - The scan SESSION id (matched against sessionScanId)
 * @returns {Object} Statistics about priority distribution
 */
ScanProgressSchema.statics.getPriorityStats = async function(scanId) {
  const pipeline = [
    {
      $match: {
        sessionScanId: scanId
      }
    },
    {
      $group: {
        _id: '$priority',
        count: { $sum: 1 }
      }
    }
  ];

  const results = await this.aggregate(pipeline);

  const stats = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0
  };

  for (const item of results) {
    // A document predating the field groups under _id: null. Assigning
    // stats[null] added a "null" key to the returned shape; counting it as
    // normal instead matches how getQueuedScansByPriority ranks the same
    // documents, so the two cannot disagree about the same row.
    const bucket = item._id ?? 'normal';
    if (bucket in stats) stats[bucket] += item.count;
  }

  return stats;
};

/**
 * Estimate when a scan session will finish.
 *
 * Keyed on `sessionScanId`, NOT `scanId`. `scanId` is a per-chunk composite
 * (`<session>_<path>_chunk_N`, see incrementalScanner.createScanEntries), so
 * matching a session identifier against it finds nothing and the estimate
 * comes back empty forever — while looking like a scan with no work in it.
 *
 * "Finished" counts failed entries as well as completed ones: a failed entry
 * still burned its processingTime and still leaves the queue, so excluding it
 * both understates throughput and leaves it counted as remaining work.
 *
 * Velocity is measured against wall-clock elapsed (first start → last finish),
 * not against the span between finishes. The span form divides by zero for a
 * single finish and over-states throughput on small samples; elapsed-time also
 * absorbs concurrency, which a per-item average cannot.
 *
 * @param {string} sessionScanId - The scan session to estimate
 * @returns {Object} Estimate plus the basis it was computed from. A null
 *   `estimatedCompletionTime` means "not enough data", never "done now".
 */
ScanProgressSchema.statics.estimateCompletionTime = async function(sessionScanId) {
  // Sample size below which throughput is not yet trustworthy, used to keep
  // `confidence` from reading 1.0 off a single finished file.
  const MIN_VELOCITY_SAMPLE = 5;

  const empty = {
    estimatedCompletionTime: null,
    estimatedMillisecondsRemaining: null,
    processingVelocity: null,
    avgProcessingTime: null,
    totalFiles: 0,
    filesFinished: 0,
    filesRemaining: 0,
    queuedFilesAhead: 0,
    confidence: 0
  };

  const [agg] = await this.aggregate([
    { $match: { sessionScanId } },
    {
      $group: {
        _id: null,
        totalFiles: { $sum: 1 },
        finishedFiles: {
          $sum: { $cond: [{ $in: ['$status', ['completed', 'failed']] }, 1, 0] }
        },
        remainingFiles: {
          $sum: { $cond: [{ $in: ['$status', ['pending', 'processing']] }, 1, 0] }
        },
        timedFiles: {
          $sum: { $cond: [{ $gt: ['$processingTime', 0] }, 1, 0] }
        },
        totalProcessingTime: { $sum: { $ifNull: ['$processingTime', 0] } },
        // $avg and $min/$max ignore Date values, so cast before aggregating.
        firstStartedAt: { $min: { $toLong: { $ifNull: ['$startedAt', '$createdAt'] } } },
        lastFinishedAt: { $max: { $toLong: '$completedAt' } },
        oldestPendingCreatedAt: {
          $min: {
            $cond: [{ $eq: ['$status', 'pending'] }, { $toLong: '$createdAt' }, null]
          }
        },
        priorityRank: {
          $max: {
            $switch: {
              branches: [
                { case: { $eq: ['$priority', 'critical'] }, then: PRIORITY_RANK.critical },
                { case: { $eq: ['$priority', 'high'] },     then: PRIORITY_RANK.high },
                { case: { $eq: ['$priority', 'low'] },      then: PRIORITY_RANK.low }
              ],
              default: DEFAULT_PRIORITY_RANK
            }
          }
        }
      }
    }
  ]);

  if (!agg || !agg.totalFiles) return empty;

  const { totalFiles, finishedFiles, remainingFiles, timedFiles, totalProcessingTime } = agg;

  // $toLong yields a BSON Int64. The driver promotes it to a JS number by
  // default, but not under `promoteLongs: false`, and arithmetic on a Long
  // object silently produces NaN rather than throwing.
  const asMillis = v => (v === null || v === undefined ? null : Number(v));
  const firstStartedAt = asMillis(agg.firstStartedAt);
  const lastFinishedAt = asMillis(agg.lastFinishedAt);
  const oldestPendingCreatedAt = asMillis(agg.oldestPendingCreatedAt);

  const avgProcessingTime = timedFiles > 0 ? totalProcessingTime / timedFiles : null;

  // Files per millisecond of wall-clock. Needs a start, a finish, and a
  // non-zero span between them.
  let processingVelocity = null;
  if (finishedFiles > 0 && firstStartedAt && lastFinishedAt) {
    const elapsed = lastFinishedAt - firstStartedAt;
    if (elapsed > 0) processingVelocity = finishedFiles / elapsed;
  }
  // Fall back to the per-file average, which assumes no concurrency.
  if (processingVelocity === null && avgProcessingTime > 0) {
    processingVelocity = 1 / avgProcessingTime;
  }

  if (remainingFiles === 0) {
    return {
      ...empty,
      estimatedCompletionTime: lastFinishedAt ? new Date(lastFinishedAt).toISOString() : null,
      estimatedMillisecondsRemaining: 0,
      processingVelocity,
      avgProcessingTime,
      totalFiles,
      filesFinished: finishedFiles,
      filesRemaining: 0,
      confidence: 1
    };
  }

  // Pending work from OTHER sessions that the queue will serve first, using
  // the same ordering as getQueuedScansByPriority: higher priority rank, then
  // older first. Counted in the database rather than by pulling the whole
  // global queue into memory.
  let queuedFilesAhead = 0;
  if (oldestPendingCreatedAt !== null) {
    const [ahead] = await this.aggregate([
      { $match: { status: 'pending', sessionScanId: { $ne: sessionScanId } } },
      {
        $addFields: {
          _priorityRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$priority', 'critical'] }, then: PRIORITY_RANK.critical },
                { case: { $eq: ['$priority', 'high'] },     then: PRIORITY_RANK.high },
                { case: { $eq: ['$priority', 'low'] },      then: PRIORITY_RANK.low }
              ],
              default: DEFAULT_PRIORITY_RANK
            }
          }
        }
      },
      {
        $match: {
          $expr: {
            $or: [
              { $gt: ['$_priorityRank', agg.priorityRank] },
              {
                $and: [
                  { $eq: ['$_priorityRank', agg.priorityRank] },
                  { $lt: [{ $toLong: '$createdAt' }, oldestPendingCreatedAt] }
                ]
              }
            ]
          }
        }
      },
      { $count: 'n' }
    ]);
    queuedFilesAhead = ahead?.n || 0;
  }

  let estimatedMillisecondsRemaining = null;
  if (processingVelocity > 0) {
    estimatedMillisecondsRemaining = (remainingFiles + queuedFilesAhead) / processingVelocity;
  }

  // Coverage of this scan, held down by how little throughput data exists.
  // Without the sample floor a one-file scan reports full confidence off a
  // single timing.
  const coverage = finishedFiles / totalFiles;
  const sampleFactor = Math.min(1, finishedFiles / MIN_VELOCITY_SAMPLE);
  const confidence = estimatedMillisecondsRemaining === null
    ? 0
    : Math.min(coverage, sampleFactor);

  return {
    estimatedCompletionTime: estimatedMillisecondsRemaining === null
      ? null
      : new Date(Date.now() + estimatedMillisecondsRemaining).toISOString(),
    estimatedMillisecondsRemaining,
    processingVelocity,
    avgProcessingTime,
    totalFiles,
    filesFinished: finishedFiles,
    filesRemaining: remainingFiles,
    queuedFilesAhead,
    confidence
  };
};

export const ScanProgress = mongoose.model('ScanProgress', ScanProgressSchema);
