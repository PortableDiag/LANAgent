import mongoose from 'mongoose';

const agentSchema = new mongoose.Schema({
  // Identity
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  
  personality: {
    type: String,
    default: 'helpful and eager assistant'
  },
  
  avatar: String,           // Served URL (e.g., /api/agent/avatar)
  avatarPath: String,       // Filesystem path (e.g., data/agent/avatar.png)
  avatarDescription: String, // Text description for system prompt awareness
  activeVRMModel: String,   // Active VRM model ID (e.g., "nova", "miku")

  // Configuration
  config: {
    maxDailyUpdates: {
      type: Number,
      default: 2
    },
    autoApprovalEnabled: {
      type: Boolean,
      default: true
    },
    autoModelUpdate: {
      type: Boolean,
      default: true
    },
    requiresApprovalFor: [{
      type: String,
      enum: ['system_updates', 'package_install', 'remote_access', 'file_deletion', 'service_restart']
    }],
    workingHours: {
      enabled: Boolean,
      timezone: String,
      start: String, // "09:00"
      end: String    // "17:00"
    },
    resourceLimits: {
      maxCpuPercent: {
        type: Number,
        default: 80
      },
      maxMemoryMB: {
        type: Number,
        default: 4096
      },
      maxDiskUsageGB: {
        type: Number,
        default: 50
      }
    }
  },
  
  // AI Providers
  aiProviders: {
    current: {
      type: String,
      enum: ['openai', 'anthropic', 'xai', 'gab', 'huggingface', 'ollama', 'bitnet'],
      default: 'anthropic'
    },
    configurations: {
      openai: {
        enabled: Boolean,
        apiKey: String,
        model: {
          type: String,
          default: 'gpt-4o'
        },
        temperature: Number,
        maxTokens: Number
      },
      anthropic: {
        enabled: Boolean,
        apiKey: String,
        model: {
          type: String,
          default: 'claude-sonnet-4-5-20250929'
        },
        temperature: Number,
        maxTokens: Number
      },
      xai: {
        enabled: Boolean,
        apiKey: String,
        model: String,
        temperature: Number,
        maxTokens: Number
      },
      gab: {
        enabled: Boolean,
        apiKey: String,
        model: String,
        temperature: Number,
        maxTokens: Number
      },
      huggingface: {
        enabled: Boolean,
        token: String,
        model: String,
        temperature: Number,
        maxTokens: Number
      },
      ollama: {
        enabled: { type: Boolean, default: false },
        baseUrl: { type: String, default: 'http://localhost:11434' },
        chatModel: { type: String, default: 'mistral' },
        embeddingModel: { type: String, default: 'nomic-embed-text' },
        visionModel: { type: String, default: 'llava' },
        temperature: Number,
        maxTokens: Number
      },
      bitnet: {
        enabled: { type: Boolean, default: false },
        baseUrl: { type: String, default: 'http://localhost:8080' },
        chatModel: { type: String, default: 'BitNet-b1.58-2B-4T' },
        contextLength: { type: Number, default: 2048 },
        temperature: Number,
        maxTokens: Number
      }
    }
  },
  
  // Capabilities
  capabilities: [{
    name: String,
    enabled: Boolean,
    permissions: [String],
    config: mongoose.Schema.Types.Mixed
  }],
  
  // Statistics
  stats: {
    tasksCompleted: {
      type: Number,
      default: 0
    },
    tasksFaild: {
      type: Number,
      default: 0
    },
    messagesProcessed: {
      type: Number,
      default: 0
    },
    commandsExecuted: {
      type: Number,
      default: 0
    },
    errorsEncountered: {
      type: Number,
      default: 0
    },
    uptime: {
      type: Number,
      default: 0
    },
    lastError: {
      message: String,
      timestamp: Date,
      resolved: Boolean
    },
    dailyUpdates: {
      count: {
        type: Number,
        default: 0
      },
      lastReset: {
        type: Date,
        default: Date.now
      }
    }
  },
  
  // Learning and adaptation
  learning: {
    userPreferences: {
      type: Map,
      of: mongoose.Schema.Types.Mixed
    },
    commonTasks: [{
      pattern: String,
      count: Number,
      lastUsed: Date,
      averageDuration: Number
    }],
    errorPatterns: [{
      pattern: String,
      count: Number,
      lastOccurred: Date,
      resolution: String
    }]
  },
  
  // System state
  state: {
    status: {
      type: String,
      enum: ['initializing', 'running', 'paused', 'updating', 'error', 'stopped'],
      default: 'initializing'
    },
    health: {
      type: String,
      enum: ['healthy', 'degraded', 'unhealthy'],
      default: 'healthy'
    },
    lastHeartbeat: {
      type: Date,
      default: Date.now
    },
    version: {
      current: String,
      available: String,
      lastChecked: Date
    }
  },
  
  // Security
  security: {
    authorizedUsers: [{
      userId: String,
      name: String,
      role: {
        type: String,
        enum: ['admin', 'user', 'viewer'],
        default: 'user'
      },
      permissions: [String],
      addedAt: {
        type: Date,
        default: Date.now
      }
    }],
    blockedUsers: [{
      userId: String,
      reason: String,
      blockedAt: Date
    }],
    apiKeys: [{
      key: String,
      name: String,
      permissions: [String],
      lastUsed: Date,
      createdAt: {
        type: Date,
        default: Date.now
      }
    }]
  },
  
  // Voice configuration
  voice: {
    enabled: {
      type: Boolean,
      default: false
    },
    provider: {
      type: String,
      default: 'openai',
      enum: ['openai', 'huggingface']
    },
    model: {
      type: String,
      default: 'gpt-4o-mini-tts'
    },
    voice: {
      type: String,
      default: 'nova'
    },
    speed: {
      type: Number,
      default: 1.0,
      min: 0.25,
      max: 4.0
    },
    format: {
      type: String,
      default: 'mp3',
      enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']
    },
    telegramResponses: {
      type: Boolean,
      default: false
    },
    speakThroughServer: {
      type: Boolean,
      default: false
    },
    instructions: {
      type: String,
      default: ''
    },
    // Wake word listening state (persists across restarts)
    voiceInteractionEnabled: {
      type: Boolean,
      default: false
    }
  },

  // Media Generation (Image & Video)
  mediaGeneration: {
    image: {
      enabled: {
        type: Boolean,
        default: true
      },
      provider: {
        type: String,
        enum: ['openai', 'huggingface'],
        default: 'openai'
      },
      openai: {
        model: {
          type: String,
          default: 'gpt-image-1'
        },
        size: {
          type: String,
          default: '1024x1024',
          enum: ['1024x1024', '1792x1024', '1024x1792', '512x512', '256x256']
        },
        quality: {
          type: String,
          default: 'auto',
          enum: ['auto', 'high', 'medium', 'low']
        }
      },
      huggingface: {
        model: {
          type: String,
          default: 'black-forest-labs/FLUX.1-schnell'
        },
        numInferenceSteps: {
          type: Number,
          default: 5,
          min: 1,
          max: 50
        }
      }
    },
    video: {
      enabled: {
        type: Boolean,
        default: true
      },
      provider: {
        type: String,
        enum: ['modelslab', 'openai', 'huggingface'],
        default: 'modelslab'
      },
      modelslab: {
        model: {
          type: String,
          default: 'wan2.1'
        },
        endpoint: {
          type: String,
          default: 'text2video_ultra',
          enum: ['text2video_ultra', 'text2video']
        },
        resolution: {
          type: String,
          default: '720p',
          enum: ['480p', '720p', '1080p']
        },
        numFrames: {
          type: Number,
          default: 65,
          min: 1,
          max: 257
        },
        numInferenceSteps: {
          type: Number,
          default: 30,
          min: 1,
          max: 50
        },
        guidanceScale: {
          type: Number,
          default: 5.0
        },
        fps: {
          type: Number,
          default: 16,
          enum: [8, 16, 24]
        },
        apiKey: {
          type: String
        }
      },
      openai: {
        model: {
          type: String,
          default: 'sora-2'
        },
        size: {
          type: String,
          default: '1024x1792'
        },
        duration: {
          type: String,
          default: '8'
        },
        quality: {
          type: String,
          default: 'standard',
          enum: ['standard', 'high']
        }
      },
      huggingface: {
        model: {
          type: String,
          default: 'Wan-AI/Wan2.1-T2V-14B'
        }
      }
    }
  },

  // Backup configuration
  backup: {
    enabled: {
      type: Boolean,
      default: true
    },
    schedule: {
      type: String,
      default: '0 3 * * *' // 3 AM daily
    },
    retention: {
      days: {
        type: Number,
        default: 7
      }
    },
    lastBackup: {
      timestamp: Date,
      size: Number,
      location: String,
      success: Boolean
    }
  },
  
  // ERC-8004 Agent Identity
  erc8004: {
    status: {
      type: String,
      enum: ['none', 'local', 'minted', 'active'],
      default: 'none'
    },
    chain: { type: String, default: 'bsc' },
    agentId: Number,
    txHash: String,
    agentURI: String,
    registrationFile: mongoose.Schema.Types.Mixed,
    capabilitiesHash: String,
    ipfs: {
      avatarCID: String,
      registrationCID: String
    },
    mintedAt: Date,
    lastUpdated: Date,
    linkedWallet: String,
    walletLinkedAt: Date
  },

  // Service configurations
  serviceConfigs: {
    pluginDevelopment: {
      enabled: {
        type: Boolean,
        default: true
      },
      checkIntervalHours: {
        type: Number,
        default: 24
      },
      maxPluginsPerDay: {
        type: Number,
        default: 1
      },
      focusAreas: [{
        type: String,
        enum: ['productivity', 'monitoring', 'communication', 'automation', 'data', 'development', 'ai', 'iot', 'finance', 'health']
      }],
      excludeAPIs: [String],
      requireTests: {
        type: Boolean,
        default: true
      },
      createPR: {
        type: Boolean,
        default: true
      },
      lastCheckTime: {
        type: Date,
        default: null
      }
    },
    selfModification: {
      enabled: {
        type: Boolean,
        default: true
      },
      analysisOnly: {
        type: Boolean,
        default: false
      },
      maxChangesPerSession: {
        type: Number,
        default: 50
      },
      maxDailyImprovements: {
        type: Number,
        default: 2
      },
      idleMinutes: {
        type: Number,
        default: 5
      },
      cpuThreshold: {
        type: Number,
        default: 50
      },
      memoryThreshold: {
        type: Number,
        default: 70
      },
      checkIntervalMinutes: {
        type: Number,
        default: 30
      },
      scheduledHour: {
        type: Number,
        default: null
      },
      scheduledMinute: {
        type: Number,
        default: 0
      },
      restrictedFiles: {
        type: [String],
        default: ['.env', 'package-lock.json']
      },
      allowedUpgrades: {
        type: [String],
        default: []
      },
      requireTests: {
        type: Boolean,
        default: true
      },
      useDockerTesting: {
        type: Boolean,
        default: false
      },
      dockerImage: {
        type: String,
        default: 'lanagent:test'
      },
      testTimeout: {
        type: Number,
        default: 300000
      },
      createPR: {
        type: Boolean,
        default: true
      },
      lastCheckTime: {
        type: Date,
        default: null
      },
      coreUpgradesFirst: {
        type: Boolean,
        default: true
      },
      dailyImprovementCount: {
        type: Number,
        default: 0
      },
      lastImprovementDate: {
        type: Date,
        default: null
      }
    },
    bugFixing: {
      enabled: {
        type: Boolean,
        default: true
      },
      checkIntervalHours: {
        type: Number,
        default: 12
      },
      maxFixesPerDay: {
        type: Number,
        default: 3
      },
      maxFixesPerSession: {
        type: Number,
        default: 5
      },
      githubOwner: {
        type: String,
        default: null
      },
      githubRepo: {
        type: String,
        default: null
      },
      priorityOrder: {
        type: [String],
        default: ['critical', 'high', 'medium', 'low']
      },
      priorityThresholds: {
        critical: {
          type: Number,
          default: 24
        },
        high: {
          type: Number,
          default: 72
        }
      },
      requireTests: {
        type: Boolean,
        default: true
      },
      createPR: {
        type: Boolean,
        default: true
      },
      lastCheckTime: {
        type: Date,
        default: null
      }
    },
    // Self-healing service configuration
    selfHealing: {
      enabled: {
        type: Boolean,
        default: false
      },
      dryRun: {
        type: Boolean,
        default: true
      },
      checkInterval: {
        type: Number,
        default: 60000
      },
      maxActionsPerHour: {
        type: Number,
        default: 10
      },
      globalCooldownMinutes: {
        type: Number,
        default: 2
      },
      rules: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
      }
    },
    // Agent reasoning configuration (ReAct / Plan-and-Execute patterns)
    reasoning: {
      enabled: {
        type: Boolean,
        default: true
      },
      mode: {
        type: String,
        enum: ['react', 'plan-execute', 'auto'],
        default: 'auto'
      },
      maxIterations: {
        type: Number,
        default: 10
      },
      enableReplanning: {
        type: Boolean,
        default: true
      },
      showThoughts: {
        type: Boolean,
        default: false
      },
      thoughtPersistence: {
        type: Boolean,
        default: true
      }
    }
  }
}, {
  timestamps: true
});

// Indexes
agentSchema.index({ name: 1 });
agentSchema.index({ 'state.status': 1 });
agentSchema.index({ 'security.authorizedUsers.userId': 1 });

// Methods
agentSchema.methods.updateHeartbeat = function() {
  this.state.lastHeartbeat = new Date();
  return this.save();
};

agentSchema.methods.incrementStat = function(statName, amount = 1) {
  if (this.stats[statName] !== undefined) {
    this.stats[statName] += amount;
    return this.save();
  }
};

agentSchema.methods.recordError = function(error) {
  this.stats.errorsEncountered++;
  this.stats.lastError = {
    message: error.message,
    timestamp: new Date(),
    resolved: false
  };
  
  // Check if this is a recurring pattern
  const pattern = this.learning.errorPatterns.find(p => p.pattern === error.message);
  if (pattern) {
    pattern.count++;
    pattern.lastOccurred = new Date();
  } else {
    this.learning.errorPatterns.push({
      pattern: error.message,
      count: 1,
      lastOccurred: new Date()
    });
  }
  
  return this.save();
};

agentSchema.methods.checkDailyUpdateLimit = function() {
  const now = new Date();
  const lastReset = new Date(this.stats.dailyUpdates.lastReset);
  
  // Reset counter if it's a new day
  if (now.toDateString() !== lastReset.toDateString()) {
    this.stats.dailyUpdates.count = 0;
    this.stats.dailyUpdates.lastReset = now;
  }
  
  return this.stats.dailyUpdates.count < this.config.maxDailyUpdates;
};

agentSchema.methods.incrementDailyUpdate = function() {
  this.checkDailyUpdateLimit(); // Ensure counter is reset if needed
  this.stats.dailyUpdates.count++;
  return this.save();
};

agentSchema.methods.isAuthorizedUser = function(userId) {
  return this.security.authorizedUsers.some(user => user.userId === userId);
};

agentSchema.methods.getUserRole = function(userId) {
  const user = this.security.authorizedUsers.find(u => u.userId === userId);
  return user ? user.role : null;
};

agentSchema.methods.addUserPreference = function(userId, key, value) {
  if (!this.learning.userPreferences.has(userId)) {
    this.learning.userPreferences.set(userId, {});
  }
  const prefs = this.learning.userPreferences.get(userId);
  prefs[key] = value;
  this.learning.userPreferences.set(userId, prefs);
  return this.save();
};

// Static methods
agentSchema.statics.getOrCreate = async function(name = 'LANAgent') {
  let agent = await this.findOne({ name });
  
  if (!agent) {
    agent = new this({
      name,
      personality: 'I am an eager and helpful AI assistant, ready to help with any task you need!',
      'security.authorizedUsers': [{
        userId: process.env.TELEGRAM_USER_ID,
        name: 'Admin',
        role: 'admin'
      }]
    });
    await agent.save();
  }
  
  return agent;
};

export const Agent = mongoose.model('Agent', agentSchema);