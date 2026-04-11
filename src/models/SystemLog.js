import mongoose from 'mongoose';

const systemLogSchema = new mongoose.Schema({
  // Log type and level
  level: {
    type: String,
    enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    required: true,
    index: true
  },
  
  category: {
    type: String,
    enum: ['system', 'task', 'network', 'security', 'ai', 'user', 'performance', 'update'],
    required: true,
    index: true
  },
  
  // Message and details
  message: {
    type: String,
    required: true
  },
  
  details: mongoose.Schema.Types.Mixed,
  
  // Source information
  source: {
    service: String,
    module: String,
    function: String,
    file: String,
    line: Number
  },
  
  // Context
  context: {
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task'
    },
    userId: String,
    userName: String,
    sessionId: String,
    requestId: String,
    remoteHost: String
  },
  
  // Error information
  error: {
    name: String,
    message: String,
    stack: String,
    code: String,
    statusCode: Number
  },
  
  // Performance metrics
  performance: {
    duration: Number, // milliseconds
    memory: {
      before: Number,
      after: Number,
      delta: Number
    },
    cpu: Number // percentage
  },
  
  // System state at time of log
  systemState: {
    uptime: Number,
    loadAverage: [Number],
    memoryUsage: {
      total: Number,
      free: Number,
      used: Number,
      percentage: Number
    },
    diskUsage: [{
      filesystem: String,
      total: Number,
      used: Number,
      available: Number,
      percentage: Number
    }]
  },
  
  // Tags for filtering and searching
  tags: [String],
  
  // Resolution tracking
  resolved: {
    status: {
      type: Boolean,
      default: false
    },
    at: Date,
    by: String,
    action: String,
    notes: String
  }
}, {
  timestamps: true,
  capped: {
    size: 104857600, // 100MB
    max: 100000     // 100k documents
  }
});

// Indexes
systemLogSchema.index({ createdAt: -1 });
systemLogSchema.index({ level: 1, createdAt: -1 });
systemLogSchema.index({ category: 1, createdAt: -1 });
systemLogSchema.index({ 'context.userId': 1 });
systemLogSchema.index({ 'context.taskId': 1 });
systemLogSchema.index({ tags: 1 });
systemLogSchema.index({ 
  message: 'text',
  'error.message': 'text',
  tags: 'text'
});

// Methods
systemLogSchema.methods.resolve = function(userId, action, notes) {
  this.resolved = {
    status: true,
    at: new Date(),
    by: userId,
    action,
    notes
  };
  return this.save();
};

// Static methods
systemLogSchema.statics.logError = function(error, context = {}) {
  return this.create({
    level: 'error',
    category: context.category || 'system',
    message: error.message,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    },
    context,
    source: {
      service: context.service || 'agent',
      module: context.module
    }
  });
};

systemLogSchema.statics.logInfo = function(message, details = {}, context = {}) {
  return this.create({
    level: 'info',
    category: context.category || 'system',
    message,
    details,
    context,
    source: {
      service: context.service || 'agent',
      module: context.module
    }
  });
};

systemLogSchema.statics.logPerformance = function(operation, duration, metrics = {}, context = {}) {
  return this.create({
    level: 'info',
    category: 'performance',
    message: `${operation} completed in ${duration}ms`,
    performance: {
      duration,
      ...metrics
    },
    context,
    source: {
      service: context.service || 'agent',
      module: context.module
    }
  });
};

systemLogSchema.statics.findRecent = function(hours = 24, filters = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  const query = {
    createdAt: { $gte: since },
    ...filters
  };
  
  return this.find(query).sort({ createdAt: -1 });
};

systemLogSchema.statics.findErrors = function(unresolved = true, limit = 100) {
  const query = {
    level: 'error'
  };
  
  if (unresolved) {
    query['resolved.status'] = false;
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit);
};

systemLogSchema.statics.getStatistics = async function(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  const stats = await this.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          level: '$level',
          category: '$category'
        },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.level',
        categories: {
          $push: {
            category: '$_id.category',
            count: '$count'
          }
        },
        total: { $sum: '$count' }
      }
    }
  ]);
  
  return stats;
};

export const SystemLog = mongoose.model('SystemLog', systemLogSchema);