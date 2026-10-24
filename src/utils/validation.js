import NodeCache from 'node-cache';

/**
 * Input validation utilities for plugins
 */

const validationCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Generate a unique cache key for input-schema-options combination
 * @param {Object} input - Input data
 * @param {Object} schema - Validation schema
 * @param {Object} [options] - Validation options
 * @returns {string|null} Cache key or null if serialization fails
 */
function generateCacheKey(input, schema, options = {}) {
  try {
    return JSON.stringify({ input, schema, options });
  } catch {
    return null;
  }
}

/**
 * Return a human-readable field path.
 *
 * @param {string} path - Current field path
 * @param {string|number} segment - Path segment to append
 * @returns {string} Complete field path
 */
function appendPath(path, segment) {
  if (typeof segment === 'number') {
    return `${path}[${segment}]`;
  }

  return path ? `${path}.${segment}` : String(segment);
}

/**
 * Validate a value against compositional schema rules.
 *
 * @param {*} value - Value to validate
 * @param {Object} rules - Validation rules
 * @param {string} path - Field path
 * @returns {Array<string>} Validation errors
 */
function validateComposition(value, rules, path, options = {}) {
  const errors = [];

  if (Array.isArray(rules.oneOf)) {
    const matches = rules.oneOf.filter((candidate) =>
      validateValue(value, candidate, path).length === 0
    );

    if (matches.length !== 1) {
      errors.push(`Field '${path}' must match exactly one schema in oneOf`);
    }
  }

  if (Array.isArray(rules.anyOf)) {
    const matches = rules.anyOf.some((candidate) =>
      validateValue(value, candidate, path).length === 0
    );

    if (!matches) {
      errors.push(`Field '${path}' must match at least one schema in anyOf`);
    }
  }

  if (Array.isArray(rules.allOf)) {
    for (const candidate of rules.allOf) {
      // allOf is a plain conjunction, so partial mode applies to each branch.
      // oneOf/anyOf/not stay strict: relaxing `required` inside them changes
      // which branch matches rather than just loosening a constraint.
      errors.push(...validateValue(value, candidate, path, options));
    }
  }

  if (rules.not && validateValue(value, rules.not, path).length === 0) {
    errors.push(`Field '${path}' must not match the specified schema`);
  }

  return errors;
}

/**
 * Validate a value recursively against schema rules.
 *
 * @param {*} value - Value to validate
 * @param {Object} rules - Validation rules
 * @param {string} path - Field path
 * @param {Object} [options] - Validation options (e.g., { partial: true })
 * @returns {Array<string>} Validation errors
 */
function validateValue(value, rules = {}, path = 'value', options = {}) {
  const errors = [];
  const fieldName = path || 'value';

  if (rules.type && !validateType(value, rules.type, rules)) {
    errors.push(`Field '${fieldName}' must be of type ${Array.isArray(rules.type) ? rules.type.join(' or ') : rules.type}`);
    return errors;
  }

  errors.push(...validateComposition(value, rules, fieldName, options));

  if (rules.enum && !rules.enum.includes(value)) {
    errors.push(`Field '${fieldName}' must be one of: ${rules.enum.join(', ')}`);
  }

  if (typeof value === 'string') {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      errors.push(`Field '${fieldName}' must be at least ${rules.minLength} characters long`);
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      errors.push(`Field '${fieldName}' must be at most ${rules.maxLength} characters long`);
    }
    if (rules.pattern) {
      try {
        if (!new RegExp(rules.pattern).test(value)) {
          errors.push(`Field '${fieldName}' does not match required pattern`);
        }
      } catch {
        errors.push(`Validation error for field '${fieldName}': invalid pattern`);
      }
    }
  }

  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      errors.push(`Field '${fieldName}' must be at least ${rules.min}`);
    }
    if (rules.max !== undefined && value > rules.max) {
      errors.push(`Field '${fieldName}' must be at most ${rules.max}`);
    }
  }

  if (Array.isArray(value)) {
    if (rules.minItems !== undefined && value.length < rules.minItems) {
      errors.push(`Field '${fieldName}' must contain at least ${rules.minItems} items`);
    }
    if (rules.maxItems !== undefined && value.length > rules.maxItems) {
      errors.push(`Field '${fieldName}' must contain at most ${rules.maxItems} items`);
    }

    if (rules.items) {
      value.forEach((item, index) => {
        errors.push(...validateValue(item, rules.items, appendPath(path, index), options));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value) && rules.properties) {
    if (Array.isArray(rules.required)) {
      for (const field of rules.required) {
        // In partial mode, skip required check for fields not present in the object
        if (options.partial && !(field in value)) {
          continue;
        }
        if (value[field] === undefined || value[field] === null) {
          errors.push(`Required field '${appendPath(path, field)}' is missing`);
        }
      }
    }

    for (const [field, childRules] of Object.entries(rules.properties)) {
      const childValue = value[field];

      if (childValue === undefined || childValue === null) {
        continue;
      }

      errors.push(...validateValue(childValue, childRules, appendPath(path, field), options));
    }
  }

  // Custom validation function — wrap in try/catch so a throwing custom
  // validator doesn't crash the whole request (the previous pattern would
  // surface as an unhandled 500 with a stack trace; now it's a normal
  // validation error message).
  if (typeof rules.validate === 'function') {
    try {
      const customError = rules.validate(value);
      if (customError) {
        errors.push(customError);
      }
    } catch (err) {
      errors.push(`Validation error for field '${fieldName}': ${err.message}`);
    }
  }

  return errors;
}

/**
 * Validate input against a schema
 * @param {Object} input - Input to validate
 * @param {Object} schema - Validation schema
 * @param {Object} [options] - Validation options
 * @param {boolean} [options.partial] - If true, skip required checks for fields not present in input (for PATCH requests)
 * @returns {Object} Validation result { valid: boolean, errors: Array }
 */
export function validateInput(input, schema = {}, options = {}) {
  const cacheKey = generateCacheKey(input, schema, options);

  if (cacheKey) {
    const cachedResult = validationCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }
  }

  const errors = [];
  const value = input;

  // Check required fields. A missing/null input reports every required field
  // as missing (instead of throwing on input[field]).
  if (Array.isArray(schema.required)) {
    const target = value === undefined || value === null ? {} : value;
    for (const field of schema.required) {
      // In partial mode, skip required check for fields not present in input
      if (options.partial && !(field in target)) {
        continue;
      }
      if (target[field] === undefined || target[field] === null) {
        errors.push(`Required field '${field}' is missing`);
      }
    }
  }

  if (schema.properties || schema.type || schema.oneOf || schema.anyOf || schema.allOf || schema.not) {
    const rootRules = { ...schema };
    delete rootRules.required;

    if (schema.properties) {
      // Absent input was already reported via `required`; nothing to walk.
      if (value !== undefined && value !== null) {
        errors.push(...validateValue(value, rootRules, '', options));
      }
    } else {
      errors.push(...validateValue(value, rootRules, 'value', options));
    }
  }

  const result = {
    valid: errors.length === 0,
    errors
  };

  if (cacheKey) {
    validationCache.set(cacheKey, result);
  }

  return result;
}

/**
 * Validate value type
 * @param {*} value - Value to check
 * @param {string} type - Expected type
 * @returns {boolean} Whether value matches type
 */
function validateType(value, type, rules = {}) {
  if (Array.isArray(type)) {
    return type.some((candidate) => validateType(value, candidate, rules));
  }

  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * Sanitize string input
 * @param {string} str - String to sanitize
 * @param {Object} options - Sanitization options
 * @returns {string} Sanitized string
 */
export function sanitizeString(str, options = {}) {
  if (typeof str !== 'string') {
    return '';
  }

  let result = str;

  // Remove null bytes
  result = result.replace(/\0/g, '');

  // Trim whitespace
  if (options.trim !== false) {
    result = result.trim();
  }

  // Limit length
  if (options.maxLength) {
    result = result.substring(0, options.maxLength);
  }

  // Remove or escape HTML
  if (options.escapeHtml) {
    result = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  // Remove control characters (except newlines and tabs)
  if (options.removeControl) {
    result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  return result;
}

/**
 * Sanitize file path
 * @param {string} path - Path to sanitize
 * @returns {string} Sanitized path
 */
export function sanitizePath(path) {
  if (typeof path !== 'string') {
    return '';
  }

  // Remove null bytes
  let sanitized = path.replace(/\0/g, '');

  // Prevent directory traversal
  sanitized = sanitized.replace(/\.\./g, '');

  // Remove multiple slashes
  sanitized = sanitized.replace(/\/+/g, '/');

  // Remove leading slashes for relative paths
  if (!path.startsWith('/')) {
    sanitized = sanitized.replace(/^\/+/, '');
  }

  return sanitized;
}

/**
 * Validate email address
 * @param {string} email - Email to validate
 * @returns {boolean} Whether email is valid
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate URL
 * @param {string} url - URL to validate
 * @returns {boolean} Whether URL is valid
 */
export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a validation schema for common plugin parameters
 * @returns {Object} Common validation schemas
 */
export const commonSchemas = {
  action: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 50
  },

  email: {
    type: 'string',
    validate: (value) => {
      if (!isValidEmail(value)) {
        return 'Invalid email address format';
      }
    }
  },

  url: {
    type: 'string',
    validate: (value) => {
      if (!isValidUrl(value)) {
        return 'Invalid URL format';
      }
    }
  },

  path: {
    type: 'string',
    validate: (value) => {
      if (value.includes('..') || value.includes('\0')) {
        return 'Invalid path: contains forbidden characters';
      }
    }
  },

  command: {
    type: 'string',
    maxLength: 1000,
    validate: (value) => {
      // Prevent only the most dangerous commands
      const dangerous = [
        { pattern: /rm\s+-rf\s+\/(?:\s|$)/, message: 'Dangerous rm -rf / detected' },
        { pattern: /dd\s+if=\/dev\/zero\s+of=\//, message: 'Dangerous dd command detected' },
        { pattern: /mkfs\.\w+\s+\/dev\/[sh]da/, message: 'Dangerous mkfs on system drive detected' },
        { pattern: /:\(\)\s*{\s*:\|:&\s*};:/, message: 'Fork bomb detected' }
      ];

      for (const check of dangerous) {
        if (check.pattern.test(value)) {
          return check.message;
        }
      }
    }
  },

  port: {
    type: 'number',
    min: 1,
    max: 65535
  },

  timeout: {
    type: 'number',
    min: 0,
    max: 300000 // 5 minutes max
  }
};

/**
 * Create a validation middleware for express routes
 * @param {Object} schema - Validation schema
 * @param {Object} [options] - Validation options (e.g., { partial: true } for PATCH)
 * @returns {Function} Express middleware
 */
export function validationMiddleware(schema, options = {}) {
  return (req, res, next) => {
    const { valid, errors } = validateInput(req.body, schema, options);

    if (!valid) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        errors
      });
    }

    next();
  };
}
