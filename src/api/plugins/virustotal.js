import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

/**
 * VirusTotal Integration Plugin
 * Provides file scanning, URL analysis, and malware detection using VirusTotal API
 */
export class VirusTotalPlugin extends BasePlugin {
  constructor() {
    super();
    this.name = 'virustotal';
    this.version = '1.0.0';
    this.description = 'File and URL scanning with VirusTotal integration for malware detection';
    
    this.apiKey = process.env.VIRUSTOTAL_API_KEY;
    this.baseURL = 'https://www.virustotal.com/vtapi/v2';
    
    this.config = {
      maxFileSize: 32 * 1024 * 1024, // 32MB limit for VirusTotal free API
      scanTimeout: 300000, // 5 minutes
      rateLimitDelay: 15000, // 15 seconds between requests (free API limit)
      autoQuarantine: false,
      quarantineDir: '/tmp/virustotal-quarantine',
      scanHistory: true,
      alertThreshold: 1 // Number of detections to trigger alert
    };
    
    this.scanHistory = new Map(); // In-memory scan history
    this.lastRequestTime = 0;
    
    this.methods = [
      {
        name: 'scanFile',
        description: 'Scan a file for malware using VirusTotal',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to file to scan' },
          quarantine: { type: 'boolean', required: false, description: 'Quarantine if malicious' }
        }
      },
      {
        name: 'scanURL',
        description: 'Scan a URL for malicious content',
        parameters: {
          url: { type: 'string', required: true, description: 'URL to scan' }
        }
      },
      {
        name: 'scanHash',
        description: 'Check file hash against VirusTotal database',
        parameters: {
          hash: { type: 'string', required: true, description: 'MD5, SHA1, or SHA256 hash' }
        }
      },
      {
        name: 'scanDirectory',
        description: 'Recursively scan a directory for malware',
        parameters: {
          dirPath: { type: 'string', required: true, description: 'Directory path to scan' },
          recursive: { type: 'boolean', required: false, description: 'Scan subdirectories' },
          extensions: { type: 'array', required: false, description: 'File extensions to scan' }
        }
      },
      {
        name: 'getReport',
        description: 'Get detailed scan report by resource ID',
        parameters: {
          resource: { type: 'string', required: true, description: 'Scan resource ID or hash' }
        }
      },
      {
        name: 'getScanHistory',
        description: 'Get recent scan history and statistics',
        parameters: {
          limit: { type: 'number', required: false, description: 'Number of recent scans' }
        }
      },
      {
        name: 'quarantineFile',
        description: 'Move a malicious file to quarantine',
        parameters: {
          filePath: { type: 'string', required: true, description: 'Path to file to quarantine' }
        }
      },
      {
        name: 'restoreFile',
        description: 'Restore a file from quarantine',
        parameters: {
          fileName: { type: 'string', required: true, description: 'Name of quarantined file' },
          restorePath: { type: 'string', required: false, description: 'Path to restore to' }
        }
      },
      {
        name: 'listQuarantine',
        description: 'List files in quarantine',
        parameters: {}
      },
      {
        name: 'getDomainReport',
        description: 'Get domain reputation report',
        parameters: {
          domain: { type: 'string', required: true, description: 'Domain name to check' }
        }
      }
    ];
  }

  async initialize() {
    try {
      if (!this.apiKey) {
        logger.warn('VirusTotal API key not found - some features will be limited');
        logger.info('Set VIRUSTOTAL_API_KEY environment variable to enable full functionality');
      }

      // Ensure quarantine directory exists
      try {
        await fs.mkdir(this.config.quarantineDir, { recursive: true });
      } catch (error) {
        logger.warn('Could not create quarantine directory:', error.message);
      }

      logger.info('VirusTotal Plugin initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize VirusTotal Plugin:', error);
      return false;
    }
  }

  async execute(params) {
    const { action, ...args } = params;
    
    try {
      switch (action) {
        case 'scanFile':
          return await this.scanFile(args);
        case 'scanURL':
          return await this.scanURL(args);
        case 'scanHash':
          return await this.scanHash(args);
        case 'scanDirectory':
          return await this.scanDirectory(args);
        case 'getReport':
          return await this.getReport(args);
        case 'getScanHistory':
          return await this.getScanHistory(args);
        case 'quarantineFile':
          return await this.quarantineFile(args);
        case 'restoreFile':
          return await this.restoreFile(args);
        case 'listQuarantine':
          return await this.listQuarantine();
        case 'getDomainReport':
          return await this.getDomainReport(args);
        default:
          throw new Error(`Unknown VirusTotal action: ${action}`);
      }
    } catch (error) {
      logger.error(`VirusTotal Plugin error in ${action}:`, error);
      throw error;
    }
  }

  /**
   * Scan a file using VirusTotal API
   */
  async scanFile({ filePath, quarantine = false }) {
    try {
      logger.info(`Scanning file: ${filePath}`);

      if (!this.apiKey) {
        return await this.localFileScan(filePath);
      }

      // Check if file exists and get stats
      const fileStats = await fs.stat(filePath);
      if (fileStats.size > this.config.maxFileSize) {
        throw new Error(`File too large (${fileStats.size} bytes). Max size: ${this.config.maxFileSize} bytes`);
      }

      // Calculate file hash first to check if already scanned
      const fileHash = await this.calculateFileHash(filePath);
      logger.info(`File hash (SHA256): ${fileHash}`);

      // Check if we already have results for this hash
      const existingReport = await this.getReport({ resource: fileHash });
      if (existingReport.success && existingReport.scans) {
        logger.info('Using existing VirusTotal report for this file');
        const result = this.processScanResult(existingReport, filePath);
        
        if (quarantine && result.malicious) {
          await this.quarantineFile({ filePath });
          result.quarantined = true;
        }
        
        return result;
      }

      // Upload file for scanning
      await this.enforceRateLimit();
      const uploadResult = await this.uploadFileForScanning(filePath);
      
      if (!uploadResult.success) {
        throw new Error(`Upload failed: ${uploadResult.error}`);
      }

      // Wait for scan to complete and get results
      const scanResult = await this.waitForScanCompletion(uploadResult.resource || fileHash);
      const result = this.processScanResult(scanResult, filePath);

      // Add to scan history
      this.addToScanHistory(filePath, result);

      // Auto-quarantine if enabled and malicious
      if (quarantine && result.malicious) {
        await this.quarantineFile({ filePath });
        result.quarantined = true;
      }

      return result;

    } catch (error) {
      logger.error(`File scan failed for ${filePath}:`, error);
      return {
        success: false,
        error: error.message,
        filePath: filePath
      };
    }
  }

  /**
   * Scan a URL using VirusTotal API
   */
  async scanURL({ url }) {
    try {
      logger.info(`Scanning URL: ${url}`);

      if (!this.apiKey) {
        return {
          success: false,
          error: 'VirusTotal API key required for URL scanning'
        };
      }

      await this.enforceRateLimit();

      // Submit URL for scanning
      const formData = new URLSearchParams();
      formData.append('apikey', this.apiKey);
      formData.append('url', url);

      const response = await fetch(`${this.baseURL}/url/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
      });

      const data = await response.json();
      
      if (data.response_code !== 1) {
        throw new Error(data.verbose_msg || 'URL scan submission failed');
      }

      // Wait for scan completion
      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
      
      const reportResult = await this.getURLReport(data.resource);
      const result = this.processURLScanResult(reportResult, url);

      this.addToScanHistory(url, result);
      return result;

    } catch (error) {
      logger.error(`URL scan failed for ${url}:`, error);
      return {
        success: false,
        error: error.message,
        url: url
      };
    }
  }

  /**
   * Check file hash against VirusTotal database
   */
  async scanHash({ hash }) {
    try {
      logger.info(`Checking hash: ${hash}`);

      if (!this.apiKey) {
        return {
          success: false,
          error: 'VirusTotal API key required for hash checking'
        };
      }

      const report = await this.getReport({ resource: hash });
      if (report.success) {
        return this.processScanResult(report, `Hash: ${hash}`);
      } else {
        return {
          success: true,
          hash: hash,
          found: false,
          message: 'Hash not found in VirusTotal database'
        };
      }

    } catch (error) {
      logger.error(`Hash check failed for ${hash}:`, error);
      return {
        success: false,
        error: error.message,
        hash: hash
      };
    }
  }

  /**
   * Recursively scan a directory
   */
  async scanDirectory({ dirPath, recursive = true, extensions = null }) {
    try {
      logger.info(`Scanning directory: ${dirPath}`);

      const results = {
        success: true,
        directory: dirPath,
        scanned: 0,
        malicious: 0,
        clean: 0,
        errors: 0,
        files: []
      };

      const filesToScan = await this.getFilesToScan(dirPath, recursive, extensions);
      logger.info(`Found ${filesToScan.length} files to scan`);

      for (const filePath of filesToScan) {
        try {
          const scanResult = await this.scanFile({ filePath, quarantine: this.config.autoQuarantine });
          results.files.push({
            file: filePath,
            result: scanResult
          });

          results.scanned++;
          if (scanResult.malicious) {
            results.malicious++;
          } else if (scanResult.success) {
            results.clean++;
          } else {
            results.errors++;
          }

          // Add delay between scans to respect rate limits
          await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));

        } catch (error) {
          results.errors++;
          results.files.push({
            file: filePath,
            result: { success: false, error: error.message }
          });
        }
      }

      results.summary = `Scanned ${results.scanned} files: ${results.clean} clean, ${results.malicious} malicious, ${results.errors} errors`;
      return results;

    } catch (error) {
      logger.error(`Directory scan failed for ${dirPath}:`, error);
      return {
        success: false,
        error: error.message,
        directory: dirPath
      };
    }
  }

  /**
   * Get scan report from VirusTotal
   */
  async getReport({ resource }) {
    try {
      if (!this.apiKey) {
        return {
          success: false,
          error: 'VirusTotal API key required'
        };
      }

      await this.enforceRateLimit();

      const url = `${this.baseURL}/file/report?apikey=${this.apiKey}&resource=${resource}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.response_code === 1) {
        return {
          success: true,
          resource: resource,
          scans: data.scans,
          positives: data.positives,
          total: data.total,
          scanDate: new Date(data.scan_date),
          permalink: data.permalink,
          md5: data.md5,
          sha1: data.sha1,
          sha256: data.sha256
        };
      } else if (data.response_code === 0) {
        return {
          success: true,
          found: false,
          message: 'Resource not found in VirusTotal database'
        };
      } else {
        throw new Error(data.verbose_msg || 'Failed to get report');
      }

    } catch (error) {
      logger.error(`Failed to get report for ${resource}:`, error);
      return {
        success: false,
        error: error.message,
        resource: resource
      };
    }
  }

  /**
   * Get scan history
   */
  async getScanHistory({ limit = 10 }) {
    const history = Array.from(this.scanHistory.values())
      .sort((a, b) => new Date(b.scanTime) - new Date(a.scanTime))
      .slice(0, limit);

    const stats = {
      totalScans: this.scanHistory.size,
      maliciousFiles: Array.from(this.scanHistory.values()).filter(scan => scan.malicious).length,
      cleanFiles: Array.from(this.scanHistory.values()).filter(scan => !scan.malicious && scan.success).length
    };

    return {
      success: true,
      history: history,
      statistics: stats,
      total: this.scanHistory.size
    };
  }

  /**
   * Quarantine a malicious file
   */
  async quarantineFile({ filePath }) {
    try {
      logger.info(`Quarantining file: ${filePath}`);

      const fileName = path.basename(filePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantinedName = `${timestamp}_${fileName}`;
      const quarantinedPath = path.join(this.config.quarantineDir, quarantinedName);

      // Move file to quarantine
      await fs.rename(filePath, quarantinedPath);

      // Create metadata file
      const metadata = {
        originalPath: filePath,
        quarantineTime: new Date().toISOString(),
        reason: 'Malicious content detected by VirusTotal'
      };

      await fs.writeFile(
        `${quarantinedPath}.meta`,
        JSON.stringify(metadata, null, 2)
      );

      logger.info(`File quarantined: ${quarantinedPath}`);

      return {
        success: true,
        originalPath: filePath,
        quarantinedPath: quarantinedPath,
        message: 'File successfully quarantined'
      };

    } catch (error) {
      logger.error(`Failed to quarantine ${filePath}:`, error);
      return {
        success: false,
        error: error.message,
        filePath: filePath
      };
    }
  }

  /**
   * Restore file from quarantine
   */
  async restoreFile({ fileName, restorePath = null }) {
    try {
      const quarantinedPath = path.join(this.config.quarantineDir, fileName);
      const metadataPath = `${quarantinedPath}.meta`;

      // Read metadata to get original path
      let originalPath = restorePath;
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        originalPath = originalPath || metadata.originalPath;
      } catch (error) {
        if (!restorePath) {
          throw new Error('No metadata found and no restore path specified');
        }
      }

      // Restore file
      await fs.rename(quarantinedPath, originalPath);

      // Remove metadata
      try {
        await fs.unlink(metadataPath);
      } catch (error) {
        // Ignore if metadata file doesn't exist
      }

      logger.info(`File restored: ${originalPath}`);

      return {
        success: true,
        restoredPath: originalPath,
        message: 'File successfully restored from quarantine'
      };

    } catch (error) {
      logger.error(`Failed to restore ${fileName}:`, error);
      return {
        success: false,
        error: error.message,
        fileName: fileName
      };
    }
  }

  /**
   * List quarantined files
   */
  async listQuarantine() {
    try {
      const files = await fs.readdir(this.config.quarantineDir);
      const quarantinedFiles = [];

      for (const file of files) {
        if (file.endsWith('.meta')) continue;

        const filePath = path.join(this.config.quarantineDir, file);
        const metadataPath = `${filePath}.meta`;
        const stats = await fs.stat(filePath);

        let metadata = {};
        try {
          metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        } catch (error) {
          // Metadata not available
        }

        quarantinedFiles.push({
          fileName: file,
          size: stats.size,
          quarantineTime: metadata.quarantineTime || stats.ctime,
          originalPath: metadata.originalPath || 'Unknown',
          reason: metadata.reason || 'Unknown'
        });
      }

      return {
        success: true,
        files: quarantinedFiles,
        total: quarantinedFiles.length,
        quarantineDirectory: this.config.quarantineDir
      };

    } catch (error) {
      logger.error('Failed to list quarantined files:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get domain reputation report
   */
  async getDomainReport({ domain }) {
    try {
      if (!this.apiKey) {
        return {
          success: false,
          error: 'VirusTotal API key required for domain reports'
        };
      }

      await this.enforceRateLimit();

      const url = `${this.baseURL}/domain/report?apikey=${this.apiKey}&domain=${domain}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.response_code === 1) {
        return {
          success: true,
          domain: domain,
          reputation: this.calculateDomainReputation(data),
          detectedUrls: data.detected_urls || [],
          undetectedUrls: data.undetected_urls || [],
          resolutions: data.resolutions || [],
          scanDate: new Date()
        };
      } else {
        return {
          success: true,
          domain: domain,
          found: false,
          message: 'Domain not found in VirusTotal database'
        };
      }

    } catch (error) {
      logger.error(`Failed to get domain report for ${domain}:`, error);
      return {
        success: false,
        error: error.message,
        domain: domain
      };
    }
  }

  /**
   * Helper Methods
   */

  async localFileScan(filePath) {
    // Basic local file analysis when VirusTotal API is not available
    try {
      const stats = await fs.stat(filePath);
      const hash = await this.calculateFileHash(filePath);
      
      return {
        success: true,
        filePath: filePath,
        hash: hash,
        size: stats.size,
        malicious: false,
        confidence: 'low',
        message: 'Local analysis only - VirusTotal API key required for comprehensive scanning',
        scanTime: new Date()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        filePath: filePath
      };
    }
  }

  async calculateFileHash(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  async uploadFileForScanning(filePath) {
    try {
      // For file uploads, we need to create a proper FormData with file content
      const fileContent = await fs.readFile(filePath);
      const formData = new FormData();
      formData.append('apikey', this.apiKey);
      formData.append('file', new Blob([fileContent]), path.basename(filePath));

      const response = await fetch(`${this.baseURL}/file/scan`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.response_code === 1) {
        return {
          success: true,
          resource: data.resource,
          scanId: data.scan_id
        };
      } else {
        throw new Error(data.verbose_msg || 'Upload failed');
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async waitForScanCompletion(resource, timeout = 300000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
      
      const report = await this.getReport({ resource });
      if (report.success && report.scans) {
        return report;
      }
    }
    
    throw new Error('Scan timeout - results may be available later');
  }

  processScanResult(report, filePath) {
    if (!report.success || !report.scans) {
      return {
        success: false,
        error: 'Invalid scan report',
        filePath: filePath
      };
    }

    const detections = [];
    let positiveCount = 0;

    Object.entries(report.scans).forEach(([engine, result]) => {
      if (result.detected) {
        positiveCount++;
        detections.push({
          engine: engine,
          result: result.result,
          version: result.version,
          update: result.update
        });
      }
    });

    const malicious = positiveCount >= this.config.alertThreshold;
    const confidence = this.calculateConfidence(positiveCount, report.total);

    return {
      success: true,
      filePath: filePath,
      malicious: malicious,
      detections: positiveCount,
      total: report.total,
      confidence: confidence,
      engines: detections,
      permalink: report.permalink,
      hashes: {
        md5: report.md5,
        sha1: report.sha1,
        sha256: report.sha256
      },
      scanTime: new Date()
    };
  }

  async getURLReport(resource) {
    await this.enforceRateLimit();
    
    const url = `${this.baseURL}/url/report?apikey=${this.apiKey}&resource=${resource}`;
    const response = await fetch(url);
    const data = await response.json();

    return data.response_code === 1 ? data : null;
  }

  processURLScanResult(report, url) {
    if (!report) {
      return {
        success: false,
        error: 'No scan report available',
        url: url
      };
    }

    const malicious = report.positives > 0;
    const confidence = this.calculateConfidence(report.positives, report.total);

    return {
      success: true,
      url: url,
      malicious: malicious,
      detections: report.positives,
      total: report.total,
      confidence: confidence,
      scanTime: new Date(),
      permalink: report.permalink
    };
  }

  calculateConfidence(positives, total) {
    if (total === 0) return 'unknown';
    
    const ratio = positives / total;
    if (ratio === 0) return 'high';
    if (ratio < 0.1) return 'medium';
    if (ratio < 0.3) return 'high';
    return 'very-high';
  }

  calculateDomainReputation(data) {
    const detectedUrls = (data.detected_urls || []).length;
    const undetectedUrls = (data.undetected_urls || []).length;
    
    if (detectedUrls === 0 && undetectedUrls > 0) {
      return 'clean';
    } else if (detectedUrls > 0 && detectedUrls < 5) {
      return 'suspicious';
    } else if (detectedUrls >= 5) {
      return 'malicious';
    } else {
      return 'unknown';
    }
  }

  async getFilesToScan(dirPath, recursive, extensions) {
    const files = [];
    
    async function scanDir(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory() && recursive) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          if (!extensions || extensions.some(ext => entry.name.toLowerCase().endsWith(ext.toLowerCase()))) {
            files.push(fullPath);
          }
        }
      }
    }
    
    await scanDir(dirPath);
    return files;
  }

  addToScanHistory(resource, result) {
    this.scanHistory.set(resource, {
      resource: resource,
      scanTime: new Date(),
      malicious: result.malicious,
      detections: result.detections || 0,
      success: result.success
    });
  }

  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.config.rateLimitDelay) {
      const delay = this.config.rateLimitDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.lastRequestTime = Date.now();
  }

  getStatus() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      apiConfigured: Boolean(this.apiKey),
      scansPerformed: this.scanHistory.size,
      quarantineDir: this.config.quarantineDir,
      methods: this.methods.map(m => ({ name: m.name, description: m.description }))
    };
  }
}

export default VirusTotalPlugin;