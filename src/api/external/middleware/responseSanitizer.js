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

function sanitizeString(str) {
  let sanitized = str;
  let hadRedactions = false;

  const patterns = [
    INTERNAL_IP_PATTERN,
    INTERNAL_PATH_PATTERN,
    HOME_PATH_PATTERN,
    MEDIA_PATH_PATTERN,
    NODE_MODULES_PATTERN,
    DEPLOY_PATH_PATTERN,
    STACK_TRACE_PATTERN,
    HOSTNAME_PATTERN
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      hadRedactions = true;
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
  if (val && typeof val === 'object') {
    const result = {};
    for (const [key, v] of Object.entries(val)) {
      result[key] = sanitizeValue(v);
    }
    return result;
  }
  return val;
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
