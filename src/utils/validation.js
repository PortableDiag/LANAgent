import NodeCache from 'node-cache';

/**
 * Input validation utilities for plugins
 */

const validationCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Generate a unique cache key for input-schema combination
 */
function generateCacheKey(input, schema) {
  return JSON.stringify({ input, schema });
}

/**
 * Validate input against a schema
 * @param {Object} input - Input to validate
 * @param {Object} schema - Validation schema
 * @returns {Object} Validation result { valid: boolean, errors: Array }
 */
export function validateInput(input, schema) {
  const cacheKey = generateCacheKey(input, schema);
  const cachedResult = validationCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  const errors = [];
  
  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (input[field] === undefined || input[field] === null) {
        errors.push(`Required field '${field}' is missing`);
      }
    }
  }
  
  // Validate field types and constraints
  if (schema.properties) {
    for (const [field, rules] of Object.entries(schema.properties)) {
      const value = input[field];
      
      if (value === undefined || value === null) {
        continue; // Skip if not provided and not required
      }
      
      // Type validation
      if (rules.type && !validateType(value, rules.type)) {
        errors.push(`Field '${field}' must be of type ${rules.type}`);
      }
      
      // String constraints
      if (rules.type === 'string') {
        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`Field '${field}' must be at least ${rules.minLength} characters long`);
        }
        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`Field '${field}' must be at most ${rules.maxLength} characters long`);
        }
        if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
          errors.push(`Field '${field}' does not match required pattern`);
        }
        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`Field '${field}' must be one of: ${rules.enum.join(', ')}`);
        }
      }
      
      // Number constraints
      if (rules.type === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          errors.push(`Field '${field}' must be at least ${rules.min}`);
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push(`Field '${field}' must be at most ${rules.max}`);
        }
      }
      
      // Array constraints
      if (rules.type === 'array') {
        if (rules.minItems && value.length < rules.minItems) {
          errors.push(`Field '${field}' must contain at least ${rules.minItems} items`);
        }
        if (rules.maxItems && value.length > rules.maxItems) {
          errors.push(`Field '${field}' must contain at most ${rules.maxItems} items`);
        }
      }
      
      // Custom validation function
      if (rules.validate && typeof rules.validate === 'function') {
        const customError = rules.validate(value);
        if (customError) {
          errors.push(customError);
        }
      }
    }
  }
  
  const result = {
    valid: errors.length === 0,
    errors
  };

  validationCache.set(cacheKey, result);
  return result;
}

/**
 * Validate value type
 * @param {*} value - Value to check
 * @param {string} type - Expected type
 * @returns {boolean} Whether value matches type
 */
function validateType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
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
 * @returns {Function} Express middleware
 */
export function validationMiddleware(schema) {
  return (req, res, next) => {
    const { valid, errors } = validateInput(req.body, schema);
    
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