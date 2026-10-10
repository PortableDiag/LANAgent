import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { logger } from '../utils/logger.js';

/**
 * Base OutputParser class for extracting and validating structured data from LLM responses
 */
export class OutputParser {
  /**
   * @param {object|null} schema - JSON Schema for validation
   * @param {object} [options] - Configuration options
   * @param {boolean} [options.repair=true] - On a JSON.parse failure, retry once after repairJSON()
   */
  constructor(schema = null, options = {}) {
    this.schema = schema;
    this.repair = options.repair !== false; // default true
    this.ajv = new Ajv({ allErrors: true, coerceTypes: true });
    addFormats(this.ajv);
    this.validator = null; // Lazy: compile on first parse
  }

  /**
   * Repair common LLM JSON mistakes: comments, single-quoted strings,
   * unquoted keys, trailing commas. String-aware: content inside
   * double-quoted strings (URLs with //, apostrophes) is never touched.
   * Only used as a fallback after the text failed to parse as-is.
   * @param {string} text - Raw text to repair
   * @returns {string} Repaired text
   */
  static repairJSON(text) {
    if (!text || typeof text !== 'string') return text;

    let out = '';
    let lastSig = ''; // last non-whitespace char emitted outside strings
    const n = text.length;
    let i = 0;

    const emit = (str) => {
      out += str;
      const t = str.trim();
      if (t) lastSig = t[t.length - 1];
    };

    while (i < n) {
      const ch = text[i];

      // Double-quoted string: copy verbatim, honouring escapes.
      if (ch === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        emit(text.slice(i, Math.min(j + 1, n)));
        i = j + 1;
        continue;
      }

      // Single-quoted string -> double-quoted, re-escaping as needed.
      if (ch === "'") {
        let j = i + 1;
        let body = '';
        while (j < n && text[j] !== "'") {
          if (text[j] === '\\' && j + 1 < n) {
            body += text[j + 1] === "'" ? "'" : text[j] + text[j + 1];
            j += 2;
          } else {
            body += text[j] === '"' ? '\\"' : text[j];
            j += 1;
          }
        }
        emit(`"${body}"`);
        i = j + 1;
        continue;
      }

      // Comments.
      if (ch === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }

      // Trailing comma: drop if the next significant char closes a container.
      if (ch === ',') {
        let k = i + 1;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === '}' || text[k] === ']') { i++; continue; }
        emit(ch);
        i++;
        continue;
      }

      // Bare identifier used as an object key ({ key: ... } / , key: ...).
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < n && /[\w$]/.test(text[j])) j++;
        const word = text.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === ':' && (lastSig === '{' || lastSig === ',')) {
          emit(`"${word}"`);
        } else {
          emit(word);
        }
        i = j;
        continue;
      }

      emit(ch);
      i++;
    }

    return out;
  }

  /**
   * Locate the outermost JSON object/array in already fence-stripped text.
   * @param {string} cleaned
   * @returns {string}
   */
  static locateJSON(cleaned) {
    // Try to find JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return cleaned.substring(firstBrace, lastBrace + 1);
    }

    // Try to find JSON array
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      return cleaned.substring(firstBracket, lastBracket + 1);
    }

    // Return trimmed text as-is
    return cleaned.trim();
  }

  /**
   * Extract JSON from text that may contain markdown code fences or other formatting
   */
  extractJSON(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    // Strip all code fences — Claude nests ```javascript inside ```json
    const cleaned = text.replace(/```\w*\n?/g, '');
    return OutputParser.locateJSON(cleaned);
  }

  /**
   * Parse text and validate against schema
   */
  parse(text) {
    const jsonStr = this.extractJSON(text);

    if (!jsonStr) {
      throw new ParseError('No valid content found in response', text);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      // Fallback only: valid JSON is never rewritten. Repair the located
      // slice first (prose apostrophes around it can't interfere), then the
      // whole fence-stripped text (a comment may hold a stray brace).
      let repaired;
      if (this.repair) {
        const cleaned = text.replace(/```\w*\n?/g, '');
        for (const candidate of [jsonStr, cleaned]) {
          try {
            repaired = JSON.parse(OutputParser.locateJSON(OutputParser.repairJSON(candidate)));
            break;
          } catch { /* try the next candidate, else the original error */ }
        }
      }
      if (repaired === undefined) {
        throw new ParseError(`Invalid JSON: ${error.message}`, text);
      }
      logger.debug('OutputParser: parsed after JSON repair');
      parsed = repaired;
    }

    if (this.schema && !this.validator) {
      this.validator = this.ajv.compile(this.schema);
    }

    if (this.validator) {
      const valid = this.validator(parsed);
      if (!valid) {
        const errors = this.validator.errors.map(e => `${e.instancePath || 'root'}: ${e.message}`).join(', ');
        throw new ValidationError(`Schema validation failed: ${errors}`, parsed, this.validator.errors);
      }
    }

    return parsed;
  }

  /**
   * Safely parse without throwing - returns default on error
   */
  safeParse(text, defaultValue = null) {
    try {
      return this.parse(text);
    } catch (error) {
      logger.debug(`OutputParser safe parse failed: ${error.message}`);
      return defaultValue;
    }
  }

  /**
   * Generate format instructions for the LLM prompt
   */
  getFormatInstructions() {
    if (!this.schema) {
      return 'Respond with valid JSON.';
    }

    const schemaStr = JSON.stringify(this.schema, null, 2);
    return `Respond with valid JSON that matches this schema:\n\`\`\`json\n${schemaStr}\n\`\`\``;
  }
}

/**
 * JSON Output Parser - Basic JSON extraction and validation
 */
export class JSONOutputParser extends OutputParser {
  constructor() {
    super(null);
  }

  getFormatInstructions() {
    return 'Respond with valid JSON only. No explanations or markdown.';
  }
}

/**
 * Structured Output Parser - Schema-based with detailed error messages
 */
export class StructuredOutputParser extends OutputParser {
  constructor(schema) {
    super(schema);
    this.schemaDescription = this.generateSchemaDescription(schema);
  }

  /**
   * Create from JSON schema
   */
  static fromJSONSchema(schema) {
    return new StructuredOutputParser(schema);
  }

  /**
   * Generate human-readable schema description
   */
  generateSchemaDescription(schema, indent = 0) {
    if (!schema) return '';

    const prefix = '  '.repeat(indent);
    const lines = [];

    if (schema.type === 'object' && schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const required = schema.required?.includes(key) ? ' (required)' : ' (optional)';
        const type = prop.type || 'any';
        const desc = prop.description ? ` - ${prop.description}` : '';
        lines.push(`${prefix}${key}: ${type}${required}${desc}`);

        if (prop.type === 'object' && prop.properties) {
          lines.push(this.generateSchemaDescription(prop, indent + 1));
        }
        if (prop.type === 'array' && prop.items) {
          lines.push(`${prefix}  [${prop.items.type || 'any'}]`);
        }
      }
    }

    return lines.join('\n');
  }

  getFormatInstructions() {
    const description = this.schemaDescription || 'a valid JSON object';
    return `Respond with ONLY a JSON object (no markdown, no explanation). The JSON must have:\n${description}`;
  }
}

/**
 * List Output Parser - Parses numbered or bulleted lists
 */
export class ListOutputParser extends OutputParser {
  constructor(options = {}) {
    super(null);
    this.delimiter = options.delimiter || '\n';
    this.minItems = options.minItems || 0;
    this.maxItems = options.maxItems || Infinity;
  }

  parse(text) {
    if (!text || typeof text !== 'string') {
      throw new ParseError('Empty input', text);
    }

    // Remove common list prefixes and split
    const items = text
      .split(this.delimiter)
      .map(line => line.replace(/^[\s]*[-*•\d.)\]]+[\s]*/, '').trim())
      .filter(line => line.length > 0);

    if (items.length < this.minItems) {
      throw new ValidationError(`Expected at least ${this.minItems} items, got ${items.length}`, items);
    }

    if (items.length > this.maxItems) {
      return items.slice(0, this.maxItems);
    }

    return items;
  }

  getFormatInstructions() {
    return `Respond with a list of items, one per line. ${this.minItems > 0 ? `Provide at least ${this.minItems} items.` : ''}`;
  }
}

/**
 * Enum Output Parser - Validates against allowed values
 */
export class EnumOutputParser extends OutputParser {
  constructor(allowedValues, options = {}) {
    super(null);
    this.allowedValues = allowedValues;
    this.caseSensitive = options.caseSensitive !== false;
  }

  parse(text) {
    if (!text || typeof text !== 'string') {
      throw new ParseError('Empty input', text);
    }

    const value = text.trim();
    const normalizedValue = this.caseSensitive ? value : value.toLowerCase();
    const normalizedAllowed = this.caseSensitive
      ? this.allowedValues
      : this.allowedValues.map(v => v.toLowerCase());

    const index = normalizedAllowed.indexOf(normalizedValue);
    if (index === -1) {
      throw new ValidationError(
        `Value "${value}" not in allowed values: ${this.allowedValues.join(', ')}`,
        value
      );
    }

    return this.allowedValues[index];
  }

  getFormatInstructions() {
    return `Respond with exactly one of these values: ${this.allowedValues.join(', ')}`;
  }
}

/**
 * Regex Output Parser - Pattern-based extraction
 */
export class RegexOutputParser extends OutputParser {
  constructor(pattern, options = {}) {
    super(null);
    this.pattern = pattern instanceof RegExp ? pattern : new RegExp(pattern, options.flags || 'i');
    this.groupIndex = options.groupIndex || 0;
  }

  parse(text) {
    if (!text || typeof text !== 'string') {
      throw new ParseError('Empty input', text);
    }

    const match = text.match(this.pattern);
    if (!match) {
      throw new ParseError(`Pattern not found in response`, text);
    }

    return match[this.groupIndex] || match[0];
  }

  getFormatInstructions() {
    return `Respond in a format matching: ${this.pattern.source}`;
  }
}

/**
 * Combined Parser - Tries multiple parsers in order
 */
export class CombinedParser extends OutputParser {
  constructor(parsers) {
    super(null);
    this.parsers = parsers;
  }

  parse(text) {
    const errors = [];

    for (const parser of this.parsers) {
      try {
        return parser.parse(text);
      } catch (error) {
        errors.push(error.message);
      }
    }

    throw new ParseError(`All parsers failed: ${errors.join('; ')}`, text);
  }

  getFormatInstructions() {
    return this.parsers[0]?.getFormatInstructions() || 'Respond with valid data.';
  }
}

/**
 * Custom error classes
 */
export class ParseError extends Error {
  constructor(message, rawInput) {
    super(message);
    this.name = 'ParseError';
    this.rawInput = rawInput;
  }
}

export class ValidationError extends Error {
  constructor(message, parsedValue, schemaErrors = null) {
    super(message);
    this.name = 'ValidationError';
    this.parsedValue = parsedValue;
    this.schemaErrors = schemaErrors;
  }
}

export default {
  OutputParser,
  JSONOutputParser,
  StructuredOutputParser,
  ListOutputParser,
  EnumOutputParser,
  RegexOutputParser,
  CombinedParser,
  ParseError,
  ValidationError
};
