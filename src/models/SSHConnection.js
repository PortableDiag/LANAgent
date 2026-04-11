import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';
import { safeTimeout } from '../utils/errorHandlers.js';

const sshConnectionSchema = new mongoose.Schema({
  connectionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  host: {
    type: String,
    required: true
  },
  port: {
    type: Number,
    default: 22
  },
  username: {
    type: String,
    required: true
  },
  description: String,
  hasPassword: {
    type: Boolean,
    default: false
  },
  hasPrivateKey: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false
  },
  privateKey: {
    type: String,
    select: false
  },
  tags: {
    type: [String],
    default: []
  },
  sessionLogs: [{
    startTime: { type: Date },
    endTime: { type: Date },
    duration: { type: Number },
    error: { type: String }
  }]
}, {
  timestamps: true
});

sshConnectionSchema.index({ host: 1, username: 1 });
sshConnectionSchema.index({ tags: 1 });

const sessionTimeoutCache = new NodeCache({ stdTTL: 0, checkperiod: 600 });
const sessionLogsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Start a new session log entry with timeout management
 */
sshConnectionSchema.methods.startSession = async function(maxDuration) {
  this.sessionLogs.push({
    startTime: new Date(),
    endTime: null,
    duration: null,
    error: null
  });

  const sessionId = this.sessionLogs.length - 1;
  const timeoutId = safeTimeout(async () => {
    logger.info(`Session ${sessionId} for connection ${this.connectionId} exceeded max duration. Ending session.`);
    await retryOperation(() => this.endSession(), { retries: 3 });
  }, maxDuration * 1000, this);

  sessionTimeoutCache.set(this.connectionId, timeoutId);
  return this.save();
};

/**
 * End the most recent active session and clear timeout
 */
sshConnectionSchema.methods.endSession = async function() {
  const activeSession = this.sessionLogs.find(log => !log.endTime);
  if (!activeSession) {
    logger.warn(`No active session found for connection ${this.connectionId}`);
    return this;
  }
  activeSession.endTime = new Date();
  activeSession.duration = (activeSession.endTime - activeSession.startTime) / 1000;

  const timeoutId = sessionTimeoutCache.get(this.connectionId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    sessionTimeoutCache.del(this.connectionId);
  }

  return this.save();
};

/**
 * Log an error for the current active session
 * @param {string} errorMessage - The error message
 */
sshConnectionSchema.methods.logSessionError = function(errorMessage) {
  const activeSession = this.sessionLogs.find(log => !log.endTime);
  if (!activeSession) {
    logger.warn(`No active session to log error for connection ${this.connectionId}`);
    return this;
  }
  activeSession.error = errorMessage;
  return this.save();
};

/**
 * Generate a session analytics report
 * @returns {Object} - Summary report of session analytics
 */
sshConnectionSchema.methods.generateSessionReport = function() {
  const totalSessions = this.sessionLogs.length;
  const completedSessions = this.sessionLogs.filter(log => log.endTime).length;
  const totalDuration = this.sessionLogs.reduce((acc, log) => acc + (log.duration || 0), 0);
  const averageDuration = completedSessions ? totalDuration / completedSessions : 0;
  const errorSessions = this.sessionLogs.filter(log => log.error).length;
  const errorRate = totalSessions ? (errorSessions / totalSessions) * 100 : 0;

  const usagePatterns = this.sessionLogs.reduce((patterns, log) => {
    if (log.startTime) {
      const day = new Date(log.startTime).toLocaleDateString('en-US', { weekday: 'long' });
      patterns[day] = (patterns[day] || 0) + 1;
    }
    return patterns;
  }, {});

  const peakUsageTimes = this.sessionLogs.reduce((times, log) => {
    if (log.startTime) {
      const hour = new Date(log.startTime).getHours();
      times[hour] = (times[hour] || 0) + 1;
    }
    return times;
  }, {});

  const errorTrends = this.sessionLogs.reduce((trends, log) => {
    if (log.error) {
      const day = new Date(log.startTime).toLocaleDateString('en-US');
      trends[day] = (trends[day] || 0) + 1;
    }
    return trends;
  }, {});

  return {
    totalSessions,
    completedSessions,
    averageDuration,
    errorRate,
    usagePatterns,
    peakUsageTimes,
    errorTrends
  };
};

/**
 * Retrieve session logs in a paginated manner
 * @param {number} pageNumber - The page number to retrieve
 * @param {number} pageSize - The number of logs per page
 * @returns {Array} - The paginated session logs
 */
sshConnectionSchema.methods.getPaginatedSessionLogs = async function(pageNumber, pageSize) {
  const cacheKey = `sessionLogs_${this.connectionId}_${pageNumber}_${pageSize}`;
  const cachedLogs = sessionLogsCache.get(cacheKey);
  if (cachedLogs) {
    return cachedLogs;
  }

  const start = (pageNumber - 1) * pageSize;
  const paginatedLogs = this.sessionLogs.slice(start, start + pageSize);

  sessionLogsCache.set(cacheKey, paginatedLogs);
  return paginatedLogs;
};

export const SSHConnection = mongoose.model('SSHConnection', sshConnectionSchema);
