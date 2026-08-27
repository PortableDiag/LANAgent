/**
 * Utility functions for handling Markdown text
 */

/**
 * Escape special markdown characters for Telegram and other Markdown parsers
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
export function escapeMarkdown(text) {
  if (!text) return '';
  // Escape characters that can break Telegram markdown (single regex for performance)
  return String(text).replace(/([*_\[\]()~`>#\+=|{}!])/g, '\\$1');
}

/**
 * Escape only the most critical markdown characters (less aggressive)
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
export function escapeMarkdownLite(text) {
  if (!text) return '';
  // Only escape the most problematic characters (single regex for performance)
  return String(text).replace(/([*_`\[\]])/g, '\\$1');
}

/**
 * Truncate text and add ellipsis if needed
 * @param {string} text - The text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} - The truncated text
 */
export function truncateText(text, maxLength = 200) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Format code block for Markdown
 * @param {string} code - The code to format
 * @param {string} language - The language for syntax highlighting
 * @returns {string} - The formatted code block
 */
export function formatCodeBlock(code, language = '') {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Add support for custom Markdown syntax extensions
 * @param {string} text - The text to process
 * @param {Array} extensions - Array of custom syntax extensions with pattern and replacement
 * @returns {string} - The processed text with custom syntax applied
 */
export function applyCustomMarkdownExtensions(text, extensions = []) {
  if (!text || !Array.isArray(extensions)) return text;

  let processedText = text;
  extensions.forEach(extension => {
    if (extension.pattern && extension.replacement) {
      processedText = processedText.replace(new RegExp(extension.pattern, 'g'), extension.replacement);
    }
  });

  return processedText;
}

/**
 * Format a 2D array of strings into a Markdown table with advanced features
 * @param {string[][]} tableData - The 2D array of strings representing the table
 * @param {Object} options - Formatting options
 * @param {string[]} options.alignments - Array of column alignments ('left', 'center', 'right')
 * @param {Function[]} options.cellFormatters - Array of functions to format cells by column
 * @returns {string} - The formatted Markdown table
 */
export function formatTable(tableData, options = {}) {
  if (!Array.isArray(tableData) || tableData.length === 0) return '';

  const { alignments = [], cellFormatters = [] } = options;

  // Apply cell formatters if provided
  const formattedData = tableData.map((row, rowIndex) => 
    row.map((cell, colIndex) => {
      if (cellFormatters[colIndex]) {
        return cellFormatters[colIndex](cell, rowIndex, colIndex);
      }
      return String(cell);
    })
  );

  // Calculate column widths based on formatted data
  const columnWidths = formattedData[0].map((_, colIndex) => 
    Math.max(...formattedData.map(row => row[colIndex].length))
  );

  // Create alignment markers
  const getAlignmentMarker = (alignment, width) => {
    switch (alignment) {
      case 'center':
        return ':' + '-'.repeat(Math.max(0, width - 2)) + ':';
      case 'right':
        return '-'.repeat(Math.max(0, width - 1)) + ':';
      case 'left':
      default:
        return '-'.repeat(width);
    }
  };

  const formatRow = (row) => 
    '| ' + row.map((cell, colIndex) => {
      const width = columnWidths[colIndex];
      const alignment = alignments[colIndex] || 'left';
      
      switch (alignment) {
        case 'center':
          const padTotal = width - cell.length;
          const padLeft = Math.floor(padTotal / 2);
          const padRight = padTotal - padLeft;
          return ' '.repeat(padLeft) + cell + ' '.repeat(padRight);
        case 'right':
          return cell.padStart(width);
        case 'left':
        default:
          return cell.padEnd(width);
      }
    }).join(' | ') + ' |';

  const headerSeparator = '| ' + columnWidths.map((width, index) => 
    getAlignmentMarker(alignments[index] || 'left', width)
  ).join(' | ') + ' |';

  const [header, ...rows] = formattedData;
  return [
    formatRow(header),
    headerSeparator,
    ...rows.map(formatRow)
  ].join('\n');
}

// Frontmatter delimiters: YAML uses ---, TOML uses +++. Both must sit alone on
// their own line, which is what separates a real frontmatter block from a
// document that merely opens with a horizontal rule.
const FRONTMATTER_RE = /^﻿?\s*(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)/;

/**
 * Coerce a scalar frontmatter value.
 *
 * Deliberately small. This is NOT a YAML parser and does not pretend to be:
 * no nesting, no block scalars, no anchors, no multi-line strings. Frontmatter
 * in this project is flat key/value, and a partial parser that silently
 * mishandles the hard cases is worse than one with a stated boundary.
 */
function coerceScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';

  // Quoted: take it literally, quotes stripped, no further coercion. "true"
  // stays the string "true" — the author quoted it for a reason.
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
    return v.slice(1, -1);
  }

  // Inline array: [a, b, "c"]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(part => coerceScalar(part));
  }

  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;

  // Numbers, but only when the whole token is one. Guarded against the classic
  // trap: Number('') is 0, and a bare '-' or '.' would slip through a looser
  // test, so an explicit shape check comes first.
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }

  return v;
}

/**
 * Check if the text opens with a frontmatter block.
 * @param {string} text
 * @returns {boolean}
 */
export function hasFrontmatter(text) {
  if (typeof text !== 'string') return false;
  return FRONTMATTER_RE.test(text);
}

/**
 * Remove the frontmatter block, returning the document body.
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  if (typeof text !== 'string') return '';
  const match = text.match(FRONTMATTER_RE);
  if (!match) return text;
  return text.slice(match[0].length);
}

/**
 * Parse a frontmatter block into an object.
 *
 * Returns {} when there is no frontmatter, and never throws — callers treat a
 * document without metadata as ordinary, not as an error.
 *
 * @param {string} text
 * @returns {Object}
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  const match = text.match(FRONTMATTER_RE);
  if (!match) return {};

  const out = {};
  for (const line of match[2].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;   // blank or comment
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;                               // no key, or no separator
    const key = trimmed.slice(0, sep).trim();
    if (!key) continue;
    // Values may contain colons (URLs, timestamps) — only the first splits.
    out[key] = coerceScalar(trimmed.slice(sep + 1));
  }
  return out;
}

/**
 * Extract common metadata fields from a document's frontmatter.
 *
 * Every key present in the frontmatter is preserved; title/tags/date are only
 * normalised so callers can rely on their types.
 *
 * @param {string} text
 * @returns {{title: string, tags: string[], date: string}}
 */
export function extractMetadata(text) {
  const frontmatter = parseFrontmatter(text);

  // tags may be written as an inline array or as a comma-separated string.
  // Normalising here means a caller never has to check which it got.
  let tags = frontmatter.tags;
  if (typeof tags === 'string') {
    tags = tags.split(',').map(t => t.trim()).filter(Boolean);
  } else if (!Array.isArray(tags)) {
    tags = tags === undefined || tags === null ? [] : [tags];
  }

  return {
    ...frontmatter,
    title: frontmatter.title === undefined || frontmatter.title === null ? '' : String(frontmatter.title),
    tags: tags.map(t => String(t)),
    date: frontmatter.date === undefined || frontmatter.date === null ? '' : String(frontmatter.date)
  };
}

export default {
  escapeMarkdown,
  escapeMarkdownLite,
  truncateText,
  formatCodeBlock,
  applyCustomMarkdownExtensions,
  formatTable,
  hasFrontmatter,
  stripFrontmatter,
  parseFrontmatter,
  extractMetadata
};
