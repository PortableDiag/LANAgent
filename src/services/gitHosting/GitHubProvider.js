import { GitHostingProvider } from './GitHostingProvider.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * GitHubProvider - GitHub implementation of GitHostingProvider
 *
 * Uses GitHub REST API v3 and the GitHub CLI (gh) for operations.
 */
export class GitHubProvider extends GitHostingProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'github';
    this.baseUrl = 'https://api.github.com';
    this.token = config.token || process.env.GIT_PERSONAL_ACCESS_TOKEN;
    this.owner = config.owner || null;
    this.repo = config.repo || null;
    this.repoPath = config.repoPath || process.env.AGENT_REPO_PATH || process.cwd();
  }

  /**
   * Initialize the provider
   */
  async initialize() {
    // Parse owner/repo from GITHUB_REPO env or config
    const repoUrl = this.config.repoUrl || process.env.GITHUB_REPO;
    if (repoUrl && !this.owner) {
      const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) {
        this.owner = match[1];
        this.repo = match[2];
      }
    }

    if (!this.token) {
      throw new Error('GitHub token not configured. Set GIT_PERSONAL_ACCESS_TOKEN environment variable.');
    }

    if (!this.owner || !this.repo) {
      throw new Error('GitHub repository not configured. Set GITHUB_REPO environment variable.');
    }

    this.initialized = true;
    this.log('info', `Initialized for ${this.owner}/${this.repo}`);
  }

  /**
   * Make an authenticated API request to GitHub
   */
  async apiRequest(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'LANAgent',
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${error}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  /**
   * Execute a gh CLI command
   */
  async ghCommand(args, options = {}) {
    const cmd = `gh ${args}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: options.cwd || this.repoPath,
        env: { ...process.env, GH_TOKEN: this.token }
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      return { success: false, error: error.message, stderr: error.stderr };
    }
  }

  /**
   * Validate credentials
   */
  async validateCredentials() {
    try {
      const user = await this.apiRequest('/user');
      return {
        valid: true,
        message: `Authenticated as ${user.login}`,
        user: { login: user.login, name: user.name, email: user.email }
      };
    } catch (error) {
      return { valid: false, message: error.message };
    }
  }

  // ==================== MERGE/PULL REQUEST OPERATIONS ====================

  async createMergeRequest(options) {
    const {
      title,
      body,
      sourceBranch,
      targetBranch = 'main',
      draft = false,
      labels = [],
      assignees = []
    } = options;

    try {
      // Use gh CLI for PR creation (handles authentication better)
      let cmd = `pr create --title "${title.replace(/"/g, '\\"')}" --base ${targetBranch} --head ${sourceBranch}`;

      if (draft) cmd += ' --draft';
      if (labels.length) cmd += ` --label "${labels.join(',')}"`;
      if (assignees.length) cmd += ` --assignee "${assignees.join(',')}"`;

      // Write body to temp file to avoid escaping issues
      const fs = await import('fs/promises');
      const os = await import('os');
      const path = await import('path');
      const tempFile = path.join(os.tmpdir(), `pr-body-${Date.now()}.md`);
      await fs.writeFile(tempFile, body);
      cmd += ` --body-file "${tempFile}"`;

      let result = await this.ghCommand(cmd);

      // If labels don't exist on the repo, retry without them
      if (!result.success && (result.error || result.stderr || '').includes('not found') && labels.length) {
        this.log('warn', 'PR labels not found on repo, retrying without labels');
        const cmdNoLabels = cmd.replace(/ --label "[^"]*"/, '');
        result = await this.ghCommand(cmdNoLabels);
      }

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      if (!result.success) {
        return { success: false, error: result.error || result.stderr };
      }

      // Parse PR URL from output
      const urlMatch = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      const prNumber = urlMatch ? parseInt(urlMatch[1]) : null;

      return {
        success: true,
        number: prNumber,
        url: result.stdout.trim()
      };
    } catch (error) {
      this.log('error', 'Failed to create PR:', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async listMergeRequests(options = {}) {
    const { state = 'open', limit = 30, author = null } = options;

    try {
      let cmd = `pr list --state ${state} --limit ${limit} --json number,title,author,createdAt,isDraft,headRefName`;
      if (author) cmd += ` --author ${author}`;

      const result = await this.ghCommand(cmd);
      if (!result.success) {
        throw new Error(result.error || result.stderr);
      }

      const prs = JSON.parse(result.stdout || '[]');
      return prs.map(pr => ({
        number: pr.number,
        title: pr.title,
        author: pr.author?.login || 'unknown',
        createdAt: pr.createdAt,
        draft: pr.isDraft,
        sourceBranch: pr.headRefName
      }));
    } catch (error) {
      this.log('error', 'Failed to list PRs:', { error: error.message });
      return [];
    }
  }

  async getMergeRequest(prNumber) {
    try {
      const result = await this.ghCommand(
        `pr view ${prNumber} --json number,title,body,files,additions,deletions,state,headRefName,baseRefName`
      );

      if (!result.success) {
        throw new Error(result.error || result.stderr);
      }

      const pr = JSON.parse(result.stdout);
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        files: pr.files || [],
        additions: pr.additions,
        deletions: pr.deletions,
        state: pr.state,
        sourceBranch: pr.headRefName,
        targetBranch: pr.baseRefName
      };
    } catch (error) {
      this.log('error', `Failed to get PR #${prNumber}:`, { error: error.message });
      throw error;
    }
  }

  async getMergeRequestDiff(prNumber) {
    try {
      const result = await this.ghCommand(`pr diff ${prNumber}`);
      if (!result.success) {
        throw new Error(result.error || result.stderr);
      }
      return result.stdout;
    } catch (error) {
      this.log('error', `Failed to get diff for PR #${prNumber}:`, { error: error.message });
      throw error;
    }
  }

  async commentOnMergeRequest(prNumber, body) {
    try {
      const result = await this.ghCommand(`pr comment ${prNumber} --body "${body.replace(/"/g, '\\"')}"`);

      if (!result.success) {
        return { success: false, error: result.error || result.stderr };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async mergeMergeRequest(prNumber, options = {}) {
    const { deleteBranch = true, mergeMethod = 'merge' } = options;

    try {
      let cmd = `pr merge ${prNumber}`;

      if (mergeMethod === 'squash') cmd += ' --squash';
      else if (mergeMethod === 'rebase') cmd += ' --rebase';
      else cmd += ' --merge';

      if (deleteBranch) cmd += ' --delete-branch';

      const result = await this.ghCommand(cmd);

      if (!result.success) {
        return { success: false, error: result.error || result.stderr };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async closeMergeRequest(prNumber, comment = null) {
    try {
      if (comment) {
        await this.commentOnMergeRequest(prNumber, comment);
      }

      const result = await this.ghCommand(`pr close ${prNumber}`);

      if (!result.success) {
        return { success: false, error: result.error || result.stderr };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== ISSUE OPERATIONS ====================

  async createIssue(options) {
    const { title, body, labels = [], assignees = [] } = options;

    try {
      const data = await this.apiRequest(`/repos/${this.owner}/${this.repo}/issues`, {
        method: 'POST',
        body: {
          title,
          body,
          labels,
          assignees
        }
      });

      return {
        success: true,
        number: data.number,
        url: data.html_url
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listIssues(options = {}) {
    const { state = 'open', labels = [], limit = 30 } = options;

    try {
      let endpoint = `/repos/${this.owner}/${this.repo}/issues?state=${state}&per_page=${limit}`;
      if (labels.length) endpoint += `&labels=${labels.join(',')}`;

      const data = await this.apiRequest(endpoint);

      // Filter out pull requests (GitHub API returns PRs in issues endpoint)
      return data
        .filter(issue => !issue.pull_request)
        .map(issue => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login || 'unknown',
          labels: issue.labels?.map(l => l.name) || [],
          createdAt: issue.created_at
        }));
    } catch (error) {
      this.log('error', 'Failed to list issues:', { error: error.message });
      return [];
    }
  }

  async getIssue(issueNumber) {
    try {
      const data = await this.apiRequest(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`);

      return {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        author: data.user?.login || 'unknown',
        labels: data.labels?.map(l => l.name) || [],
        createdAt: data.created_at
      };
    } catch (error) {
      this.log('error', `Failed to get issue #${issueNumber}:`, { error: error.message });
      throw error;
    }
  }

  async searchIssues(query, options = {}) {
    try {
      const q = encodeURIComponent(`${query} repo:${this.owner}/${this.repo}`);
      const data = await this.apiRequest(`/search/issues?q=${q}&per_page=${options.limit || 20}`);

      return data.items.map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        labels: issue.labels?.map(l => l.name) || [],
        repository: issue.repository_url?.split('/').slice(-2).join('/'),
        score: issue.score
      }));
    } catch (error) {
      this.log('error', 'Failed to search issues:', { error: error.message });
      return [];
    }
  }

  async closeIssue(issueNumber, comment = null) {
    try {
      if (comment) {
        await this.apiRequest(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
          method: 'POST',
          body: { body: comment }
        });
      }

      await this.apiRequest(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, {
        method: 'PATCH',
        body: { state: 'closed' }
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== REPOSITORY OPERATIONS ====================

  async getRepository() {
    try {
      const data = await this.apiRequest(`/repos/${this.owner}/${this.repo}`);

      return {
        name: data.name,
        fullName: data.full_name,
        description: data.description,
        defaultBranch: data.default_branch,
        private: data.private
      };
    } catch (error) {
      this.log('error', 'Failed to get repository:', { error: error.message });
      throw error;
    }
  }

  async getFileContent(path, ref = null) {
    try {
      let endpoint = `/repos/${this.owner}/${this.repo}/contents/${path}`;
      if (ref) endpoint += `?ref=${ref}`;

      const data = await this.apiRequest(endpoint);

      return {
        content: data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString() : data.content,
        encoding: data.encoding,
        size: data.size
      };
    } catch (error) {
      this.log('error', `Failed to get file ${path}:`, { error: error.message });
      throw error;
    }
  }

  async listDirectory(path = '', ref = null) {
    try {
      let endpoint = `/repos/${this.owner}/${this.repo}/contents/${path}`;
      if (ref) endpoint += `?ref=${ref}`;

      const data = await this.apiRequest(endpoint);

      if (!Array.isArray(data)) {
        return [{ name: data.name, type: data.type, path: data.path }];
      }

      return data.map(item => ({
        name: item.name,
        type: item.type === 'dir' ? 'dir' : 'file',
        path: item.path
      }));
    } catch (error) {
      this.log('error', `Failed to list directory ${path}:`, { error: error.message });
      return [];
    }
  }

  async getCommits(options = {}) {
    const { branch = 'main', limit = 30 } = options;

    try {
      const data = await this.apiRequest(
        `/repos/${this.owner}/${this.repo}/commits?sha=${branch}&per_page=${limit}`
      );

      return data.map(commit => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author?.name || commit.author?.login || 'unknown',
        date: commit.commit.author?.date
      }));
    } catch (error) {
      this.log('error', 'Failed to get commits:', { error: error.message });
      return [];
    }
  }

  async searchRepositories(query, options = {}) {
    try {
      const q = encodeURIComponent(query);
      const data = await this.apiRequest(`/search/repositories?q=${q}&per_page=${options.limit || 10}`);

      return data.items.map(repo => ({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        url: repo.html_url,
        stars: repo.stargazers_count
      }));
    } catch (error) {
      this.log('error', 'Failed to search repositories:', { error: error.message });
      return [];
    }
  }

  async searchCode(query, options = {}) {
    try {
      const q = encodeURIComponent(query);
      const data = await this.apiRequest(`/search/code?q=${q}&per_page=${options.limit || 10}`);

      return data.items.map(item => ({
        path: item.path,
        repository: item.repository.full_name,
        url: item.html_url
      }));
    } catch (error) {
      this.log('error', 'Failed to search code:', { error: error.message });
      return [];
    }
  }

  // ==================== BRANCH OPERATIONS ====================

  async createBranch(branchName, sourceBranch = 'main') {
    try {
      // Get the SHA of the source branch
      const refData = await this.apiRequest(`/repos/${this.owner}/${this.repo}/git/refs/heads/${sourceBranch}`);
      const sha = refData.object.sha;

      // Create new branch
      await this.apiRequest(`/repos/${this.owner}/${this.repo}/git/refs`, {
        method: 'POST',
        body: {
          ref: `refs/heads/${branchName}`,
          sha
        }
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteBranch(branchName) {
    try {
      await this.apiRequest(`/repos/${this.owner}/${this.repo}/git/refs/heads/${branchName}`, {
        method: 'DELETE'
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listBranches() {
    try {
      const data = await this.apiRequest(`/repos/${this.owner}/${this.repo}/branches`);
      const repo = await this.getRepository();

      return data.map(branch => ({
        name: branch.name,
        protected: branch.protected,
        default: branch.name === repo.defaultBranch
      }));
    } catch (error) {
      this.log('error', 'Failed to list branches:', { error: error.message });
      return [];
    }
  }

  // ==================== UPSTREAM CONTRIBUTION ====================

  /**
   * Create a cross-fork pull request to the upstream repository.
   * This allows agent instances to contribute improvements back to the upstream genesis repo.
   *
   * Flow: agent pushes branch to their fork, then creates a PR from fork → upstream.
   *
   * @param {Object} options
   * @param {string} options.title - PR title
   * @param {string} options.body - PR description
   * @param {string} options.sourceBranch - Branch name on the fork
   * @param {string} options.targetBranch - Target branch on upstream (default: main)
   * @param {string} options.upstreamOwner - Upstream repo owner (default: from UPSTREAM_REPO env)
   * @param {string} options.upstreamRepo - Upstream repo name (default: LANAgent)
   * @returns {Promise<{success: boolean, number?: number, url?: string, error?: string}>}
   */
  async createUpstreamPR(options) {
    const {
      title,
      body,
      sourceBranch,
      targetBranch = 'main',
      upstreamOwner,
      upstreamRepo
    } = options;

    // Determine upstream target
    const upstreamUrl = process.env.UPSTREAM_REPO || 'https://github.com/PortableDiag/LANAgent';
    let uOwner = upstreamOwner;
    let uRepo = upstreamRepo;

    if (!uOwner || !uRepo) {
      const match = upstreamUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) {
        uOwner = match[1];
        uRepo = match[2];
      }
    }

    if (!uOwner || !uRepo) {
      return { success: false, error: 'Could not determine upstream repository. Set UPSTREAM_REPO env var.' };
    }

    // Don't PR to yourself
    if (uOwner === this.owner && uRepo === this.repo) {
      this.log('info', 'Fork owner matches upstream — creating local PR instead');
      return this.createMergeRequest({ title, body, sourceBranch, targetBranch });
    }

    try {
      // GitHub API: Create cross-fork PR
      // head format for cross-fork: "fork_owner:branch_name"
      const head = `${this.owner}:${sourceBranch}`;

      const data = await this.apiRequest(`/repos/${uOwner}/${uRepo}/pulls`, {
        method: 'POST',
        body: {
          title,
          body,
          head,
          base: targetBranch,
          maintainer_can_modify: true
        }
      });

      this.log('info', `Upstream PR created: ${data.html_url}`);

      return {
        success: true,
        number: data.number,
        url: data.html_url
      };
    } catch (error) {
      this.log('error', 'Failed to create upstream PR:', { error: error.message });

      // Common error: fork not synced or branch doesn't exist on fork
      if (error.message.includes('422')) {
        return {
          success: false,
          error: `GitHub rejected the PR. Ensure branch "${sourceBranch}" is pushed to your fork (${this.owner}/${this.repo}) and your fork is not too far behind upstream.`
        };
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Check if this repo is a fork and get upstream info
   */
  async getUpstreamInfo() {
    try {
      const data = await this.apiRequest(`/repos/${this.owner}/${this.repo}`);
      if (data.fork && data.parent) {
        return {
          isFork: true,
          upstream: {
            owner: data.parent.owner.login,
            repo: data.parent.name,
            fullName: data.parent.full_name,
            defaultBranch: data.parent.default_branch
          }
        };
      }
      return { isFork: false, upstream: null };
    } catch (error) {
      this.log('warn', 'Could not check fork status:', { error: error.message });
      return { isFork: false, upstream: null };
    }
  }

  // ==================== UTILITY METHODS ====================

  getCloneUrl(useSSH = false) {
    if (useSSH) {
      return `git@github.com:${this.owner}/${this.repo}.git`;
    }
    return `https://github.com/${this.owner}/${this.repo}.git`;
  }

  getMergeRequestUrl(prNumber) {
    return `https://github.com/${this.owner}/${this.repo}/pull/${prNumber}`;
  }

  getIssueUrl(issueNumber) {
    return `https://github.com/${this.owner}/${this.repo}/issues/${issueNumber}`;
  }

  getTerminology() {
    return {
      mergeRequest: 'pull request',
      pullRequest: 'pull request'
    };
  }
}

export default GitHubProvider;
