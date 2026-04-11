import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import RuntimeError from '../models/RuntimeError.js';
import { LOGS_PATH } from '../utils/paths.js';

/**
 * Service for scanning and tracking runtime errors from log files
 */
export class ErrorLogScanner extends EventEmitter {
  constructor() {
    super();
    this.agent = null; // Will be set by agent.js
    this.startupTime = new Date();
    this.scanInterval = 60000; // 1 minute
    this.isScanning = false;
    this.lastScanPosition = {};
    this.config = {
      createGitHubIssues: true,
      githubIssueSeverities: ['critical'], // Only create issues for critical errors
      maxIssuesPerHour: 5,
      ignorePatterns: []
    };
    this.githubIssuesCreatedThisHour = [];
    this.errorPatterns = [
      // Standard error patterns
      /\[ERROR\]/i,
      /\[ERR\]/i,
      /\bError:/i,
      /\bException:/i,
      /\bFATAL\b/i,
      /\bfailed to\b/i,  // More specific than just "failed"
      /\bcrash/i,
      /\bunable to\b/i,
      /\bcannot\b/i,
      /undefined is not/i,
      /null is not/i,
      /TypeError:/i,
      /ReferenceError:/i,
      /SyntaxError:/i,
      /MongoError:/i,
      /ValidationError:/i,
      // Custom patterns for LANAgent
      /Plugin.*\bfailed\b/i,  // Word boundary to avoid matching "Failed to load"
      /Service.*\berror\b/i,
      /API.*\berror\b/i,
      /Authentication.*\bfailed\b/i
    ];
  }

  /**
   * Set the agent reference
   */
  setAgent(agent) {
    this.agent = agent;
  }

  /**
   * Initialize the error log scanner
   */
  async initialize() {
    try {
      logger.info('[ErrorLogScanner] Initializing runtime error scanner', {
        service: 'error-scanner',
        startupTime: this.startupTime
      });

      // Load last scan positions
      await this.loadScanPositions();

      // Start periodic scanning
      this.startScanning();

      logger.info('[ErrorLogScanner] Runtime error scanner initialized successfully', {
        service: 'error-scanner'
      });
    } catch (error) {
      logger.error('[ErrorLogScanner] Failed to initialize:', error, {
        service: 'error-scanner'
      });
      throw error;
    }
  }

  /**
   * Load saved scan positions from database
   */
  async loadScanPositions() {
    try {
      const savedPositions = await RuntimeError.findOne({ 
        fingerprint: 'scan_position_tracker' 
      });

      if (savedPositions && savedPositions.data) {
        this.lastScanPosition = savedPositions.data;
        logger.info('[ErrorLogScanner] Loaded scan positions from database', {
          positions: Object.keys(this.lastScanPosition).length,
          lastUpdated: savedPositions.updatedAt
        });
      } else {
        logger.info('[ErrorLogScanner] No saved scan positions found, starting fresh');
      }
    } catch (error) {
      logger.warn('[ErrorLogScanner] Could not load scan positions:', error.message);
    }
  }

  /**
   * Save current scan positions to database
   */
  async saveScanPositions() {
    try {
      logger.debug('[ErrorLogScanner] Attempting to save scan positions...', {
        positionCount: Object.keys(this.lastScanPosition).length
      });
      
      // Create a document that satisfies the RuntimeError schema
      const now = new Date();
      const scanPositionDoc = {
        type: 'scan_position',
        fingerprint: 'scan_position_tracker', // Unique fingerprint for scan position
        message: 'Scan position tracker document',
        file: 'system',
        timestamp: now,
        firstSeen: now,
        lastSeen: now,
        data: this.lastScanPosition,
        status: 'acknowledged', // Not a real error
        source: 'log_scanner',
        severity: 'low', // Add required severity field
        occurrences: 1
      };
      
      logger.debug('[ErrorLogScanner] Scan position document prepared:', {
        fingerprint: scanPositionDoc.fingerprint,
        dataKeys: Object.keys(scanPositionDoc.data || {})
      });
      
      const result = await RuntimeError.findOneAndUpdate(
        { fingerprint: 'scan_position_tracker' },
        scanPositionDoc,
        { upsert: true, new: true, runValidators: true }
      );
      
      if (result) {
        logger.info('[ErrorLogScanner] Successfully saved scan positions to database', {
          id: result._id,
          updatedAt: result.updatedAt
        });
      } else {
        logger.warn('[ErrorLogScanner] Save operation returned no result');
      }
    } catch (error) {
      logger.error('[ErrorLogScanner] Failed to save scan positions:', error, {
        name: error.name,
        message: error.message,
        code: error.code,
        stack: error.stack
      });
      
      // If it's a validation error, log the details
      if (error.name === 'ValidationError') {
        logger.error('[ErrorLogScanner] Validation error details:', {
          errors: error.errors
        });
      }
    }
  }

  /**
   * Get list of log files to scan
   */
  getLogFiles() {
    const logDirs = [
      // Only scan deployed logs when in production
      process.cwd().includes('lanagent') ? 'logs' : null,
      LOGS_PATH,
      path.join(process.env.HOME || '/root', '.pm2/logs')
    ].filter(Boolean);

    const logFiles = [];

    for (const dir of logDirs) {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.endsWith('.log')) {
              logFiles.push(path.join(dir, file));
            }
          }
          logger.debug(`[ErrorLogScanner] Found ${files.filter(f => f.endsWith('.log')).length} log files in ${dir}`);
        } else {
          logger.debug(`[ErrorLogScanner] Directory does not exist: ${dir}`);
        }
      } catch (error) {
        logger.warn(`[ErrorLogScanner] Cannot access directory ${dir}:`, error.message);
      }
    }

    return logFiles;
  }

  /**
   * Generate fingerprint for an error
   */
  generateErrorFingerprint(errorData) {
    const { message, file, pattern } = errorData;
    // Remove line numbers and timestamps from message for better deduplication
    const cleanMessage = message
      .replace(/:\d+/g, '') // Remove line numbers
      .replace(/\d{4}-\d{2}-\d{2}T?\s?\d{2}:\d{2}:\d{2}/g, '') // Remove timestamps
      .replace(/backup-\d{4}-\d{2}-\d{2}T[\d-]+Z/g, 'backup-TIMESTAMP') // Normalize backup timestamps
      .replace(/\/root\/lanagent-deploy(-backups)?/g, 'DEPLOY_PATH') // Normalize deployment paths
      .substring(0, 150); // Increase to 150 for better uniqueness
    
    // Create fingerprint based only on the cleaned message and pattern
    // This ensures the same error in different log files gets the same fingerprint
    const fingerprintData = `${pattern}:${cleanMessage}`;
    return crypto.createHash('sha256').update(fingerprintData).digest('hex').substring(0, 16);
  }

  /**
   * Parse timestamp from log line
   */
  parseTimestamp(line) {
    // Common timestamp patterns
    const patterns = [
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,  // ISO format
      /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,   // Standard format
      /(\d{2}:\d{2}:\d{2})/                       // Time only
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const timestamp = new Date(match[1]);
        if (!isNaN(timestamp.getTime())) {
          return timestamp;
        }
      }
    }

    return new Date(); // Default to current time if no timestamp found
  }

  /**
   * Extract context around an error
   */
  extractErrorContext(lines, errorIndex, contextLines = 3) {
    const start = Math.max(0, errorIndex - contextLines);
    const end = Math.min(lines.length, errorIndex + contextLines + 1);
    return lines.slice(start, end).join('\n');
  }

  /**
   * Scan a single log file for errors
   */
  async scanLogFile(filePath) {
    try {
      const stats = fs.statSync(filePath);
      const lastPosition = this.lastScanPosition[filePath] || 0;

      // Skip if file hasn't changed
      if (stats.size <= lastPosition) {
        return;
      }

      // Skip very large files (over 50MB)
      if (stats.size > 50 * 1024 * 1024) {
        logger.warn(`[ErrorLogScanner] Skipping large file: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
        // Update position to current size to skip it next time
        this.lastScanPosition[filePath] = stats.size;
        return;
      }

      // Read only the new content
      let buffer;
      try {
        const fd = fs.openSync(filePath, 'r');
        const newContentSize = stats.size - lastPosition;
        buffer = Buffer.alloc(Math.min(newContentSize, 10 * 1024 * 1024)); // Max 10MB at a time
        
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
        fs.closeSync(fd);
        
        // Trim buffer to actual bytes read
        if (bytesRead < buffer.length) {
          buffer = buffer.slice(0, bytesRead);
        }
      } catch (readError) {
        logger.error(`[ErrorLogScanner] Error reading file ${filePath}:`, readError);
        return;
      }
      
      const content = buffer.toString('utf8');
      const lines = content.split('\n');
      const newErrors = [];

      let lineStartPosition = lastPosition;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineEndPosition = lineStartPosition + line.length + 1; // +1 for newline

        // Skip INFO, DEBUG, and WARN level logs
        if (line.includes('[INFO]') || line.includes('[DEBUG]') || line.includes('[WARN]')) {
          lineStartPosition = lineEndPosition;
          continue;
        }

        // Skip telegram startup timeout errors (false positives)
        if (line.includes('Failed to start telegram interface') || 
            line.includes('Failed to start Telegram bot') ||
            line.includes('Telegram bot launch timeout') ||
            line.includes('telegram interface startup timeout') ||
            line.includes('Telegram interface startup timeout') ||
            (line.includes('Telegram bot error') && line.includes('Promise timed out'))) {
          lineStartPosition = lineEndPosition;
          continue;
        }

        // Skip external API errors that can't be fixed
        if (line.includes('api_error') || 
            line.includes('Internal server error') ||
            line.includes('500 {') ||
            line.includes('502 Bad Gateway') ||
            line.includes('503 Service Unavailable') ||
            line.includes('504 Gateway Timeout') ||
            line.includes('Primary provider failed, trying fallback')) {
          lineStartPosition = lineEndPosition;
          continue;
        }

        // Skip expected operational errors
        if (line.includes('Could not find code to replace') ||
            line.includes('is not automatically fixable') ||
            line.includes('AI analysis timeout') ||
            line.includes('Bug fixing session completed') ||
            line.includes('High response time') ||
            line.includes('Alert:')) {
          lineStartPosition = lineEndPosition;
          continue;
        }

        // Check for error patterns
        for (const pattern of this.errorPatterns) {
          if (pattern.test(line)) {
            // Skip JWT authentication failures - these are expected
            if (line.includes('JWT authentication failed') || 
                (line.includes('Invalid token') && line.includes('auth.js'))) {
              continue;
            }
            
            const timestamp = this.parseTimestamp(line);
            
            // Only include errors since startup
            if (timestamp >= this.startupTime) {
              const errorData = {
                file: filePath,
                line: i + 1,
                message: line.trim(),
                pattern: pattern.toString(),
                timestamp,
                context: this.extractErrorContext(lines, i)
              };

              errorData.fingerprint = this.generateErrorFingerprint(errorData);
              newErrors.push(errorData);
              break; // Only match first pattern
            }
          }
        }
        
        lineStartPosition = lineEndPosition;
      }

      // Update scan position to what we actually read
      this.lastScanPosition[filePath] = lastPosition + buffer.length;
      
      logger.debug(`[ErrorLogScanner] Scanned ${filePath}:`, {
        previousPosition: lastPosition,
        newPosition: this.lastScanPosition[filePath],
        bytesRead: buffer.length,
        errorsFound: newErrors.length
      });

      // Process new errors
      if (newErrors.length > 0) {
        logger.info(`[ErrorLogScanner] Found ${newErrors.length} new errors in ${filePath}`);
        await this.processErrors(newErrors, filePath);
      }
      
      return { errorsFound: newErrors.length };

    } catch (error) {
      logger.error(`[ErrorLogScanner] Error scanning ${filePath}:`, error);
    }
  }

  /**
   * Process and store new errors
   */
  async processErrors(errors, logFile) {
    for (const error of errors) {
      try {
        // Check if error already exists
        const existing = await RuntimeError.findOne({ 
          fingerprint: error.fingerprint 
        });

        if (!existing) {
          logger.debug(`[ErrorLogScanner] Creating new error with fingerprint ${error.fingerprint}`, {
            message: error.message.substring(0, 100),
            file: error.file
          });
          
          // Create new runtime error record
          const runtimeError = new RuntimeError({
            fingerprint: error.fingerprint,
            type: 'runtime',
            severity: this.classifyErrorSeverity(error.message),
            message: error.message,
            file: error.file,
            line: error.line,
            timestamp: error.timestamp,
            context: error.context,
            pattern: error.pattern,
            occurrences: 1,
            firstSeen: error.timestamp,
            lastSeen: error.timestamp,
            status: 'new',
            source: 'log_scanner'
          });

          await runtimeError.save();
          
          logger.info('[ErrorLogScanner] New runtime error detected', {
            service: 'error-scanner',
            file: logFile,
            severity: runtimeError.severity,
            message: error.message.substring(0, 100)
          });

          // Emit event for other services
          this.emit('newError', runtimeError);
          
          // Create GitHub issue if enabled and severity matches config
          if (this.config.createGitHubIssues && 
              this.config.githubIssueSeverities.includes(runtimeError.severity)) {
            await this.createGitHubIssueForError(runtimeError);
          }
        } else {
          // Update occurrence count and last seen
          existing.occurrences += 1;
          existing.lastSeen = error.timestamp;
          await existing.save();
          
          logger.debug(`[ErrorLogScanner] Duplicate error detected (fingerprint: ${error.fingerprint})`, {
            occurrences: existing.occurrences,
            message: error.message.substring(0, 100),
            file: error.file,
            originalFile: existing.file
          });
        }
      } catch (err) {
        logger.error('[ErrorLogScanner] Failed to process error:', err);
      }
    }
  }

  /**
   * Create GitHub issue for critical runtime errors
   */
  async createGitHubIssueForError(runtimeError) {
    try {
      // Skip if issue already created
      if (runtimeError.githubIssueNumber) {
        return;
      }

      // Check rate limiting
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      this.githubIssuesCreatedThisHour = this.githubIssuesCreatedThisHour.filter(
        time => time > hourAgo
      );
      
      if (this.githubIssuesCreatedThisHour.length >= this.config.maxIssuesPerHour) {
        logger.warn('[ErrorLogScanner] Rate limit reached for GitHub issue creation', {
          created: this.githubIssuesCreatedThisHour.length,
          limit: this.config.maxIssuesPerHour
        });
        return;
      }

      // Check if agent is available
      if (!this.agent || !this.agent.apiManager) {
        logger.warn('[ErrorLogScanner] Agent not available for GitHub issue creation');
        return;
      }

      const bugDetectorPlugin = this.agent.apiManager.getPlugin('bugDetector');
      if (!bugDetectorPlugin) {
        logger.warn('[ErrorLogScanner] Bug detector plugin not available');
        return;
      }

      // Transform runtime error to bug format
      const bug = {
        id: `runtime_${runtimeError.fingerprint}`,
        fingerprint: runtimeError.fingerprint,
        title: `Runtime Error: ${runtimeError.message.substring(0, 100)}`,
        description: `A runtime error was detected by the error log scanner.\n\n**Error Message:**\n${runtimeError.message}\n\n**Context:**\n\`\`\`\n${runtimeError.context || 'No context available'}\n\`\`\``,
        severity: runtimeError.severity,
        priority: runtimeError.severity, // Use same as severity
        file: runtimeError.file,
        line: runtimeError.line || 'N/A',
        pattern: 'Runtime Error',
        code: runtimeError.context || runtimeError.message,
        foundBy: 'error-log-scanner',
        foundDate: runtimeError.firstSeen,
        environment: 'production',
        tags: ['runtime-error', 'automated-detection']
      };

      // Use the bug detector's duplicate-aware GitHub issue creation
      const result = await bugDetectorPlugin.createGitHubIssueWithDuplicateCheck(bug);
      
      if (result.success) {
        // Update runtime error with GitHub issue info
        runtimeError.githubIssueNumber = result.issue.number;
        runtimeError.githubIssueUrl = result.issue.html_url;
        runtimeError.status = 'github-issue-created';
        await runtimeError.save();
        
        // Track for rate limiting
        this.githubIssuesCreatedThisHour.push(new Date());
        
        logger.info('[ErrorLogScanner] Created GitHub issue for runtime error', {
          fingerprint: runtimeError.fingerprint,
          issueNumber: result.issue.number,
          issueUrl: result.issue.html_url
        });
        
        // Send Telegram notification
        try {
          const notificationMessage = `🚨 *Runtime Error Detected*\n\n` +
            `*Severity:* ${runtimeError.severity}\n` +
            `*File:* \`${runtimeError.file}\`\n` +
            `*Line:* ${runtimeError.line}\n` +
            `*Error:* ${runtimeError.message.substring(0, 200)}${runtimeError.message.length > 200 ? '...' : ''}\n\n` +
            `*GitHub Issue:* [#${result.issue.number}](${result.issue.html_url})\n\n` +
            `LANAgent has automatically created a GitHub issue to track this error.`;
          
          if (this.agent?.telegramInterface?.sendNotification) {
            await this.agent.telegramInterface.sendNotification(notificationMessage, {
              disable_web_page_preview: false
            });
            logger.info('[ErrorLogScanner] Sent Telegram notification for GitHub issue');
          }
        } catch (notifyError) {
          logger.warn('[ErrorLogScanner] Failed to send Telegram notification:', notifyError);
        }
      } else if (result.skipped) {
        logger.info('[ErrorLogScanner] Skipped duplicate GitHub issue for runtime error', {
          fingerprint: runtimeError.fingerprint,
          reason: result.error
        });
      } else {
        logger.error('[ErrorLogScanner] Failed to create GitHub issue:', result.error);
      }
    } catch (error) {
      logger.error('[ErrorLogScanner] Error creating GitHub issue for runtime error:', error);
    }
  }

  /**
   * Classify error severity based on message content
   */
  classifyErrorSeverity(message) {
    const msg = message.toLowerCase();
    
    // Critical: System crashes, data loss, security breaches
    if (msg.includes('fatal') || 
        msg.includes('crash') || 
        msg.includes('segmentation fault') ||
        msg.includes('core dumped') ||
        msg.includes('out of memory') ||
        msg.includes('data corruption')) {
      return 'critical';
    }
    
    // High: Actual runtime errors, not operational errors
    if ((msg.includes('[error]') || msg.includes('error:')) && 
        !msg.includes('error log') &&
        !msg.includes('error scanner') &&
        !msg.includes('error detection')) {
      return 'high';
    }
    
    // Medium: Exceptions and failed operations
    if (msg.includes('exception') || 
        msg.includes('failed to') ||
        msg.includes('unable to')) {
      return 'medium';
    }
    
    // Low: Everything else
    return 'low';
  }

  /**
   * Start periodic scanning
   */
  startScanning() {
    if (this.isScanning) {
      logger.warn('[ErrorLogScanner] Scanning already started');
      return;
    }

    this.isScanning = true;
    logger.info('[ErrorLogScanner] Starting periodic scanning', {
      interval: this.scanInterval,
      intervalMinutes: this.scanInterval / 60000
    });
    
    this.scanTimer = setInterval(async () => {
      logger.debug('[ErrorLogScanner] Scan timer triggered');
      await this.performScan();
    }, this.scanInterval);

    // Perform initial scan
    logger.info('[ErrorLogScanner] Performing initial scan');
    this.performScan().catch(error => {
      logger.error('[ErrorLogScanner] Initial scan failed:', error);
    });
  }

  /**
   * Stop scanning
   */
  stopScanning() {
    this.isScanning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * Perform a scan of all log files
   */
  async performScan() {
    try {
      logger.info('[ErrorLogScanner] Starting error log scan', {
        service: 'error-scanner',
        scanPositions: Object.keys(this.lastScanPosition).length
      });

      const logFiles = this.getLogFiles();
      logger.info('[ErrorLogScanner] Found log files to scan:', {
        service: 'error-scanner',
        files: logFiles,
        count: logFiles.length
      });
      
      let filesScanned = 0;
      let errorsFound = 0;
      
      for (const file of logFiles) {
        try {
          const result = await this.scanLogFile(file);
          filesScanned++;
        } catch (scanError) {
          logger.error(`[ErrorLogScanner] Failed to scan file ${file}:`, scanError);
        }
      }

      // Save scan positions after each scan
      try {
        await this.saveScanPositions();
        logger.info('[ErrorLogScanner] Saved scan positions', {
          service: 'error-scanner',
          positions: Object.keys(this.lastScanPosition).length
        });
      } catch (saveError) {
        logger.error('[ErrorLogScanner] Failed to save scan positions:', saveError);
      }

      logger.info('[ErrorLogScanner] Error log scan completed', {
        service: 'error-scanner',
        filesScanned,
        totalFiles: logFiles.length,
        positions: this.lastScanPosition
      });
    } catch (error) {
      logger.error('[ErrorLogScanner] Scan failed:', error, {
        stack: error.stack
      });
    }
  }

  /**
   * Get statistics about runtime errors
   */
  async getStats() {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now - 60 * 60 * 1000);

      const [
        totalErrors,
        errorsSinceStartup,
        errorsLastHour,
        errorsLastDay,
        errorsBySeverity,
        errorsByFile,
        recentErrors
      ] = await Promise.all([
        RuntimeError.countDocuments({ type: 'runtime' }),
        RuntimeError.countDocuments({ 
          type: 'runtime',
          timestamp: { $gte: this.startupTime }
        }),
        RuntimeError.countDocuments({
          type: 'runtime',
          timestamp: { $gte: oneHourAgo }
        }),
        RuntimeError.countDocuments({
          type: 'runtime',
          timestamp: { $gte: oneDayAgo }
        }),
        RuntimeError.aggregate([
          { $match: { type: 'runtime' } },
          { $group: { _id: '$severity', count: { $sum: 1 } } }
        ]),
        RuntimeError.aggregate([
          { $match: { type: 'runtime' } },
          { $group: { _id: '$file', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ]),
        RuntimeError.find({ type: 'runtime' })
          .sort({ timestamp: -1 })
          .limit(10)
          .select('message severity timestamp file occurrences')
      ]);

      return {
        startupTime: this.startupTime,
        totalErrors,
        errorsSinceStartup,
        errorsLastHour,
        errorsLastDay,
        errorsBySeverity: errorsBySeverity.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        topErrorFiles: errorsByFile,
        recentErrors,
        scannerStatus: this.isScanning ? 'active' : 'stopped',
        lastScanPosition: Object.keys(this.lastScanPosition).length
      };
    } catch (error) {
      logger.error('[ErrorLogScanner] Failed to get stats:', error);
      return null;
    }
  }

  /**
   * Clear old errors (cleanup)
   */
  async cleanupOldErrors(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await RuntimeError.deleteMany({
        type: 'runtime',
        timestamp: { $lt: cutoffDate }
      });

      logger.info(`[ErrorLogScanner] Cleaned up ${result.deletedCount} old errors`);
      return result.deletedCount;
    } catch (error) {
      logger.error('[ErrorLogScanner] Failed to cleanup old errors:', error);
      return 0;
    }
  }
}

// Create singleton instance
export const errorLogScanner = new ErrorLogScanner();