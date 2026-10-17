import { logger } from "../../utils/logger.js";
import { escapeMarkdown } from "../../utils/markdown.js";
// canvas is a native addon; load it only when an image is actually rendered so the
// text helpers (charts, sparklines) work on a host where its binding is not built.

export class DashboardVisuals {
  constructor() {
    this.chartWidth = 800;
    this.chartHeight = 400;
    this.commands = [
      { command: 'createTextChart', description: 'Create a text-based chart', usage: 'createTextChart <data> <title>' },
      { command: 'zoomChart', description: 'Zoom into specific data points on the chart', usage: 'zoomChart <start> <end>' },
      { command: 'filterChartData', description: 'Filter chart data by criteria', usage: 'filterChartData <criteria>' },
      { command: 'exportChartAsImage', description: 'Export chart as an image', usage: 'exportChartAsImage <data> <title>' },
      { command: 'createSparkline', description: 'Create a sparkline from numeric data', usage: 'createSparkline <data> [options]' }
    ];
  }

  // Create text-based progress bar
  createProgressBar(percentage, width = 10) {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    const bar = "▰".repeat(filled) + "▱".repeat(empty);
    return `${bar} ${percentage.toFixed(1)}%`;
  }

  // Create text-based chart
  createTextChart(data, title) {
    let chart = `📊 *${escapeMarkdown(title)}*\\n\\n`;
    
    data.forEach(item => {
      const bar = this.createProgressBar(item.value, 20);
      chart += `${escapeMarkdown(item.label)}: ${bar}\\n`;
    });
    
    return chart;
  }

  /**
   * Zoom into specific data points on the chart
   * @param {Array} data - The chart data
   * @param {number} start - Start index for zoom
   * @param {number} end - End index for zoom
   * @returns {string} - The zoomed chart
   */
  zoomChart(data, start, end) {
    const zoomedData = data.slice(start, end);
    return this.createTextChart(zoomedData, `Zoomed Chart: ${start} to ${end}`);
  }

  /**
   * Filter chart data by criteria
   * @param {Array} data - The chart data
   * @param {Function} criteria - The filter criteria function
   * @returns {string} - The filtered chart
   */
  filterChartData(data, criteria) {
    const filteredData = data.filter(criteria);
    return this.createTextChart(filteredData, 'Filtered Chart');
  }

  // Get color emoji for percentage
  getColorEmoji(percentage) {
    if (percentage < 30) return "🟢";
    if (percentage < 60) return "🟡";
    if (percentage < 80) return "🟠";
    return "🔴";
  }

  // Format system metrics as text
  formatSystemMetrics(metrics) {
    const cpuEmoji = this.getColorEmoji(metrics.cpu);
    const memEmoji = this.getColorEmoji(metrics.memory);
    const diskEmoji = this.getColorEmoji(metrics.disk);
    
    return `*System Metrics*\\n\\n` +
      `${cpuEmoji} CPU: ${this.createProgressBar(metrics.cpu)}\\n` +
      `${memEmoji} Memory: ${this.createProgressBar(metrics.memory)}\\n` +
      `${diskEmoji} Disk: ${this.createProgressBar(metrics.disk)}\\n`;
  }

  /**
   * Export chart as an image
   * @param {Array} data - The chart data
   * @param {string} title - The chart title
   * @returns {Buffer} - The image buffer
   */
  async exportChartAsImage(data, title) {
    const { createCanvas } = await import('canvas');
    const canvas = createCanvas(this.chartWidth, this.chartHeight);
    const ctx = canvas.getContext('2d');

    // Set background color
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.chartWidth, this.chartHeight);

    // Set text properties
    ctx.fillStyle = '#000';
    ctx.font = '20px Arial';
    ctx.fillText(title, 50, 50);

    // Draw chart bars
    data.forEach((item, index) => {
      const barHeight = (item.value / 100) * (this.chartHeight - 100);
      ctx.fillStyle = '#007bff';
      ctx.fillRect(50 + index * 60, this.chartHeight - barHeight - 50, 40, barHeight);
      ctx.fillStyle = '#000';
      ctx.fillText(item.label, 50 + index * 60, this.chartHeight - 30);
    });

    return canvas.toBuffer();
  }

  /**
   * Create a sparkline from numeric data using Unicode block characters.
   * Maps values to a sequence of ▁▂▃▄▅▆▇█ based on min/max scaling.
   * @param {number[]} data - Array of numeric values
   * @param {Object} [options] - Optional configuration
   * @param {number} [options.width] - Desired number of characters (resamples if needed)
   * @param {number} [options.min] - Override minimum value for scaling
   * @param {number} [options.max] - Override maximum value for scaling
   * @returns {string} Sparkline string of block characters
   */
  createSparkline(data, options = {}) {
    if (!Array.isArray(data)) return '';
    // Non-numeric entries (null gaps, strings) would scale to NaN and render as
    // the text "undefined"; drop them.
    data = data.filter(v => typeof v === 'number' && Number.isFinite(v));
    if (data.length === 0) return '';

    const { width, min: overrideMin, max: overrideMax } = options || {};
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

    // Resample data if width is specified and smaller than data length
    let values = data;
    if (Number.isInteger(width) && width > 0 && width < data.length) {
      values = [];
      const bucketSize = data.length / width;
      for (let i = 0; i < width; i++) {
        const start = Math.floor(i * bucketSize);
        const end = Math.floor((i + 1) * bucketSize);
        const slice = data.slice(start, end);
        const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length;
        values.push(avg);
      }
    }

    // Determine min and max for scaling
    const min = Number.isFinite(overrideMin) ? overrideMin : values.reduce((a, b) => Math.min(a, b), Infinity);
    const max = Number.isFinite(overrideMax) ? overrideMax : values.reduce((a, b) => Math.max(a, b), -Infinity);
    const range = max - min;

    // Map each value to a block character
    return values.map(v => {
      if (range <= 0) {
        // All values equal – use middle block
        return blocks[3]; // ▄
      }
      // Scale to 0-1, then to index 0-7
      const scaled = (v - min) / range;
      const index = Math.min(blocks.length - 1, Math.max(0, Math.round(scaled * (blocks.length - 1))));
      return blocks[index];
    }).join('');
  }

  /**
   * Execute a command
   * @param {string} command - The command to execute
   * @param {Array} params - Parameters for the command
   * @returns {string|Buffer} - Result of the command execution
   */
  async execute(command, params) {
    switch (command) {
      case 'createTextChart':
        return this.createTextChart(params[0], params[1]);
      case 'zoomChart':
        return this.zoomChart(params[0], params[1], params[2]);
      case 'filterChartData':
        return this.filterChartData(params[0], params[1]);
      case 'exportChartAsImage':
        return await this.exportChartAsImage(params[0], params[1]);
      case 'createSparkline':
        return this.createSparkline(params[0], params[1] || {});
      default:
        logger.warn(`Unknown command: ${command}`);
        return 'Unknown command';
    }
  }
}
