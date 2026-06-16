import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { selfModLock } from '../../services/selfModLock.js';
import { escapeMarkdown, truncateText } from '../../utils/markdown.js';

export default class BugDetectorPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'bugDetector';
    this.version = '2.0.0';
    this.description = 'AI-powered incremental bug detection with MongoDB state tracking, file chunking, and provider-agnostic analysis. Features: context-aware scanning, persistent progress tracking, and intelligent file chunking for large codebases.';
    
    // Initialize incremental scanner
    this.incrementalScanner = null; // Lazy loaded
    this.commands = [
      {
        command: 'scan',
        description: 'Scan code for potential bugs',
        usage: 'scan [file|directory]'
      },
      {
        command: 'bugs',
        description: 'List found bugs',
        usage: 'bugs [status]'
      }
    ];
    
    // Default settings for bug detector
    this.defaultSettings = {
      enabled: true,
      dailyScanEnabled: true,
      autoCreateGitHubIssues: true,
      autoStoreBugs: true,
      sendTelegramNotifications: true, // New setting for issue creation notifications
      scanPaths: [(process.env.AGENT_REPO_PATH || process.cwd()) + '/src', (process.env.AGENT_REPO_PATH || process.cwd()) + '/docs'],
      excludePaths: ['node_modules', '.git', 'logs', 'projects', 'test', 'tests'],
      minimumSeverity: 'low',
      lastScan: null,
      dailyBugLimit: 5
    };
    
    // AI-based bug detection categories
    this.bugCategories = [
      {
        name: 'Security Vulnerabilities',
        description: 'Security issues like hardcoded credentials, SQL injection, XSS vulnerabilities',
        severity: 'critical'
      },
      {
        name: 'Error Handling Issues',
        description: 'Missing try-catch blocks, unhandled promise rejections, uncaught exceptions',
        severity: 'high'
      },
      {
        name: 'Resource Management',
        description: 'Memory leaks, unclosed connections, resource cleanup issues',
        severity: 'high'
      },
      {
        name: 'Code Quality Issues',
        description: 'Deprecated APIs, inefficient code patterns, maintainability issues',
        severity: 'medium'
      },
      {
        name: 'Logging and Debugging',
        description: 'Console.log in production, missing logging, debug code left in',
        severity: 'low'
      }
    ];
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'scan':
          return await this.scanForBugs(data);
        case 'scanIncremental':
          return await this.scanIncremental(data);
        case 'scanDaily':
          return await this.performDailyScan(data);
        case 'listBugs':
          return await this.listBugs(data);
        case 'getBug':
          return await this.getBug(data);
        case 'createGitHubIssue':
          return await this.createGitHubIssue(data);
        case 'getSettings':
          return await this.getSettings();
        case 'updateSettings':
          return await this.updateSettings(data);
        case 'testScan':
          return await this.testBugScan(data);
        case 'clearDuplicateCache':
          return await this.clearDuplicateCache();
        case 'testAI':
          return await this.testAIAnalysis(data);
        case 'getScanProgress':
          return await this.getScanProgress(data);
        default:
          return {
            success: false,
            error: 'Unknown action. Use: scan, scanIncremental, scanDaily, listBugs, getBug, createGitHubIssue, getSettings, updateSettings, testScan, testAI, clearDuplicateCache, getScanProgress'
          };
      }
    } catch (error) {
      logger.error('Bug detector plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async scanForBugs(data = {}) {
    // Get current settings to use proper scanPaths and excludePaths
    const settings = await this.getSettings();
    const scanPaths = data.scanPath ? [data.scanPath] : (settings.settings?.scanPaths || [(process.env.AGENT_REPO_PATH || process.cwd()) + '/src', (process.env.AGENT_REPO_PATH || process.cwd()) + '/docs']);
    const excludePaths = data.exclude || (settings.settings?.excludePaths || ['node_modules', '.git', 'logs', 'projects']);
    
    // Use autoCreateGitHubIssues from data if provided, otherwise use settings
    const autoCreateGitHubIssues = data.autoCreateGitHubIssues !== undefined 
      ? data.autoCreateGitHubIssues 
      : settings.settings?.autoCreateGitHubIssues;
    
    logger.info(`=== STARTING BUG SCAN ===`);
    logger.info(`Scan paths: ${JSON.stringify(scanPaths)}`);
    logger.info(`Exclude paths: ${JSON.stringify(excludePaths)}`);
    logger.info(`Auto create GitHub issues: ${autoCreateGitHubIssues}`);
    
    const results = {
      scannedFiles: 0,
      bugsFound: [],
      scanStartTime: new Date().toISOString(),
      scanPath: scanPaths.join(', ')
    };
    
    try {
      // Step A: Validate scan paths exist
      logger.info('Step A: Validating scan paths exist...');
      const fs = await import('fs/promises');
      for (const scanPath of scanPaths) {
        const stat = await fs.stat(scanPath);
        if (!stat.isDirectory()) {
          throw new Error(`Scan path is not a directory: ${scanPath}`);
        }
        logger.info(`Validated scan path: ${scanPath}`);
      }
      logger.info('Step A completed - all scan paths validated');
      
      // Step B: Scan directories for files
      logger.info('Step B: Scanning directories for JavaScript files...');
      for (const scanPath of scanPaths) {
        logger.info(`Scanning path: ${scanPath}`);
        await this.scanDirectory(scanPath, excludePaths, results);
      }
      logger.info(`Step B completed - scanned ${results.scannedFiles} files`);
      
      // Step C: Calculate scan duration
      logger.info('Step C: Calculating scan metrics...');
      results.scanEndTime = new Date().toISOString();
      results.scanDuration = Date.now() - new Date(results.scanStartTime).getTime();
      logger.info(`Step C completed - scan took ${results.scanDuration}ms`);
      
      // Step D: Store results if bugs found
      logger.info('Step D: Storing bug results...');
      if (results.bugsFound.length > 0) {
        logger.info(`Found ${results.bugsFound.length} bugs, storing in projects plugin...`);
        await this.storeBugsInProject(results.bugsFound, autoCreateGitHubIssues);
        logger.info('Step D completed - bugs stored successfully');
      } else {
        logger.info('Step D completed - no bugs to store');
      }
      
      logger.info(`=== BUG SCAN COMPLETED SUCCESSFULLY ===`);
      logger.info(`Summary: ${results.bugsFound.length} bugs found in ${results.scannedFiles} files (${results.scanDuration}ms)`);
      
      // Apply prioritization and limiting if requested
      let finalBugs = results.bugsFound;
      const requestedLimit = data.limit || 5;
      if (results.bugsFound.length > 0 && requestedLimit < results.bugsFound.length) {
        logger.info(`Applying prioritization and limiting to top ${requestedLimit} bugs`);
        finalBugs = this.prioritizeAndLimitBugs(results.bugsFound, requestedLimit);
        logger.info(`Prioritized ${finalBugs.length} most critical bugs from ${results.bugsFound.length} total`);
      }
      
      return {
        success: true,
        ...results,
        bugsFound: finalBugs,
        originalBugCount: results.bugsFound.length,
        summary: {
          totalBugs: results.bugsFound.length,
          critical: results.bugsFound.filter(b => b.severity === 'critical').length,
          high: results.bugsFound.filter(b => b.severity === 'high').length,
          medium: results.bugsFound.filter(b => b.severity === 'medium').length,
          low: results.bugsFound.filter(b => b.severity === 'low').length
        }
      };
      
    } catch (error) {
      logger.error('=== BUG SCAN FAILED ===');
      logger.error(`Error in scanForBugs: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * AI-powered incremental scanning with MongoDB state tracking
   */
  async scanIncremental(data = {}) {
    try {
      // Lazy load incremental scanner
      if (!this.incrementalScanner) {
        const { IncrementalScanner } = await import('../../services/incrementalScanner.js');
        this.incrementalScanner = new IncrementalScanner(this);
      }
      
      // Get settings for scan paths
      const settings = await this.getSettings();
      const scanPaths = data.scanPath ? [data.scanPath] : (settings.settings?.scanPaths || [(process.env.AGENT_REPO_PATH || process.cwd()) + '/src', (process.env.AGENT_REPO_PATH || process.cwd()) + '/docs']);
      const excludePaths = data.exclude || (settings.settings?.excludePaths || ['node_modules', '.git', 'logs', 'projects']);
      
      logger.info(`=== STARTING INCREMENTAL AI SCAN ===`);
      logger.info(`Scan paths: ${JSON.stringify(scanPaths)}`);
      logger.info(`Exclude paths: ${JSON.stringify(excludePaths)}`);
      
      // Start incremental scan
      const result = await this.incrementalScanner.startIncrementalScan(scanPaths, excludePaths);
      
      if (result.success) {
        // Apply prioritization if requested
        let finalBugs = result.bugsFound || [];
        const requestedLimit = data.limit || 5;
        
        logger.info(`DEBUG: result.bugsFound length: ${finalBugs.length}`);
        logger.info(`DEBUG: result object keys: ${Object.keys(result)}`);
        
        // EMERGENCY FIX: If no bugs in result but scan found bugs, get them from scan progress
        if (finalBugs.length === 0 && result.summary && result.summary.totalBugs > 0) {
          logger.info(`EMERGENCY: No bugs in result but ${result.summary.totalBugs} bugs detected. Collecting from scan progress...`);
          const { ScanProgress } = await import('../../models/ScanProgress.js');
          const scanEntries = await ScanProgress.find({ sessionScanId: result.scanId, bugsFound: { $gt: 0 } });
          
          // Reconstruct bugs from scan progress
          const reconstructedBugs = [];
          for (const entry of scanEntries) {
            if (entry.bugIds && entry.bugIds.length > 0) {
              // Create simplified bug objects for storage
              for (let i = 0; i < entry.bugIds.length; i++) {
                reconstructedBugs.push({
                  id: entry.bugIds[i],
                  title: `Bug detected in ${entry.relativePath}`,
                  description: `AI-detected security or quality issue in ${entry.relativePath} during incremental scan`,
                  severity: 'medium',
                  priority: 'medium',
                  status: 'open',
                  foundBy: 'agent',
                  foundDate: new Date().toISOString(),
                  file: entry.relativePath,
                  line: 1,
                  code: '',
                  pattern: 'AI Detection',
                  tags: ['automated', 'ai-analysis'],
                  environment: 'development',
                  projectId: 'lanagent'
                });
              }
            }
          }
          finalBugs = reconstructedBugs;
          logger.info(`EMERGENCY: Reconstructed ${finalBugs.length} bugs for storage`);
        }
        
        if (finalBugs.length > requestedLimit) {
          logger.info(`Applying prioritization to top ${requestedLimit} bugs from ${finalBugs.length} total`);
          finalBugs = this.prioritizeAndLimitBugs(finalBugs, requestedLimit);
        }
        
        // Store bugs in project database (with anti-spam measures)
        if (finalBugs.length > 0 && (data.autoStoreBugs !== false)) {
          // Anti-spam: Don't store more than 20 bugs per scan to prevent database spam
          if (finalBugs.length > 20) {
            logger.info(`Anti-spam: Limiting to 20 bugs from ${finalBugs.length} total to prevent database spam`);
            finalBugs = finalBugs.slice(0, 20);
          }
          logger.info(`Storing ${finalBugs.length} bugs in project database...`);
          try {
            logger.info(`FORCE STORAGE: About to store ${finalBugs.length} bugs`);
            const settings = await this.getSettings();
            const autoCreateGitHubIssues = data.autoCreateGitHubIssues !== undefined 
              ? data.autoCreateGitHubIssues 
              : settings.settings?.autoCreateGitHubIssues;
            await this.storeBugsInProject(finalBugs, autoCreateGitHubIssues);
            logger.info('FORCE STORAGE: Bugs stored successfully in project database');
          } catch (error) {
            logger.error(`FORCE STORAGE ERROR: Failed to store bugs: ${error.message}`);
            logger.error(`FORCE STORAGE ERROR: Stack trace: ${error.stack}`);
            // Don't fail the whole scan if storage fails
          }
        }
        
        logger.info(`=== INCREMENTAL SCAN COMPLETED ===`);
        logger.info(`Found ${result.bugsFound?.length || 0} total bugs, returning top ${finalBugs.length}`);
        
        return {
          success: true,
          scanId: result.scanId,
          scannedFiles: result.scannedFiles,
          bugsFound: finalBugs,
          originalBugCount: result.bugsFound?.length || 0,
          totalFiles: result.totalFiles,
          summary: result.summary
        };
      } else {
        return result;
      }
      
    } catch (error) {
      logger.error(`Incremental scan failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test AI analysis with a simple code snippet
   */
  async testAIAnalysis(data = {}) {
    try {
      logger.info('=== TESTING AI ANALYSIS ===');
      
      // Simple test code with known issues
      const testCode = data.code || `function test() {
  console.log('This is a console.log in production');
  let password = 'hardcoded123';
  let user = data.user;
  return user.name; // potential undefined access
}`;

      logger.info(`Testing AI with code: ${testCode.substring(0, 100)}...`);
      
      // Test AI analysis directly
      const bugs = await this.analyzeCodeWithAI(testCode, 'test.js', '/test/test.js');
      
      logger.info(`AI analysis completed, found ${bugs.length} bugs`);
      
      return {
        success: true,
        testCode,
        bugsFound: bugs,
        summary: {
          totalBugs: bugs.length,
          critical: bugs.filter(b => b.severity === 'critical').length,
          high: bugs.filter(b => b.severity === 'high').length,
          medium: bugs.filter(b => b.severity === 'medium').length,
          low: bugs.filter(b => b.severity === 'low').length
        }
      };
      
    } catch (error) {
      logger.error(`AI test failed: ${error.message}`);
      return { 
        success: false, 
        error: error.message,
        stack: error.stack 
      };
    }
  }

  async scanDirectory(dirPath, excludePaths, results) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(process.cwd(), fullPath);
      
      // Skip excluded paths
      if (excludePaths.some(exclude => relativePath.includes(exclude))) {
        continue;
      }
      
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, excludePaths, results);
      } else if (entry.isFile() && this.shouldScanFile(entry.name)) {
        await this.scanFile(fullPath, relativePath, results);
      }
    }
  }

  shouldScanFile(filename) {
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs'];
    return extensions.some(ext => filename.endsWith(ext));
  }

  async scanFile(filePath, relativePath, results) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      results.scannedFiles++;
      
      // For regular scan, only process small files directly
      // Larger files should be handled by incremental scanner with chunking
      if (content.length > 2000) {
        logger.info(`File ${relativePath} too large for regular scan (${content.length} chars) - use incremental scan`);
        return;
      }
      
      // Skip files with too many lines for direct processing
      const lines = content.split('\n');
      if (lines.length > 50) {
        logger.info(`File ${relativePath} has too many lines for regular scan (${lines.length} lines) - use incremental scan`);
        return;
      }
      
      // Use AI to analyze the code for bugs
      const bugs = await this.analyzeCodeWithAI(content, relativePath, filePath);
      
      if (bugs && bugs.length > 0) {
        for (const bug of bugs) {
          // Generate unique fingerprint for duplicate detection
          const fingerprint = this.generateBugFingerprint(relativePath, bug.line, bug.pattern);
          
          // Skip if this is a duplicate bug
          if (await this.isDuplicateBug(fingerprint)) {
            continue;
          }
          
          bug.fingerprint = fingerprint;
          results.bugsFound.push(bug);
        }
      }
      
    } catch (error) {
      logger.error(`Error scanning file ${relativePath}:`, error);
    }
  }

  /**
   * Use AI to analyze code for bugs - provider agnostic
   */
  async analyzeCodeWithAI(content, relativePath, filePath) {
    try {
      logger.info(`Starting AI analysis for ${relativePath} (${content.length} chars)`);
      const lines = content.split('\n');
      
      // Create AI prompt for bug detection
      const prompt = `You are a senior code reviewer analyzing JavaScript/TypeScript code for bugs and security issues. 

IMPORTANT: Return ONLY a valid JSON array. Do not include any explanatory text, markdown formatting, or code blocks.

Analyze this code file and identify actual bugs, security vulnerabilities, and code quality issues:

File: ${relativePath}
Code:
\`\`\`javascript
${content}
\`\`\`

Categories to check:
1. Security Vulnerabilities (hardcoded secrets, SQL injection, XSS)
2. Error Handling Issues (missing try-catch, unhandled promises)
3. Resource Management (memory leaks, unclosed connections)
4. Code Quality Issues (deprecated APIs, inefficient patterns)
5. Logic Errors (null/undefined access, incorrect comparisons)

For each REAL bug found, return a JSON object with:
{
  "line": number,
  "pattern": "category name",
  "severity": "critical|high|medium|low", 
  "title": "Brief description",
  "description": "Detailed explanation with fix suggestion",
  "code": "the problematic line of code"
}

Return empty array [] if no real bugs found. Be conservative - only flag actual issues, not false positives.`;

      // Get AI response using agent's current provider with timeout
      logger.info(`Calling AI provider for ${relativePath}`);
      const response = await Promise.race([
        this.agent.providerManager.generateResponse(prompt, {
          maxTokens: 1000,
          temperature: 0.1 // Low temperature for consistent results
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI timeout')), 30000) // 30 second timeout
        )
      ]);
      logger.info(`AI responded for ${relativePath}, response type: ${typeof response}`);
      logger.debug(`Raw AI response for ${relativePath}:`, response);
      
      // Parse AI response - handle both string and object responses
      let bugAnalysis;
      try {
        let responseText;
        
        // Handle different response types from AI providers
        if (typeof response === 'string') {
          responseText = response;
        } else if (response && typeof response === 'object') {
          // Try common object properties
          responseText = response.content || response.text || response.message || response.choices?.[0]?.message?.content || JSON.stringify(response);
        } else {
          throw new Error(`Unexpected response type: ${typeof response}`);
        }
        
        logger.debug(`Extracted response text: ${responseText}`);
        
        // Strip all code fences — Claude nests ```javascript inside ```json
        let cleaned = responseText.replace(/```\w*\n?/g, '');

        // Find outermost JSON array or object
        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');

        let jsonStr;
        // Prefer array (bug analysis returns arrays), fall back to object
        if (firstBracket !== -1 && lastBracket > firstBracket &&
            (firstBrace === -1 || firstBracket < firstBrace)) {
          jsonStr = cleaned.substring(firstBracket, lastBracket + 1);
        } else if (firstBrace !== -1 && lastBrace > firstBrace) {
          jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
        } else {
          jsonStr = cleaned.trim();
        }

        // Clean up trailing commas
        jsonStr = jsonStr.replace(/,(\s*[\]}])/g, '$1');

        try {
          bugAnalysis = JSON.parse(jsonStr);
        } catch (innerErr) {
          // Sanitize embedded newlines in string values and retry
          jsonStr = jsonStr.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
            return match.replace(/[\n\r\t]/g, ' ');
          });
          logger.debug(`Retrying parse after sanitization: ${jsonStr.substring(0, 200)}`);
          bugAnalysis = JSON.parse(jsonStr);
        }
        logger.debug(`Parsed bug analysis:`, bugAnalysis);
      } catch (parseError) {
        logger.error(`Failed to parse AI response for ${relativePath}: ${parseError.message}`);
        logger.debug(`Raw AI response: ${response}`);
        return [];
      }
      
      // Validate and enhance the bugs
      const validBugs = [];
      for (const bug of Array.isArray(bugAnalysis) ? bugAnalysis : []) {
        if (bug.line && bug.pattern && bug.severity && bug.title) {
          // Get surrounding context for the bug
          const contextLines = this.getCodeContext(lines, bug.line - 1, 5);
          const functionContext = this.getFunctionContext(lines, bug.line - 1);
          
          const enhancedBug = {
            id: `bug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            title: `${bug.pattern}: ${relativePath}:${bug.line}`,
            description: bug.description || bug.title,
            severity: bug.severity,
            priority: this.severityToPriority(bug.severity),
            status: 'open',
            foundBy: 'agent',
            foundDate: new Date().toISOString(),
            file: relativePath,
            line: bug.line,
            code: bug.code || (lines[bug.line - 1] ? lines[bug.line - 1].trim() : ''),
            pattern: bug.pattern,
            tags: ['automated', 'ai-analysis'],
            environment: 'development',
            projectId: 'lanagent',
            context: {
              surroundingLines: contextLines,
              functionContext: functionContext,
              filePath: filePath,
              lineNumber: bug.line
            }
          };
          
          validBugs.push(enhancedBug);
        }
      }
      
      logger.info(`AI found ${validBugs.length} bugs in ${relativePath}`);
      return validBugs;
      
    } catch (error) {
      logger.error(`AI analysis failed for ${relativePath}: ${error.message}`);
      return [];
    }
  }

  getLineNumber(content, index) {
    const beforeIndex = content.substring(0, index);
    return beforeIndex.split('\n').length;
  }

  /**
   * Get surrounding code context for better bug reports
   */
  getCodeContext(lines, lineIndex, contextSize = 5) {
    const startLine = Math.max(0, lineIndex - contextSize);
    const endLine = Math.min(lines.length - 1, lineIndex + contextSize);
    
    const contextLines = [];
    for (let i = startLine; i <= endLine; i++) {
      contextLines.push({
        lineNumber: i + 1,
        content: lines[i] || '',
        isTarget: i === lineIndex
      });
    }
    
    return contextLines;
  }

  /**
   * Find the function or method context containing the bug
   */
  getFunctionContext(lines, lineIndex) {
    let functionStart = -1;
    let functionName = 'unknown';
    let indentLevel = 0;
    
    // Search backwards for function declaration
    for (let i = lineIndex; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      
      // Look for function patterns
      const functionMatch = line.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)|(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{|class\s+(\w+))/);
      if (functionMatch) {
        functionName = functionMatch[1] || functionMatch[2] || functionMatch[3] || functionMatch[4] || 'anonymous';
        functionStart = i;
        break;
      }
      
      // Stop if we've gone too far back
      if (i < lineIndex - 20) break;
    }
    
    return {
      functionName,
      startLine: functionStart + 1,
      contextFound: functionStart !== -1
    };
  }

  /**
   * Generate enhanced bug description with context and location
   */
  generateEnhancedDescription(pattern, relativePath, lineNumber, code, contextLines, functionContext) {
    let description = `**🐛 ${pattern.name} Detected**\n\n`;
    description += `${pattern.description}\n\n`;
    
    // Severity and Impact
    description += `**🚨 Severity & Impact:**\n`;
    description += `- **Severity Level:** \`${pattern.severity}\`\n`;
    const impactDescription = this.getSeverityImpact(pattern.severity);
    if (impactDescription) {
      description += `- **Impact:** ${impactDescription}\n`;
    }
    description += `- **Pattern Category:** Code Quality${pattern.severity === 'critical' || pattern.severity === 'high' ? ' & Security' : ''}\n\n`;
    
    // Location information
    description += `**📍 Location Details:**\n`;
    description += `- **File:** \`${relativePath}\`\n`;
    description += `- **Line Number:** ${lineNumber}\n`;
    if (functionContext.contextFound) {
      description += `- **Function/Method:** \`${functionContext.functionName}\` (defined at line ${functionContext.startLine})\n`;
    }
    
    // Problem code with enhanced formatting
    description += `\n**💻 Problematic Code:**\n`;
    description += `\`\`\`javascript\n${code}\n\`\`\`\n\n`;
    
    // Enhanced code context with more detail
    description += `**🔍 Code Context (±5 lines):**\n`;
    description += `\`\`\`javascript\n`;
    contextLines.forEach(line => {
      const prefix = line.isTarget ? '>>> ' : '    ';
      const lineNum = String(line.lineNumber).padStart(3, ' ');
      description += `${prefix}${lineNum}: ${line.content}\n`;
    });
    description += `\`\`\`\n`;
    description += `*Note: Lines marked with \`>>>\` indicate the problematic code.*\n\n`;
    
    // Specific guidance based on pattern with enhanced details
    const guidance = this.getPatternGuidance(pattern.name);
    if (guidance) {
      description += `**🛠️ Recommended Solution:**\n${guidance}\n\n`;
      
      // Add example fix if possible
      const exampleFix = this.getExampleFix(pattern.name, code);
      if (exampleFix) {
        description += `**✅ Example Fix:**\n`;
        description += `\`\`\`javascript\n${exampleFix}\n\`\`\`\n\n`;
      }
    }
    
    // Risk assessment
    const riskInfo = this.getRiskAssessment(pattern.name, pattern.severity);
    if (riskInfo) {
      description += `**⚠️ Risk Assessment:**\n${riskInfo}\n\n`;
    }
    
    // Related patterns and best practices
    const relatedInfo = this.getRelatedBestPractices(pattern.name);
    if (relatedInfo) {
      description += `**📚 Related Best Practices:**\n${relatedInfo}\n\n`;
    }
    
    description += `**🔗 Quick Navigation:** \`${relativePath}:${lineNumber}\`\n`;
    description += `**🔍 Pattern Match:** \`${pattern.name}\``;
    
    return description;
  }

  /**
   * Get pattern-specific guidance for fixing bugs
   */
  getPatternGuidance(patternName) {
    const guidance = {
      'Missing Error Handling': '🔧 **Add proper error handling:** Wrap async operations in try-catch blocks or add .catch() handlers to prevent unhandled promise rejections and application crashes.',
      'Console.log in Production': '📝 **Use structured logging:** Replace console.log with proper logging infrastructure (logger.info(), logger.debug(), etc.) to enable proper log management and filtering.',
      'Hardcoded Credentials': '🔐 **Secure sensitive data:** Move credentials, API keys, and secrets to environment variables or secure configuration management systems.',
      'SQL Injection Risk': '🛡️ **Prevent injection attacks:** Use parameterized queries, prepared statements, or proper SQL escaping to prevent malicious SQL injection attacks.',
      'Undefined Variable Access': '🔍 **Add null/undefined checks:** Implement proper validation and null checks before accessing object properties to prevent runtime errors.',
      'Missing Input Validation': '✅ **Validate user input:** Sanitize and validate all user input before processing to prevent security vulnerabilities and runtime errors.',
      'Resource Leak': '🔒 **Manage resource lifecycle:** Properly close connections, clear timers, and clean up resources using finally blocks or proper lifecycle management.',
      'Deprecated Node.js APIs': '📦 **Update to modern APIs:** Replace deprecated Node.js APIs with their modern, secure equivalents as recommended in the latest documentation.'
    };
    
    return guidance[patternName] || '🔧 **Review and fix:** Analyze the code for potential issues and apply appropriate fixes according to best practices.';
  }

  /**
   * Get severity impact description
   */
  getSeverityImpact(severity) {
    const impacts = {
      'critical': 'Immediate security risk or application failure. Requires urgent attention.',
      'high': 'Significant security risk or functionality impact. Should be addressed quickly.',
      'medium': 'Moderate impact on security or code maintainability. Plan for resolution.',
      'low': 'Minor code quality issue. Address when convenient.'
    };
    
    return impacts[severity] || 'Impact level unknown';
  }

  /**
   * Generate example fix for common patterns
   */
  getExampleFix(patternName, originalCode) {
    const fixes = {
      'Missing Error Handling': () => {
        if (originalCode.includes('await')) {
          return `try {\n  ${originalCode}\n} catch (error) {\n  logger.error('Operation failed:', error);\n  throw error; // Re-throw or handle appropriately\n}`;
        } else if (originalCode.includes('fetch(')) {
          return `${originalCode}\n  .catch(error => {\n    logger.error('HTTP request failed:', error);\n    throw error;\n  })`;
        }
        return null;
      },
      'Console.log in Production': () => {
        if (originalCode.includes('console.log')) {
          return originalCode.replace(/console\.log/g, 'logger.info');
        } else if (originalCode.includes('console.debug')) {
          return originalCode.replace(/console\.debug/g, 'logger.debug');
        }
        return null;
      },
      'Hardcoded Credentials': () => {
        return `// Move to environment variables:\nconst apiKey = process.env.API_KEY;\nconst dbPassword = process.env.DB_PASSWORD;\n\n// Or use a config file:\nconst config = require('./config/secrets.json');`;
      },
      'Missing Input Validation': () => {
        return `// Add input validation:\nif (!data || typeof data !== 'object') {\n  throw new Error('Invalid input data');\n}\n\n// Validate specific fields:\nif (!data.email || !isValidEmail(data.email)) {\n  throw new Error('Valid email required');\n}\n\n${originalCode}`;
      }
    };
    
    const fixGenerator = fixes[patternName];
    return fixGenerator ? fixGenerator() : null;
  }

  /**
   * Get risk assessment for the bug pattern
   */
  getRiskAssessment(patternName, severity) {
    const risks = {
      'Missing Error Handling': '- **Runtime Crashes:** Unhandled errors can crash the application\n- **User Experience:** Poor error handling leads to bad user experience\n- **Debugging Difficulty:** Makes troubleshooting production issues harder',
      'Console.log in Production': '- **Performance Impact:** Console output in production can slow down application\n- **Information Leakage:** May expose sensitive information in logs\n- **Log Management:** Difficult to filter and manage unstructured console output',
      'Hardcoded Credentials': '- **Security Breach:** Credentials in code can be exposed via version control\n- **Rotation Difficulty:** Hard to update credentials without code changes\n- **Audit Trail:** No proper tracking of credential usage',
      'SQL Injection Risk': '- **Data Breach:** Attackers can access, modify, or delete database data\n- **System Compromise:** Can lead to complete system takeover\n- **Compliance Issues:** Violates security standards and regulations',
      'Missing Input Validation': '- **Security Vulnerabilities:** Can lead to injection attacks\n- **Data Corruption:** Invalid data can corrupt system state\n- **System Instability:** Unexpected input can cause crashes',
      'Resource Leak': '- **Memory Issues:** Can lead to memory leaks and performance degradation\n- **System Overload:** Accumulated resource usage can overwhelm system\n- **Service Disruption:** Can cause application to become unresponsive'
    };
    
    return risks[patternName] || null;
  }

  /**
   * Get related best practices information
   */
  getRelatedBestPractices(patternName) {
    const practices = {
      'Missing Error Handling': '- Implement a global error handler for unhandled promise rejections\n- Use async/await with proper try-catch blocks\n- Log errors with sufficient context for debugging\n- Return meaningful error messages to users',
      'Console.log in Production': '- Use structured logging libraries (winston, bunyan, etc.)\n- Implement log levels (debug, info, warn, error)\n- Configure different log outputs for different environments\n- Use correlation IDs for request tracking',
      'Hardcoded Credentials': '- Use environment variables for configuration\n- Implement secret management systems (HashiCorp Vault, AWS Secrets Manager)\n- Rotate credentials regularly\n- Never commit secrets to version control',
      'SQL Injection Risk': '- Always use parameterized queries or prepared statements\n- Validate and sanitize all user input\n- Use an ORM or query builder that handles escaping\n- Implement principle of least privilege for database access',
      'Missing Input Validation': '- Validate input at API boundaries\n- Use schema validation libraries (Joi, Yup, etc.)\n- Implement whitelist validation approach\n- Sanitize data before processing',
      'Resource Leak': '- Use connection pooling for database connections\n- Implement proper cleanup in finally blocks\n- Use resource management patterns (using statements)\n- Monitor resource usage in production'
    };
    
    return practices[patternName] || null;
  }

  severityToPriority(severity) {
    const mapping = {
      'critical': 'critical',
      'high': 'high', 
      'medium': 'medium',
      'low': 'low'
    };
    return mapping[severity] || 'medium';
  }

  prioritizeAndLimitBugs(bugs, limit = 5) {
    // Define severity/priority rankings
    const severityRank = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    const priorityRank = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    
    // Sort bugs by severity first, then by priority, then by whether they're security-related
    const sortedBugs = bugs.sort((a, b) => {
      // Primary sort: Severity (critical > high > medium > low)
      const severityDiff = (severityRank[b.severity] || 2) - (severityRank[a.severity] || 2);
      if (severityDiff !== 0) return severityDiff;
      
      // Secondary sort: Priority (critical > high > medium > low)
      const priorityDiff = (priorityRank[b.priority] || 2) - (priorityRank[a.priority] || 2);
      if (priorityDiff !== 0) return priorityDiff;
      
      // Tertiary sort: Security-related bugs get higher priority
      const aIsSecurity = a.tags?.includes('security') ? 1 : 0;
      const bIsSecurity = b.tags?.includes('security') ? 1 : 0;
      if (bIsSecurity !== aIsSecurity) return bIsSecurity - aIsSecurity;
      
      // Quaternary sort: Error handling bugs are important
      const aIsErrorHandling = a.tags?.includes('error-handling') ? 1 : 0;
      const bIsErrorHandling = b.tags?.includes('error-handling') ? 1 : 0;
      
      return bIsErrorHandling - aIsErrorHandling;
    });
    
    // Return only the top N bugs
    return sortedBugs.slice(0, limit);
  }

  async checkErrorHandling(content, lines, relativePath, filePath) {
    const bugs = [];
    const asyncPattern = /(?:await\s+[^}]+)|(?:new\s+Promise)|(?:fetch\()|(?:fs\.[^(]+\()/g;
    const matches = [...content.matchAll(asyncPattern)];
    
    for (const match of matches) {
      const lineNumber = this.getLineNumber(content, match.index);
      const line = lines[lineNumber - 1];
      
      // Check if this line is inside a try-catch block
      const isTryCovered = this.isInTryCatch(content, match.index);
      
      if (!isTryCovered && !line.includes('.catch') && !line.includes('try')) {
        const fingerprint = this.generateBugFingerprint(relativePath, lineNumber, 'Missing Error Handling');
        
        // Get enhanced code context for better bug fixing
        const codeContext = this.getCodeContext(lines, lineNumber);
        const functionContext = this.getFunctionContext(content, match.index);
        const suggestedFix = this.generateErrorHandlingFix(line.trim(), functionContext);
        
        // Use enhanced description generation
        const contextLines = this.getCodeContext(lines, lineNumber - 1, 5);
        const enhancedDescription = this.generateEnhancedDescription(
          { name: 'Missing Error Handling', description: 'Async operation without proper error handling', severity: 'medium' },
          relativePath, lineNumber, line.trim(), contextLines, functionContext
        );

        bugs.push({
          id: `bug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title: `Missing Error Handling: ${relativePath}:${lineNumber}`,
          description: enhancedDescription,
          severity: 'medium',
          priority: 'medium',
          status: 'open',
          foundBy: 'agent',
          foundDate: new Date().toISOString(),
          file: relativePath,
          line: lineNumber,
          code: line.trim(),
          context: {
            surroundingLines: contextLines,
            functionContext: functionContext,
            filePath: filePath,
            lineNumber: lineNumber
          },
          suggestedFix: suggestedFix,
          pattern: 'Missing Error Handling',
          tags: ['automated', 'error-handling', 'async'],
          environment: 'development',
          projectId: 'lanagent',
          fingerprint: fingerprint
        });
      }
    }
    
    return bugs;
  }

  isInTryCatch(content, index) {
    const beforeIndex = content.substring(0, index);
    const afterIndex = content.substring(index);
    
    // Simple heuristic: check if there's a try before and catch after
    const lastTry = beforeIndex.lastIndexOf('try');
    const lastCatch = beforeIndex.lastIndexOf('catch');
    const nextCatch = afterIndex.indexOf('catch');
    
    return lastTry > lastCatch && nextCatch !== -1;
  }

  async checkUndefinedAccess(content, lines, relativePath, filePath) {
    // This would require more sophisticated AST parsing
    // For now, return empty array
    return [];
  }

  async checkInputValidation(content, lines, relativePath, filePath) {
    const bugs = [];
    const inputPattern = /(?:params\.|data\.|req\.body\.)(\w+)/g;
    const matches = [...content.matchAll(inputPattern)];
    
    for (const match of matches) {
      const lineNumber = this.getLineNumber(content, match.index);
      const line = lines[lineNumber - 1];
      
      // Check if there's validation nearby
      const hasValidation = line.includes('validate') || 
                           line.includes('required') || 
                           line.includes('typeof') ||
                           content.substring(match.index - 200, match.index + 200).includes('validateParams');
      
      if (!hasValidation) {
        const fingerprint = this.generateBugFingerprint(relativePath, lineNumber, 'Missing Input Validation');
        
        // Generate enhanced description
        const contextLines = this.getCodeContext(lines, lineNumber - 1, 5);
        const functionContext = this.getFunctionContext(lines, lineNumber - 1);
        const enhancedDescription = this.generateEnhancedDescription(
          { name: 'Missing Input Validation', description: `User input field '${match[1]}' used without validation`, severity: 'medium' },
          relativePath, lineNumber, line.trim(), contextLines, functionContext
        );
        
        bugs.push({
          id: `bug_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title: `Missing Input Validation: ${relativePath}:${lineNumber}`,
          description: enhancedDescription,
          severity: 'medium',
          priority: 'medium', 
          status: 'open',
          foundBy: 'agent',
          foundDate: new Date().toISOString(),
          file: relativePath,
          line: lineNumber,
          code: line.trim(),
          context: {
            surroundingLines: contextLines,
            functionContext: functionContext,
            filePath: filePath,
            lineNumber: lineNumber
          },
          inputField: match[1],
          pattern: 'Missing Input Validation',
          tags: ['automated', 'security'],
          environment: 'development',
          projectId: 'lanagent',
          fingerprint: fingerprint
        });
      }
    }
    
    return bugs;
  }

  async checkResourceLeaks(content, lines, relativePath, filePath) {
    // Simple check for resources that might not be cleaned up
    // Would need more sophisticated analysis for real detection
    return [];
  }

  async storeBugsInProject(bugs, autoCreateGitHubIssues = false) {
    logger.info('=== STORING BUGS IN PROJECT ===');
    logger.info(`Number of bugs to store: ${bugs.length}`);
    logger.info(`Auto create GitHub issues: ${autoCreateGitHubIssues}`);
    
    try {
      // Step D1: Get projects plugin
      logger.info('Step D1: Getting projects plugin...');
      const projectsPlugin = this.agent.apiManager.getPlugin('projects');
      if (!projectsPlugin) {
        logger.error('Step D1 failed - Projects plugin not available');
        throw new Error('Projects plugin not available for bug storage');
      }
      logger.info('Step D1 completed - projects plugin found');

      // Step D2: Store each bug
      logger.info('Step D2: Storing individual bugs...');
      let storedCount = 0;
      let errorCount = 0;
      
      for (const [index, bug] of bugs.entries()) {
        try {
          logger.info(`Storing bug ${index + 1}/${bugs.length}: ${bug.title}`);
          
          // Simplify bug object for storage - remove complex nested objects
          const simplifiedBug = {
            id: bug.id,
            title: bug.title,
            description: bug.description,
            severity: bug.severity,
            priority: bug.priority,
            status: bug.status,
            foundBy: bug.foundBy,
            foundDate: bug.foundDate,
            file: bug.file,
            line: bug.line,
            code: bug.code,
            pattern: bug.pattern,
            tags: bug.tags,
            environment: bug.environment,
            projectId: bug.projectId,
            fingerprint: bug.fingerprint
          };

          // Store bug directly in BugReport collection
          const { BugReport } = await import('../../models/BugReport.js');
          // Map AI status values to valid BugReport enum values
          const validStatuses = ['new', 'analyzing', 'in-progress', 'fixed', 'ignored', 'duplicate'];
          const statusMap = { 'open': 'new', 'pending': 'new', 'active': 'analyzing', 'resolved': 'fixed', 'closed': 'fixed' };
          let bugStatus = bug.status || 'new';
          if (!validStatuses.includes(bugStatus)) {
            bugStatus = statusMap[bugStatus] || 'new';
          }

          const bugReport = new BugReport({
            bugId: bug.id || `bug_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            title: bug.title || bug.pattern || bug.description?.substring(0, 200) || 'Untitled bug',
            fingerprint: bug.fingerprint,
            type: 'bug',
            pattern: bug.pattern || bug.title || 'unknown',
            description: bug.description || bug.title || '',
            severity: ['critical', 'high', 'medium', 'low'].includes(bug.severity) ? bug.severity : 'medium',
            priority: ['critical', 'high', 'medium', 'low'].includes(bug.priority) ? bug.priority : 'medium',
            file: bug.file,
            line: bug.line,
            code: bug.code,
            foundBy: bug.foundBy,
            foundDate: bug.foundDate || new Date(),
            status: bugStatus,
            tags: bug.tags || [],
            metadata: {
              id: bug.id,
              environment: bug.environment,
              projectId: bug.projectId,
              title: bug.title
            }
          });
          
          await bugReport.save();
          logger.info(`Successfully stored bug ${index + 1} in BugReport collection: ${bug.id}`);
          
          // Also try to store in projects plugin (for backwards compatibility)
          try {
            await projectsPlugin.execute({
              action: 'createBug',
              ...simplifiedBug
            });
            logger.info(`Also stored bug in projects plugin: ${bug.id}`);
          } catch (projectError) {
            logger.debug(`Projects plugin storage failed (expected): ${projectError.message}`);
          }
          
          storedCount++;
          
          // Step D3: Create GitHub issue if needed
          if (autoCreateGitHubIssues) {
            logger.info(`Creating GitHub issue for ${bug.severity} severity bug: ${bug.id}`);
            try {
              const githubResult = await this.createGitHubIssueWithDuplicateCheck(bug, { justStored: true });
              if (githubResult.success) {
                logger.info(`GitHub issue created successfully for bug: ${bug.id} - Issue #${githubResult.issue?.number}`);
              } else if (githubResult.skipped) {
                logger.info(`Skipped creating GitHub issue for bug ${bug.id}: ${githubResult.error}`);
              } else {
                logger.error(`Failed to create GitHub issue for bug ${bug.id}: ${githubResult.error}`);
                errorCount++;
              }
            } catch (gitHubError) {
              logger.error(`Failed to create GitHub issue for bug ${bug.id}: ${gitHubError.message}`);
              errorCount++;
            }
          }
          
        } catch (error) {
          logger.error(`Failed to store bug ${index + 1} (${bug.id}): ${error.message}`);
          errorCount++;
        }
      }
      
      logger.info(`=== BUG STORAGE COMPLETED ===`);
      logger.info(`Stored: ${storedCount}/${bugs.length} bugs successfully`);
      if (errorCount > 0) {
        logger.warn(`Errors: ${errorCount} bugs failed to store/process`);
      }
      
      return { success: true, stored: storedCount, errors: errorCount };
      
    } catch (error) {
      logger.error('=== BUG STORAGE FAILED ===');
      logger.error(`Error in storeBugsInProject: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  async createGitHubIssue(data) {
    this.validateParams(data, {
      bugId: { required: true, type: 'string' }
    });

    const gitPlugin = this.agent.apiManager.getPlugin('git');
    if (!gitPlugin) {
      return { success: false, error: 'Git plugin not available' };
    }

    // Get bug details
    const bugResult = await this.getBug(data);
    if (!bugResult.success) {
      return bugResult;
    }

    const bug = bugResult.bug;
    return this.createGitHubIssueFromBug(bug);
  }

  async createGitHubIssueFromBug(bug) {
    const gitPlugin = this.agent.apiManager.getPlugin('git');
    if (!gitPlugin) {
      return { success: false, error: 'Git plugin not available' };
    }

    // Create GitHub issue using bug object directly
    const issueData = {
      title: bug.title,
      body: this.formatBugAsIssue(bug),
      labels: ['bug', 'automated', ...bug.tags],
      assignees: bug.assignedTo ? [bug.assignedTo] : []
    };

    const result = await gitPlugin.execute({
      action: 'createIssue',
      ...issueData
    });

    if (result.success) {
      // Update bug with GitHub issue info
      const projectsPlugin = this.agent.apiManager.getPlugin('projects');
      if (projectsPlugin) {
        await projectsPlugin.execute({
          action: 'updateBug',
          bugId: bug.id,
          githubIssue: {
            number: result.issue.number,
            url: result.issue.url,
            createdAt: result.issue.createdAt
          }
        });
      }
    }

    return result;
  }

  formatBugAsIssue(bug) {
    let issueBody = `# ${bug.pattern || 'Bug Detected'}

## 🔍 Problem Description
${bug.description}

## 📍 Location Details
- **File:** \`${bug.file}\`
- **Line:** ${bug.line}
- **Severity:** \`${bug.severity}\` 
- **Priority:** \`${bug.priority}\`
- **Pattern:** \`${bug.pattern}\`

## 💻 Code Context
### Problematic Code:
\`\`\`javascript
${bug.code}
\`\`\`

${bug.context?.surroundingLines ? `### Surrounding Code:
\`\`\`javascript
${bug.context.surroundingLines.map(line => {
  const marker = line.isTarget ? '>>> ' : '    ';
  return `${marker}${String(line.lineNumber).padStart(3, ' ')}: ${line.content}`;
}).join('\n')}
\`\`\`

` : ''}${bug.context?.functionContext?.contextFound ? `### Function Context:
- **Function Name:** \`${bug.context.functionContext.functionName}\`
- **Function Start Line:** ${bug.context.functionContext.startLine}

` : ''}## 🛠️ Recommended Fix
${this.getPatternGuidance(bug.pattern)}

${bug.suggestedFix ? `### Suggested Code Fix:
\`\`\`javascript
${bug.suggestedFix}
\`\`\`

` : ''}## 🏷️ Additional Information
- **Found By:** ${bug.foundBy}
- **Found Date:** ${new Date(bug.foundDate).toLocaleDateString()} ${new Date(bug.foundDate).toLocaleTimeString()}
- **Environment:** ${bug.environment}
- **Tags:** ${bug.tags?.join(', ') || 'None'}
- **Bug ID:** \`${bug.id}\`
${bug.fingerprint ? `- **Fingerprint:** \`${bug.fingerprint}\`\n` : ''}
${bug.reproduction ? `## 🔄 Reproduction Steps
${bug.reproduction}

` : ''}${bug.expectedBehavior ? `## ✅ Expected Behavior
${bug.expectedBehavior}

` : ''}${bug.actualBehavior ? `## ❌ Actual Behavior
${bug.actualBehavior}

` : ''}## 🔗 File Navigation
[View file at line ${bug.line}](${bug.context?.filePath ? bug.context.filePath.replace(/^\//, '') : bug.file}#L${bug.line})

---
*🤖 This issue was automatically created by LANAgent's enhanced bug detection system.*  
*For questions about this automated detection, refer to the bug detection documentation.*`;

    return issueBody;
  }

  /**
   * Generate a unique fingerprint for a bug to prevent duplicates
   */
  generateBugFingerprint(file, line, pattern) {
    const normalizedFile = file.replace(/^\.\.?\/?/, ''); // Remove relative path prefixes
    const fingerprintData = `${normalizedFile}:${line}:${pattern}`;
    return crypto.createHash('sha256').update(fingerprintData).digest('hex').substring(0, 16);
  }

  /**
   * Check if a bug is a duplicate based on fingerprint
   */
  async isDuplicateBug(fingerprint, { skipDbCheck = false } = {}) {
    // Check database for existing bug reports with this fingerprint
    // skipDbCheck is used when we just stored the bug ourselves in the same run
    if (!skipDbCheck) {
      try {
        const { BugReport } = await import('../../models/BugReport.js');
        const existingBug = await BugReport.findOne({ fingerprint });
        if (existingBug) {
          logger.info(`Found existing bug report in database with fingerprint: ${fingerprint}`);
          return true;
        }
      } catch (error) {
        logger.warn('Failed to check database for duplicate bugs:', error);
      }
    }

    // Fall back to local state check
    const duplicateState = this.getState('duplicates') || { fingerprints: [], lastCleanup: null };
    
    // Convert array back to Set for efficient operations
    const fingerprintSet = new Set(duplicateState.fingerprints);
    
    // Clean up old fingerprints periodically (older than 30 days)
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    if (!duplicateState.lastCleanup || duplicateState.lastCleanup < thirtyDaysAgo) {
      // For simplicity, we'll just reset the cache periodically
      // In production, you might want more sophisticated cleanup
      fingerprintSet.clear();
      duplicateState.lastCleanup = now;
    }
    
    const isDuplicate = fingerprintSet.has(fingerprint);
    if (!isDuplicate) {
      fingerprintSet.add(fingerprint);
      this.setState('duplicates', {
        fingerprints: Array.from(fingerprintSet), // Convert Set to Array for storage
        lastCleanup: duplicateState.lastCleanup
      });
    }
    
    return isDuplicate;
  }

  /**
   * Check GitHub for existing issues to prevent duplicates
   */
  async checkGitHubForDuplicateIssue(bug) {
    try {
      const gitPlugin = this.agent.apiManager.getPlugin('git');
      if (!gitPlugin) {
        return false; // Can't check, assume not duplicate
      }

      // Search for issues with similar title patterns or fingerprint
      // Search for duplicates in the fork's repo (not hardcoded to genesis)
      let repoSlug;
      try {
        const { getOriginSlug } = await import('../../utils/repoInfo.js');
        repoSlug = getOriginSlug();
      } catch { repoSlug = 'PortableDiag/LANAgent'; }
      const searchQueries = [
        `${bug.pattern} ${bug.file} in:title repo:${repoSlug}`,
        `"${bug.fingerprint}" in:body repo:${repoSlug}`
      ];
      
      for (const searchQuery of searchQueries) {
        const searchResult = await gitPlugin.execute({
          action: 'searchIssues',
          query: searchQuery,
          state: 'all' // Check both open and closed issues
        });

        if (searchResult.success && searchResult.issues && searchResult.issues.length > 0) {
          // Check if any issue matches our specific file and line
          for (const issue of searchResult.issues) {
            if (issue.title.includes(`${bug.file}:${bug.line}`) ||
                (issue.body.includes(`**File:** \`${bug.file}\``) &&
                 issue.body.includes(`**Line:** ${bug.line}`)) ||
                (bug.fingerprint && issue.body.includes(bug.fingerprint))) {
              logger.info(`Found duplicate GitHub issue: ${issue.url}`);
              return true;
            }
          }
        }
      }
      
      return false;
    } catch (error) {
      logger.warn(`Error checking GitHub for duplicates: ${error.message}`);
      return false; // On error, assume not duplicate to avoid missing real bugs
    }
  }

  /**
   * Enhanced GitHub issue creation with duplicate prevention
   */
  async createGitHubIssueWithDuplicateCheck(bug, { justStored = false } = {}) {
    try {
      // Check fingerprint cache — skip DB check if we just stored this bug in the same run
      if (bug.fingerprint && await this.isDuplicateBug(bug.fingerprint, { skipDbCheck: justStored })) {
        logger.info(`Skipping duplicate bug based on fingerprint: ${bug.title}`);
        return { success: false, error: 'Duplicate bug (fingerprint match)', skipped: true };
      }

      // Check GitHub for existing similar issues
      const isDuplicateOnGitHub = await this.checkGitHubForDuplicateIssue(bug);
      if (isDuplicateOnGitHub) {
        logger.info(`Skipping duplicate bug found on GitHub: ${bug.title}`);
        return { success: false, error: 'Duplicate bug (GitHub match)', skipped: true };
      }

      // Create the issue if no duplicates found
      const gitPlugin = this.agent.apiManager.getPlugin('git');
      if (!gitPlugin) {
        return { success: false, error: 'Git plugin not available' };
      }

      const issueBody = `# ${bug.pattern}

**File:** \`${bug.file}\`  
**Line:** ${bug.line}  
**Severity:** ${bug.severity}  
**Priority:** ${bug.priority}

## Description
${bug.description}

## Code Context
\`\`\`javascript
${bug.code}
\`\`\`

## Bug Details
- **Found by:** ${bug.foundBy}
- **Found date:** ${bug.foundDate}
- **Environment:** ${bug.environment}
- **Bug ID:** ${bug.id}
- **Fingerprint:** ${bug.fingerprint}

---
*This issue was automatically created by LANAgent's bug detection system.*`;

      const issueResult = await gitPlugin.execute({
        action: 'createIssue',
        title: `${bug.pattern}: ${bug.file}:${bug.line}`,
        body: issueBody,
        labels: ['bug', 'automated', bug.severity, ...bug.tags]
      });

      if (issueResult.success) {
        // Mark this fingerprint as used to prevent future duplicates
        if (bug.fingerprint) {
          await this.isDuplicateBug(bug.fingerprint); // This will add it to our cache
        }
        
        logger.info(`Successfully created GitHub issue: ${issueResult.issue.url}`);
        
        // Send Telegram notification if enabled
        const settings = await this.getSettings();
        if (settings.settings?.sendTelegramNotifications) {
          try {
            const notificationMessage = `🐛 *Bug Detected*\n\n` +
              `*Severity:* ${escapeMarkdown(bug.severity)}\n` +
              `*Type:* ${escapeMarkdown(bug.type)}\n` +
              `*File:* \`${escapeMarkdown(bug.file)}\`\n` +
              `*Line:* ${bug.line}\n` +
              `*Title:* ${escapeMarkdown(bug.title)}\n` +
              `*Description:* ${escapeMarkdown(truncateText(bug.description, 200))}\n\n` +
              `*GitHub Issue:* [#${issueResult.issue.number}](${issueResult.issue.url})\n\n` +
              `LANAgent has automatically created a GitHub issue to track this bug.`;
            
            // Get telegram interface from agent's interfaces map
            const telegramInterface = this.agent?.interfaces?.get('telegram');
            if (telegramInterface?.sendNotification) {
              await telegramInterface.sendNotification(notificationMessage, {
                disable_web_page_preview: false
              });
              logger.info('[BugDetector] Sent Telegram notification for GitHub issue');
            } else {
              logger.warn('[BugDetector] Telegram interface not available for notifications');
            }
          } catch (notifyError) {
            logger.warn('[BugDetector] Failed to send Telegram notification:', notifyError);
          }
        } else {
          logger.info('[BugDetector] Telegram notifications disabled in settings');
        }
      }

      return issueResult;
      
    } catch (error) {
      logger.error(`Error creating GitHub issue: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getSettings() {
    const currentSettings = this.getState('settings') || {};
    // Always merge with defaults to ensure all properties exist
    const settings = { ...this.defaultSettings, ...currentSettings };
    
    return { success: true, settings };
  }

  async updateSettings(data) {
    const currentSettings = this.getState('settings') || {};
    // Merge: defaults -> current -> new data
    const newSettings = { ...this.defaultSettings, ...currentSettings, ...data };
    
    this.setState('settings', newSettings);
    
    return {
      success: true,
      settings: newSettings,
      message: 'Bug detector settings updated'
    };
  }

  async performDailyScan() {
    logger.info('=== STARTING DAILY BUG SCAN ===');
    
    // Try to acquire lock
    const lockAcquired = await selfModLock.acquire('bug-detector');
    if (!lockAcquired) {
      logger.info('Another self-modification process is running. Skipping bug detection.');
      return { success: false, message: 'Another process is running', skipped: true };
    }
    
    try {
      // Step 1: Load settings
      logger.info('Step 1: Loading bug detection settings...');
      const settings = this.getState('settings') || {};
      logger.info(`DEBUG: Daily scan settings: ${JSON.stringify(settings)}`);
      
      if (!settings.dailyScanEnabled) {
        logger.info('Daily scan disabled in settings - exiting');
        return { success: true, message: 'Daily scan disabled', skipped: true };
      }
      
      // Step 2: Validate scan path
      logger.info('Step 2: Validating scan path...');
      const scanPath = settings.scanPaths?.[0] || (process.env.AGENT_REPO_PATH || process.cwd());
      logger.info(`Using scan path: ${scanPath}`);
      
      // Step 3: Run the scan
      logger.info('Step 3: Starting bug scan...');
      const result = await this.scanForBugs({
        path: scanPath,
        exclude: settings.excludePaths,
        autoCreateGitHubIssues: settings.autoCreateGitHubIssues
      });
      logger.info(`Step 3 completed - scan success: ${result.success}`);
      
      // Step 4: Process results
      logger.info('Step 4: Processing scan results...');
      if (result.success && result.bugsFound && result.bugsFound.length > 0) {
        const originalBugCount = result.bugsFound.length;
        const dailyLimit = settings.dailyBugLimit || 5;
        logger.info(`Found ${originalBugCount} bugs, limiting to top ${dailyLimit}`);
        
        const prioritizedBugs = this.prioritizeAndLimitBugs(result.bugsFound, dailyLimit);
        result.bugsFound = prioritizedBugs;
        result.limitedToTopBugs = true;
        result.originalBugCount = originalBugCount;
        
        logger.info(`Limited daily scan results to ${prioritizedBugs.length} most critical bugs`);
      } else {
        logger.info(`No bugs found or scan failed. Success: ${result.success}, Bug count: ${result.bugsFound?.length || 0}`);
      }
      
      // Step 5: Update settings
      logger.info('Step 5: Updating last scan time...');
      await this.updateSettings({ lastScan: new Date().toISOString() });
      logger.info('Step 5 completed - settings updated');
      
      // Step 6: Prepare final result
      logger.info('Step 6: Preparing final result...');
      const finalResult = {
        ...result,
        scanType: 'daily',
        message: `Daily scan completed. Found ${result.bugsFound?.length || 0} potential issues.`
      };
      
      logger.info(`=== DAILY BUG SCAN COMPLETED SUCCESSFULLY ===`);
      logger.info(`Final result summary: ${JSON.stringify({
        success: finalResult.success,
        bugsFound: finalResult.bugsFound?.length || 0,
        scanDuration: finalResult.scanDuration,
        message: finalResult.message
      }, null, 2)}`);
      
      return finalResult;
      
    } catch (error) {
      logger.error('=== DAILY BUG SCAN FAILED ===');
      logger.error(`Error during daily scan: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      
      return {
        success: false,
        error: error.message,
        scanType: 'daily',
        message: `Daily scan failed: ${error.message}`
      };
    } finally {
      // Always release the lock
      await selfModLock.release('bug-detector');
      logger.info('Released bug detector lock');
    }
  }

  async listBugs(data = {}) {
    try {
      // Import ProcessedBug model
      const { ProcessedBug } = await import('../../models/ProcessedBug.js');

      const { status, limit = 20 } = data;

      // Build query
      const query = {};
      if (status) {
        query.fixResult = status;
      }

      // Fetch bugs from database
      const bugs = await ProcessedBug.find(query)
        .sort({ processedAt: -1 })
        .limit(limit)
        .lean();

      if (bugs.length === 0) {
        return {
          success: true,
          data: {
            bugs: [],
            count: 0,
            message: 'No bugs found in the database.'
          }
        };
      }

      // Format the response
      const formattedBugs = bugs.map(bug => ({
        issueNumber: bug.issueNumber,
        title: bug.issueTitle,
        status: bug.fixResult,
        processedAt: bug.processedAt,
        prUrl: bug.prUrl,
        branchName: bug.branchName,
        errorMessage: bug.errorMessage
      }));

      return {
        success: true,
        data: {
          bugs: formattedBugs,
          count: formattedBugs.length,
          message: `Found ${formattedBugs.length} bug(s).`
        }
      };
    } catch (error) {
      logger.error('Error listing bugs:', error);
      return {
        success: false,
        error: `Failed to list bugs: ${error.message}`
      };
    }
  }

  async getBug(data) {
    const projectsPlugin = this.agent.apiManager.getPlugin('projects');
    if (!projectsPlugin) {
      return { success: false, error: 'Projects plugin not available' };
    }

    return await projectsPlugin.execute({
      action: 'getBug',
      ...data
    });
  }

  /**
   * Test endpoint for debugging bug scan process
   */
  async testBugScan(data = {}) {
    logger.info('=== STARTING TEST BUG SCAN ===');
    
    try {
      // Test different steps individually
      const testType = data.testType || 'full';
      
      switch (testType) {
        case 'settings':
          return await this.testSettings();
        case 'path':
          return await this.testScanPath(data);
        case 'scan':
          return await this.testFileScan(data);
        case 'storage':
          return await this.testBugStorage(data);
        case 'github':
          return await this.testGitHubIssueCreation(data);
        case 'full':
        default:
          return await this.performDailyScan();
      }
      
    } catch (error) {
      logger.error('=== TEST BUG SCAN FAILED ===');
      logger.error(`Error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      return { success: false, error: error.message, testType };
    }
  }

  async testSettings() {
    logger.info('Testing settings...');
    const settingsResult = await this.getSettings();
    logger.info(`Settings result: ${JSON.stringify(settingsResult, null, 2)}`);
    return { success: true, test: 'settings', result: settingsResult };
  }

  async testScanPath(data = {}) {
    logger.info('Testing scan path...');
    const scanPath = data.path || (process.env.AGENT_REPO_PATH || process.cwd());
    
    try {
      const fs = await import('fs/promises');
      const stat = await fs.stat(scanPath);
      const isDir = stat.isDirectory();
      
      logger.info(`Path: ${scanPath}`);
      logger.info(`Exists: true`);
      logger.info(`Is directory: ${isDir}`);
      
      return { 
        success: true, 
        test: 'path', 
        result: { path: scanPath, exists: true, isDirectory: isDir } 
      };
      
    } catch (error) {
      logger.error(`Path test failed: ${error.message}`);
      return { 
        success: false, 
        test: 'path', 
        error: error.message, 
        result: { path: scanPath, exists: false } 
      };
    }
  }

  async testFileScan(data = {}) {
    logger.info('Testing file scanning...');
    const scanPath = data.path || (process.env.AGENT_REPO_PATH || process.cwd());
    const excludePaths = data.exclude || ['node_modules', '.git', 'logs', 'projects'];
    
    // Just scan without storing
    const result = await this.scanForBugs({ 
      path: scanPath, 
      exclude: excludePaths, 
      autoCreateGitHubIssues: false 
    });
    
    return { success: true, test: 'scan', result };
  }

  async testBugStorage(data = {}) {
    logger.info('Testing bug storage...');
    
    // Create a test bug
    const testBug = {
      id: `test_bug_${Date.now()}`,
      title: 'Test Bug for Storage',
      description: 'This is a test bug to verify storage functionality',
      severity: 'low',
      priority: 'low',
      status: 'open',
      foundBy: 'test',
      foundDate: new Date().toISOString(),
      file: 'test/file.js',
      line: 1,
      code: 'console.log("test");',
      pattern: 'Test Pattern',
      tags: ['test'],
      environment: 'test',
      projectId: 'lanagent-test'
    };
    
    try {
      await this.storeBugsInProject([testBug], false);
      return { success: true, test: 'storage', result: { stored: 1, testBugId: testBug.id } };
    } catch (error) {
      return { success: false, test: 'storage', error: error.message };
    }
  }

  async testGitHubIssueCreation(data = {}) {
    logger.info('Testing GitHub issue creation...');
    
    // This would need a real bug ID from the database
    const bugId = data.bugId || 'test_bug_123';
    
    try {
      const result = await this.createGitHubIssue({ bugId });
      return { success: true, test: 'github', result };
    } catch (error) {
      return { success: false, test: 'github', error: error.message };
    }
  }

  generateErrorHandlingFix(code, functionContext) {
    // Generate specific error handling suggestions based on code patterns
    if (code.includes('await')) {
      return `Wrap await operations in try-catch:\ntry {\n  ${code}\n} catch (error) {\n  logger.error('Operation failed:', error);\n  // Handle error appropriately\n}`;
    } else if (code.includes('fetch(')) {
      return `Add .catch() to fetch:\n${code}\n  .catch(error => {\n    logger.error('Fetch failed:', error);\n    throw error;\n  })`;
    } else if (code.includes('new Promise')) {
      return `Handle Promise rejection:\n${code}\n  .catch(error => {\n    logger.error('Promise rejected:', error);\n    // Handle rejection\n  })`;
    } else {
      return `Add try-catch around potentially throwing operation:\ntry {\n  ${code}\n} catch (error) {\n  logger.error('Error:', error);\n}`;
    }
  }

  /**
   * Clear duplicate detection cache - useful for testing
   */
  async clearDuplicateCache() {
    this.setState('duplicates', { fingerprints: [], lastCleanup: Date.now() });
    return { 
      success: true, 
      message: 'Duplicate detection cache cleared',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get current scan progress
   */
  async getScanProgress(data = {}) {
    try {
      const { ScanProgress } = await import('../../models/ScanProgress.js');
      
      // Find the most recent scan session
      const latestSession = await ScanProgress.findOne({})
        .sort({ createdAt: -1 })
        .select('sessionScanId')
        .exec();
      
      if (!latestSession) {
        return { success: true, isScanning: false };
      }
      
      const sessionId = latestSession.sessionScanId;
      
      // Get progress stats
      const totalEntries = await ScanProgress.countDocuments({ sessionScanId: sessionId });
      const completedEntries = await ScanProgress.countDocuments({ 
        sessionScanId: sessionId, 
        status: 'completed' 
      });
      const processingEntries = await ScanProgress.countDocuments({ 
        sessionScanId: sessionId, 
        status: 'processing' 
      });
      const failedEntries = await ScanProgress.countDocuments({ 
        sessionScanId: sessionId, 
        status: 'failed' 
      });
      
      // Get unique file count
      const uniqueFiles = await ScanProgress.distinct('filePath', { sessionScanId: sessionId });
      
      // Get current file being processed
      const currentFile = await ScanProgress.findOne({ 
        sessionScanId: sessionId, 
        status: 'processing' 
      }).select('relativePath').exec();
      
      // Calculate if still scanning
      const isScanning = processingEntries > 0 || 
        (totalEntries > 0 && completedEntries + failedEntries < totalEntries);
      
      return {
        success: true,
        isScanning,
        sessionId,
        progress: {
          totalFiles: uniqueFiles.length,
          totalChunks: totalEntries,
          completedChunks: completedEntries,
          processingChunks: processingEntries,
          failedChunks: failedEntries,
          percentComplete: totalEntries > 0 ? 
            Math.round((completedEntries + failedEntries) / totalEntries * 100) : 0,
          currentFile: currentFile?.relativePath || null
        }
      };
    } catch (error) {
      logger.error('Failed to get scan progress:', error);
      return { success: false, error: error.message };
    }
  }
}