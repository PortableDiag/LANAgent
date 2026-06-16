import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { logger } from '../utils/logger.js';

/**
 * Base OutputParser class for extracting and validating structured data from LLM responses
 */
export class OutputParser {
  constructor(schema = null) {
    this.schema = schema;
    this.ajv = new Ajv({ allErrors: true, coerceTypes: true });
    addFormats(this.ajv);
    this.validator = null; // Lazy: compile on first parse
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
      throw new ParseError(`Invalid JSON: ${error.message}`, text);
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
