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
  // Check for active sessions
  const activeSession = this.sessionLogs.find(log => !log.endTime);
  if (activeSession) {
    logger.warn(`Cannot start a new session for connection ${this.connectionId} as an active session already exists.`);
    return this;
  }

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
 * Generate a session analytics report with filtering capabilities
 * @param {Date} startDate - Start date for filtering
 * @param {Date} endDate - End date for filtering
 * @param {string} aggregationLevel - Aggregation level: hourly, daily, or weekly
 * @returns {Object} - Filtered and aggregated session analytics report
 */
sshConnectionSchema.methods.generateFilteredSessionReport = function(startDate, endDate, aggregationLevel) {
  // Filter logs by date range
  const filteredLogs = this.sessionLogs.filter(log => {
    const logStartTime = new Date(log.startTime);
    return logStartTime >= startDate && logStartTime <= endDate;
  });

  const totalSessions = filteredLogs.length;
  const completedSessions = filteredLogs.filter(log => log.endTime).length;
  const totalDuration = filteredLogs.reduce((acc, log) => acc + (log.duration || 0), 0);
  const averageDuration = completedSessions ? totalDuration / completedSessions : 0;
  const errorSessions = filteredLogs.filter(log => log.error).length;
  const errorRate = totalSessions ? (errorSessions / totalSessions) * 100 : 0;

  // Initialize aggregation containers
  const usagePatterns = {};
  const peakUsageTimes = {};
  const errorTrends = {};

  // Process filtered logs for analytics
  filteredLogs.forEach(log => {
    if (log.startTime) {
      const logDate = new Date(log.startTime);
      
      // Usage patterns by day of week
      const day = logDate.toLocaleDateString('en-US', { weekday: 'long' });
      usagePatterns[day] = (usagePatterns[day] || 0) + 1;
      
      // Peak usage times by hour
      const hour = logDate.getHours();
      peakUsageTimes[hour] = (peakUsageTimes[hour] || 0) + 1;
      
      // Error trends
      if (log.error) {
        let key;
        switch (aggregationLevel) {
          case 'hourly':
            key = logDate.toLocaleDateString('en-US') + ' ' + hour + ':00';
            break;
          case 'weekly':
            const weekStart = new Date(logDate);
            weekStart.setDate(logDate.getDate() - logDate.getDay());
            key = weekStart.toLocaleDateString('en-US');
            break;
          case 'daily':
          default:
            key = logDate.toLocaleDateString('en-US');
            break;
        }
        errorTrends[key] = (errorTrends[key] || 0) + 1;
      }
    }
  });

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
