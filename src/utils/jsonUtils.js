import { logger } from './logger.js';

/**
 * Create a structured JSON parsing failure result.
 *
 * @param {*} defaultValue - Default value returned after a failure
 * @param {string} code - Stable error code
 * @param {string} message - Human-readable error message
 * @param {number|null} position - Character position associated with the error
 * @returns {{ok: false, value: *, error: {code: string, message: string, position: number|null}, truncated: boolean}}
 */
function jsonParseFailure(defaultValue, code, message, position = null) {
  return {
    ok: false,
    value: defaultValue,
    error: { code, message, position },
    truncated: false
  };
}

/**
 * Extract a character position from the different SyntaxError formats
 * produced by supported Node.js versions.
 *
 * @param {Error} error - JSON parsing error
 * @returns {number|null} Character position or null when unavailable
 */
function getJsonErrorPosition(error) {
  const message = error?.message || '';
  const positionMatch = message.match(/\bposition\s+(\d+)/i);
  if (positionMatch) return Number(positionMatch[1]);

  const columnMatch = message.match(/\bcolumn\s+(\d+)/i);
  if (columnMatch) return Number(columnMatch[1]) - 1;

  return null;
}

/**
 * Return a configured non-negative integer limit, or undefined when no
 * usable limit was supplied.
 *
 * @param {*} value - Candidate limit
 * @returns {number|undefined} Normalized limit
 */
function normalizeLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Walk a parsed JSON value and enforce collection and nesting limits.
 *
 * @param {*} value - Parsed value
 * @param {Object} limits - Configured limits
 * @param {number} depth - Current nesting depth
 * @param {string} path - Diagnostic value path
 * @param {Set<object>} seen - Ancestors of value (cycle detection)
 * @returns {{code: string, message: string, position: null}|null} Limit failure or null
 */
function findJsonLimitFailure(value, limits, depth = 0, path = '$', seen = new Set()) {
  if (value === null || typeof value !== 'object') return null;

  if (limits.maxDepth !== undefined && depth > limits.maxDepth) {
    return {
      code: 'MAX_DEPTH_EXCEEDED',
      message: `Maximum JSON nesting depth of ${limits.maxDepth} exceeded at ${path}`,
      position: null
    };
  }

  // `seen` holds the ancestors of this value only, so a reviver that returns the same object
  // twice is not mistaken for a cycle.
  if (seen.has(value)) {
    return {
      code: 'CIRCULAR_VALUE',
      message: `Circular value encountered at ${path}`,
      position: null
    };
  }
  seen.add(value);
  try {
    return findJsonChildLimitFailure(value, limits, depth, path, seen);
  } finally {
    seen.delete(value);
  }
}

/** Container checks and recursion for findJsonLimitFailure (value is a non-null object). */
function findJsonChildLimitFailure(value, limits, depth, path, seen) {
  if (Array.isArray(value)) {
    if (limits.maxArrayLength !== undefined && value.length > limits.maxArrayLength) {
      return {
        code: 'MAX_ARRAY_LENGTH_EXCEEDED',
        message: `Maximum JSON array length of ${limits.maxArrayLength} exceeded at ${path}`,
        position: null
      };
    }

    for (let index = 0; index < value.length; index += 1) {
      const failure = findJsonLimitFailure(
        value[index],
        limits,
        depth + 1,
        `${path}[${index}]`,
        seen
      );
      if (failure) return failure;
    }
    return null;
  }

  const keys = Object.keys(value);
  if (limits.maxObjectKeys !== undefined && keys.length > limits.maxObjectKeys) {
    return {
      code: 'MAX_OBJECT_KEYS_EXCEEDED',
      message: `Maximum JSON object key count of ${limits.maxObjectKeys} exceeded at ${path}`,
      position: null
    };
  }

  for (const key of keys) {
    const failure = findJsonLimitFailure(
      value[key],
      limits,
      depth + 1,
      `${path}.${key}`,
      seen
    );
    if (failure) return failure;
  }

  return null;
}

/**
 * Parse JSON with diagnostic failure details and configurable resource limits.
 *
 * Strings are measured in UTF-8 bytes before parsing. Buffers are decoded as
 * UTF-8 and measured using their original byte length. Limits are checked
 * after parsing so the returned value is never partially truncated.
 *
 * @param {string|Buffer} input - JSON string or UTF-8 Buffer to parse
 * @param {Object} [options={}] - Parsing and resource limit options
 * @param {*} [options.defaultValue=null] - Value returned after a failure
 * @param {Function} [options.reviver] - Optional JSON reviver
 * @param {number} [options.maxBytes] - Maximum UTF-8 input size
 * @param {number} [options.maxDepth] - Maximum nested container depth
 * @param {number} [options.maxArrayLength] - Maximum array length
 * @param {number} [options.maxObjectKeys] - Maximum enumerable object keys
 * @returns {{ok: true, value: *}|{ok: false, value: *, error: {code: string, message: string, position: number|null}, truncated: boolean}}
 */
export function parseJsonDetailed(input, options = {}) {
  const parseOptions = options && typeof options === 'object' ? options : {};
  const defaultValue = Object.prototype.hasOwnProperty.call(parseOptions, 'defaultValue')
    ? parseOptions.defaultValue
    : null;

  let text;
  let byteLength;

  if (Buffer.isBuffer(input)) {
    byteLength = input.length;
    text = input.toString('utf8');
  } else if (typeof input === 'string') {
    text = input;
    byteLength = Buffer.byteLength(input, 'utf8');
  } else {
    const failure = jsonParseFailure(
      defaultValue,
      'INVALID_INPUT',
      'JSON input must be a string or Buffer'
    );
    logger.debug(`JSON parse error: ${failure.error.message}`);
    return failure;
  }

  const maxBytes = normalizeLimit(parseOptions.maxBytes);
  if (maxBytes !== undefined && byteLength > maxBytes) {
    const failure = jsonParseFailure(
      defaultValue,
      'MAX_BYTES_EXCEEDED',
      `JSON input size of ${byteLength} bytes exceeds the maximum of ${maxBytes} bytes`
    );
    logger.debug(`JSON parse error: ${failure.error.message}`, {
      byteLength,
      maxBytes
    });
    return failure;
  }

  let value;
  try {
    value = typeof parseOptions.reviver === 'function'
      ? JSON.parse(text, parseOptions.reviver)
      : JSON.parse(text);
  } catch (error) {
    const message = error?.message || 'Invalid JSON';
    const failure = jsonParseFailure(
      defaultValue,
      'JSON_PARSE_ERROR',
      message,
      getJsonErrorPosition(error)
    );
    logger.debug(`JSON parse error: ${message}`, {
      text: text.substring(0, 100),
      error: message
    });
    return failure;
  }

  const limits = {
    maxDepth: normalizeLimit(parseOptions.maxDepth),
    maxArrayLength: normalizeLimit(parseOptions.maxArrayLength),
    maxObjectKeys: normalizeLimit(parseOptions.maxObjectKeys)
  };
  // Walk the parsed value only when a limit was asked for; safeJsonParse sets none and must
  // not pay for a full traversal on every call.
  const hasLimits = Object.values(limits).some(limit => limit !== undefined);
  const limitFailure = hasLimits ? findJsonLimitFailure(value, limits) : null;

  if (limitFailure) {
    const failure = jsonParseFailure(
      defaultValue,
      limitFailure.code,
      limitFailure.message,
      limitFailure.position
    );
    logger.debug(`JSON parse limit exceeded: ${limitFailure.message}`);
    return failure;
  }

  return { ok: true, value };
}

/**
 * Safely parse JSON with error handling and custom deserializer
 * @param {string} text - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @param {Function} [customDeserializer] - Optional custom deserializer function
 * @returns {*} Parsed object or default value
 */
export function safeJsonParse(text, defaultValue = null, customDeserializer = null) {
  // Unchanged contract: only non-empty strings are parsed (a Buffer still gets the default).
  if (!text || typeof text !== 'string') {
    return defaultValue;
  }

  return parseJsonDetailed(text, {
    defaultValue,
    reviver: customDeserializer
  }).value;
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
