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

export default {
  escapeMarkdown,
  escapeMarkdownLite,
  truncateText,
  formatCodeBlock,
  applyCustomMarkdownExtensions,
  formatTable
};
