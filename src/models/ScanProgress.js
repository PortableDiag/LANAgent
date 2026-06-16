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

export const ScanProgress = mongoose.model('ScanProgress', ScanProgressSchema);