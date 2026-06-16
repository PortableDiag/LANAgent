import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
    getCachedCount,
    getCachedPendingEntries,
    invalidateSessionCache
} from './scanProgressCache.js';

export class IncrementalScanner {
  constructor(bugDetectorPlugin) {
    this.plugin = bugDetectorPlugin;
    this.agent = bugDetectorPlugin.agent;
    
    // Context limits per provider (conservative estimates)
    this.contextLimits = {
      'openai': {
        'gpt-4o': 128000,
        'gpt-4': 8000,
        'gpt-3.5-turbo': 4000
      },
      'anthropic': {
        'claude-3-sonnet': 200000,
        'claude-3-haiku': 200000,
        'claude-sonnet-4-5-20250929': 200000
      },
      'huggingface': {
        'default': 8000
      },
      'gab': {
        'default': 32000
      }
    };
  }

  /**
   * Start a new incremental scan session
   */
  async startIncrementalScan(scanPaths, excludePaths = []) {
    try {
      const scanId = `scan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      logger.info(`Starting incremental scan session: ${scanId}`);
      logger.info(`Scan paths: ${JSON.stringify(scanPaths)}`);
      logger.info(`Exclude paths: ${JSON.stringify(excludePaths)}`);
      
      // Get current AI provider info
      const providerInfo = await this.getCurrentProviderInfo();
      logger.info(`Provider info: ${JSON.stringify(providerInfo)}`);
      
      // Discover all files to scan
      const filesToScan = await this.discoverFiles(scanPaths, excludePaths);
      logger.info(`Found ${filesToScan.length} files to scan`);
      
      // Log first few files for debugging
      if (filesToScan.length > 0) {
        logger.info(`Sample files found: ${filesToScan.slice(0, 5).map(f => f.relativePath).join(', ')}`);
      }
      
      // Create scan progress entries
      await this.createScanEntries(scanId, filesToScan, providerInfo);
      logger.info(`Created scan entries for ${filesToScan.length} files`);
      
      // Start processing one file at a time
      const results = await this.processFilesIncrementally(scanId);
      logger.info(`Processing completed: ${results.processedFiles} files processed`);
      
      return {
        success: true,
        scanId,
        totalFiles: filesToScan.length,
        bugsFound: results.bugs,
        scannedFiles: results.processedFiles,
        summary: results.summary
      };
      
    } catch (error) {
      logger.error(`Incremental scan failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current AI provider and model info
   */
  async getCurrentProviderInfo() {
    try {
      // Get current provider from agent - handle both sync and async cases
      let currentProvider, currentModel;
      
      if (this.agent.providerManager?.getCurrentProvider) {
        const providerResult = this.agent.providerManager.getCurrentProvider();
        currentProvider = await Promise.resolve(providerResult);
      }
      
      if (this.agent.providerManager?.getCurrentModel) {
        const modelResult = this.agent.providerManager.getCurrentModel();
        currentModel = await Promise.resolve(modelResult);
      }
      
      // Extract provider name from object if needed
      if (typeof currentProvider === 'object' && currentProvider?.name) {
        currentProvider = currentProvider.name.toLowerCase();
      } else if (typeof currentProvider === 'string') {
        currentProvider = currentProvider.toLowerCase();
      } else {
        currentProvider = 'huggingface';
      }
      
      // Extract model name from object if needed
      if (typeof currentModel === 'object' && currentModel?.chat) {
        currentModel = currentModel.chat;
      } else if (typeof currentModel !== 'string') {
        currentModel = 'default';
      }
      
      // Get context limit for this provider/model combo
      const contextLimit = this.getContextLimit(currentProvider, currentModel);
      
      logger.info(`Using AI provider: ${currentProvider}, model: ${currentModel}, context limit: ${contextLimit}`);
      
      return {
        provider: currentProvider,
        model: currentModel,
        contextLimit
      };
    } catch (error) {
      logger.warn(`Could not get provider info, using defaults: ${error.message}`);
      return {
        provider: 'huggingface',
        model: 'default',
        contextLimit: 8000
      };
    }
  }

  /**
   * Get context limit for a specific provider/model
   */
  getContextLimit(provider, model) {
    const providerLimits = this.contextLimits[provider] || this.contextLimits['huggingface'];
    return providerLimits[model] || providerLimits['default'] || 8000;
  }

  /**
   * Discover all files that need to be scanned
   */
  async discoverFiles(scanPaths, excludePaths) {
    const files = [];
    
    for (const scanPath of scanPaths) {
      logger.info(`Scanning directory: ${scanPath}`);
      await this.collectFilesRecursively(scanPath, excludePaths, files);
      logger.info(`Found ${files.length} total files so far in ${scanPath}`);
    }
    
    const jsFiles = files.filter(file => this.shouldScanFile(file));
    logger.info(`Filtered to ${jsFiles.length} JavaScript files`);
    
    // Shuffle files to ensure different files get scanned each time
    // This prevents always scanning the same files first
    const shuffled = [...jsFiles];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    logger.info(`Shuffled files for fair rotation`);
    
    // Return all files - removed testing limit
    return shuffled;
  }

  /**
   * Recursively collect JavaScript/TypeScript files
   */
  async collectFilesRecursively(dirPath, excludePaths, files) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(process.cwd(), fullPath);
        
        // Skip excluded paths
        if (excludePaths.some(exclude => relativePath.includes(exclude))) {
          continue;
        }
        
        if (entry.isDirectory()) {
          await this.collectFilesRecursively(fullPath, excludePaths, files);
        } else if (entry.isFile()) {
          files.push({
            fullPath,
            relativePath,
            name: entry.name
          });
        }
      }
    } catch (error) {
      logger.warn(`Could not read directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Check if file should be scanned based on extension
   */
  shouldScanFile(file) {
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs'];
    return extensions.some(ext => file.name.endsWith(ext));
  }

  /**
   * Create MongoDB entries for all files/chunks to be scanned
   */
  async createScanEntries(scanId, files, providerInfo) {
    const { ScanProgress } = await import('../models/ScanProgress.js');
    const entries = [];
    
    for (const file of files) {
      try {
        // Get file info
        const stats = await fs.stat(file.fullPath);
        const content = await fs.readFile(file.fullPath, 'utf8');
        const lines = content.split('\n');
        
        // Skip extremely large files that would be too complex to chunk
        // 20MB limit (20 * 1024 * 1024 bytes ≈ 20 million chars)
        if (content.length > 20000000 || lines.length > 100000) {
          logger.info(`Skipping extremely large file ${file.relativePath} (${content.length} chars, ${lines.length} lines)`);
          continue;
        }
        
        // Decide if file needs chunking based on context limit
        const needsChunking = this.needsChunking(content, providerInfo.contextLimit);
        
        if (needsChunking) {
          // Create multiple entries for chunks
          const chunks = this.calculateChunks(content, providerInfo.contextLimit);
          
          for (let i = 0; i < chunks.length; i++) {
            entries.push({
              scanId: `${scanId}_${file.relativePath.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${i + 1}`,
              sessionScanId: scanId,
              filePath: file.fullPath,
              relativePath: file.relativePath,
              isChunked: true,
              chunkIndex: i + 1,
              totalChunks: chunks.length,
              chunkStartLine: chunks[i].startLine,
              chunkEndLine: chunks[i].endLine,
              fileSize: stats.size,
              lineCount: lines.length,
              aiProvider: providerInfo.provider,
              aiModel: providerInfo.model,
              contextLimit: providerInfo.contextLimit
            });
          }
        } else {
          // Single entry for whole file
          entries.push({
            scanId: `${scanId}_${file.relativePath.replace(/[^a-zA-Z0-9]/g, '_')}_whole`,
            sessionScanId: scanId,
            filePath: file.fullPath,
            relativePath: file.relativePath,
            isChunked: false,
            fileSize: stats.size,
            lineCount: lines.length,
            aiProvider: providerInfo.provider,
            aiModel: providerInfo.model,
            contextLimit: providerInfo.contextLimit
          });
        }
      } catch (error) {
        logger.warn(`Could not analyze file ${file.relativePath}: ${error.message}`);
      }
    }
    
    // Bulk insert entries
    if (entries.length > 0) {
      await ScanProgress.insertMany(entries);
      logger.info(`Created ${entries.length} scan entries for ${files.length} files`);
    }
  }

  /**
   * Check if file needs to be chunked based on context limit
   */
  needsChunking(content, contextLimit) {
    // Conservative limits for single AI analysis
    const maxCharsPerChunk = 2000;
    const maxLinesPerChunk = 50;
    
    const lines = content.split('\n');
    return content.length > maxCharsPerChunk || lines.length > maxLinesPerChunk;
  }

  /**
   * Calculate how to chunk a large file
   */
  calculateChunks(content, contextLimit) {
    const lines = content.split('\n');
    const maxCharsPerChunk = 2000;
    const maxLinesPerChunk = 50;
    
    const chunks = [];
    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;
    let braceDepth = 0;
    let inFunction = false;
    let inClass = false;
    
    for (const line of lines) {
      const lineWithNewline = line + '\n';
      const trimmedLine = line.trim();
      const chunkLines = currentChunk.split('\n').length - 1;
      
      // Track code structure
      if (trimmedLine.includes('function') || trimmedLine.includes('=>') || trimmedLine.match(/^\s*\w+\s*\(/)) {
        inFunction = true;
      }
      if (trimmedLine.includes('class ')) {
        inClass = true;
      }
      
      // Count braces to track block depth
      braceDepth += (trimmedLine.match(/\{/g) || []).length;
      braceDepth -= (trimmedLine.match(/\}/g) || []).length;
      
      // Check if we should split here (at logical boundaries)
      const shouldSplit = (currentChunk.length + lineWithNewline.length > maxCharsPerChunk || chunkLines >= maxLinesPerChunk) && 
                          currentChunk.length > 0 &&
                          braceDepth === 0 && // Only split when not inside a block
                          !inFunction && 
                          !inClass &&
                          (trimmedLine === '' || // Empty line (good boundary)
                           trimmedLine.startsWith('//') || // Comment line
                           trimmedLine.startsWith('/*') || // Comment block
                           trimmedLine.startsWith('import ') || // Import statement
                           trimmedLine.startsWith('export ') || // Export statement
                           trimmedLine.startsWith('const ') || // Top-level const
                           trimmedLine.startsWith('let ') || // Top-level let
                           trimmedLine.startsWith('var ')); // Top-level var
      
      if (shouldSplit) {
        // End current chunk at a logical boundary
        chunks.push({
          content: currentChunk,
          startLine,
          endLine: currentLine - 1
        });
        
        // Start new chunk
        currentChunk = lineWithNewline;
        startLine = currentLine;
        braceDepth = 0;
        inFunction = false;
        inClass = false;
      } else {
        currentChunk += lineWithNewline;
      }
      
      // Reset flags when leaving blocks
      if (braceDepth === 0) {
        inFunction = false;
        inClass = false;
      }
      
      currentLine++;
    }
    
    // Add final chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk,
        startLine,
        endLine: currentLine - 1
      });
    }
    
    return chunks;
  }

  /**
   * Process files incrementally, one at a time
   */
  async processFilesIncrementally(scanId) {
    const { ScanProgress } = await import('../models/ScanProgress.js');
    const allBugs = [];
    let processedFiles = 0;

    try {
      // Get all pending scan entries for this session (using cache)
      const pendingEntries = await getCachedPendingEntries(ScanProgress, scanId);

      logger.info(`Processing ${pendingEntries.length} scan entries`);

      // Debug: Check total entries for this scan (using cache)
      const totalEntries = await getCachedCount(ScanProgress, scanId, null);
      const completedEntries = await getCachedCount(ScanProgress, scanId, 'completed');
      logger.info(`DEBUG: Total entries for scan ${scanId}: ${totalEntries}, Completed: ${completedEntries}, Pending: ${pendingEntries.length}`);
      
      for (const entry of pendingEntries) {
        try {
          await this.processOneScanEntry(entry, allBugs);
          processedFiles++;
          
          // Small delay to avoid overwhelming the AI provider
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          logger.error(`Failed to process entry ${entry._id}: ${error.message}`);

          // Mark as failed
          await ScanProgress.updateOne(
            { _id: entry._id },
            {
              status: 'failed',
              errorMessage: error.message,
              completedAt: new Date()
            }
          );
          // Invalidate cache after status change
          invalidateSessionCache(scanId);
        }
      }
      
      // Generate summary
      const summary = this.generateSummary(allBugs);
      
      logger.info(`DEBUG SCANNER: allBugs.length = ${allBugs.length}`);
      logger.info(`DEBUG SCANNER: processedFiles = ${processedFiles}`);
      
      return {
        bugs: allBugs,
        processedFiles,
        summary
      };
      
    } catch (error) {
      logger.error(`Incremental processing failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process a single scan entry (file or chunk)
   */
  async processOneScanEntry(entry, allBugs) {
    const { ScanProgress } = await import('../models/ScanProgress.js');

    // Mark as processing
    await ScanProgress.updateOne(
      { _id: entry._id },
      {
        status: 'processing',
        startedAt: new Date()
      }
    );
    // Invalidate cache after status change
    invalidateSessionCache(entry.sessionScanId);

    const startTime = Date.now();

    try {
      // Read file content (or chunk)
      let content;
      if (entry.isChunked) {
        content = await this.readFileChunk(entry);
      } else {
        content = await fs.readFile(entry.filePath, 'utf8');
      }

      // Analyze with AI
      const bugs = await this.plugin.analyzeCodeWithAI(content, entry.relativePath, entry.filePath);

      // Store bug IDs
      const bugIds = bugs.map(bug => bug.id);
      allBugs.push(...bugs);

      const processingTime = Date.now() - startTime;

      // Mark as completed
      await ScanProgress.updateOne(
        { _id: entry._id },
        {
          status: 'completed',
          bugsFound: bugs.length,
          bugIds,
          processingTime,
          completedAt: new Date()
        }
      );
      // Invalidate cache after status change
      invalidateSessionCache(entry.sessionScanId);

      logger.info(`Processed ${entry.relativePath} (chunk ${entry.chunkIndex}/${entry.totalChunks}): ${bugs.length} bugs found in ${processingTime}ms`);

    } catch (error) {
      const processingTime = Date.now() - startTime;

      await ScanProgress.updateOne(
        { _id: entry._id },
        {
          status: 'failed',
          errorMessage: error.message,
          processingTime,
          completedAt: new Date()
        }
      );
      // Invalidate cache after status change
      invalidateSessionCache(entry.sessionScanId);

      throw error;
    }
  }

  /**
   * Read a specific chunk of a file
   */
  async readFileChunk(entry) {
    const content = await fs.readFile(entry.filePath, 'utf8');
    const lines = content.split('\n');
    
    const chunkLines = lines.slice(entry.chunkStartLine - 1, entry.chunkEndLine);
    return chunkLines.join('\n');
  }

  /**
   * Generate summary statistics
   */
  generateSummary(bugs) {
    return {
      totalBugs: bugs.length,
      critical: bugs.filter(b => b.severity === 'critical').length,
      high: bugs.filter(b => b.severity === 'high').length,
      medium: bugs.filter(b => b.severity === 'medium').length,
      low: bugs.filter(b => b.severity === 'low').length
    };
  }
}