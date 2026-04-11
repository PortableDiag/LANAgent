import { logger } from './logger.js';

/**
 * Safely parse JSON with error handling
 * @param {string} text - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
export function safeJsonParse(text, defaultValue = null) {
  if (!text || typeof text !== 'string') {
    return defaultValue;
  }
  
  try {
    return JSON.parse(text);
  } catch (error) {
    logger.debug(`JSON parse error: ${error.message}`, { 
      text: text.substring(0, 100),
      error: error.message 
    });
    return defaultValue;
  }
}

/**
 * Safely stringify JSON with error handling
 * @param {*} obj - Object to stringify
 * @param {number} spaces - Number of spaces for indentation
 * @returns {string} JSON string or empty string on error
 */
export function safeJsonStringify(obj, spaces = 0) {
  try {
    return JSON.stringify(obj, null, spaces);
  } catch (error) {
    logger.error(`JSON stringify error: ${error.message}`, { error });
    
    // Handle circular references
    if (error.message.includes('circular')) {
      try {
        const seen = new WeakSet();
        return JSON.stringify(obj, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }
            seen.add(value);
          }
          return value;
        }, spaces);
      } catch (secondError) {
        logger.error('Failed to stringify with circular reference handler', { error: secondError });
        return '{}';
      }
    }
    
    return '{}';
  }
}

/**
 * Parse JSON from various sources (string, buffer, or already parsed)
 * @param {string|Buffer|Object} input - Input to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
export function parseJsonInput(input, defaultValue = null) {
  // Already an object
  if (typeof input === 'object' && input !== null && !Buffer.isBuffer(input)) {
    return input;
  }
  
  // Convert buffer to string
  if (Buffer.isBuffer(input)) {
    input = input.toString('utf8');
  }
  
  // Parse string
  if (typeof input === 'string') {
    return safeJsonParse(input, defaultValue);
  }
  
  return defaultValue;
}

/**
 * Deep clone an object using JSON (handles most cases but not functions/dates)
 * @param {*} obj - Object to clone
 * @returns {*} Cloned object or null on error
 */
export function jsonClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    logger.error('Failed to clone object via JSON', { error });
    return null;
  }
}

/**
 * Validate JSON schema with detailed error reporting
 * @param {*} obj - Object to validate
 * @param {Object} schema - Expected schema with required fields
 * @param {Object} [options] - Options for validation including custom error messages and severity levels
 * @returns {Array} Array of error objects or empty array if valid
 */
export function validateJsonSchema(obj, schema, options = {}) {
  const errors = [];
  
  if (!obj || typeof obj !== 'object') {
    errors.push({ message: 'Invalid object type', field: null, severity: options.severity || 'error' });
    return errors;
  }
  
  // Check required fields
  if (schema.required && Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!(field in obj)) {
        errors.push({ 
          message: options.customMessages?.[field]?.missing || `Missing required field: ${field}`, 
          field, 
          severity: options.severity || 'error' 
        });
      }
    }
  }
  
  // Check field types
  if (schema.properties) {
    for (const [field, rules] of Object.entries(schema.properties)) {
      if (field in obj && rules.type) {
        const actualType = Array.isArray(obj[field]) ? 'array' : typeof obj[field];
        if (actualType !== rules.type) {
          errors.push({ 
            message: options.customMessages?.[field]?.type || `Incorrect type for field: ${field}. Expected ${rules.type}, got ${actualType}`, 
            field, 
            severity: options.severity || 'error' 
          });
        }
      }
    }
  }
  
  return errors;
}