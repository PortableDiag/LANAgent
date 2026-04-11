import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { EventEmitter } from 'events';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const healthTrendCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5-min TTL

const diagnosticReportSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  triggeredBy: {
    type: String,
    enum: ['manual', 'scheduled', 'self', 'error-triggered'],
    default: 'manual'
  },
  requestedBy: {
    type: String,
    default: 'system'
  },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running'
  },
  overallHealth: {
    type: String,
    enum: ['healthy', 'warning', 'critical', 'unknown'],
    default: 'unknown'
  },
  summary: {
    type: String,
    default: ''
  },
  tests: [{
    name: String,
    category: String,
    status: {
      type: String,
      enum: ['passed', 'failed', 'warning', 'skipped']
    },
    duration: Number, // milliseconds
    message: String,
    details: mongoose.Schema.Types.Mixed
  }],
  systemInfo: {
    cpuUsage: Number,
    memoryUsage: {
      total: Number,
      used: Number,
      percentage: Number
    },
    diskUsage: [{
      filesystem: String,
      size: String,
      used: String,
      available: String,
      percentage: Number
    }],
    uptime: Number,
    loadAverage: [Number],
    nodeVersion: String,
    platform: String
  },
  serviceStatus: {
    telegram: {
      connected: Boolean,
      lastActivity: Date,
      errors: [String]
    },
    mongodb: {
      connected: Boolean,
      collections: Number,
      errors: [String]
    },
    scheduler: {
      running: Boolean,
      jobsCount: Number,
      errors: [String]
    },
    plugins: [{
      name: String,
      enabled: Boolean,
      healthy: Boolean,
      errors: [String]
    }]
  },
  autonomousServices: {
    selfModification: {
      enabled: Boolean,
      lastRun: Date,
      currentBranch: String,
      dailyCount: Number
    },
    pluginDevelopment: {
      enabled: Boolean,
      lastRun: Date,
      todayCount: Number,
      totalCount: Number
    },
    bugFixing: {
      enabled: Boolean,
      lastRun: Date,
      issuesAnalyzed: Number,
      prsCreated: Number
    }
  },
  issues: [{
    severity: {
      type: String,
      enum: ['critical', 'warning', 'info']
    },
    category: String,
    message: String,
    recommendation: String,
    timestamp: Date
  }],
  recommendations: [String],
  duration: Number, // Total test duration in milliseconds
  completedAt: Date
});

// Indexes for efficient querying
diagnosticReportSchema.index({ overallHealth: 1, timestamp: -1 });
diagnosticReportSchema.index({ 'issues.severity': 1 });

// Methods
diagnosticReportSchema.methods.addTest = function(test) {
  this.tests.push(test);
  return this.save();
};

diagnosticReportSchema.methods.complete = function(overallHealth, summary) {
  this.status = 'completed';
  this.overallHealth = overallHealth;
  this.summary = summary;
  this.completedAt = new Date();
  this.duration = this.completedAt - this.timestamp;
  return this.save();
};

diagnosticReportSchema.methods.fail = function(error) {
  this.status = 'failed';
  this.summary = `Diagnostic failed: ${error}`;
  this.completedAt = new Date();
  this.duration = this.completedAt - this.timestamp;
  return retryOperation(() => this.save(), { retries: 3, context: 'DiagnosticReport.fail' });
};

// Statics
diagnosticReportSchema.statics.getLatest = function() {
  return this.findOne().sort({ timestamp: -1 });
};

diagnosticReportSchema.statics.getHealthTrend = async function(days = 7) {
  const cacheKey = `healthTrend_${days}`;
  const cached = healthTrendCache.get(cacheKey);
  if (cached) return cached;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const result = await retryOperation(() => this.aggregate([
    {
      $match: {
        timestamp: { $gte: startDate },
        status: 'completed'
      }
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$timestamp' }
        },
        healthCounts: {
          $push: '$overallHealth'
        },
        avgDuration: { $avg: '$duration' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { _id: 1 }
    }
  ]), { retries: 3, context: 'DiagnosticReport.getHealthTrend' });

  healthTrendCache.set(cacheKey, result);
  return result;
};

// Event emitter for real-time monitoring
const reportEventEmitter = new EventEmitter();

// Monitoring configuration
const monitoringConfig = {
  enabled: process.env.DIAGNOSTIC_MONITORING_ENABLED !== 'false',
  alertThreshold: process.env.DIAGNOSTIC_ALERT_THRESHOLD || 'critical',
  emailConfig: {
    enabled: process.env.DIAGNOSTIC_EMAIL_ALERTS === 'true',
    smtp: {
      service: process.env.SMTP_SERVICE,
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    },
    from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
    to: process.env.ALERT_TO_EMAIL,
    cc: process.env.ALERT_CC_EMAIL
  }
};

// Update methods to emit events
const originalComplete = diagnosticReportSchema.methods.complete;
diagnosticReportSchema.methods.complete = function(overallHealth, summary) {
  const result = originalComplete.call(this, overallHealth, summary);
  if (monitoringConfig.enabled) {
    reportEventEmitter.emit('statusChange', this);
  }
  return result;
};

const originalFail = diagnosticReportSchema.methods.fail;
diagnosticReportSchema.methods.fail = function(error) {
  const result = originalFail.call(this, error);
  if (monitoringConfig.enabled) {
    reportEventEmitter.emit('statusChange', this);
  }
  return result;
};

// Real-time monitoring handler
if (monitoringConfig.enabled) {
  reportEventEmitter.on('statusChange', async (report) => {
    try {
      const shouldAlert = shouldSendAlert(report.overallHealth, monitoringConfig.alertThreshold);
      
      if (shouldAlert && monitoringConfig.emailConfig.enabled) {
        await sendAlertEmail(report);
      }
      
      // Log significant events
      if (report.overallHealth === 'critical') {
        logger.error(`Critical system health detected: ${report.summary}`);
      } else if (report.overallHealth === 'warning') {
        logger.warn(`System health warning: ${report.summary}`);
      }
    } catch (error) {
      logger.error('Failed to process diagnostic report event:', error);
    }
  });
}

/**
 * Determine if an alert should be sent based on health status and threshold
 * @param {string} health - Current health status
 * @param {string} threshold - Alert threshold
 * @returns {boolean}
 */
function shouldSendAlert(health, threshold) {
  const levels = { healthy: 0, warning: 1, critical: 2 };
  const healthLevel = levels[health] || 0;
  const thresholdLevel = levels[threshold] || 2;
  return healthLevel >= thresholdLevel;
}

/**
 * Send alert email for diagnostic report
 * @param {Object} report - Diagnostic report
 */
async function sendAlertEmail(report) {
  const { emailConfig } = monitoringConfig;
  
  if (!emailConfig.to) {
    logger.warn('Alert email recipient not configured (ALERT_TO_EMAIL)');
    return;
  }
  
  if (!emailConfig.smtp.auth.user || !emailConfig.smtp.auth.pass) {
    logger.warn('SMTP credentials not configured');
    return;
  }
  
  try {
    // Create transporter with flexible configuration
    const transportConfig = emailConfig.smtp.service 
      ? { service: emailConfig.smtp.service, auth: emailConfig.smtp.auth }
      : {
          host: emailConfig.smtp.host,
          port: emailConfig.smtp.port,
          secure: emailConfig.smtp.secure,
          auth: emailConfig.smtp.auth
        };
    
    const transporter = nodemailer.createTransport(transportConfig);
    
    // Format the report for email
    const issuesList = report.issues
      ?.filter(i => i.severity === 'high' || i.severity === 'critical')
      .map(i => `- ${i.description} (${i.severity})`)
      .join('\\n');
    
    const failedTests = report.tests
      ?.filter(t => t.status === 'failed')
      .map(t => `- ${t.name}: ${t.message}`)
      .join('\\n');
    
    const mailOptions = {
      from: emailConfig.from,
      to: emailConfig.to,
      cc: emailConfig.cc,
      subject: `[LANAgent Alert] ${report.overallHealth.toUpperCase()} - System Health Report`,
      text: `System Health Alert

Status: ${report.overallHealth.toUpperCase()}
Time: ${new Date(report.timestamp).toLocaleString()}
Triggered By: ${report.triggeredBy}

Summary:
${report.summary}

${issuesList ? `\\nCritical Issues:\\n${issuesList}` : ''}
${failedTests ? `\\nFailed Tests:\\n${failedTests}` : ''}

System Info:
- CPU Usage: ${report.systemInfo?.cpuUsage?.toFixed(1)}%
- Memory Usage: ${report.systemInfo?.memoryUsage?.percentage?.toFixed(1)}%
- Uptime: ${Math.floor((report.systemInfo?.uptime || 0) / 3600)}h

View full report in the LANAgent dashboard.`,
      html: `
        <h2>System Health Alert</h2>
        <p><strong>Status:</strong> <span style="color: ${report.overallHealth === 'critical' ? 'red' : 'orange'}">${report.overallHealth.toUpperCase()}</span></p>
        <p><strong>Time:</strong> ${new Date(report.timestamp).toLocaleString()}</p>
        <p><strong>Triggered By:</strong> ${report.triggeredBy}</p>
        
        <h3>Summary</h3>
        <p>${report.summary}</p>
        
        ${issuesList ? `<h3>Critical Issues</h3><ul>${issuesList.split('\\n').map(i => `<li>${i.substring(2)}</li>`).join('')}</ul>` : ''}
        ${failedTests ? `<h3>Failed Tests</h3><ul>${failedTests.split('\\n').map(t => `<li>${t.substring(2)}</li>`).join('')}</ul>` : ''}
        
        <h3>System Info</h3>
        <ul>
          <li>CPU Usage: ${report.systemInfo?.cpuUsage?.toFixed(1)}%</li>
          <li>Memory Usage: ${report.systemInfo?.memoryUsage?.percentage?.toFixed(1)}%</li>
          <li>Uptime: ${Math.floor((report.systemInfo?.uptime || 0) / 3600)}h</li>
        </ul>
        
        <p><em>View full report in the LANAgent dashboard.</em></p>
      `
    };
    
    await transporter.sendMail(mailOptions);
    logger.info(`Alert email sent for ${report.overallHealth} health status`);
  } catch (error) {
    logger.error('Failed to send alert email:', error);
  }
}

// Export the model
const DiagnosticReport = mongoose.model('DiagnosticReport', diagnosticReportSchema);

// Also export utilities for external use
export { reportEventEmitter, monitoringConfig };
export default DiagnosticReport;