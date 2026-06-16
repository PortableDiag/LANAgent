import { logger } from '../../utils/logger.js';

/**
 * Sanitizer strips sensitive data from all outgoing P2P content
 * Patterns adapted from src/api/external/middleware/responseSanitizer.js
 */

const REDACTED = '[REDACTED]';

// Patterns to strip/redact from outgoing content
const SANITIZE_PATTERNS = [
  // Environment variable access
  { pattern: /process\.env\.([\w]+)/g, replace: 'process.env.REDACTED' },

  // API key literals (common prefixes)
  { pattern: /(['"`])(?:sk-|la_|ghp_|xox[bpsa]-|AKIA|glpat-|shpat_)[^'"`]*\1/g, replace: `${REDACTED}` },

  // Root paths
  { pattern: /\/root\/[^\s'"`\])},]*/g, replace: REDACTED },

  // Home paths
  { pattern: /\/home\/[^\s'"`\])},]*/g, replace: REDACTED },

  // Media paths
  { pattern: /\/media\/[^\s'"`\])},]*/g, replace: REDACTED },

  // Node modules paths
  { pattern: /\/node_modules\/[^\s'"`\])},]*/g, replace: REDACTED },

  // IP addresses (v4)
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replace: REDACTED },

  // MongoDB connection strings
  { pattern: /mongodb(?:\+srv)?:\/\/[^\s'"`\])},]*/g, replace: REDACTED },

  // Redis connection strings
  { pattern: /redis:\/\/[^\s'"`\])},]*/g, replace: REDACTED },

  // Password assignments
  { pattern: /password\s*[:=]\s*['"`][^'"`]+['"`]/gi, replace: `password: ${REDACTED}` },

  // Secret/token assignments
  { pattern: /(secret|token|apikey|api_key)\s*[:=]\s*['"`][^'"`]+['"`]/gi, replace: (match, key) => `${key}: ${REDACTED}` },

  // Email addresses (to protect identity)
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replace: REDACTED },

  // loadCredentials call contents (keep the call, remove actual keys)
  { pattern: /loadCredentials\([^)]*\)/g, replace: 'loadCredentials()' },

  // Hostnames that could identify the system
  { pattern: /\b(veracrypt\d*|lanagent-deploy|lanagent-repo)\b/gi, replace: REDACTED },

  // Stack traces (may contain paths)
  { pattern: /\bat\s+\S+\s+\([^)]*\)/g, replace: REDACTED },

  // Hex-encoded keys that are 32+ bytes
  { pattern: /(['"`])[0-9a-f]{64,}(['"`])/g, replace: `$1${REDACTED}$2` },

  // Social Security Numbers (SSNs)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: REDACTED },

  // Credit Card Numbers (Visa, MC, Amex, Discover with separators)
  { pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replace: REDACTED }
];

/**
 * Sanitize a string by applying all redaction patterns
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  let sanitized = str;

  for (const { pattern, replace } of SANITIZE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replace);
  }

  return sanitized;
}

/**
 * Sanitize a value recursively (handles strings, arrays, objects)
 * @param {*} value - Value to sanitize
 * @returns {*} Sanitized value
 */
export function sanitizeValue(value, _seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) {
    if (_seen.has(value)) return '[Circular]';
    _seen.add(value);
    return value.map(v => sanitizeValue(v, _seen));
  }
  if (value && typeof value === 'object') {
    if (_seen.has(value)) return '[Circular]';
    _seen.add(value);
    const result = {};
    for (const [key, v] of Object.entries(value)) {
      // Skip keys that are likely sensitive
      const lowerKey = key.toLowerCase();
      if (['password', 'secret', 'token', 'apikey', 'api_key', 'private_key', 'privatekey'].includes(lowerKey)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(v, _seen);
      }
    }
    return result;
  }
  return value;
}

/**
 * Sanitize plugin source code for sharing
 * @param {string} sourceCode - Plugin source code
 * @returns {string} Sanitized source code
 */
export function sanitizePluginSource(sourceCode) {
  if (!sourceCode) return '';

  let sanitized = sanitizeString(sourceCode);

  // Additional plugin-specific sanitization:
  // Remove single-line comments that might contain sensitive info
  sanitized = sanitized.replace(/\/\/.*(?:password|secret|key|token|credential|api_key).*$/gmi, '// [comment redacted]');

  // Remove multi-line comment blocks that reference sensitive things
  sanitized = sanitized.replace(/\/\*[\s\S]*?(?:password|secret|credential)[\s\S]*?\*\//gi, '/* [comment redacted] */');

  return sanitized;
}

/**
 * Sanitize a plugin manifest for sharing
 * Only allow safe fields through
 * @param {object} manifest - Plugin manifest
 * @returns {object} Sanitized manifest
 */
export function sanitizeManifest(manifest) {
  return {
    name: manifest.name || '',
    version: manifest.version || '1.0.0',
    description: sanitizeString(manifest.description || ''),
    commands: (manifest.commands || []).map(cmd => ({
      command: cmd.command,
      description: sanitizeString(cmd.description || '')
    })),
    requiredDependencies: manifest.requiredDependencies || [],
    requiredCredentials: (manifest.requiredCredentials || []).map(name =>
      typeof name === 'string' ? name.replace(/=.*/, '') : name // Strip any values, keep only names
    )
  };
}

/**
 * Validate that sanitization was effective
 * @param {string} content - Content to validate
 * @returns {{ safe: boolean, warnings: string[] }}
 */
export function validateSanitization(content) {
  const warnings = [];

  // Check for remaining IP addresses
  if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(content) && !content.includes(REDACTED)) {
    warnings.push('Potential IP address found');
  }

  // Check for remaining absolute paths
  if (/\/(root|home|media)\//.test(content)) {
    warnings.push('Potential filesystem path found');
  }

  // Check for potential API keys
  if (/(?:sk-|la_|ghp_|xox[bpsa]-|AKIA|glpat-)[A-Za-z0-9]{10,}/.test(content)) {
    warnings.push('Potential API key found');
  }

  if (warnings.length > 0) {
    logger.warn('P2P sanitization warnings:', warnings.join(', '));
  }

  return {
    safe: warnings.length === 0,
    warnings
  };
}
