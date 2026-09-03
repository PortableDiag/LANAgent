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
 * @param {string} scanId - The ID of the scan to summarize
 * @returns {Object} Summary of scan progress including completion status, processing times, and bug detection rates
 */
ScanProgressSchema.statics.getScanProgressSummary = async function(scanId) {
  const pipeline = [
    {
      $match: {
        scanId: scanId
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
 * @param {string} scanId - The ID of the scan to analyze
 * @returns {Object} Statistics about priority distribution
 */
ScanProgressSchema.statics.getPriorityStats = async function(scanId) {
  const pipeline = [
    {
      $match: {
        scanId: scanId
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

export const ScanProgress = mongoose.model('ScanProgress', ScanProgressSchema);
