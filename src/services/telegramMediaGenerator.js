import { createCanvas } from 'canvas';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';

/**
 * Telegram Media Generator Service
 * Generates dynamic charts, progress bars, and rich media for Telegram interface
 */
export class TelegramMediaGenerator {
  constructor(agent) {
    this.agent = agent;
    this.tempDir = '/tmp/lanagent-media';
    this.config = {
      chartSize: { width: 800, height: 600 },
      progressBarSize: { width: 400, height: 100 },
      colors: {
        primary: '#3498db',
        secondary: '#2ecc71',
        warning: '#f39c12',
        danger: '#e74c3c',
        dark: '#2c3e50',
        light: '#ecf0f1',
        success: '#27ae60'
      },
      fonts: {
        title: '20px Arial',
        label: '14px Arial',
        text: '12px Arial'
      }
    };
  }

  async initialize() {
    try {
      // Ensure temp directory exists
      await fs.mkdir(this.tempDir, { recursive: true });
      logger.info('Telegram Media Generator initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram Media Generator:', error);
      return false;
    }
  }

  /**
   * Generate system health chart
   */
  async generateSystemHealthChart(systemStats) {
    try {
      const canvas = createCanvas(this.config.chartSize.width, this.config.chartSize.height);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = this.config.colors.dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Title
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.title;
      ctx.textAlign = 'center';
      ctx.fillText('System Health Overview', canvas.width / 2, 40);

      // Chart area
      const chartArea = {
        x: 100,
        y: 80,
        width: canvas.width - 200,
        height: canvas.height - 160
      };

      // Draw CPU usage bar
      this.drawMetricBar(ctx, chartArea, 'CPU Usage', systemStats.cpu, 0, this.config.colors.primary);
      
      // Draw Memory usage bar  
      this.drawMetricBar(ctx, chartArea, 'Memory Usage', systemStats.memory, 1, this.config.colors.secondary);
      
      // Draw Disk usage bar
      this.drawMetricBar(ctx, chartArea, 'Disk Usage', systemStats.disk, 2, this.config.colors.warning);

      // Add timestamp
      ctx.font = this.config.fonts.text;
      ctx.fillStyle = this.config.colors.light;
      ctx.textAlign = 'right';
      ctx.fillText(`Generated: ${new Date().toLocaleString()}`, canvas.width - 20, canvas.height - 20);

      // Save to file
      const filename = `system-health-${Date.now()}.png`;
      const filepath = path.join(this.tempDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        filename,
        cleanup: () => this.cleanupFile(filepath)
      };
    } catch (error) {
      logger.error('Failed to generate system health chart:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate process usage pie chart
   */
  async generateProcessPieChart(processes) {
    try {
      const canvas = createCanvas(this.config.chartSize.width, this.config.chartSize.height);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = this.config.colors.dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Title
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.title;
      ctx.textAlign = 'center';
      ctx.fillText('Top Processes by CPU Usage', canvas.width / 2, 40);

      // Prepare data (top 5 processes)
      const topProcesses = processes.slice(0, 5);
      const totalCpu = topProcesses.reduce((sum, p) => sum + p.cpu, 0);
      
      if (totalCpu === 0) {
        ctx.fillStyle = this.config.colors.light;
        ctx.font = this.config.fonts.label;
        ctx.fillText('No significant CPU usage', canvas.width / 2, canvas.height / 2);
      } else {
        // Draw pie chart
        const centerX = canvas.width / 2 - 100;
        const centerY = canvas.height / 2;
        const radius = 120;
        
        const colors = [
          this.config.colors.primary,
          this.config.colors.secondary, 
          this.config.colors.warning,
          this.config.colors.danger,
          this.config.colors.success
        ];

        let currentAngle = -Math.PI / 2;

        topProcesses.forEach((process, index) => {
          const sliceAngle = (process.cpu / totalCpu) * 2 * Math.PI;
          
          // Draw slice
          ctx.beginPath();
          ctx.moveTo(centerX, centerY);
          ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle);
          ctx.closePath();
          ctx.fillStyle = colors[index % colors.length];
          ctx.fill();

          // Draw label
          const labelAngle = currentAngle + sliceAngle / 2;
          const labelX = centerX + Math.cos(labelAngle) * (radius + 30);
          const labelY = centerY + Math.sin(labelAngle) * (radius + 30);
          
          ctx.fillStyle = this.config.colors.light;
          ctx.font = this.config.fonts.text;
          ctx.textAlign = 'center';
          ctx.fillText(`${process.command.substring(0, 15)}`, labelX, labelY);
          ctx.fillText(`${process.cpu.toFixed(1)}%`, labelX, labelY + 15);

          currentAngle += sliceAngle;
        });

        // Draw legend
        let legendY = 100;
        topProcesses.forEach((process, index) => {
          ctx.fillStyle = colors[index % colors.length];
          ctx.fillRect(canvas.width - 180, legendY, 15, 15);
          
          ctx.fillStyle = this.config.colors.light;
          ctx.font = this.config.fonts.text;
          ctx.textAlign = 'left';
          ctx.fillText(`${process.command.substring(0, 20)} (${process.cpu.toFixed(1)}%)`, 
                      canvas.width - 160, legendY + 12);
          legendY += 25;
        });
      }

      // Save to file
      const filename = `process-chart-${Date.now()}.png`;
      const filepath = path.join(this.tempDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        filename,
        cleanup: () => this.cleanupFile(filepath)
      };
    } catch (error) {
      logger.error('Failed to generate process pie chart:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate progress bar image
   */
  async generateProgressBar(title, progress, options = {}) {
    try {
      const {
        subtitle = '',
        showPercent = true,
        color = this.config.colors.primary,
        backgroundColor = this.config.colors.dark
      } = options;

      const canvas = createCanvas(this.config.progressBarSize.width, this.config.progressBarSize.height);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Title
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.label;
      ctx.textAlign = 'center';
      ctx.fillText(title, canvas.width / 2, 25);

      if (subtitle) {
        ctx.font = this.config.fonts.text;
        ctx.fillText(subtitle, canvas.width / 2, 45);
      }

      // Progress bar background
      const barY = 55;
      const barHeight = 20;
      const barPadding = 20;
      const barWidth = canvas.width - (barPadding * 2);

      ctx.fillStyle = this.config.colors.light;
      ctx.fillRect(barPadding, barY, barWidth, barHeight);

      // Progress fill
      const fillWidth = (progress / 100) * barWidth;
      ctx.fillStyle = color;
      ctx.fillRect(barPadding, barY, fillWidth, barHeight);

      // Progress text
      if (showPercent) {
        ctx.fillStyle = this.config.colors.dark;
        ctx.font = this.config.fonts.text;
        ctx.textAlign = 'center';
        ctx.fillText(`${progress.toFixed(1)}%`, canvas.width / 2, barY + 14);
      }

      // Save to file
      const filename = `progress-${Date.now()}.png`;
      const filepath = path.join(this.tempDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        filename,
        cleanup: () => this.cleanupFile(filepath)
      };
    } catch (error) {
      logger.error('Failed to generate progress bar:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate AI usage analytics chart
   */
  async generateAIUsageChart(usageData) {
    try {
      const canvas = createCanvas(this.config.chartSize.width, this.config.chartSize.height);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = this.config.colors.dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Title
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.title;
      ctx.textAlign = 'center';
      ctx.fillText('AI Provider Usage Analytics', canvas.width / 2, 40);

      // Chart area
      const chartArea = {
        x: 80,
        y: 80,
        width: canvas.width - 160,
        height: canvas.height - 160
      };

      if (!usageData || usageData.length === 0) {
        ctx.fillStyle = this.config.colors.light;
        ctx.font = this.config.fonts.label;
        ctx.fillText('No usage data available', canvas.width / 2, canvas.height / 2);
      } else {
        // Draw bar chart
        const barWidth = chartArea.width / usageData.length - 10;
        const maxUsage = Math.max(...usageData.map(d => d.tokens));

        usageData.forEach((provider, index) => {
          const barHeight = (provider.tokens / maxUsage) * chartArea.height * 0.8;
          const x = chartArea.x + (index * (barWidth + 10));
          const y = chartArea.y + chartArea.height - barHeight;

          // Draw bar
          ctx.fillStyle = this.config.colors.primary;
          ctx.fillRect(x, y, barWidth, barHeight);

          // Draw provider name
          ctx.fillStyle = this.config.colors.light;
          ctx.font = this.config.fonts.text;
          ctx.textAlign = 'center';
          ctx.save();
          ctx.translate(x + barWidth / 2, chartArea.y + chartArea.height + 20);
          ctx.rotate(-Math.PI / 4);
          ctx.fillText(provider.name, 0, 0);
          ctx.restore();

          // Draw value
          ctx.fillStyle = this.config.colors.light;
          ctx.font = this.config.fonts.text;
          ctx.textAlign = 'center';
          ctx.fillText(provider.tokens.toLocaleString(), x + barWidth / 2, y - 5);
        });
      }

      // Save to file
      const filename = `ai-usage-${Date.now()}.png`;
      const filepath = path.join(this.tempDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        filename,
        cleanup: () => this.cleanupFile(filepath)
      };
    } catch (error) {
      logger.error('Failed to generate AI usage chart:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate installation/update progress visualization
   */
  async generateInstallProgressChart(steps, currentStep) {
    try {
      const canvas = createCanvas(this.config.chartSize.width, 300);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = this.config.colors.dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Title
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.title;
      ctx.textAlign = 'center';
      ctx.fillText('Installation Progress', canvas.width / 2, 40);

      // Step visualization
      const stepWidth = (canvas.width - 100) / steps.length;
      const stepY = 100;
      
      steps.forEach((step, index) => {
        const x = 50 + (index * stepWidth);
        const isComplete = index < currentStep;
        const isCurrent = index === currentStep;
        
        // Draw step circle
        ctx.beginPath();
        ctx.arc(x + stepWidth / 2, stepY, 15, 0, 2 * Math.PI);
        ctx.fillStyle = isComplete ? this.config.colors.success :
                       isCurrent ? this.config.colors.warning :
                       this.config.colors.light;
        ctx.fill();

        // Draw step number
        ctx.fillStyle = this.config.colors.dark;
        ctx.font = this.config.fonts.text;
        ctx.textAlign = 'center';
        ctx.fillText((index + 1).toString(), x + stepWidth / 2, stepY + 5);

        // Draw step name
        ctx.fillStyle = this.config.colors.light;
        ctx.font = this.config.fonts.text;
        ctx.textAlign = 'center';
        ctx.fillText(step, x + stepWidth / 2, stepY + 40);

        // Draw connection line
        if (index < steps.length - 1) {
          ctx.strokeStyle = isComplete ? this.config.colors.success : this.config.colors.light;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + stepWidth / 2 + 15, stepY);
          ctx.lineTo(x + stepWidth + stepWidth / 2 - 15, stepY);
          ctx.stroke();
        }
      });

      // Current step details
      if (currentStep < steps.length) {
        ctx.fillStyle = this.config.colors.warning;
        ctx.font = this.config.fonts.label;
        ctx.textAlign = 'center';
        ctx.fillText(`Currently: ${steps[currentStep]}`, canvas.width / 2, 200);
      }

      // Progress percentage
      const progress = ((currentStep + 1) / steps.length) * 100;
      ctx.fillStyle = this.config.colors.light;
      ctx.font = this.config.fonts.label;
      ctx.textAlign = 'center';
      ctx.fillText(`${progress.toFixed(0)}% Complete`, canvas.width / 2, 230);

      // Save to file
      const filename = `install-progress-${Date.now()}.png`;
      const filepath = path.join(this.tempDir, filename);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        filename,
        cleanup: () => this.cleanupFile(filepath)
      };
    } catch (error) {
      logger.error('Failed to generate install progress chart:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Helper method to draw metric bars
   */
  drawMetricBar(ctx, chartArea, label, value, index, color) {
    const barHeight = 40;
    const barSpacing = 60;
    const y = chartArea.y + (index * barSpacing);
    
    // Label
    ctx.fillStyle = this.config.colors.light;
    ctx.font = this.config.fonts.label;
    ctx.textAlign = 'left';
    ctx.fillText(label, chartArea.x, y + 20);

    // Bar background
    ctx.fillStyle = this.config.colors.light;
    ctx.fillRect(chartArea.x + 120, y, chartArea.width - 120, barHeight);

    // Bar fill
    const fillWidth = ((value / 100) * (chartArea.width - 120));
    ctx.fillStyle = color;
    ctx.fillRect(chartArea.x + 120, y, fillWidth, barHeight);

    // Value text
    ctx.fillStyle = this.config.colors.dark;
    ctx.font = this.config.fonts.text;
    ctx.textAlign = 'center';
    ctx.fillText(`${value}%`, chartArea.x + 120 + (chartArea.width - 120) / 2, y + 25);
  }

  /**
   * Cleanup temporary file
   */
  async cleanupFile(filepath) {
    try {
      await fs.unlink(filepath);
    } catch (error) {
      logger.warn(`Failed to cleanup temp file ${filepath}:`, error.message);
    }
  }

  /**
   * Cleanup all old temporary files
   */
  async cleanupOldFiles() {
    try {
      const files = await fs.readdir(this.tempDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      for (const file of files) {
        const filepath = path.join(this.tempDir, file);
        const stats = await fs.stat(filepath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          await this.cleanupFile(filepath);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old temp files:', error);
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      name: 'TelegramMediaGenerator',
      tempDirectory: this.tempDir,
      config: this.config,
      capabilities: [
        'System health charts',
        'Process usage pie charts', 
        'Progress bars and indicators',
        'AI usage analytics',
        'Installation progress visualization',
        'Automatic temporary file cleanup'
      ]
    };
  }
}

export default TelegramMediaGenerator;