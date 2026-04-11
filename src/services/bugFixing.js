import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';
import { selfModLock } from './selfModLock.js';

export class BugFixingService extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.enabled = true; // ENABLED BY DEFAULT
    this.isRunning = false;
    this.lastCheckTime = null;
    this.processedBugs = new Set(); // Track processed issue numbers
    this.fixQueue = [];
    
    // Use same git setup as other services
    this.developmentPath = process.env.AGENT_REPO_PATH || process.cwd();

    // Resolve owner/repo dynamically from git remote (not hardcoded)
    let githubOwner = 'PortableDiag', githubRepo = 'LANAgent';
    try {
      const remoteUrl = execSync('git remote get-url origin', { cwd: this.developmentPath, encoding: 'utf8', timeout: 5000 }).trim();
      const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) { githubOwner = match[1]; githubRepo = match[2]; }
    } catch {}

    // Configuration
    this.config = {
      enabled: true,
      maxFixesPerSession: 3,
      githubOwner,
      githubRepo,
      priorityOrder: ['critical', 'high', 'medium', 'low'],
      requireTests: false,
      createPR: true,
      gitToken: process.env.GIT_PERSONAL_ACCESS_TOKEN
    };
    this.git = simpleGit(this.developmentPath);
    
    logger.info(`Bug fixing service using repo path: ${this.developmentPath}`);
    
    // Load processed bugs from MongoDB
    this.loadProcessedBugs();
    
    logger.info('Bug fixing service initialized (ENABLED by default)');
    
    // Load configuration from database
    this.initialize();
  }

  /**
   * Initialize the service with database configuration
   */
  async initialize() {
    try {
      await this.loadConfig();
    } catch (error) {
      logger.error('Failed to initialize bug fixing service:', error);
    }
  }

  /**
   * Load previously processed bugs from MongoDB
   */
  async loadProcessedBugs() {
    try {
      const { ProcessedBug } = await import('../models/ProcessedBug.js');
      const processedBugs = await ProcessedBug.find({}, 'issueNumber');
      this.processedBugs = new Set(processedBugs.map(pb => pb.issueNumber));
      logger.info(`Loaded ${this.processedBugs.size} processed bugs from MongoDB`);
    } catch (error) {
      logger.warn('Failed to load processed bugs from MongoDB:', error.message);
      logger.info('Starting with empty processed bugs set');
      this.processedBugs = new Set();
    }
  }

  /**
   * Save processed bug to MongoDB
   */
  async saveProcessedBug(issueNumber, issueTitle, result) {
    try {
      const { ProcessedBug } = await import('../models/ProcessedBug.js');
      
      const processedBug = new ProcessedBug({
        issueNumber,
        issueTitle,
        fixResult: result.success ? 'success' : (result.skipped ? 'skipped' : 'failed'),
        prUrl: result.prUrl || null,
        branchName: result.branchName || null,
        errorMessage: result.error || null
      });
      
      await processedBug.save();
      logger.info(`Saved processed bug #${issueNumber} to MongoDB`);
    } catch (error) {
      if (error.code === 11000) {
        // Duplicate key error - bug already processed
        logger.info(`Bug #${issueNumber} already exists in MongoDB`);
      } else {
        logger.error('Failed to save processed bug to MongoDB:', error.message);
      }
    }
  }

  /**
   * Enable bug fixing service
   */
  async enable() {
    if (this.enabled) {
      logger.warn('Bug fixing service already enabled');
      return;
    }
    
    if (!this.config.gitToken) {
      throw new Error('Git personal access token required for bug fixing');
    }
    
    this.enabled = true;
    this.config.enabled = true;
    logger.info('Bug fixing service ENABLED');
    
    // Save the enabled state to database
    await this.saveConfig();
    
    this.emit('enabled');
  }

  /**
   * Disable bug fixing service
   */
  async disable() {
    this.enabled = false;
    this.config.enabled = false;
    logger.info('Bug fixing service DISABLED');
    
    // Save the disabled state to database
    await this.saveConfig();
    
    this.emit('disabled');
  }

  /**
   * Main method to check for and fix bugs - called by Agenda scheduler
   */
  async runBugFixingSession() {
    if (!this.enabled || this.isRunning) return;
    
    // Try to acquire lock
    const lockAcquired = await selfModLock.acquire('bug-fixing');
    if (!lockAcquired) {
      logger.info('Another self-modification process is running. Skipping bug fixing.');
      return;
    }
    
    // IMPORTANT: Everything after acquiring the lock must be in try-finally to ensure lock release
    try {
      this.isRunning = true;
      this.lastCheckTime = new Date();
      
      // Save lastCheckTime to database
      await this.saveLastCheckTime();
      logger.info('Starting bug fixing session...');
      
      // 0. Ensure we start from main branch
      try {
        logger.info('Ensuring we start from main branch...');
        await this.git.checkout('main');
        await this.git.pull('origin', 'main');
        logger.info('Successfully switched to main branch and pulled latest changes');
      } catch (gitError) {
        logger.error('Failed to switch to main branch at start:', gitError);
        throw new Error('Cannot proceed without clean main branch');
      }
      
      // 1. Fetch open issues from GitHub
      const issues = await this.fetchGitHubIssues();
      
      // 2. Filter out already processed bugs
      logger.info(`DEBUG: processedBugs set contains: ${Array.from(this.processedBugs).join(', ')}`);
      logger.info(`DEBUG: processedBugs size: ${this.processedBugs.size}`);
      issues.forEach(issue => {
        logger.info(`DEBUG: Issue #${issue.number} - in processedBugs? ${this.processedBugs.has(issue.number)}`);
      });
      
      const unprocessedIssues = issues.filter(issue => !this.processedBugs.has(issue.number));
      
      if (unprocessedIssues.length === 0) {
        logger.info('No unprocessed bugs found');
        return;
      }
      
      // 3. Sort by priority
      const sortedIssues = this.sortIssuesByPriority(unprocessedIssues);
      
      // 4. Select bugs to fix (up to maxFixesPerSession)
      const bugsToFix = sortedIssues.slice(0, this.config.maxFixesPerSession);
      
      logger.info(`Selected ${bugsToFix.length} bugs to fix from ${unprocessedIssues.length} unprocessed issues`);
      
      // 5. Fix each bug
      for (const issue of bugsToFix) {
        await this.fixBug(issue);
      }
      
      // 6. Save results to MongoDB
      for (const issue of bugsToFix) {
        const result = { success: true }; // We'll update this per bug in fixBug method
        // Individual bugs are saved in fixBug method
      }
      
      logger.info(`Bug fixing session completed. Fixed ${bugsToFix.length} bugs.`);
      
    } catch (error) {
      logger.error('Bug fixing session failed:', error);
    } finally {
      // Ensure we're back on main branch after all operations
      try {
        await this.git.checkout('main');
        logger.info('Returned to main branch at end of bug fixing session');
      } catch (gitError) {
        logger.error('Failed to return to main branch:', gitError);
      }
      
      // Release the lock
      await selfModLock.release('bug-fixing');
      
      this.isRunning = false;
    }
  }

  /**
   * Fetch open issues from GitHub
   */
  async fetchGitHubIssues() {
    try {
      
      // Use gh CLI to fetch issues
      const result = execSync(
        `cd ${this.developmentPath} && gh issue list --repo ${this.config.githubOwner}/${this.config.githubRepo} --state open --label bug --json number,title,body,labels,createdAt --limit 50`,
        { encoding: 'utf8' }
      );
      
      const issues = JSON.parse(result);
      logger.info(`Fetched ${issues.length} open bug issues from GitHub`);
      
      return issues;
    } catch (error) {
      logger.error('Failed to fetch GitHub issues:', error);
      return [];
    }
  }

  /**
   * Sort issues by priority based on labels
   */
  sortIssuesByPriority(issues) {
    const getPriorityScore = (issue) => {
      const labels = issue.labels.map(l => l.name.toLowerCase());
      
      if (labels.includes('critical') || labels.includes('p0')) return 0;
      if (labels.includes('high') || labels.includes('p1')) return 1;
      if (labels.includes('medium') || labels.includes('p2')) return 2;
      if (labels.includes('low') || labels.includes('p3')) return 3;
      
      // Default to medium priority
      return 2;
    };
    
    return issues.sort((a, b) => getPriorityScore(a) - getPriorityScore(b));
  }

  /**
   * Fix a specific bug
   */
  async fixBug(issue) {
    logger.info(`Attempting to fix bug #${issue.number}: ${issue.title}`);
    
    try {
      // 1. Analyze the bug
      const analysis = await this.analyzeBug(issue);
      
      if (!analysis.fixable) {
        logger.warn(`Bug #${issue.number} is not automatically fixable: ${analysis.reason}`);
        this.processedBugs.add(issue.number);
        await this.saveProcessedBug(issue.number, issue.title, {
          success: false,
          skipped: true,
          error: analysis.reason
        });
        return;
      }
      
      // 2. Create feature branch
      const agentName = (process.env.AGENT_NAME || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '');
      const branchName = `fix/${agentName}/issue-${issue.number}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30)}`;
      await this.createFeatureBranch(branchName);
      
      // 3. Generate and apply fix
      const fixResult = await this.generateAndApplyFix(issue, analysis);
      
      if (!fixResult.success) {
        logger.error(`Failed to generate fix for bug #${issue.number}: ${fixResult.error}`);
        await this.git.checkout('main');
        this.processedBugs.add(issue.number);
        await this.saveProcessedBug(issue.number, issue.title, {
          success: false,
          error: fixResult.error,
          branchName
        });
        return;
      }
      
      // 4. Run tests if required
      if (this.config.requireTests) {
        const testResult = await this.runTests(analysis.affectedFiles);
        if (!testResult.success) {
          logger.warn(`Tests failed for bug #${issue.number} fix`);
          await this.git.checkout('main');
          this.processedBugs.add(issue.number);
          await this.saveProcessedBug(issue.number, issue.title, {
            success: false,
            error: 'Tests failed: ' + testResult.error,
            branchName
          });
          return;
        }
      }
      
      // 5. Update documentation if needed
      if (analysis.requiresDocUpdate) {
        await this.updateDocumentation(issue, analysis);
      }
      
      // 6. Commit changes
      await this.commitBugFix(issue, branchName, analysis);
      
      // 7. Create pull request
      const prUrl = await this.createBugFixPullRequest(issue, branchName, analysis);
      
      // 8. Switch back to main branch after successful PR creation
      await this.git.checkout('main');
      logger.info(`Switched back to main branch after PR creation`);
      
      // 9. Mark as processed and save to MongoDB
      this.processedBugs.add(issue.number);
      await this.saveProcessedBug(issue.number, issue.title, {
        success: true,
        prUrl,
        branchName
      });
      
      logger.info(`Successfully created fix for bug #${issue.number}. PR: ${prUrl}`);
      
    } catch (error) {
      logger.error(`Failed to fix bug #${issue.number}:`, error);
      this.processedBugs.add(issue.number);
      
      await this.saveProcessedBug(issue.number, issue.title, {
        success: false,
        error: error.message
      });
      
      // Ensure we're back on main branch
      try {
        await this.git.checkout('main');
      } catch (e) {
        // Ignore checkout errors
      }
    }
  }

  /**
   * Extract file location references from bug report
   */
  extractLocationFromBugReport(issueBody) {
    const locations = [];
    
    // Look for file:line patterns
    const fileLineMatches = issueBody.match(/`([^`]+\.(js|ts|jsx|tsx|mjs)):(\d+)`/g);
    if (fileLineMatches) {
      fileLineMatches.forEach(match => {
        const [, filePath, , lineNumber] = match.match(/`([^`]+\.(js|ts|jsx|tsx|mjs)):(\d+)`/);
        locations.push({ filePath, lineNumber: parseInt(lineNumber) });
      });
    }
    
    // Look for "File: ` pattern
    const fileMatches = issueBody.match(/File: `([^`]+\.(js|ts|jsx|tsx|mjs))`/g);
    if (fileMatches) {
      fileMatches.forEach(match => {
        const [, filePath] = match.match(/File: `([^`]+\.(js|ts|jsx|tsx|mjs))`/);
        if (!locations.some(loc => loc.filePath === filePath)) {
          locations.push({ filePath, lineNumber: null });
        }
      });
    }
    
    // Look for "Line: number" pattern
    const lineMatches = issueBody.match(/Line: (\d+)/g);
    if (lineMatches && locations.length > 0) {
      lineMatches.forEach((match, index) => {
        const [, lineNumber] = match.match(/Line: (\d+)/);
        if (locations[index] && !locations[index].lineNumber) {
          locations[index].lineNumber = parseInt(lineNumber);
        }
      });
    }
    
    return locations;
  }

  /**
   * Read specific code around a location for better context
   */
  async readCodeAtLocation(filePath, lineNumber, contextSize = 10) {
    try {
      const fullPath = path.join(this.developmentPath, filePath);
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split('\n');
      
      const startLine = Math.max(0, lineNumber - contextSize - 1);
      const endLine = Math.min(lines.length - 1, lineNumber + contextSize - 1);
      
      const contextLines = [];
      for (let i = startLine; i <= endLine; i++) {
        contextLines.push({
          lineNumber: i + 1,
          content: lines[i] || '',
          isTarget: i === lineNumber - 1
        });
      }
      
      return {
        contextLines,
        targetLine: lines[lineNumber - 1] || '',
        fullContent: content
      };
    } catch (error) {
      logger.warn(`Could not read code at ${filePath}:${lineNumber}:`, error.message);
      return null;
    }
  }

  /**
   * Analyze a bug to determine if it's fixable and how
   */
  async analyzeBug(issue) {
    // Extract location information from bug report
    const extractedLocations = this.extractLocationFromBugReport(issue.body);
    
    // Read code at specific locations for better analysis
    const locationContext = [];
    for (const location of extractedLocations) {
      if (location.lineNumber) {
        const codeContext = await this.readCodeAtLocation(location.filePath, location.lineNumber);
        if (codeContext) {
          locationContext.push({
            file: location.filePath,
            line: location.lineNumber,
            context: codeContext
          });
        }
      }
    }
    
    const prompt = `TASK: TECHNICAL CODE ANALYSIS - RESPOND ONLY WITH JSON

Analyze this GitHub issue for automatic fixing potential:

ISSUE: #${issue.number} - ${issue.title}
BODY: ${issue.body}
LABELS: ${issue.labels.map(l => l.name).join(', ')}

EXTRACTED LOCATIONS: ${JSON.stringify(extractedLocations)}
${locationContext.length > 0 ? `
CODE CONTEXT AT LOCATIONS:
${locationContext.map(ctx => 
  `File: ${ctx.file}:${ctx.line}
Target Line: ${ctx.context.targetLine}
Context:
${ctx.context.contextLines.map(line => 
    `${line.isTarget ? '>>> ' : '    '}${String(line.lineNumber).padStart(3)}: ${line.content}`
  ).join('\n')}`
).join('\n\n')}` : ''}

ANALYSIS REQUIRED:
- fixable: boolean (can this be automatically fixed?)
- reason: string (if not fixable, explain why)  
- fixType: string (error handling, logic fix, etc.)
- affectedFiles: array of file paths likely affected (use extracted locations if available)
- requiresDocUpdate: boolean
- confidence: string (high/medium/low)
- approach: string (brief fix approach)
- searchTerms: array (terms to find relevant code)
- specificLocations: array of {file, line} objects from bug report

RESPOND ONLY WITH THIS JSON STRUCTURE - NO OTHER TEXT:
{
  "fixable": true,
  "reason": "",
  "fixType": "add error handling",
  "affectedFiles": ["path/to/file.js"],
  "requiresDocUpdate": false,
  "confidence": "high",
  "approach": "wrap async call in try-catch",
  "searchTerms": ["async", "await", "error"],
  "specificLocations": [{"file": "path/to/file.js", "line": 42}]
}`;

    try {
      // Use direct AI provider call to bypass intent detection
      const response = await this.agent.providerManager.generateResponse(prompt, {
        maxTokens: 1000,
        temperature: 0.1,
        format: 'json'
      });
      logger.debug(`AI response for bug #${issue.number}:`, response);
      
      // Handle AI provider response format
      let responseText;
      if (response && response.content) {
        responseText = response.content;
      } else if (typeof response === 'string') {
        responseText = response;
      } else {
        logger.error(`Unexpected response format for bug #${issue.number}:`, response);
        return {
          fixable: false,
          reason: 'AI response format unexpected'
        };
      }
      
      // Try to parse JSON response
      let analysis;
      try {
        analysis = this.extractJSONFromResponse(responseText);
        logger.info(`Successfully parsed AI response for bug #${issue.number}`);
      } catch (parseError) {
        logger.error(`JSON parsing failed for bug #${issue.number}:`, parseError.message);
        logger.error('Raw AI response:', response);
        return {
          fixable: false,
          reason: 'AI response was not valid JSON'
        };
      }
      
      // Validate analysis structure
      if (typeof analysis !== 'object' || analysis.fixable === undefined) {
        logger.error(`Invalid analysis structure for bug #${issue.number}:`, analysis);
        return {
          fixable: false,
          reason: 'AI response had invalid structure'
        };
      }
      
      // If fixable, search for affected files
      if (analysis.fixable && analysis.searchTerms && analysis.searchTerms.length > 0) {
        const foundFiles = await this.searchForAffectedFiles(analysis.searchTerms);
        if (foundFiles.length > 0) {
          analysis.affectedFiles = [...new Set([...analysis.affectedFiles, ...foundFiles])];
        }
      }
      
      logger.info(`Bug #${issue.number} analysis: fixable=${analysis.fixable}, confidence=${analysis.confidence}`);
      return analysis;
    } catch (error) {
      logger.error('Bug analysis failed:', error);
      return {
        fixable: false,
        reason: 'Failed to analyze bug: ' + error.message
      };
    }
  }

  /**
   * Search for files that might be affected by the bug
   */
  async searchForAffectedFiles(searchTerms) {
    const foundFiles = [];
    
    for (const term of searchTerms) {
      try {
        const result = execSync(
          `cd ${this.developmentPath} && grep -r "${term}" --include="*.js" --include="*.json" -l | head -20`,
          { encoding: 'utf8' }
        );
        
        const files = result.split('\n').filter(f => f.trim());
        foundFiles.push(...files);
      } catch (error) {
        // Grep returns error if no matches found
      }
    }
    
    return [...new Set(foundFiles)];
  }

  /**
   * Generate and apply the bug fix
   */
  async generateAndApplyFix(issue, analysis) {
    try {
      // Read affected files
      const fileContents = {};
      for (const filePath of analysis.affectedFiles) {
        try {
          const fullPath = path.join(this.developmentPath, filePath);
          fileContents[filePath] = await fs.readFile(fullPath, 'utf8');
        } catch (error) {
          logger.warn(`Could not read file ${filePath}:`, error.message);
        }
      }
      
      // Generate fix using AI
      const fixPrompt = `TASK: GENERATE BUG FIX CODE - RESPOND ONLY WITH JSON

Fix this bug:
BUG: #${issue.number} - ${issue.title}
DESCRIPTION: ${issue.body}

ANALYSIS:
- Type: ${analysis.fixType}
- Approach: ${analysis.approach}
- Confidence: ${analysis.confidence}

CODE FILES:
${Object.entries(fileContents).map(([file, content]) => 
  `FILE: ${file}\n${content.split('\n').slice(0, 50).join('\n')}`
).join('\n\n---FILE SEPARATOR---\n\n')}

REQUIREMENTS:
- Generate exact code replacements
- Match existing code style and indentation (preserve whitespace)
- Add proper error handling for async operations
- Include minimal logging if needed
- Don't break existing functionality
- Maintain proper indentation (use 2 spaces, not tabs)

RESPOND ONLY WITH THIS JSON STRUCTURE - NO OTHER TEXT:
{
  "fixes": [
    {
      "file": "path/to/file.js",
      "changes": [
        {
          "old": "exact code to replace",
          "new": "replacement code",
          "reason": "explanation"
        }
      ]
    }
  ],
  "summary": "Brief description of changes",
  "testingNotes": "How to test the fix"
}`;

      const response = await this.agent.providerManager.generateResponse(fixPrompt, {
        maxTokens: 2000,
        temperature: 0.1,
        format: 'json'
      });
      const responseText = response.content || response;
      const fixData = this.extractJSONFromResponse(responseText);
      
      // Apply fixes
      for (const fileFix of fixData.fixes) {
        const fullPath = path.join(this.developmentPath, fileFix.file);
        let fileContent = await fs.readFile(fullPath, 'utf8');
        
        for (const change of fileFix.changes) {
          if (!fileContent.includes(change.old)) {
            logger.warn(`Could not find exact match for change in ${fileFix.file}`);
            return {
              success: false,
              error: `Could not find code to replace in ${fileFix.file}`
            };
          }
          
          fileContent = fileContent.replace(change.old, change.new);
          logger.info(`Applied fix to ${fileFix.file}: ${change.reason}`);
        }
        
        await fs.writeFile(fullPath, fileContent);
      }
      
      return {
        success: true,
        summary: fixData.summary,
        testingNotes: fixData.testingNotes,
        filesChanged: fixData.fixes.map(f => f.file)
      };
      
    } catch (error) {
      logger.error('Failed to generate/apply fix:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Extract JSON from AI response that might be wrapped in markdown or text
   */
  extractJSONFromResponse(responseText) {
    // First try direct parse
    try {
      return JSON.parse(responseText);
    } catch (e) {
      // Strip all code fences — Claude nests ```javascript inside ```json
      let cleaned = responseText.replace(/```\w*\n?/g, '');

      // Find outermost JSON object
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');

      if (firstBrace !== -1 && lastBrace > firstBrace) {
        let jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
        jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
        try {
          return JSON.parse(jsonStr);
        } catch (e2) {
          // Sanitize embedded newlines in string values and retry
          jsonStr = jsonStr.replace(/("(?:[^"\\]|\\.)*")/g, (match) => {
            return match.replace(/[\n\r\t]/g, ' ');
          });
          return JSON.parse(jsonStr);
        }
      }

      throw new Error('Could not extract valid JSON from response');
    }
  }

  /**
   * Run tests on affected files
   */
  async runTests(affectedFiles) {
    try {
      // First check if there's a test script
      const packageJsonPath = path.join(this.developmentPath, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      
      if (!packageJson.scripts || !packageJson.scripts.test) {
        logger.warn('No test script found in package.json');
        return { success: true, skipped: true };
      }
      
      // Run tests
      logger.info('Running tests to verify fix...');
      const result = execSync(`cd ${this.developmentPath} && npm test`, { 
        encoding: 'utf8',
        timeout: 300000 // 5 minute timeout
      });
      
      logger.info('Tests passed successfully');
      return { success: true, output: result };
      
    } catch (error) {
      logger.error('Tests failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update documentation if needed
   */
  async updateDocumentation(issue, analysis) {
    try {
      // Update CHANGELOG.md if it exists
      const changelogPath = path.join(this.developmentPath, 'CHANGELOG.md');
      try {
        let changelog = await fs.readFile(changelogPath, 'utf8');
        
        // Add entry for bug fix
        const date = new Date().toISOString().split('T')[0];
        const entry = `\n### Bug Fixes\n- Fixed issue #${issue.number}: ${issue.title}\n`;
        
        // Find the right place to insert (after the latest version header)
        const versionMatch = changelog.match(/## \[([\d.]+)\]/);
        if (versionMatch) {
          const insertIndex = changelog.indexOf(versionMatch[0]) + versionMatch[0].length;
          changelog = changelog.slice(0, insertIndex) + entry + changelog.slice(insertIndex);
          await fs.writeFile(changelogPath, changelog);
          logger.info('Updated CHANGELOG.md');
        }
      } catch (error) {
        // No changelog file
      }
      
      // Update README if mentioned
      if (issue.body.toLowerCase().includes('readme')) {
        logger.info('Bug mentions README, but skipping automatic README updates for safety');
      }
      
    } catch (error) {
      logger.error('Failed to update documentation:', error);
    }
  }

  /**
   * Create a feature branch for the bug fix
   */
  async createFeatureBranch(branchName) {
    try {
      // Ensure we're on main branch
      await this.git.checkout('main');
      await this.git.pull('origin', 'main');
      
      // Check if branch already exists and delete it
      try {
        const branches = await this.git.branchLocal();
        if (branches.all.includes(branchName)) {
          logger.info(`Deleting existing branch: ${branchName}`);
          await this.git.deleteLocalBranch(branchName, true);
        }
      } catch (branchError) {
        // Ignore branch check errors
        logger.debug('Branch check error (ignored):', branchError.message);
      }
      
      // Create and checkout new branch
      await this.git.checkoutLocalBranch(branchName);
      
      logger.info(`Created feature branch: ${branchName}`);
    } catch (error) {
      throw new Error(`Failed to create feature branch: ${error.message}`);
    }
  }

  /**
   * Commit bug fix changes
   */
  async commitBugFix(issue, branchName, analysis) {
    try {
      // Get list of changed files first
      const status = await this.git.status();
      const changedFiles = [...status.modified, ...status.created];
      
      // Add only the source files, exclude state files
      const filesToAdd = changedFiles.filter(file => 
        !file.includes('.bug-fixing-state.json') && 
        !file.startsWith('.git/')
      );
      
      if (filesToAdd.length === 0) {
        throw new Error('No files to commit after filtering');
      }
      
      // Add filtered files
      for (const file of filesToAdd) {
        await this.git.add(file);
      }
      
      // Create commit message
      const commitMessage = `fix: Resolve issue #${issue.number} - ${issue.title}

Analysis:
- Fix Type: ${analysis.fixType}
- Confidence: ${analysis.confidence}
- Approach: ${analysis.approach}

Changed files:
${changedFiles.map(f => `- ${f}`).join('\n')}

Fixes #${issue.number}

🤖 Generated by Bug Fixing Service`;

      await this.git.commit(commitMessage);
      
      // Push to remote
      await this.git.push('origin', branchName);
      
      logger.info(`Committed and pushed bug fix for issue #${issue.number}`);
    } catch (error) {
      throw new Error(`Failed to commit changes: ${error.message}`);
    }
  }

  /**
   * Create pull request for the bug fix
   */
  async createBugFixPullRequest(issue, branchName, analysis) {
    try {
      
      const prTitle = `fix: Resolve issue #${issue.number} - ${issue.title}`;
      const prBody = `## Summary
This PR automatically fixes issue #${issue.number}.

## Bug Details
**Issue**: #${issue.number}
**Title**: ${issue.title}
**Fix Type**: ${analysis.fixType}
**Confidence**: ${analysis.confidence}

## Changes Made
${analysis.approach}

## Affected Files
${analysis.affectedFiles && analysis.affectedFiles.length > 0 
  ? analysis.affectedFiles.map(f => `- \`${f}\``).join('\n')
  : '- Files were automatically identified during fix generation'}

## Testing
- [ ] Automated tests pass
- [ ] Manual testing completed
- [ ] No regressions introduced

## Documentation
${analysis.requiresDocUpdate ? '- [ ] Documentation updated' : '- No documentation changes required'}

---
🤖 *This PR was automatically generated by the Bug Fixing Service*

Fixes #${issue.number}`;

      const result = execSync(
        `cd ${this.developmentPath} && gh pr create --title "${prTitle}" --body "${prBody}" --base main --head ${branchName}`,
        { encoding: 'utf8' }
      );
      
      // Extract PR URL from output
      const prUrlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
      return prUrlMatch ? prUrlMatch[0] : 'PR created successfully';
      
    } catch (error) {
      logger.error('Failed to create PR:', error);
      throw new Error(`Failed to create pull request: ${error.message}`);
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      config: this.config,
      processedBugs: Array.from(this.processedBugs),
      stats: {
        totalProcessed: this.processedBugs.size,
        sessionCount: Math.floor(this.processedBugs.size / this.config.maxFixesPerSession)
      }
    };
  }

  /**
   * Update service configuration
   */
  async updateConfig(updates) {
    Object.assign(this.config, updates);
    logger.info('Bug fixing service configuration updated');
    
    // Save to database
    await this.saveConfig();
  }

  /**
   * Load configuration from database
   */
  async loadConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent && agent.serviceConfigs && agent.serviceConfigs.bugFixing) {
        const savedConfig = agent.serviceConfigs.bugFixing;
        
        // Merge saved config with defaults, preserving structure
        this.config = {
          ...this.config,
          enabled: savedConfig.enabled !== undefined ? savedConfig.enabled : this.config.enabled,
          maxFixesPerSession: savedConfig.maxFixesPerSession || this.config.maxFixesPerSession,
          githubOwner: savedConfig.githubOwner || this.config.githubOwner,
          githubRepo: savedConfig.githubRepo || this.config.githubRepo,
          priorityOrder: savedConfig.priorityOrder || this.config.priorityOrder,
          requireTests: savedConfig.requireTests !== undefined ? savedConfig.requireTests : this.config.requireTests,
          createPR: savedConfig.createPR !== undefined ? savedConfig.createPR : this.config.createPR
        };
        
        // Load lastCheckTime if available
        if (savedConfig.lastCheckTime) {
          this.lastCheckTime = new Date(savedConfig.lastCheckTime);
        }
        
        logger.info('Bug fixing configuration loaded from database');
      } else {
        logger.info('No saved bug fixing configuration found, using defaults');
      }
    } catch (error) {
      logger.warn('Failed to load bug fixing configuration from database:', error.message);
    }
  }

  /**
   * Save configuration to database
   */
  async saveConfig() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent) {
        if (!agent.serviceConfigs) {
          agent.serviceConfigs = {};
        }
        
        agent.serviceConfigs.bugFixing = {
          enabled: this.config.enabled,
          maxFixesPerSession: this.config.maxFixesPerSession,
          githubOwner: this.config.githubOwner,
          githubRepo: this.config.githubRepo,
          priorityOrder: this.config.priorityOrder,
          requireTests: this.config.requireTests,
          createPR: this.config.createPR,
          lastCheckTime: this.lastCheckTime
        };
        
        agent.markModified('serviceConfigs');
        await agent.save();
        
        logger.info('Bug fixing configuration saved to database');
      }
    } catch (error) {
      logger.error('Failed to save bug fixing configuration to database:', error);
    }
  }

  /**
   * Save just the lastCheckTime to database
   */
  async saveLastCheckTime() {
    try {
      const { Agent } = await import('../models/Agent.js');
      const agent = await Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
      
      if (agent) {
        if (!agent.serviceConfigs) {
          agent.serviceConfigs = {};
        }
        if (!agent.serviceConfigs.bugFixing) {
          agent.serviceConfigs.bugFixing = {};
        }
        
        agent.serviceConfigs.bugFixing.lastCheckTime = this.lastCheckTime;
        agent.markModified('serviceConfigs');
        await agent.save();
        logger.info('Bug fixing lastCheckTime saved to database');
      }
    } catch (error) {
      logger.error('Failed to save bug fixing lastCheckTime to database:', error);
      throw error; // Re-throw to see the error
    }
  }
}