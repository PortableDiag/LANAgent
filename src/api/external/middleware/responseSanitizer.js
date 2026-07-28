import { logger } from '../../../utils/logger.js';

const log = logger.child({ service: 'external-gateway' });

// Patterns that should never appear in external responses
const INTERNAL_IP_PATTERN = /\b(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|127\.0\.0\.\d{1,3})\b/g;
const INTERNAL_PATH_PATTERN = /\/root\/[^\s"']*/g;
const HOME_PATH_PATTERN = /\/home\/[^\s"']*/g;
const MEDIA_PATH_PATTERN = /\/media\/[^\s"']*/g;
const NODE_MODULES_PATTERN = /\/node_modules\/[^\s"']*/g;
const DEPLOY_PATH_PATTERN = /lanagent-deploy\/[^\s"']*/g;
const STACK_TRACE_PATTERN = /\bat\s+\S+\s+\([^)]*\)/g;
const HOSTNAME_PATTERN = /\b(veracrypt\d*|lanagent-deploy)\b/gi;

const REDACTED = '[redacted]';

// Store sanitization statistics
let sanitizationStats = {
  totalRedactions: 0,
  patternCounts: {},
  logEntries: []
};

/**
 * Record a sanitization event for statistics tracking
 */
function recordSanitizationEvent(patternName) {
  sanitizationStats.totalRedactions++;
  
  if (!sanitizationStats.patternCounts[patternName]) {
    sanitizationStats.patternCounts[patternName] = 0;
  }
  
  sanitizationStats.patternCounts[patternName]++;
  
  // Keep only the last 100 log entries
  if (sanitizationStats.logEntries.length >= 100) {
    sanitizationStats.logEntries.shift();
  }
  
  sanitizationStats.logEntries.push({
    timestamp: new Date().toISOString(),
    pattern: patternName
  });
}

function sanitizeString(str) {
  let sanitized = str;
  let hadRedactions = false;

  const patterns = [
    { pattern: INTERNAL_IP_PATTERN, name: 'INTERNAL_IP' },
    { pattern: INTERNAL_PATH_PATTERN, name: 'INTERNAL_PATH' },
    { pattern: HOME_PATH_PATTERN, name: 'HOME_PATH' },
    { pattern: MEDIA_PATH_PATTERN, name: 'MEDIA_PATH' },
    { pattern: NODE_MODULES_PATTERN, name: 'NODE_MODULES' },
    { pattern: DEPLOY_PATH_PATTERN, name: 'DEPLOY_PATH' },
    { pattern: STACK_TRACE_PATTERN, name: 'STACK_TRACE' },
    { pattern: HOSTNAME_PATTERN, name: 'HOSTNAME' }
  ];

  for (const { pattern, name } of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      hadRedactions = true;
      recordSanitizationEvent(name);
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, REDACTED);
    }
  }

  if (hadRedactions) {
    log.warn('Sanitized internal data from external response');
  }

  return sanitized;
}

function sanitizeValue(val) {
  if (typeof val === 'string') return sanitizeString(val);
  if (Array.isArray(val)) return val.map(sanitizeValue);
  // Pass dates and buffers through unchanged. Object.entries(date) === [], so
  // without this guard every Date in every external response gets flattened
  // to {} and downstream consumers can't read it.
  if (val instanceof Date) return val;
  if (Buffer.isBuffer(val)) return val;
  if (val && typeof val === 'object') {
    const result = {};
    for (const [key, v] of Object.entries(val)) {
      result[key] = sanitizeValue(v);
    }
    return result;
  }
  return val;
}

/**
 * Get current sanitization statistics
 */
function getSanitizationStats() {
  return {
    totalRedactions: sanitizationStats.totalRedactions,
    patternCounts: { ...sanitizationStats.patternCounts },
    logEntries: [...sanitizationStats.logEntries],
    mostCommonPattern: Object.keys(sanitizationStats.patternCounts)
      .sort((a, b) => sanitizationStats.patternCounts[b] - sanitizationStats.patternCounts[a])[0] || null
  };
}

export function responseSanitizer(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    try {
      const sanitized = sanitizeValue(body);
      return originalJson(sanitized);
    } catch (err) {
      log.error('Sanitizer error:', err);
      return originalJson(body);
    }
  };

  next();
}

/**
 * Handle request for sanitization statistics
 */
export async function handleStatsRequest(req, res) {
  try {
    const stats = getSanitizationStats();
    res.json(stats);
  } catch (error) {
    log.error('Error retrieving sanitization stats:', error);
    res.status(500).json({ error: 'Failed to retrieve sanitization statistics' });
  }
}
