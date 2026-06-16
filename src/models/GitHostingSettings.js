import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

/**
 * Git Hosting Settings Schema
 *
 * Stores configuration for the git hosting provider (GitHub, GitLab, Bitbucket).
 * Used by selfModification, prReviewer, bugFixing, and other services.
 */
const gitHostingSettingsSchema = new mongoose.Schema({
  agentId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: 'default'
  },

  // Active provider: 'github', 'gitlab', or 'bitbucket'
  provider: {
    type: String,
    enum: ['github', 'gitlab', 'bitbucket'],
    default: 'github'
  },

  // GitHub-specific configuration
  github: {
    token: {
      type: String,
      default: null, // Will use GITHUB_TOKEN env var if not set
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-]{10,}$/.test(v);
        },
        message: props => `${props.value} is not a valid GitHub token`
      }
    },
    owner: {
      type: String,
      default: null, // Will auto-detect from git remote
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9][a-zA-Z0-9\-]{0,38}$/.test(v);
        },
        message: props => `${props.value} is not a valid GitHub username`
      }
    },
    repo: {
      type: String,
      default: null, // Will auto-detect from git remote
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-\.]{1,100}$/.test(v);
        },
        message: props => `${props.value} is not a valid GitHub repository name`
      }
    },
    // Use gh CLI for operations (recommended)
    useCli: {
      type: Boolean,
      default: true
    },
    mfa: {
      enabled: {
        type: Boolean,
        default: false
      },
      method: {
        type: String,
        enum: ['sms', 'authenticator', 'email'],
        default: 'authenticator'
      }
    }
  },

  // GitLab-specific configuration
  gitlab: {
    token: {
      type: String,
      default: null, // Will use GITLAB_TOKEN env var if not set
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-]{10,}$/.test(v);
        },
        message: props => `${props.value} is not a valid GitLab token`
      }
    },
    baseUrl: {
      type: String,
      default: 'https://gitlab.com'
    },
    projectId: {
      type: String,
      default: null, // Can be 'owner/repo' or numeric ID
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-\/\.]+$/.test(v);
        },
        message: props => `${props.value} is not a valid GitLab project ID`
      }
    },
    // For self-hosted instances
    selfHosted: {
      type: Boolean,
      default: false
    },
    mfa: {
      enabled: {
        type: Boolean,
        default: false
      },
      method: {
        type: String,
        enum: ['sms', 'authenticator', 'email'],
        default: 'authenticator'
      }
    }
  },

  // Bitbucket-specific configuration
  bitbucket: {
    token: {
      type: String,
      default: null, // Will use BITBUCKET_TOKEN env var if not set
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-]{10,}$/.test(v);
        },
        message: props => `${props.value} is not a valid Bitbucket token`
      }
    },
    workspace: {
      type: String,
      default: null,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-]{1,}$/.test(v);
        },
        message: props => `${props.value} is not a valid Bitbucket workspace`
      }
    },
    repoSlug: {
      type: String,
      default: null,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[a-zA-Z0-9_\-\.]{1,100}$/.test(v);
        },
        message: props => `${props.value} is not a valid Bitbucket repository slug`
      }
    },
    mfa: {
      enabled: {
        type: Boolean,
        default: false
      },
      method: {
        type: String,
        enum: ['sms', 'authenticator', 'email'],
        default: 'authenticator'
      }
    }
  },

  // Merge/PR creation defaults
  defaults: {
    targetBranch: {
      type: String,
      default: 'main'
    },
    deleteBranchAfterMerge: {
      type: Boolean,
      default: true
    },
    mergeMethod: {
      type: String,
      enum: ['merge', 'squash', 'rebase'],
      default: 'squash'
    },
    draftByDefault: {
      type: Boolean,
      default: false
    },
    labels: {
      type: [String],
      default: ['ai-generated']
    }
  },

  // Feature flags
  features: {
    autoCreatePRs: {
      type: Boolean,
      default: true
    },
    autoMergeApproved: {
      type: Boolean,
      default: false
    },
    commentOnPRs: {
      type: Boolean,
      default: true
    },
    createIssuesOnError: {
      type: Boolean,
      default: false
    }
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for quick lookups
gitHostingSettingsSchema.index({ provider: 1 });

// Cache for provider config lookups (5 min TTL)
const configCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Pre-save middleware to update timestamp and invalidate cache
gitHostingSettingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  // Invalidate cached config when settings change
  configCache.del(`activeProviderConfig-${this.agentId}`);
  next();
});

// Static method to get or create default settings
gitHostingSettingsSchema.statics.getOrCreate = async function(agentId = 'default') {
  try {
    let settings = await retryOperation(() => this.findOne({ agentId }), { retries: 3 });
    if (!settings) {
      settings = await this.create({ agentId });
    }
    return settings;
  } catch (error) {
    logger.error(`Failed to get or create settings for agentId ${agentId}: ${error.message}`);
    throw error;
  }
};

// Static method to get active provider config with caching
gitHostingSettingsSchema.statics.getActiveProviderConfig = async function(agentId = 'default') {
  const cacheKey = `activeProviderConfig-${agentId}`;
  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const settings = await this.getOrCreate(agentId);
    const provider = settings.provider;

    let config;
    if (provider === 'gitlab') {
      config = settings.gitlab;
    } else if (provider === 'bitbucket') {
      config = settings.bitbucket;
    } else {
      config = settings.github;
    }

    const activeConfig = {
      provider,
      config,
      defaults: settings.defaults,
      features: settings.features,
      mfa: config.mfa
    };

    configCache.set(cacheKey, activeConfig);
    return activeConfig;
  } catch (error) {
    logger.error(`Failed to get active provider config for agentId ${agentId}: ${error.message}`);
    throw error;
  }
};

// Instance method to check if provider is properly configured
gitHostingSettingsSchema.methods.isConfigured = function() {
  if (this.provider === 'github') {
    const token = this.github?.token || process.env.GITHUB_TOKEN;
    return !!token;
  } else if (this.provider === 'gitlab') {
    const token = this.gitlab?.token || process.env.GITLAB_TOKEN;
    return !!token;
  } else if (this.provider === 'bitbucket') {
    const token = this.bitbucket?.token || process.env.BITBUCKET_TOKEN;
    return !!token;
  }
  return false;
};

// Instance method to get provider display name
gitHostingSettingsSchema.methods.getProviderDisplayName = function() {
  if (this.provider === 'gitlab') {
    return 'GitLab';
  } else if (this.provider === 'bitbucket') {
    return 'Bitbucket';
  }
  return 'GitHub';
};

// Instance method to check and enforce MFA
gitHostingSettingsSchema.methods.checkAndEnforceMFA = function() {
  const providerConfig = this[this.provider];
  if (providerConfig.mfa.enabled) {
    // Implement MFA enforcement logic here
    // This is a placeholder for actual MFA enforcement logic
    logger.info(`MFA is enabled for ${this.provider} using ${providerConfig.mfa.method} method.`);
    return true;
  }
  return false;
};

export const GitHostingSettings = mongoose.model('GitHostingSettings', gitHostingSettingsSchema);

export default GitHostingSettings;
