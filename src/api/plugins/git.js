import { BasePlugin } from '../core/basePlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import simpleGit from 'simple-git';
import { determineProjectForIssue, parseIssueDetails } from '../../utils/projectContext.js';

const execAsync = promisify(exec);

export default class GitPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'git';
    this.version = '1.0.0';
    this.description = 'Git repository management and automation';
    this.commands = [
      {
        command: 'status',
        description: 'Show git repository status',
        usage: 'status({ detailed: true })'
      },
      {
        command: 'commit',
        description: 'Create a git commit',
        usage: 'commit({ message: "feat: add new feature", files: ["."] })'
      },
      {
        command: 'push',
        description: 'Push commits to remote repository',
        usage: 'push({ branch: "main", force: false })'
      },
      {
        command: 'pull',
        description: 'Pull latest changes from remote',
        usage: 'pull({ branch: "main", rebase: false })'
      },
      {
        command: 'branch',
        description: 'Create or switch branches',
        usage: 'branch({ name: "feature/new-feature", checkout: true })'
      },
      {
        command: 'log',
        description: 'Show git commit history',
        usage: 'log({ limit: 10, oneline: true })'
      },
      {
        command: 'diff',
        description: 'Show changes in working directory',
        usage: 'diff({ staged: false, files: [] })'
      },
      {
        command: 'stash',
        description: 'Stash or apply changes',
        usage: 'stash({ action: "save", message: "WIP changes" })'
      },
      {
        command: 'merge',
        description: 'Merge branches',
        usage: 'merge({ branch: "feature/branch", strategy: "recursive" })'
      },
      {
        command: 'clone',
        description: 'Clone a repository',
        usage: 'clone({ url: "https://github.com/user/repo.git", path: "./repo" })'
      },
      {
        command: 'pr',
        description: 'Create pull request (GitHub)',
        usage: 'pr({ title: "New feature", body: "Description", base: "main" })'
      },
      {
        command: 'tag',
        description: 'Create or list tags',
        usage: 'tag({ name: "v1.0.0", message: "Release version 1.0.0" })'
      }
    ];
    this.repoPath = process.cwd();
    this.developmentPath = process.env.AGENT_REPO_PATH || process.cwd(); // Separate repo for development
    this.currentWorkingPath = this.developmentPath; // Default to development repo for git operations
    this.gitToken = process.env.GIT_PERSONAL_ACCESS_TOKEN;
    this.gitUser = null;
    this.gitEmail = null;
  }

  async initialize() {
    this.logger.info('Git plugin initializing...');
    
    // Initialize git with current working path
    this.git = simpleGit(this.currentWorkingPath);
    
    try {
      // Check if we're in a git repository
      await this.executeGitCommand('status');
      this.logger.info('Git repository detected');
      
      // Get git config
      try {
        const { stdout: userName } = await this.executeGitCommand('config user.name');
        this.gitUser = userName.trim();
      } catch (e) {
        this.logger.warn('Git user.name not configured');
      }
      
      try {
        const { stdout: userEmail } = await this.executeGitCommand('config user.email');
        this.gitEmail = userEmail.trim();
      } catch (e) {
        this.logger.warn('Git user.email not configured');
      }
      
      // Configure git if needed
      if (!this.gitUser || !this.gitEmail) {
        await this.configureGit();
      }
      
    } catch (error) {
      this.logger.warn('Not in a git repository, plugin will initialize repos as needed');
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    this.validateParams(params, {
      action: {
        required: true,
        type: 'string',
        enum: ['status', 'add', 'commit', 'push', 'pull', 'fetch', 'branch', 'checkout', 
               'log', 'diff', 'init', 'clone', 'remote', 'stash', 'config', 'setWorkingDirectory',
               'createIssue', 'listIssues', 'getIssue', 'searchIssues', 'updateIssue', 'closeIssue']
      }
    });
    
    switch (action) {
      case 'status':
        return await this.getStatus();
      case 'add':
        return await this.addFiles(data);
      case 'commit':
        return await this.commit(data);
      case 'push':
        return await this.push(data);
      case 'pull':
        return await this.pull(data);
      case 'fetch':
        return await this.fetch(data);
      case 'branch':
        return await this.manageBranch(data);
      case 'checkout':
        return await this.checkout(data);
      case 'log':
        return await this.getLog(data);
      case 'diff':
        return await this.getDiff(data);
      case 'init':
        return await this.initRepo(data);
      case 'clone':
        return await this.cloneRepo(data);
      case 'remote':
        return await this.manageRemote(data);
      case 'stash':
        return await this.stash(data);
      case 'config':
        return await this.configure(data);
      case 'setWorkingDirectory':
        return await this.setWorkingDirectory(data);
      case 'createIssue':
        // If we have a message field, it's from natural language
        if (data.message) {
          return await this.createIssueFromNaturalLanguage(data.message);
        }
        // Otherwise use direct API
        return await this.createGitHubIssue(data);
      case 'listIssues':
        return await this.listGitHubIssues(data);
      case 'getIssue':
        return await this.getGitHubIssue(data);
      case 'searchIssues':
        return await this.searchGitHubIssues(data);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async executeGitCommand(command, options = {}) {
    const cwd = options.cwd || this.currentWorkingPath;
    this.logger.debug(`Executing git command: ${command} in directory: ${cwd}`);
    try {
      const { stdout, stderr } = await execAsync(`git ${command}`, { cwd });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      this.logger.debug(`Git command failed: ${error.message}`);
      return { 
        success: false, 
        error: error.message, 
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || ''
      };
    }
  }

  async configureGit() {
    const agentName = this.agent.config.name || 'LANAgent';
    const agentEmail = this.getState('emailAddress') || 'agent@localhost';
    
    await this.executeGitCommand(`config user.name "${agentName}"`);
    await this.executeGitCommand(`config user.email "${agentEmail}"`);
    
    this.gitUser = agentName;
    this.gitEmail = agentEmail;
    
    this.logger.info(`Configured git: ${agentName} <${agentEmail}>`);
  }

  async getStatus() {
    const result = await this.executeGitCommand('status --porcelain');
    
    if (!result.success) {
      throw new Error(`Git status failed: ${result.error}`);
    }
    
    const files = result.stdout.split('\n').filter(line => line.trim());
    const changes = {
      modified: [],
      added: [],
      deleted: [],
      untracked: []
    };
    
    files.forEach(file => {
      const [status, ...pathParts] = file.split(/\s+/);
      const filePath = pathParts.join(' ');
      
      if (status === 'M' || status === 'MM') changes.modified.push(filePath);
      else if (status === 'A') changes.added.push(filePath);
      else if (status === 'D') changes.deleted.push(filePath);
      else if (status === '??') changes.untracked.push(filePath);
    });
    
    // Get branch info
    const branchResult = await this.executeGitCommand('branch --show-current');
    const branch = branchResult.stdout || 'main';
    
    // Get remote status
    const remoteResult = await this.executeGitCommand('status -sb');
    const ahead = remoteResult.stdout.match(/ahead (\d+)/)?.[1] || 0;
    const behind = remoteResult.stdout.match(/behind (\d+)/)?.[1] || 0;
    
    return {
      success: true,
      branch,
      changes,
      totalChanges: files.length,
      clean: files.length === 0,
      ahead: parseInt(ahead),
      behind: parseInt(behind)
    };
  }

  async addFiles(data) {
    this.validateParams(data, {
      files: { type: 'array' }
    });
    
    const files = data.files || ['.'];
    const results = [];
    
    for (const file of files) {
      const result = await this.executeGitCommand(`add ${file}`);
      results.push({
        file,
        success: result.success,
        error: result.error
      });
    }
    
    const allSuccess = results.every(r => r.success);
    const addedCount = results.filter(r => r.success).length;
    
    // Notify
    await this.notify(
      `📦 Added ${addedCount} file${addedCount !== 1 ? 's' : ''} to git staging`
    );
    
    return {
      success: allSuccess,
      results,
      message: `Added ${addedCount}/${files.length} files`
    };
  }

  async commit(data) {
    this.validateParams(data, {
      message: { required: true, type: 'string' }
    });
    
    const message = data.message;
    const aiGenerated = data.aiGenerated !== false;
    
    // Add AI signature if generated by AI
    let fullMessage = message;
    if (aiGenerated) {
      fullMessage += `\n\n🤖 Generated by ${this.agent.config.name}\nCo-Authored-By: ${this.agent.config.name} <${this.gitEmail}>`;
    }
    
    // Escape the message for shell
    const escapedMessage = fullMessage.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    
    const result = await this.executeGitCommand(`commit -m "${escapedMessage}"`);
    
    if (!result.success) {
      if (result.stderr.includes('nothing to commit')) {
        return {
          success: false,
          message: 'Nothing to commit, working tree clean'
        };
      }
      throw new Error(`Commit failed: ${result.stderr}`);
    }
    
    // Get commit hash
    const hashResult = await this.executeGitCommand('rev-parse HEAD');
    const commitHash = hashResult.stdout.substring(0, 7);
    
    // Notify
    await this.notify(`✅ Committed: ${message}\nHash: ${commitHash}`);
    
    return {
      success: true,
      message: 'Changes committed successfully',
      commitHash,
      fullMessage
    };
  }

  async push(data) {
    const branch = data.branch || 'current';
    const force = data.force === true;
    
    let command = 'push';
    if (branch === 'current') {
      command += ' -u origin HEAD';
    } else {
      command += ` origin ${branch}`;
    }
    
    if (force) {
      command += ' --force-with-lease';
    }
    
    // Add auth if token is available
    if (this.gitToken) {
      // Get remote URL
      const remoteResult = await this.executeGitCommand('remote get-url origin');
      if (remoteResult.success) {
        const url = remoteResult.stdout;
        if (url.includes('github.com')) {
          // Configure credential helper temporarily
          await this.executeGitCommand(`config credential.helper "store --file=/tmp/git-creds-${Date.now()}"`);
          
          // Write credentials
          const credUrl = url.replace('https://', `https://${this.gitToken}@`);
          await this.executeGitCommand(`remote set-url origin ${credUrl}`);
        }
      }
    }
    
    const result = await this.executeGitCommand(command);
    
    // Reset remote URL if we modified it
    if (this.gitToken && result.success) {
      const remoteResult = await this.executeGitCommand('remote get-url origin');
      if (remoteResult.stdout.includes(this.gitToken)) {
        const cleanUrl = remoteResult.stdout.replace(/https:\/\/[^@]+@/, 'https://');
        await this.executeGitCommand(`remote set-url origin ${cleanUrl}`);
      }
    }
    
    if (!result.success) {
      throw new Error(`Push failed: ${result.stderr}`);
    }
    
    // Notify
    await this.notify(`📤 Pushed changes to remote${force ? ' (forced)' : ''}`);
    
    return {
      success: true,
      message: 'Changes pushed successfully',
      output: result.stdout
    };
  }

  async pull(data) {
    const branch = data.branch || 'current';
    const rebase = data.rebase === true;
    
    let command = 'pull';
    if (rebase) {
      command += ' --rebase';
    }
    
    if (branch !== 'current') {
      command += ` origin ${branch}`;
    }
    
    const result = await this.executeGitCommand(command);
    
    if (!result.success) {
      throw new Error(`Pull failed: ${result.stderr}`);
    }
    
    // Check for conflicts
    const statusResult = await this.executeGitCommand('status');
    const hasConflicts = statusResult.stdout.includes('Unmerged paths');
    
    // Notify
    await this.notify(
      `📥 Pulled latest changes${rebase ? ' (rebased)' : ''}` +
      (hasConflicts ? '\n⚠️ Conflicts detected!' : '')
    );
    
    return {
      success: true,
      message: hasConflicts ? 'Pulled with conflicts' : 'Changes pulled successfully',
      hasConflicts,
      output: result.stdout
    };
  }

  async fetch(data) {
    const remote = data.remote || 'origin';
    const branch = data.branch || '';
    const prune = data.prune === true;
    
    let command = `fetch ${remote}`;
    if (branch) {
      command += ` ${branch}`;
    }
    if (prune) {
      command += ' --prune';
    }
    
    const result = await this.executeGitCommand(command);
    
    if (!result.success) {
      throw new Error(`Fetch failed: ${result.stderr}`);
    }
    
    // Get status to see if we're behind after fetch
    const statusResult = await this.executeGitCommand('status --porcelain -b');
    let behind = 0;
    let ahead = 0;
    
    if (statusResult.success) {
      const statusLine = statusResult.stdout.split('\n')[0];
      const behindMatch = statusLine.match(/behind (\d+)/);
      const aheadMatch = statusLine.match(/ahead (\d+)/);
      
      if (behindMatch) behind = parseInt(behindMatch[1]);
      if (aheadMatch) ahead = parseInt(aheadMatch[1]);
    }
    
    return {
      success: true,
      message: `Fetched from ${remote}${branch ? ` (${branch})` : ''}`,
      remote,
      branch,
      behind,
      ahead,
      output: result.stdout
    };
  }

  async manageRemote(data) {
    const subAction = data.subAction || 'list';

    switch (subAction) {
      case 'list': {
        const result = await this.executeGitCommand('remote -v');
        if (!result.success) throw new Error(`Failed to list remotes: ${result.stderr}`);
        const remotes = result.stdout.split('\n')
          .map(line => line.trim())
          .filter(line => line)
          .map(line => {
            const [name, rest] = line.split('\t');
            const [url, type] = (rest || '').split(' ');
            return { name, url, type: type?.replace(/[()]/g, '') || 'unknown' };
          });
        return { success: true, remotes };
      }

      case 'get-url': {
        const name = data.name || 'origin';
        const result = await this.executeGitCommand(`remote get-url ${name}`);
        if (!result.success) throw new Error(`Failed to get remote URL: ${result.stderr}`);
        return { success: true, url: result.stdout.trim() };
      }

      case 'add': {
        if (!data.name || !data.url) throw new Error('Remote name and URL required');
        const result = await this.executeGitCommand(`remote add ${data.name} ${data.url}`);
        return { success: result.success, message: `Added remote: ${data.name} → ${data.url}` };
      }

      case 'remove': {
        if (!data.name) throw new Error('Remote name required');
        const result = await this.executeGitCommand(`remote remove ${data.name}`);
        return { success: result.success, message: `Removed remote: ${data.name}` };
      }

      case 'set-url': {
        if (!data.name || !data.url) throw new Error('Remote name and URL required');
        const result = await this.executeGitCommand(`remote set-url ${data.name} ${data.url}`);
        return { success: result.success, message: `Updated remote URL: ${data.name} → ${data.url}` };
      }

      default:
        throw new Error(`Unknown remote action: ${subAction}`);
    }
  }

  async manageBranch(data) {
    const subAction = data.subAction || 'list';
    
    switch (subAction) {
      case 'list':
        const result = await this.executeGitCommand('branch -a');
        const branches = result.stdout.split('\n')
          .map(b => b.trim())
          .filter(b => b)
          .map(b => ({
            name: b.replace(/^\*\s*/, '').replace(/^remotes\//, ''),
            current: b.startsWith('*'),
            remote: b.includes('remotes/')
          }));
          
        return { success: true, branches };
        
      case 'create':
        if (!data.name) throw new Error('Branch name required');
        const createResult = await this.executeGitCommand(`checkout -b ${data.name}`);
        return { 
          success: createResult.success,
          message: `Created and switched to branch: ${data.name}`
        };
        
      case 'delete':
        if (!data.name) throw new Error('Branch name required');
        const deleteResult = await this.executeGitCommand(`branch -d ${data.name}`);
        return {
          success: deleteResult.success,
          message: `Deleted branch: ${data.name}`
        };
        
      default:
        throw new Error(`Unknown branch action: ${subAction}`);
    }
  }

  async checkout(data) {
    this.validateParams(data, {
      target: { required: true, type: 'string' }
    });
    
    const result = await this.executeGitCommand(`checkout ${data.target}`);
    
    if (!result.success) {
      throw new Error(`Checkout failed: ${result.stderr}`);
    }
    
    return {
      success: true,
      message: `Switched to ${data.target}`,
      output: result.stdout
    };
  }

  async getLog(data) {
    const limit = data.limit || 10;
    const oneline = data.oneline !== false;
    
    let command = `log -${limit}`;
    if (oneline) {
      command += ' --oneline --graph --decorate';
    }
    
    const result = await this.executeGitCommand(command);
    
    if (!result.success) {
      throw new Error(`Log failed: ${result.error}`);
    }
    
    const commits = result.stdout.split('\n').filter(line => line.trim());
    
    return {
      success: true,
      commits,
      count: commits.length
    };
  }

  async getDiff(data) {
    const staged = data.staged === true;
    const file = data.file;
    
    let command = 'diff';
    if (staged) {
      command += ' --cached';
    }
    if (file) {
      command += ` ${file}`;
    }
    
    const result = await this.executeGitCommand(command);
    
    return {
      success: true,
      diff: result.stdout || 'No changes',
      hasChanges: result.stdout.length > 0
    };
  }

  async initRepo(data) {
    const path = data.path || this.repoPath;
    const result = await this.executeGitCommand('init', { cwd: path });
    
    if (!result.success) {
      throw new Error(`Init failed: ${result.error}`);
    }
    
    // Configure git in new repo
    await this.configureGit();
    
    return {
      success: true,
      message: `Initialized git repository in ${path}`
    };
  }

  async cloneRepo(data) {
    this.validateParams(data, {
      url: { required: true, type: 'string' }
    });
    
    const url = data.url;
    const destination = data.destination;
    
    let command = `clone ${url}`;
    if (destination) {
      command += ` ${destination}`;
    }
    
    // Add auth if token is available and it's a GitHub URL
    let authUrl = url;
    if (this.gitToken && url.includes('github.com')) {
      authUrl = url.replace('https://', `https://${this.gitToken}@`);
      command = `clone ${authUrl}`;
      if (destination) {
        command += ` ${destination}`;
      }
    }
    
    const result = await this.executeGitCommand(command);
    
    if (!result.success) {
      throw new Error(`Clone failed: ${result.stderr}`);
    }
    
    return {
      success: true,
      message: `Repository cloned successfully`,
      destination: destination || path.basename(url, '.git')
    };
  }

  async stash(data) {
    const subAction = data.subAction || 'save';
    const message = data.message;
    
    let command = 'stash';
    
    switch (subAction) {
      case 'save':
        command += ' push';
        if (message) command += ` -m "${message}"`;
        break;
      case 'pop':
        command += ' pop';
        break;
      case 'list':
        command += ' list';
        break;
      case 'apply':
        command += ' apply';
        if (data.index !== undefined) command += ` stash@{${data.index}}`;
        break;
    }
    
    const result = await this.executeGitCommand(command);
    
    return {
      success: result.success,
      message: result.success ? `Stash ${subAction} completed` : result.stderr,
      output: result.stdout
    };
  }

  async configure(data) {
    const configs = [];
    
    if (data.userName) {
      await this.executeGitCommand(`config user.name "${data.userName}"`);
      configs.push(`user.name = ${data.userName}`);
    }
    
    if (data.userEmail) {
      await this.executeGitCommand(`config user.email "${data.userEmail}"`);
      configs.push(`user.email = ${data.userEmail}`);
    }
    
    if (data.global) {
      // Apply configs globally
      for (const config of configs) {
        const [key, value] = config.split(' = ');
        await this.executeGitCommand(`config --global ${key} "${value}"`);
      }
    }
    
    return {
      success: true,
      message: 'Git configuration updated',
      configs
    };
  }

  /**
   * Set working directory for git operations
   */
  async setWorkingDirectory(data) {
    const { path, type = 'custom' } = data;
    
    // Predefined paths for different purposes
    const presetPaths = {
      'development': this.developmentPath,
      'production': this.repoPath,
      'custom': path
    };
    
    const newPath = presetPaths[type] || path;
    
    if (!newPath) {
      throw new Error('Working directory path is required');
    }
    
    // Verify directory exists and is a git repository
    const fs = await import('fs/promises');
    const pathLib = await import('path');
    
    try {
      await fs.access(newPath);
      await fs.access(pathLib.join(newPath, '.git'));
    } catch (error) {
      throw new Error(`Invalid git repository path: ${newPath}`);
    }
    
    // Update the working path
    this.currentWorkingPath = newPath;
    this.git = simpleGit(newPath);
    
    return {
      success: true,
      message: `Git working directory set to ${newPath}`,
      path: newPath,
      type
    };
  }

  // Helper method for AI to create smart commits
  async createSmartCommit(description) {
    // Get current changes
    const status = await this.getStatus();
    
    if (status.clean) {
      return {
        success: false,
        message: 'No changes to commit'
      };
    }
    
    // Stage all changes
    await this.addFiles({ files: ['.'] });
    
    // Get diff to understand changes
    const diff = await this.getDiff({ staged: true });
    
    // Use AI to generate commit message
    const prompt = `Based on these git changes, create a conventional commit message. 
Description from user: ${description}
Changed files: ${JSON.stringify(status.changes)}
Keep it concise and follow conventional commit format (feat:, fix:, docs:, etc)`;
    
    const aiResponse = await this.processWithAI(prompt);
    
    // Commit with AI-generated message
    return await this.commit({
      message: aiResponse.content || description,
      aiGenerated: true
    });
  }

  async createGitHubIssue(data) {
    this.validateParams(data, {
      title: { required: true, type: 'string' },
      body: { required: true, type: 'string' },
      labels: { type: 'array' },
      assignees: { type: 'array' },
      milestone: { type: 'number' }
    });

    if (!this.gitToken) {
      return {
        success: false,
        error: 'GitHub personal access token not configured. Set GIT_PERSONAL_ACCESS_TOKEN in environment.'
      };
    }

    try {
      // Debug logging
      this.logger.info(`GitHub issue creation - Current working path: ${this.currentWorkingPath}`);
      
      // Get repository info
      const remote = await this.executeGitCommand('remote get-url origin');
      
      this.logger.info(`GitHub issue creation - Remote command result: ${JSON.stringify(remote)}`);
      
      if (!remote.success) {
        this.logger.error(`Failed to get remote URL - Error: ${remote.error}, stderr: ${remote.stderr}`);
        return { success: false, error: `Failed to get remote URL: ${remote.error}` };
      }
      
      const repoUrl = remote.stdout.trim();
      this.logger.info(`GitHub issue creation - Remote URL: ${repoUrl}`);
      
      // Extract owner and repo from GitHub URL (handle URLs with embedded tokens)
      const match = repoUrl.match(/github\.com[\/:](?:[^@\/]+@)?([^\/]+)\/([^\/\.]+)/);
      if (!match) {
        return { success: false, error: `Not a GitHub repository or unable to parse URL: ${repoUrl}` };
      }
      
      const [, owner, repo] = match;
      
      // Create issue using GitHub API
      const issueData = {
        title: data.title,
        body: data.body,
        labels: data.labels || [],
        assignees: data.assignees || [],
        milestone: data.milestone
      };
      
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'LANAgent/1.0'
        },
        body: JSON.stringify(issueData)
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${responseData.message}`,
          details: responseData
        };
      }
      
      return {
        success: true,
        issue: {
          id: responseData.id,
          number: responseData.number,
          title: responseData.title,
          body: responseData.body,
          state: responseData.state,
          url: responseData.html_url,
          apiUrl: responseData.url,
          createdAt: responseData.created_at,
          updatedAt: responseData.updated_at
        },
        message: `GitHub issue #${responseData.number} created successfully`
      };
      
    } catch (error) {
      this.logger.error('Failed to create GitHub issue:', error);
      return { success: false, error: error.message };
    }
  }

  async listGitHubIssues(data = {}) {
    if (!this.gitToken) {
      return {
        success: false,
        error: 'GitHub personal access token not configured'
      };
    }

    try {
      // Get repository info  
      const remote = await this.executeGitCommand('remote get-url origin');
      const repoUrl = remote.stdout.trim();
      
      const match = repoUrl.match(/github\.com[\/:](?:[^@\/]+@)?([^\/]+)\/([^\/\.]+)/);
      if (!match) {
        return { success: false, error: 'Not a GitHub repository' };
      }
      
      const [, owner, repo] = match;
      
      // Build query parameters
      const params = new URLSearchParams({
        state: data.state || 'open',
        sort: data.sort || 'created',
        direction: data.direction || 'desc',
        per_page: data.limit || 30,
        page: data.page || 1
      });
      
      if (data.labels) {
        params.append('labels', Array.isArray(data.labels) ? data.labels.join(',') : data.labels);
      }
      
      if (data.creator) {
        params.append('creator', data.creator);
      }
      
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?${params}`, {
        headers: {
          'Authorization': `token ${this.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LANAgent/1.0'
        }
      });
      
      const issues = await response.json();
      
      if (!response.ok) {
        return { success: false, error: `GitHub API error: ${issues.message}` };
      }
      
      // Filter out pull requests (they have a pull_request property)
      const actualIssues = issues.filter(issue => !issue.pull_request);
      
      return {
        success: true,
        issues: actualIssues.map(issue => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          labels: issue.labels.map(l => l.name),
          assignees: issue.assignees.map(a => a.login)
        })),
        count: actualIssues.length
      };
      
    } catch (error) {
      this.logger.error('Failed to list GitHub issues:', error);
      return { success: false, error: error.message };
    }
  }

  async getGitHubIssue(data) {
    this.validateParams(data, {
      number: { required: true, type: 'number' }
    });

    if (!this.gitToken) {
      return { success: false, error: 'GitHub personal access token not configured' };
    }

    try {
      // Get repository info
      const remote = await this.executeGitCommand('remote get-url origin');
      const repoUrl = remote.stdout.trim();
      
      const match = repoUrl.match(/github\.com[\/:](?:[^@\/]+@)?([^\/]+)\/([^\/\.]+)/);
      if (!match) {
        return { success: false, error: 'Not a GitHub repository' };
      }
      
      const [, owner, repo] = match;
      
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${data.number}`, {
        headers: {
          'Authorization': `token ${this.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LANAgent/1.0'
        }
      });
      
      const issue = await response.json();
      
      if (!response.ok) {
        return { success: false, error: `GitHub API error: ${issue.message}` };
      }
      
      return {
        success: true,
        issue: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          labels: issue.labels.map(l => l.name),
          assignees: issue.assignees.map(a => a.login)
        }
      };
      
    } catch (error) {
      this.logger.error('Failed to get GitHub issue:', error);
      return { success: false, error: error.message };
    }
  }

  async searchGitHubIssues(data) {
    this.validateParams(data, {
      query: { required: true, type: 'string' }
    });

    if (!this.gitToken) {
      return {
        success: false,
        error: 'GitHub personal access token not configured'
      };
    }

    try {
      // Build search query
      const searchQuery = encodeURIComponent(data.query);
      const state = data.state || 'open';
      
      // Use GitHub search API
      const searchUrl = `https://api.github.com/search/issues?q=${searchQuery}+state:${state}`;
      
      const response = await fetch(searchUrl, {
        headers: {
          'Authorization': `token ${this.gitToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'LANAgent/1.0'
        }
      });
      
      const searchResults = await response.json();
      
      if (!response.ok) {
        return { success: false, error: `GitHub API error: ${searchResults.message}` };
      }
      
      return {
        success: true,
        issues: searchResults.items.map(issue => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          labels: issue.labels.map(l => l.name),
          assignees: issue.assignees.map(a => a.login)
        })),
        totalCount: searchResults.total_count,
        count: searchResults.items.length
      };
      
    } catch (error) {
      this.logger.error('Failed to search GitHub issues:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Smart issue creation from natural language
   */
  async createIssueFromNaturalLanguage(message) {
    try {
      // Check if this is about a recent error
      const isErrorReport = message.toLowerCase().includes('that error') || 
                           message.toLowerCase().includes('the error') ||
                           message.toLowerCase().includes('recent error') ||
                           message.toLowerCase().includes('just got');
                           
      let enhancedMessage = message;
      
      if (isErrorReport && this.agent.memoryManager) {
        // Try to find recent error in conversation history
        // getRecentConversations takes only limit parameter
        const recentConversations = await this.agent.memoryManager.getRecentConversations(10);

        // Find the most recent error - check both agentMessage and userMessage fields
        const errorConvo = recentConversations.find(convo => {
          const agentMsg = convo.agentMessage || convo.assistant || '';
          return convo.metadata?.isError || agentMsg.includes('❌ Error:');
        });

        if (errorConvo) {
          this.logger.info('Found recent error in conversation history:', errorConvo);
          // Enhance the message with error details - handle both field naming conventions
          const agentResponse = errorConvo.agentMessage || errorConvo.assistant || '';
          const userInput = errorConvo.userMessage || errorConvo.user || '';
          enhancedMessage = `Create issue for error: ${agentResponse}\n\n` +
                           `User Input: ${userInput}\n` +
                           `Error Type: ${errorConvo.metadata?.errorType || 'Unknown'}\n` +
                           `Timestamp: ${new Date(errorConvo.metadata?.timestamp || errorConvo.timestamp).toISOString()}\n` +
                           (errorConvo.metadata?.errorStack ? `\nStack Trace:\n${errorConvo.metadata.errorStack}` : '');
        }
      }
      
      // Determine which project this issue is for
      const projectContext = await determineProjectForIssue(enhancedMessage, this.agent);
      
      if (!projectContext) {
        return {
          success: false,
          error: 'Could not determine which project to create the issue for. Please specify the project name.'
        };
      }
      
      this.logger.info(`Creating issue for project: ${projectContext.project} (${projectContext.owner}/${projectContext.repo})`);
      
      // Parse issue details from the enhanced message
      const issueDetails = parseIssueDetails(enhancedMessage);
      
      // Save current working directory
      const originalPath = this.currentWorkingPath;
      
      try {
        // If it's not LANAgent, try to switch to that project's directory
        if (projectContext.repo !== 'LANAgent') {
          // Check if we have this project locally
          const projectPath = path.join(path.dirname(this.developmentPath), projectContext.repo);
          try {
            await fs.access(projectPath);
            await fs.access(path.join(projectPath, '.git'));
            this.currentWorkingPath = projectPath;
            this.git = simpleGit(projectPath);
            this.logger.info(`Switched to project directory: ${projectPath}`);
          } catch (e) {
            this.logger.warn(`Project directory not found locally: ${projectPath}`);
            // We'll create the issue using GitHub API directly
          }
        }
        
        // Create the issue
        const result = await this.createGitHubIssue({
          title: issueDetails.title,
          body: `${issueDetails.body}\n\n---\n*Created via natural language command by ${this.agent.config.name}*`,
          labels: issueDetails.labels
        });
        
        if (result.success) {
          result.project = projectContext.project;
          result.confidence = projectContext.confidence;
          if (projectContext.reason) {
            result.contextReason = projectContext.reason;
          }
        }
        
        return result;
        
      } finally {
        // Restore original working directory
        if (this.currentWorkingPath !== originalPath) {
          this.currentWorkingPath = originalPath;
          this.git = simpleGit(originalPath);
          this.logger.info('Restored original working directory');
        }
      }
      
    } catch (error) {
      this.logger.error('Failed to create issue from natural language:', error);
      return { success: false, error: error.message };
    }
  }
}