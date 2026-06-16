import { logger } from './logger.js';

/**
 * Safely parse JSON with error handling and custom deserializer
 * @param {string} text - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @param {Function} [customDeserializer] - Optional custom deserializer function
 * @returns {*} Parsed object or default value
 */
export function safeJsonParse(text, defaultValue = null, customDeserializer = null) {
  if (!text || typeof text !== 'string') {
    return defaultValue;
  }
  
  try {
    return customDeserializer ? JSON.parse(text, customDeserializer) : JSON.parse(text);
  } catch (error) {
    logger.debug(`JSON parse error: ${error.message}`, { 
      text: text.substring(0, 100),
      error: error.message 
    });
    return defaultValue;
  }
}

/**
 * Safely stringify JSON with error handling and custom serializer
 * @param {*} obj - Object to stringify
 * @param {number} spaces - Number of spaces for indentation
 * @param {Function} [customSerializer] - Optional custom serializer function
 * @returns {string} JSON string or empty string on error
 */
export function safeJsonStringify(obj, spaces = 0, customSerializer = null) {
  try {
    return JSON.stringify(obj, customSerializer, spaces);
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
 * @param {Function} [customDeserializer] - Optional custom deserializer function
 * @returns {*} Parsed object or default value
 */
export function parseJsonInput(input, defaultValue = null, customDeserializer = null) {
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
    return safeJsonParse(input, defaultValue, customDeserializer);
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

/**
 * Deterministically stringify a value to JSON with stable key ordering.
 * Produces canonical JSON suitable for hashing, diffing, content-addressed
 * caching, and snapshot comparisons.
 *
 * Differences from JSON.stringify:
 *   - Object keys are sorted (default: lexical) so equivalent objects produce
 *     identical strings regardless of insertion order
 *   - Circular references serialize as "[Circular]" instead of throwing
 *   - BigInt → string, Date → ISO 8601, Buffer → base64
 *   - Map → object with sorted keys; Set → array sorted by JSON of items
 *   - Falls back to safeJsonStringify on any unexpected error
 *
 * @param {*} value
 * @param {Object} [options]
 * @param {number} [options.spaces=0]
 * @param {Function} [options.comparator] - Custom (a, b) => number key comparator
 * @param {boolean} [options.ignoreUndefined=false] - Drop undefined entries (default matches JSON.stringify: arrays → null, objects → drop)
 * @returns {string}
 */
export function stableJsonStringify(value, options = {}) {
  const { spaces = 0, comparator, ignoreUndefined = false } = options || {};

  const sortKeys = (keys) => {
    if (typeof comparator !== 'function') return [...keys].sort();
    try {
      return [...keys].sort(comparator);
    } catch (err) {
      logger.warn(`stableJsonStringify: custom comparator failed, using default sort: ${err?.message || err}`);
      return [...keys].sort();
    }
  };

  try {
    const seen = new WeakSet();

    const normalize = (input) => {
      if (input === null) return null;
      const t = typeof input;

      if (t === 'number' || t === 'string' || t === 'boolean') return input;
      if (t === 'bigint') return input.toString();
      // Return undefined and let the parent (array / object / top-level)
      // decide how to encode — matches JSON.stringify semantics: objects
      // drop undefined values, arrays serialize them as null.
      if (t === 'undefined') return undefined;
      if (t === 'function' || t === 'symbol') return undefined;

      if (input instanceof Date) {
        return Number.isNaN(input.getTime()) ? null : input.toISOString();
      }

      if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(input)) {
        return input.toString('base64');
      }

      if (t === 'object') {
        if (seen.has(input)) return '[Circular]';
        seen.add(input);

        if (Array.isArray(input)) {
          const out = [];
          for (const item of input) {
            const v = normalize(item);
            if (v === undefined) {
              if (!ignoreUndefined) out.push(null);
              // ignoreUndefined: drop entirely
            } else {
              out.push(v);
            }
          }
          return out;
        }

        if (input instanceof Map) {
          const entries = Array.from(input.entries()).map(([k, v]) => ({
            keyStr: typeof k === 'string' ? k : safeJsonStringify(k),
            val: v
          }));
          const sorted = sortKeys(entries.map((e) => e.keyStr));
          const out = {};
          for (const ks of sorted) {
            const e = entries.find((x) => x.keyStr === ks);
            if (!e) continue;
            const v = normalize(e.val);
            if (v === undefined && ignoreUndefined) continue;
            if (v === undefined) continue;
            out[ks] = v;
          }
          return out;
        }

        if (input instanceof Set) {
          const items = Array.from(input.values())
            .map((v) => ({ v, s: safeJsonStringify(v) }))
            .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
          return items.map((i) => normalize(i.v));
        }

        const out = {};
        for (const key of sortKeys(Object.keys(input))) {
          const v = normalize(input[key]);
          if (v === undefined) continue;
          out[key] = v;
        }
        return out;
      }

      return input;
    };

    const normalized = normalize(value);
    return JSON.stringify(normalized === undefined ? null : normalized, null, spaces);
  } catch (error) {
    logger.error(`stableJsonStringify failed; falling back to safeJsonStringify: ${error?.message || error}`);
    return safeJsonStringify(value, spaces);
  }
}
