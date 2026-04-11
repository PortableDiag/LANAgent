import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRReviewSettings, PRReviewHistory } from '../../models/PRReview.js';
import { getProvider } from '../../services/gitHosting/index.js';
import { GitHostingSettings } from '../../models/GitHostingSettings.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Git repository path - use environment variable or default
const GIT_REPO_PATH = process.env.GIT_REPO_PATH || process.env.AGENT_REPO_PATH || process.cwd();

// Helper function to execute commands in the git repo
async function execInRepo(command) {
  return await execAsync(command, { cwd: GIT_REPO_PATH });
}

export default class PRReviewerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'prReviewer';
    this.version = '1.0.0';
    this.description = 'Autonomous PR review system with configurable AI model, automatic merging, and safe self-deployment';
    
    this.commands = [
      {
        command: 'review',
        description: 'Review all open PRs',
        usage: 'review()'
      },
      {
        command: 'getSettings',
        description: 'Get PR reviewer settings',
        usage: 'getSettings()'
      },
      {
        command: 'updateSettings',
        description: 'Update PR reviewer settings',
        usage: 'updateSettings({ enabled: true, schedule: "0 9,21 * * *" })'
      },
      {
        command: 'getStats',
        description: 'Get PR review statistics',
        usage: 'getStats()'
      },
      {
        command: 'testReview',
        description: 'Test review a specific PR without merging',
        usage: 'testReview({ prNumber: 123 })'
      }
    ];
    
    // Default settings
    this.defaultSettings = {
      enabled: true, // Enabled by default — fork instances need this to auto-review and deploy upstream updates
      schedule: '0 9,21 * * *', // 9 AM and 9 PM daily
      aiProvider: 'anthropic',
      aiModel: 'claude-opus-4-5-20251101', // Default to Opus 4.5
      autoMerge: true,
      autoImplement: true,
      createPRsForImplementations: true,
      deployAfterMerge: true,
      rollbackOnFailure: true,
      reviewOnlyBotPRs: false, // Review all PRs, not just bot-created ones
      maxPRsPerRun: 10,
      requireTests: false, // Don't require tests to pass since repo doesn't have CI
      commentOnPRs: true,
      verboseComments: true,
      lastReview: null,
      stats: {
        totalReviewed: 0,
        merged: 0,
        rejected: 0,
        implemented: 0,
        deployments: 0,
        rollbacks: 0,
        errors: 0,
        lastError: null,
        reviewHistory: []
      }
    };
    
    // Track current deployment for rollback
    this.currentDeployment = null;
    
    // Health check configuration
    this.healthCheckConfig = {
      maxRestarts: 3,
      checkInterval: 5000, // 5 seconds
      checkDuration: 30000, // Monitor for 30 seconds after deployment
      endpoints: [
        { url: 'http://localhost:3000/health', expectedStatus: 200 },
        { url: 'http://localhost:3000/api/status', expectedStatus: 200 }
      ]
    };

    // Git hosting provider (GitHub or GitLab)
    this.gitHostingProvider = null;
  }

  /**
   * Get or initialize the git hosting provider
   */
  async getGitHostingProvider() {
    if (!this.gitHostingProvider) {
      try {
        const settings = await GitHostingSettings.getOrCreate('default');
        const providerSettings = {
          gitHosting: {
            provider: settings.provider,
            github: settings.github,
            gitlab: settings.gitlab
          }
        };
        this.gitHostingProvider = await getProvider(providerSettings);
        logger.info(`[prReviewer] Git hosting provider initialized: ${this.gitHostingProvider.name}`);
      } catch (error) {
        logger.warn(`[prReviewer] Failed to initialize git hosting provider: ${error.message}`);
        this.gitHostingProvider = null;
      }
    }
    return this.gitHostingProvider;
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'review':
          return await this.reviewPRs(data);
        case 'getSettings':
          return await this.getSettings();
        case 'updateSettings':
          return await this.updateSettings(data);
        case 'getStats':
          return await this.getStats();
        case 'testReview':
          return await this.testReviewPR(data);
        case 'deploy':
          return await this.performSafeDeployment(data);
        case 'rollback':
          return await this.rollbackDeployment(data);
        default:
          return {
            success: false,
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      logger.error('[PRReviewer] Plugin error:', error);
      await this.updateStats({ errors: 1, lastError: error.message });
      return { success: false, error: error.message };
    }
  }

  async initialize() {
    logger.info('[PRReviewer] Initializing PR Reviewer plugin');
    
    // Schedule PR reviews if enabled
    const settings = await this.getSettings();
    if (settings.enabled) {
      await this.scheduleReviews();
    }
  }

  async scheduleReviews() {
    const settings = await this.getSettings();
    
    if (this.agent.scheduler) {
      // Schedule PR reviews
      await this.agent.scheduler.agenda.define('review-prs', async (job) => {
        logger.info('[PRReviewer] Running scheduled PR review');
        await this.reviewPRs();
      });
      
      await this.agent.scheduler.agenda.every(settings.schedule, 'review-prs');
      logger.info(`[PRReviewer] Scheduled PR reviews with pattern: ${settings.schedule}`);
      
      // Schedule nightly model list updates
      await this.agent.scheduler.agenda.define('update-pr-review-models', async (job) => {
        logger.info('[PRReviewer] Updating AI model lists');
        try {
          // This will trigger the AI providers to update their model lists
          if (this.agent.providerManager) {
            // Update models for each provider
            for (const [name, provider] of this.agent.providerManager.providers) {
              if (provider.updateModelList) {
                await provider.updateModelList();
                logger.info(`[PRReviewer] Updated model list for ${name}`);
              }
            }
            logger.info('[PRReviewer] AI model lists updated successfully');
          }
        } catch (error) {
          logger.error('[PRReviewer] Failed to update AI model lists:', error);
        }
      });
      
      // Run model updates nightly at 2 AM
      await this.agent.scheduler.agenda.every('0 2 * * *', 'update-pr-review-models');
      logger.info('[PRReviewer] Scheduled nightly AI model list updates');
    }
  }

  async reviewPRs(options = {}) {
    const settings = await this.getSettings();
    
    if (!settings.enabled && !options.force) {
      return {
        success: false,
        message: 'PR Reviewer is disabled'
      };
    }
    
    logger.info('[PRReviewer] Starting PR review process');
    
    try {
      // First check if the repository directory exists and is a git repository
      try {
        await fs.access(GIT_REPO_PATH);
      } catch (error) {
        logger.error(`[PRReviewer] Repository directory does not exist: ${GIT_REPO_PATH}`);
        return {
          success: false,
          error: `Repository directory not found: ${GIT_REPO_PATH}. Please ensure the repository is cloned.`
        };
      }
      
      // Check if it's a git repository
      try {
        await execInRepo('git rev-parse --git-dir');
      } catch (error) {
        logger.error(`[PRReviewer] Directory is not a git repository: ${GIT_REPO_PATH}`);
        return {
          success: false,
          error: `${GIT_REPO_PATH} is not a git repository. Please clone the repository first.`
        };
      }
      
      // Get list of open PRs using git hosting provider or gh CLI
      let openPRs = [];
      const provider = await this.getGitHostingProvider();

      if (provider) {
        try {
          const mrList = await provider.listMergeRequests({ state: 'open', limit: settings.maxPRsPerRun || 10 });
          openPRs = mrList.map(mr => ({
            number: mr.number,
            title: mr.title,
            author: { login: mr.author },
            createdAt: mr.createdAt,
            isDraft: mr.draft,
            headRefName: mr.sourceBranch
          }));
        } catch (error) {
          logger.warn(`[PRReviewer] Provider failed, falling back to gh CLI: ${error.message}`);
          const { stdout: prListJson } = await execInRepo('gh pr list --state open --json number,title,author,createdAt,isDraft,headRefName');
          openPRs = JSON.parse(prListJson);
        }
      } else {
        const { stdout: prListJson } = await execInRepo('gh pr list --state open --json number,title,author,createdAt,isDraft,headRefName');
        openPRs = JSON.parse(prListJson);
      }
      
      if (openPRs.length === 0) {
        logger.info('[PRReviewer] No open PRs to review');
        return {
          success: true,
          message: 'No open PRs to review',
          reviewed: 0
        };
      }
      
      logger.info(`[PRReviewer] Found ${openPRs.length} open PRs`);
      
      const results = {
        reviewed: 0,
        merged: [],
        rejected: [],
        implemented: [],
        errors: []
      };
      
      // Review each PR up to the limit
      const prsToReview = openPRs.slice(0, settings.maxPRsPerRun);
      
      for (const pr of prsToReview) {
        if (pr.isDraft) {
          logger.info(`[PRReviewer] Skipping draft PR #${pr.number}`);
          continue;
        }
        
        try {
          const reviewResult = await this.reviewSinglePR(pr, settings);
          results.reviewed++;
          
          if (reviewResult.action === 'merge') {
            results.merged.push(pr.number);
          } else if (reviewResult.action === 'reject') {
            results.rejected.push(pr.number);
          } else if (reviewResult.action === 'implement') {
            results.implemented.push(pr.number);
          }
          
          // Add to review history
          await this.addToReviewHistory({
            prNumber: pr.number,
            title: pr.title,
            action: reviewResult.action,
            reason: reviewResult.reason,
            timestamp: new Date()
          });
          
        } catch (error) {
          logger.error(`[PRReviewer] Error reviewing PR #${pr.number}:`, error);
          results.errors.push({ pr: pr.number, error: error.message });
        }
      }
      
      // Update stats
      await this.updateStats({
        totalReviewed: results.reviewed,
        merged: results.merged.length,
        rejected: results.rejected.length,
        implemented: results.implemented.length
      });
      
      // Deploy if there were merges
      if (results.merged.length > 0 && settings.deployAfterMerge) {
        logger.info('[PRReviewer] Deploying merged changes');
        const deployResult = await this.performSafeDeployment();
        if (!deployResult.success) {
          results.deployError = deployResult.error;
        }
      }
      
      // Update last review time
      await this.updateSettings({ lastReview: new Date() });
      
      return {
        success: true,
        results
      };
      
    } catch (error) {
      logger.error('[PRReviewer] Error in review process:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async reviewSinglePR(pr, settings) {
    logger.info(`[PRReviewer] Reviewing PR #${pr.number}: ${pr.title}`);

    try {
      // Get PR details and diff using provider or gh CLI
      let prDetails;
      let diff;
      const provider = await this.getGitHostingProvider();

      if (provider) {
        try {
          const mrData = await provider.getMergeRequest(pr.number);
          prDetails = {
            body: mrData.body,
            files: mrData.files || [],
            additions: mrData.additions || 0,
            deletions: mrData.deletions || 0
          };
          diff = await provider.getMergeRequestDiff(pr.number);
        } catch (error) {
          logger.warn(`[PRReviewer] Provider failed for PR details, using gh CLI: ${error.message}`);
          const { stdout: prDetailsJson } = await execInRepo(`gh pr view ${pr.number} --json body,files,additions,deletions`);
          prDetails = JSON.parse(prDetailsJson);
          const { stdout: diffOutput } = await execInRepo(`gh pr diff ${pr.number}`);
          diff = diffOutput;
        }
      } else {
        const { stdout: prDetailsJson } = await execInRepo(`gh pr view ${pr.number} --json body,files,additions,deletions`);
        prDetails = JSON.parse(prDetailsJson);
        const { stdout: diffOutput } = await execInRepo(`gh pr diff ${pr.number}`);
        diff = diffOutput;
      }
      
      // Check what files are changed
      const hasCodeChanges = prDetails.files.some(file => 
        !file.path.endsWith('.md') && 
        !file.path.endsWith('.txt') && 
        !file.path.includes('docs/')
      );
      
      if (!hasCodeChanges) {
        logger.info(`[PRReviewer] PR #${pr.number} only contains documentation changes, auto-merging`);
        await this.mergePR(pr.number, 'Documentation-only changes - safe to merge automatically');
        return { action: 'merge', reason: 'documentation-only' };
      }
      
      // Prepare review prompt
      const reviewPrompt = `You are an expert code reviewer for the LANAgent project. Review this pull request and determine if it should be:
1. MERGED - The code is safe, correct, and improves the project
2. REJECTED - The code has issues that cannot be fixed
3. IMPLEMENT - The idea is good but the implementation needs to be redone

Pull Request: #${pr.number} - ${pr.title}
Author: ${pr.author.login}
Description: ${prDetails.body || 'No description provided'}

Files changed: ${prDetails.files.map(f => f.path).join(', ')}
Additions: ${prDetails.additions} lines
Deletions: ${prDetails.deletions} lines

Diff:
${diff}

Analyze the code for:
- Security vulnerabilities
- Breaking changes
- Code quality issues
- Performance impacts
- Correctness of implementation
- Compatibility with existing code

Respond with a JSON object:
{
  "action": "merge" | "reject" | "implement",
  "reason": "Brief explanation",
  "details": "Detailed analysis",
  "issues": ["list", "of", "specific", "issues"],
  "suggestions": ["list", "of", "improvements"]
}`;

      // Get AI review
      const aiResponse = await this.getAIReview(reviewPrompt, settings);
      
      // Log the raw response for debugging
      logger.info(`[PRReviewer] Raw AI response (first 200 chars): ${aiResponse.substring(0, 200)}`);
      
      let review;
      try {
        // Try to parse the response directly
        review = JSON.parse(aiResponse);
      } catch (parseError) {
        // If parsing fails, try to clean the response
        logger.warn('[PRReviewer] Failed to parse AI response directly, attempting to clean it');
        
        // Remove any leading/trailing whitespace and newlines
        let cleanedResponse = aiResponse.trim();
        
        // If the response starts with escaped quotes or newlines, try to unescape
        if (cleanedResponse.startsWith('\\n') || cleanedResponse.startsWith('\\"')) {
          try {
            // The response might be double-stringified
            cleanedResponse = JSON.parse(`"${cleanedResponse}"`);
            logger.info('[PRReviewer] Successfully unescaped response');
          } catch (e) {
            logger.warn('[PRReviewer] Failed to unescape response');
          }
        }
        
        // Try parsing again
        try {
          review = JSON.parse(cleanedResponse);
        } catch (finalError) {
          logger.error(`[PRReviewer] Failed to parse AI response: ${cleanedResponse.substring(0, 200)}`);
          throw new Error(`Invalid AI response format: ${finalError.message}`);
        }
      }
      
      logger.info(`[PRReviewer] AI review decision for PR #${pr.number}: ${review.action}`);
      
      // Take action based on review
      if (review.action === 'merge') {
        await this.mergePR(pr.number, review.reason, review.details);
      } else if (review.action === 'reject') {
        await this.rejectPR(pr.number, review.reason, review.details, review.issues);
      } else if (review.action === 'implement' && settings.autoImplement) {
        await this.implementPR(pr.number, pr.title, review.reason, review.suggestions);
      }
      
      return review;
      
    } catch (error) {
      logger.error(`[PRReviewer] Error reviewing PR #${pr.number}:`, error);
      throw error;
    }
  }

  async getAIReview(prompt, settings) {
    // Use the configured AI provider and model
    if (!this.agent.providerManager || !this.agent.providerManager.providers) {
      throw new Error('Provider manager not available');
    }
    
    const provider = this.agent.providerManager.providers.get(settings.aiProvider);
    if (!provider) {
      throw new Error(`AI provider ${settings.aiProvider} not available`);
    }
    
    logger.info(`[PRReviewer] Using ${settings.aiProvider} with model ${settings.aiModel} for review`);
    
    try {
      const response = await provider.generateResponse(prompt, {
        model: settings.aiModel,
        systemPrompt: 'You are an expert code reviewer. Analyze pull requests and provide structured JSON responses.',
        temperature: 0.3, // Lower temperature for more consistent reviews
        maxTokens: 2000
      });
      
      // The response is already a string from generateResponse
      let content = response;
      
      // Log the response type and content for debugging
      logger.info(`[PRReviewer] Response type: ${typeof content}, first 100 chars: ${String(content).substring(0, 100)}`);
      
      // Ensure content is a string
      if (typeof content !== 'string') {
        logger.warn(`[PRReviewer] Response is not a string, converting from ${typeof content}`);
        content = JSON.stringify(content);
      }
      
      // Try to extract JSON if it's wrapped in markdown
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }
      
      return content.trim();
      
    } catch (error) {
      logger.error('[PRReviewer] AI review error:', error);
      throw new Error(`Failed to get AI review: ${error.message}`);
    }
  }

  async mergePR(prNumber, reason, details) {
    logger.info(`[PRReviewer] Merging PR #${prNumber}`);

    const settings = await this.getSettings();
    const provider = await this.getGitHostingProvider();

    // Add comment explaining the merge
    if (settings.commentOnPRs) {
      const comment = `## 🤖 Automated PR Review - APPROVED ✅

**Decision:** MERGE
**Reason:** ${reason}

${settings.verboseComments && details ? `### Detailed Analysis\n${details}` : ''}

*This PR was automatically reviewed and merged by LANAgent PR Reviewer using ${settings.aiProvider}/${settings.aiModel}*`;

      if (provider) {
        try {
          await provider.commentOnMergeRequest(prNumber, comment);
        } catch (error) {
          logger.warn(`[PRReviewer] Provider comment failed, using gh CLI: ${error.message}`);
          await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
        }
      } else {
        await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
      }
    }

    // Merge the PR
    if (provider) {
      try {
        const mergeResult = await provider.mergeMergeRequest(prNumber, { deleteBranch: true, mergeMethod: 'merge' });
        if (!mergeResult.success) {
          throw new Error(mergeResult.error || 'Merge failed');
        }
      } catch (error) {
        logger.warn(`[PRReviewer] Provider merge failed, using gh CLI: ${error.message}`);
        await execInRepo(`gh pr merge ${prNumber} --merge --delete-branch`);
      }
    } else {
      await execInRepo(`gh pr merge ${prNumber} --merge --delete-branch`);
    }
    
    logger.info(`[PRReviewer] Successfully merged PR #${prNumber}`);
  }

  async rejectPR(prNumber, reason, details, issues) {
    logger.info(`[PRReviewer] Rejecting PR #${prNumber}`);

    const settings = await this.getSettings();
    const provider = await this.getGitHostingProvider();

    // Add comment explaining the rejection
    if (settings.commentOnPRs) {
      const issuesList = issues && issues.length > 0
        ? `\n### Issues Found\n${issues.map(i => `- ${i}`).join('\n')}`
        : '';

      const comment = `## 🤖 Automated PR Review - REJECTED ❌

**Decision:** REJECT
**Reason:** ${reason}

${settings.verboseComments && details ? `### Detailed Analysis\n${details}` : ''}
${issuesList}

*This PR was automatically reviewed and rejected by LANAgent PR Reviewer using ${settings.aiProvider}/${settings.aiModel}*`;

      if (provider) {
        try {
          await provider.commentOnMergeRequest(prNumber, comment);
        } catch (error) {
          logger.warn(`[PRReviewer] Provider comment failed, using gh CLI: ${error.message}`);
          await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
        }
      } else {
        await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
      }
    }

    // Close the PR
    if (provider) {
      try {
        const closeResult = await provider.closeMergeRequest(prNumber);
        if (!closeResult.success) {
          throw new Error(closeResult.error || 'Close failed');
        }
      } catch (error) {
        logger.warn(`[PRReviewer] Provider close failed, using gh CLI: ${error.message}`);
        await execInRepo(`gh pr close ${prNumber}`);
      }
    } else {
      await execInRepo(`gh pr close ${prNumber}`);
    }

    logger.info(`[PRReviewer] Successfully rejected PR #${prNumber}`);
  }

  async implementPR(prNumber, title, reason, suggestions) {
    logger.info(`[PRReviewer] Implementing better version of PR #${prNumber}`);
    
    const settings = await this.getSettings();
    
    // First, close the original PR with explanation
    if (settings.commentOnPRs) {
      const comment = `## 🤖 Automated PR Review - NEEDS REIMPLEMENTATION 🔄

**Decision:** IMPLEMENT
**Reason:** ${reason}

The concept is good, but the implementation needs improvement. I will create a new PR with a better implementation.

${suggestions && suggestions.length > 0 ? `### Suggested Improvements\n${suggestions.map(s => `- ${s}`).join('\n')}` : ''}

*This PR was automatically reviewed by LANAgent PR Reviewer using ${settings.aiProvider}/${settings.aiModel}*`;

      const provider = await this.getGitHostingProvider();
      if (provider) {
        try {
          await provider.commentOnMergeRequest(prNumber, comment);
        } catch (error) {
          logger.warn(`[PRReviewer] Provider comment failed, using gh CLI: ${error.message}`);
          await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
        }
      } else {
        await execInRepo(`gh pr comment ${prNumber} --body "${comment.replace(/"/g, '\\"')}"`);
      }
    }

    // Close the original PR
    const closeProvider = await this.getGitHostingProvider();
    if (closeProvider) {
      try {
        await closeProvider.closeMergeRequest(prNumber);
      } catch (error) {
        logger.warn(`[PRReviewer] Provider close failed, using gh CLI: ${error.message}`);
        await execInRepo(`gh pr close ${prNumber}`);
      }
    } else {
      await execInRepo(`gh pr close ${prNumber}`);
    }

    // Get PR details for reimplementation
    let prDetails;
    const detailProvider = await this.getGitHostingProvider();
    if (detailProvider) {
      try {
        const mrData = await detailProvider.getMergeRequest(prNumber);
        prDetails = {
          body: mrData.body,
          files: mrData.files || []
        };
      } catch (error) {
        logger.warn(`[PRReviewer] Provider failed for PR details, using gh CLI: ${error.message}`);
        const { stdout: prDetailsJson } = await execInRepo(`gh pr view ${prNumber} --json body,files`);
        prDetails = JSON.parse(prDetailsJson);
      }
    } else {
      const { stdout: prDetailsJson } = await execInRepo(`gh pr view ${prNumber} --json body,files`);
      prDetails = JSON.parse(prDetailsJson);
    }
    
    // Create implementation prompt
    const implementPrompt = `Based on the rejected PR #${prNumber} "${title}", create a better implementation.

Original PR intention: ${prDetails.body || 'No description'}
Files that were modified: ${prDetails.files.map(f => f.path).join(', ')}
Issues with original: ${reason}
Suggestions: ${suggestions ? suggestions.join(', ') : 'None'}

Provide the complete implementation with:
1. List of files to create/modify
2. Complete file contents for each file
3. Clear explanation of improvements made

Respond in JSON format:
{
  "summary": "Brief summary of implementation",
  "improvements": ["list", "of", "improvements", "made"],
  "files": [
    {
      "path": "src/file.js",
      "action": "create" | "modify",
      "content": "complete file content"
    }
  ]
}`;

    try {
      // Get AI implementation
      const aiResponse = await this.getAIReview(implementPrompt, settings);
      
      let implementation;
      try {
        implementation = JSON.parse(aiResponse);
      } catch (parseError) {
        logger.error(`[PRReviewer] Failed to parse implementation response: ${aiResponse.substring(0, 200)}`);
        throw new Error('Invalid implementation response format');
      }
      
      // Validate implementation structure
      if (!implementation || typeof implementation !== 'object') {
        throw new Error('Implementation response is not an object');
      }
      
      if (!Array.isArray(implementation.files) || implementation.files.length === 0) {
        logger.warn('[PRReviewer] No files in implementation, skipping');
        // Close the original PR without creating a new one - already closed above, just return
        return;
      }
      
      // Create a new branch
      const branchName = `pr-reviewer/implement-${prNumber}-${Date.now()}`;
      await execInRepo(`git checkout -b ${branchName}`);
      
      // Apply the implementation
      for (const file of implementation.files) {
        const filePath = path.join(GIT_REPO_PATH, file.path);
        const dir = path.dirname(filePath);
        
        // Create directory if needed
        await fs.mkdir(dir, { recursive: true });
        
        // Write file
        await fs.writeFile(filePath, file.content);
        
        // Stage file
        await execInRepo(`git add ${file.path}`);
      }
      
      // Commit changes
      const commitMessage = `feat: Reimplementation of PR #${prNumber}

${implementation.summary}

Improvements:
${implementation.improvements.map(i => `- ${i}`).join('\n')}

Original PR: #${prNumber}
Automated by LANAgent PR Reviewer`;
      
      await execInRepo(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
      
      // Push branch
      await execInRepo(`git push origin ${branchName}`);
      
      // Create new PR
      const prBody = `## Automated Reimplementation of PR #${prNumber}

This PR is an improved implementation of the ideas from PR #${prNumber} "${title}".

### Summary
${implementation.summary}

### Improvements Made
${implementation.improvements.map(i => `- ${i}`).join('\n')}

### Original Issues
${reason}

---
*This PR was automatically created by LANAgent PR Reviewer using ${settings.aiProvider}/${settings.aiModel}*`;

      // Create new PR using provider or gh CLI
      const createProvider = await this.getGitHostingProvider();
      if (createProvider) {
        try {
          const mrResult = await createProvider.createMergeRequest({
            title: `Reimplementation of #${prNumber}: ${title}`,
            body: prBody,
            sourceBranch: branchName,
            targetBranch: 'main',
            labels: ['ai-generated', 'reimplementation']
          });
          if (mrResult.success) {
            logger.info(`[PRReviewer] Created new PR via ${createProvider.name}: ${mrResult.url}`);
          } else {
            throw new Error(mrResult.error || 'Failed to create PR');
          }
        } catch (error) {
          logger.warn(`[PRReviewer] Provider PR creation failed, using gh CLI: ${error.message}`);
          await execInRepo(`gh pr create --title "Reimplementation of #${prNumber}: ${title}" --body "${prBody.replace(/"/g, '\\"')}" --head ${branchName}`);
        }
      } else {
        await execInRepo(`gh pr create --title "Reimplementation of #${prNumber}: ${title}" --body "${prBody.replace(/"/g, '\\"')}" --head ${branchName}`);
      }

      logger.info(`[PRReviewer] Created new PR for reimplementation of #${prNumber}`);

      // Return to main branch
      await execInRepo('git checkout main');

    } catch (error) {
      logger.error('[PRReviewer] Error implementing PR:', error);
      // Make sure we return to main branch
      await execInRepo('git checkout main').catch(() => {});
      throw error;
    }
  }

  async performSafeDeployment() {
    logger.info('[PRReviewer] Starting safe deployment process');
    
    const settings = await this.getSettings();
    
    try {
      // Create backup
      const backupDir = path.join(path.dirname(GIT_REPO_PATH), `lanagent-backup-${Date.now()}`);
      logger.info(`[PRReviewer] Creating backup at ${backupDir}`);
      
      await execAsync(`cp -r ${GIT_REPO_PATH} ${backupDir}`);
      
      this.currentDeployment = {
        backupDir,
        startTime: new Date(),
        preDeploymentHealth: await this.checkHealth()
      };
      
      // Pull latest changes
      logger.info('[PRReviewer] Pulling latest changes');
      await execInRepo('git pull origin main');
      
      // Install dependencies if package.json changed
      const { stdout: gitStatus } = await execInRepo('git diff HEAD~1 --name-only');
      if (gitStatus.includes('package.json')) {
        logger.info('[PRReviewer] package.json changed, installing dependencies');
        await execInRepo('npm install');
      }
      
      // Restart the application
      logger.info('[PRReviewer] Restarting application');
      await execAsync('pm2 restart lan-agent');
      
      // Monitor health
      const healthCheckResult = await this.monitorDeploymentHealth();
      
      if (!healthCheckResult.healthy) {
        logger.error('[PRReviewer] Deployment health check failed:', healthCheckResult.errors);
        
        if (settings.rollbackOnFailure) {
          await this.rollbackDeployment({ reason: 'Health check failed', errors: healthCheckResult.errors });
        }
        
        return {
          success: false,
          error: 'Deployment failed health checks',
          details: healthCheckResult.errors
        };
      }
      
      // Update stats
      await this.updateStats({ deployments: 1 });
      
      logger.info('[PRReviewer] Deployment completed successfully');
      
      // Clean up old backup after successful deployment
      setTimeout(async () => {
        try {
          await execAsync(`rm -rf ${backupDir}`);
          logger.info(`[PRReviewer] Cleaned up backup directory ${backupDir}`);
        } catch (error) {
          logger.warn('[PRReviewer] Failed to clean up backup:', error);
        }
      }, 3600000); // Clean up after 1 hour
      
      return {
        success: true,
        message: 'Deployment completed successfully'
      };
      
    } catch (error) {
      logger.error('[PRReviewer] Deployment error:', error);
      
      if (settings.rollbackOnFailure) {
        await this.rollbackDeployment({ reason: 'Deployment error', error: error.message });
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  async monitorDeploymentHealth() {
    const config = this.healthCheckConfig;
    const errors = [];
    let restartCount = 0;
    const startTime = Date.now();
    
    logger.info('[PRReviewer] Starting deployment health monitoring');
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        try {
          // Check if process is running
          const { stdout: pm2Status } = await execAsync('pm2 jlist');
          // PM2 may output non-JSON messages before the JSON array
          let jsonStr = pm2Status;
          const jsonStart = pm2Status.indexOf('[');
          if (jsonStart > 0) jsonStr = pm2Status.slice(jsonStart);
          const processes = JSON.parse(jsonStr);
          const lanAgent = processes.find(p => p.name === 'lan-agent');
          
          if (!lanAgent) {
            errors.push('Process not found in PM2');
            clearInterval(checkInterval);
            resolve({ healthy: false, errors });
            return;
          }
          
          // Check restart count
          if (lanAgent.pm2_env.restart_time > restartCount) {
            restartCount = lanAgent.pm2_env.restart_time;
            logger.warn(`[PRReviewer] Process restarted ${restartCount} times`);
            
            if (restartCount >= config.maxRestarts) {
              errors.push(`Process restarted ${restartCount} times (max: ${config.maxRestarts})`);
              clearInterval(checkInterval);
              resolve({ healthy: false, errors });
              return;
            }
          }
          
          // Check HTTP endpoints
          for (const endpoint of config.endpoints) {
            try {
              const response = await fetch(endpoint.url);
              if (response.status !== endpoint.expectedStatus) {
                errors.push(`Endpoint ${endpoint.url} returned ${response.status} (expected ${endpoint.expectedStatus})`);
              }
            } catch (error) {
              errors.push(`Endpoint ${endpoint.url} unreachable: ${error.message}`);
            }
          }
          
          // Check if monitoring duration has elapsed
          if (Date.now() - startTime >= config.checkDuration) {
            clearInterval(checkInterval);
            
            if (errors.length === 0) {
              logger.info('[PRReviewer] Health monitoring passed');
              resolve({ healthy: true });
            } else {
              resolve({ healthy: false, errors: [...new Set(errors)] }); // Remove duplicates
            }
          }
          
        } catch (error) {
          errors.push(`Health check error: ${error.message}`);
          clearInterval(checkInterval);
          resolve({ healthy: false, errors });
        }
      }, config.checkInterval);
    });
  }

  async rollbackDeployment(details) {
    logger.warn('[PRReviewer] Rolling back deployment:', details);
    
    if (!this.currentDeployment) {
      logger.error('[PRReviewer] No current deployment to rollback');
      return {
        success: false,
        error: 'No deployment to rollback'
      };
    }
    
    try {
      // Restore from backup
      logger.info(`[PRReviewer] Restoring from backup ${this.currentDeployment.backupDir}`);
      
      await execAsync('pm2 stop lan-agent');
      await execAsync(`rm -rf ${GIT_REPO_PATH}`);
      await execAsync(`mv ${this.currentDeployment.backupDir} ${GIT_REPO_PATH}`);
      await execAsync('pm2 start lan-agent');
      
      // Update stats
      await this.updateStats({ rollbacks: 1 });
      
      // Notify about rollback
      if (this.agent.interfaces.get('telegram')) {
        await this.notify(
          `⚠️ LANAgent deployment was rolled back\n\n` +
          `Reason: ${details.reason}\n` +
          `${details.error ? `Error: ${details.error}` : ''}`
        );
      }
      
      logger.info('[PRReviewer] Rollback completed');
      
      return {
        success: true,
        message: 'Deployment rolled back successfully'
      };
      
    } catch (error) {
      logger.error('[PRReviewer] Rollback failed:', error);
      return {
        success: false,
        error: `Rollback failed: ${error.message}`
      };
    }
  }

  async checkHealth() {
    const health = {
      process: false,
      endpoints: {}
    };
    
    try {
      // Check PM2 process
      const { stdout } = await execAsync('pm2 jlist');
      // PM2 may output non-JSON messages before the JSON array
      let jsonStr = stdout;
      const jsonStart = stdout.indexOf('[');
      if (jsonStart > 0) jsonStr = stdout.slice(jsonStart);
      const processes = JSON.parse(jsonStr);
      const lanAgent = processes.find(p => p.name === 'lan-agent');
      health.process = lanAgent && lanAgent.pm2_env.status === 'online';
      
      // Check endpoints
      for (const endpoint of this.healthCheckConfig.endpoints) {
        try {
          const response = await fetch(endpoint.url);
          health.endpoints[endpoint.url] = response.status === endpoint.expectedStatus;
        } catch {
          health.endpoints[endpoint.url] = false;
        }
      }
      
    } catch (error) {
      logger.error('[PRReviewer] Health check error:', error);
    }
    
    return health;
  }

  async getSettings() {
    try {
      const agentId = this.agent.id || 'default';
      let settings = await PRReviewSettings.findOne({ agentId });
      
      if (!settings) {
        // Create default settings if none exist
        settings = new PRReviewSettings({
          agentId,
          ...this.defaultSettings
        });
        await settings.save();
      }
      
      return {
        success: true,
        ...settings.toObject(),
        stats: settings.stats,
        lastReview: settings.lastReview
      };
    } catch (error) {
      logger.error('[PRReviewer] Error getting settings:', error);
      return { success: false, error: error.message };
    }
  }

  async updateSettings(updates) {
    try {
      const agentId = this.agent.id || 'default';
      const settings = await PRReviewSettings.findOneAndUpdate(
        { agentId },
        { $set: updates },
        { new: true, upsert: true }
      );
      
      // Update scheduling if enabled state changed
      if (updates.enabled !== undefined) {
        if (updates.enabled) {
          await this.scheduleReviews();
        } else if (this.agent.scheduler) {
          await this.agent.scheduler.agenda.cancel({ name: 'review-prs' });
          logger.info('[PRReviewer] Cancelled scheduled PR reviews');
        }
      }
      
      return { success: true, settings: settings.toObject() };
    } catch (error) {
      logger.error('[PRReviewer] Error updating settings:', error);
      return { success: false, error: error.message };
    }
  }

  async getStats() {
    try {
      const agentId = this.agent.id || 'default';
      const settings = await PRReviewSettings.findOne({ agentId });
      
      if (!settings) {
        return {
          success: true,
          stats: this.defaultSettings.stats,
          lastReview: null,
          nextReview: null
        };
      }
      
      return {
        success: true,
        stats: settings.stats,
        lastReview: settings.lastReview,
        nextReview: await this.getNextReviewTime()
      };
    } catch (error) {
      logger.error('[PRReviewer] Error getting stats:', error);
      return { success: false, error: error.message };
    }
  }

  async updateStats(updates) {
    try {
      const agentId = this.agent.id || 'default';
      const updateOps = {};
      
      // Build update operations
      if (updates.totalReviewed !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.totalReviewed'] = updates.totalReviewed;
      }
      if (updates.merged !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.merged'] = updates.merged;
      }
      if (updates.rejected !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.rejected'] = updates.rejected;
      }
      if (updates.implemented !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.implemented'] = updates.implemented;
      }
      if (updates.deployments !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.deployments'] = updates.deployments;
      }
      if (updates.rollbacks !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.rollbacks'] = updates.rollbacks;
      }
      if (updates.errors !== undefined) {
        updateOps['$inc'] = updateOps['$inc'] || {};
        updateOps['$inc']['stats.errors'] = updates.errors;
      }
      if (updates.lastError !== undefined) {
        updateOps['$set'] = updateOps['$set'] || {};
        updateOps['$set']['stats.lastError'] = updates.lastError;
      }
      
      await PRReviewSettings.findOneAndUpdate(
        { agentId },
        updateOps,
        { upsert: true }
      );
      
    } catch (error) {
      logger.error('[PRReviewer] Error updating stats:', error);
    }
  }

  async addToReviewHistory(review) {
    try {
      const agentId = this.agent.id || 'default';
      
      // Add to MongoDB history collection
      const historyEntry = new PRReviewHistory({
        agentId,
        prNumber: review.prNumber,
        title: review.title,
        action: review.action,
        reason: review.reason,
        reviewTime: Date.now() - new Date(review.timestamp).getTime()
      });
      await historyEntry.save();
      
      // Also update the stats review history (keep last 100)
      await PRReviewSettings.findOneAndUpdate(
        { agentId },
        {
          $push: {
            'stats.reviewHistory': {
              $each: [review],
              $slice: -100
            }
          }
        },
        { upsert: true }
      );
      
    } catch (error) {
      logger.error('[PRReviewer] Error adding to review history:', error);
    }
  }

  async getNextReviewTime() {
    if (!this.agent.scheduler) return null;
    
    const jobs = await this.agent.scheduler.agenda.jobs({ name: 'review-prs' });
    if (jobs.length > 0) {
      return jobs[0].attrs.nextRunAt;
    }
    
    return null;
  }

  async testReviewPR(data) {
    if (!data.prNumber) {
      return { success: false, error: 'PR number required' };
    }
    
    logger.info(`[PRReviewer] Test reviewing PR #${data.prNumber}`);

    try {
      const settings = await this.getSettings();

      // Get PR info using provider or gh CLI
      let pr;
      const provider = await this.getGitHostingProvider();

      if (provider) {
        try {
          const mrData = await provider.getMergeRequest(data.prNumber);
          pr = {
            number: mrData.number,
            title: mrData.title,
            author: { login: mrData.author },
            createdAt: mrData.createdAt,
            isDraft: mrData.draft
          };
        } catch (error) {
          logger.warn(`[PRReviewer] Provider failed for PR info, using gh CLI: ${error.message}`);
          const { stdout: prJson } = await execInRepo(`gh pr view ${data.prNumber} --json number,title,author,createdAt,isDraft`);
          pr = JSON.parse(prJson);
        }
      } else {
        const { stdout: prJson } = await execInRepo(`gh pr view ${data.prNumber} --json number,title,author,createdAt,isDraft`);
        pr = JSON.parse(prJson);
      }
      
      // Do a dry run review
      const review = await this.reviewSinglePR(pr, { ...settings, deployAfterMerge: false });
      
      return {
        success: true,
        message: `Test review completed for PR #${data.prNumber}`,
        review,
        wouldPerform: review.action
      };
      
    } catch (error) {
      logger.error('[PRReviewer] Test review error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}