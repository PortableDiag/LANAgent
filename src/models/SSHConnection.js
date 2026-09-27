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
 * Create the date formatting context used by session analytics.
 *
 * @param {Object} options - Analytics formatting options
 * @param {string} [options.timezone] - IANA timezone identifier
 * @param {string} [options.locale] - BCP 47 locale identifier
 * @returns {Object} Date formatting context
 */
function createAnalyticsDateContext(options = {}) {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  // en-US by default: the report keys were always en-US formatted, keep them stable.
  const locale = options.locale || 'en-US';
  const timezone = options.timezone || resolved.timeZone;

  return {
    locale,
    timezone,
    dateFormatter: new Intl.DateTimeFormat(locale, {
      timeZone: timezone
    }),
    weekdayFormatter: new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: 'long'
    }),
    partsFormatter: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    }),
    utcDateFormatter: new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC'
    })
  };
}

/**
 * Extract calendar and clock values in the requested timezone.
 *
 * @param {Date|string|number} value - Date value
 * @param {Object} context - Date formatting context
 * @returns {Object} Localized date parts
 */
function getAnalyticsDateParts(value, context) {
  const parts = context.partsFormatter.formatToParts(new Date(value));
  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  return values;
}

/**
 * Format an analytics trend bucket using the requested timezone.
 *
 * @param {Date|string|number} value - Date value
 * @param {string} aggregationLevel - Aggregation level
 * @param {Object} context - Date formatting context
 * @returns {string} Trend bucket key
 */
function getTrendBucket(value, aggregationLevel, context) {
  const date = new Date(value);
  const parts = getAnalyticsDateParts(date, context);

  if (aggregationLevel === 'hourly') {
    return `${context.dateFormatter.format(date)} ${String(parts.hour).padStart(2, '0')}:00`;
  }

  if (aggregationLevel === 'weekly') {
    const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const daysSinceSunday = localDate.getUTCDay();
    localDate.setUTCDate(localDate.getUTCDate() - daysSinceSunday);
    return context.utcDateFormatter.format(localDate);
  }

  return context.dateFormatter.format(date);
}

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
 * @param {Object} [options] - Analytics formatting options
 * @param {string} [options.timezone] - IANA timezone identifier
 * @param {string} [options.locale] - BCP 47 locale identifier
 * @param {string} [options.aggregationLevel='daily'] - Trend aggregation level: hourly, daily, or weekly
 * @returns {Object} - Summary report of session analytics
 */
sshConnectionSchema.methods.generateSessionReport = function(options = {}) {
  const {
    aggregationLevel = 'daily'
  } = options || {};
  const dateContext = createAnalyticsDateContext(options || {});
  const totalSessions = this.sessionLogs.length;
  const completedSessions = this.sessionLogs.filter(log => log.endTime).length;
  const totalDuration = this.sessionLogs.reduce((acc, log) => acc + (log.duration || 0), 0);
  const averageDuration = completedSessions ? totalDuration / completedSessions : 0;
  const errorSessions = this.sessionLogs.filter(log => log.error).length;
  const errorRate = totalSessions ? (errorSessions / totalSessions) * 100 : 0;

  const usagePatterns = this.sessionLogs.reduce((patterns, log) => {
    if (log.startTime) {
      const day = dateContext.weekdayFormatter.format(new Date(log.startTime));
      patterns[day] = (patterns[day] || 0) + 1;
    }
    return patterns;
  }, {});

  const peakUsageTimes = this.sessionLogs.reduce((times, log) => {
    if (log.startTime) {
      const { hour } = getAnalyticsDateParts(log.startTime, dateContext);
      times[hour] = (times[hour] || 0) + 1;
    }
    return times;
  }, {});

  const errorTrends = this.sessionLogs.reduce((trends, log) => {
    if (log.error && log.startTime) {
      const key = getTrendBucket(log.startTime, aggregationLevel, dateContext);
      trends[key] = (trends[key] || 0) + 1;
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
 * @param {string|Object} [aggregationLevel='daily'] - Aggregation level or analytics options
 * @param {Object} [options] - Analytics formatting options
 * @param {string} [options.timezone] - IANA timezone identifier
 * @param {string} [options.locale] - BCP 47 locale identifier
 * @param {string} [options.aggregationLevel='daily'] - Aggregation level: hourly, daily, or weekly
 * @returns {Object} - Filtered and aggregated session analytics report
 */
sshConnectionSchema.methods.generateFilteredSessionReport = function(
  startDate,
  endDate,
  aggregationLevel = 'daily',
  options = {}
) {
  const reportOptions = aggregationLevel && typeof aggregationLevel === 'object'
    ? aggregationLevel
    : {
        ...(options || {}),
        aggregationLevel
      };
  const selectedAggregationLevel = reportOptions.aggregationLevel || 'daily';
  const dateContext = createAnalyticsDateContext(reportOptions);

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
      const day = dateContext.weekdayFormatter.format(logDate);
      usagePatterns[day] = (usagePatterns[day] || 0) + 1;

      // Peak usage times by hour
      const { hour } = getAnalyticsDateParts(logDate, dateContext);
      peakUsageTimes[hour] = (peakUsageTimes[hour] || 0) + 1;

      // Error trends
      if (log.error) {
        const key = getTrendBucket(logDate, selectedAggregationLevel, dateContext);
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
