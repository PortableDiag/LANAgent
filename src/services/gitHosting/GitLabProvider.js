import { GitHostingProvider } from './GitHostingProvider.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * GitLabProvider - GitLab implementation of GitHostingProvider
 *
 * Supports both gitlab.com and self-hosted GitLab instances.
 * Uses GitLab REST API v4.
 */
export class GitLabProvider extends GitHostingProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'gitlab';
    this.baseUrl = config.baseUrl || 'https://gitlab.com';
    this.apiUrl = `${this.baseUrl}/api/v4`;
    this.token = config.token || process.env.GITLAB_TOKEN;
    this.projectId = config.projectId || null; // Can be 'owner/repo' or numeric ID
    this.projectPath = config.projectPath || null; // URL-encoded path like 'owner%2Frepo'
  }

  /**
   * Initialize the provider
   */
  async initialize() {
    if (!this.token) {
      throw new Error('GitLab token not configured. Set GITLAB_TOKEN environment variable or pass token in config.');
    }

    // Auto-detect project from git remote if not configured
    if (!this.projectId && !this.projectPath) {
      await this.detectProject();
    }

    // URL-encode the project path for API calls
    if (this.projectId && !this.projectPath) {
      this.projectPath = encodeURIComponent(this.projectId);
    }

    this.initialized = true;
    this.log('info', `GitLab provider initialized for ${this.projectId}`);
  }

  /**
   * Detect project from git remote
   */
  async detectProject() {
    try {
      const { stdout } = await execAsync('git remote get-url origin');
      const remoteUrl = stdout.trim();

      // Parse GitLab URL formats:
      // - https://gitlab.com/owner/repo.git
      // - git@gitlab.com:owner/repo.git
      // - https://self-hosted.gitlab.com/owner/repo.git
      let match = remoteUrl.match(/gitlab[^/]*[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) {
        this.projectId = match[1];
        this.projectPath = encodeURIComponent(this.projectId);

        // Also detect base URL for self-hosted instances
        const urlMatch = remoteUrl.match(/^https?:\/\/([^/]+)/);
        if (urlMatch && !urlMatch[1].includes('gitlab.com')) {
          this.baseUrl = `https://${urlMatch[1]}`;
          this.apiUrl = `${this.baseUrl}/api/v4`;
        }
      }
    } catch (error) {
      this.log('warn', 'Could not detect GitLab project from git remote', { error: error.message });
    }
  }

  /**
   * Make an API request to GitLab
   */
  async apiRequest(endpoint, options = {}) {
    const url = `${this.apiUrl}${endpoint}`;
    const headers = {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      ...options
    };

    if (options.body && typeof options.body === 'object') {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitLab API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) return null;

    return JSON.parse(text);
  }

  /**
   * Validate credentials
   */
  async validateCredentials() {
    try {
      const user = await this.apiRequest('/user');
      return {
        valid: true,
        message: `Authenticated as ${user.username}`,
        user: {
          login: user.username,
          name: user.name,
          email: user.email,
          id: user.id
        }
      };
    } catch (error) {
      return {
        valid: false,
        message: `Authentication failed: ${error.message}`
      };
    }
  }

  // ==================== MERGE REQUEST OPERATIONS ====================

  /**
   * Create a merge request
   */
  async createMergeRequest(options) {
    try {
      const body = {
        source_branch: options.sourceBranch,
        target_branch: options.targetBranch || 'main',
        title: options.title,
        description: options.body || '',
        draft: options.draft || false,
        labels: options.labels?.join(',') || '',
        assignee_ids: [] // Would need to resolve usernames to IDs
      };

      // Resolve assignee usernames to IDs if provided
      if (options.assignees?.length > 0) {
        for (const username of options.assignees) {
          try {
            const users = await this.apiRequest(`/users?username=${encodeURIComponent(username)}`);
            if (users.length > 0) {
              body.assignee_ids.push(users[0].id);
            }
          } catch (e) {
            this.log('warn', `Could not resolve assignee: ${username}`);
          }
        }
      }

      const mr = await this.apiRequest(`/projects/${this.projectPath}/merge_requests`, {
        method: 'POST',
        body
      });

      return {
        success: true,
        number: mr.iid,
        url: mr.web_url
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List merge requests
   */
  async listMergeRequests(options = {}) {
    const params = new URLSearchParams();

    // Map state values
    const stateMap = {
      'open': 'opened',
      'closed': 'closed',
      'merged': 'merged',
      'all': 'all'
    };
    params.set('state', stateMap[options.state] || 'opened');

    if (options.limit) params.set('per_page', options.limit.toString());
    if (options.author) params.set('author_username', options.author);

    const mrs = await this.apiRequest(`/projects/${this.projectPath}/merge_requests?${params}`);

    return mrs.map(mr => ({
      number: mr.iid,
      title: mr.title,
      author: mr.author?.username || 'unknown',
      createdAt: mr.created_at,
      draft: mr.draft || mr.work_in_progress,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      state: mr.state
    }));
  }

  /**
   * Get a specific merge request
   */
  async getMergeRequest(mrNumber) {
    const mr = await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}`);

    // Get changes/files
    const changes = await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}/changes`);

    return {
      number: mr.iid,
      title: mr.title,
      body: mr.description,
      state: mr.state,
      draft: mr.draft || mr.work_in_progress,
      author: mr.author?.username,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      additions: changes.changes?.reduce((sum, c) => sum + (c.diff?.split('\n').filter(l => l.startsWith('+')).length || 0), 0) || 0,
      deletions: changes.changes?.reduce((sum, c) => sum + (c.diff?.split('\n').filter(l => l.startsWith('-')).length || 0), 0) || 0,
      files: changes.changes?.map(c => ({
        filename: c.new_path,
        status: c.new_file ? 'added' : c.deleted_file ? 'deleted' : 'modified',
        additions: c.diff?.split('\n').filter(l => l.startsWith('+')).length || 0,
        deletions: c.diff?.split('\n').filter(l => l.startsWith('-')).length || 0
      })) || [],
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      mergedAt: mr.merged_at,
      mergedBy: mr.merged_by?.username
    };
  }

  /**
   * Get merge request diff
   */
  async getMergeRequestDiff(mrNumber) {
    const changes = await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}/changes`);

    // Combine all diffs
    return changes.changes?.map(c =>
      `--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`
    ).join('\n\n') || '';
  }

  /**
   * Comment on a merge request
   */
  async commentOnMergeRequest(mrNumber, body) {
    try {
      const note = await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}/notes`, {
        method: 'POST',
        body: { body }
      });

      return {
        success: true,
        commentId: note.id
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Merge a merge request
   */
  async mergeMergeRequest(mrNumber, options = {}) {
    try {
      const body = {
        should_remove_source_branch: options.deleteBranch || false
      };

      // GitLab merge methods
      if (options.mergeMethod === 'squash') {
        body.squash = true;
      } else if (options.mergeMethod === 'rebase') {
        body.merge_when_pipeline_succeeds = false;
        // Note: GitLab handles rebase differently - would need to use rebase endpoint first
      }

      await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}/merge`, {
        method: 'PUT',
        body
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close a merge request
   */
  async closeMergeRequest(mrNumber, comment = null) {
    try {
      if (comment) {
        await this.commentOnMergeRequest(mrNumber, comment);
      }

      await this.apiRequest(`/projects/${this.projectPath}/merge_requests/${mrNumber}`, {
        method: 'PUT',
        body: { state_event: 'close' }
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ==================== ISSUE OPERATIONS ====================

  /**
   * Create an issue
   */
  async createIssue(options) {
    try {
      const body = {
        title: options.title,
        description: options.body || '',
        labels: options.labels?.join(',') || ''
      };

      // Resolve assignees
      if (options.assignees?.length > 0) {
        body.assignee_ids = [];
        for (const username of options.assignees) {
          try {
            const users = await this.apiRequest(`/users?username=${encodeURIComponent(username)}`);
            if (users.length > 0) {
              body.assignee_ids.push(users[0].id);
            }
          } catch (e) {
            this.log('warn', `Could not resolve assignee: ${username}`);
          }
        }
      }

      const issue = await this.apiRequest(`/projects/${this.projectPath}/issues`, {
        method: 'POST',
        body
      });

      return {
        success: true,
        number: issue.iid,
        url: issue.web_url
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List issues
   */
  async listIssues(options = {}) {
    const params = new URLSearchParams();

    if (options.state && options.state !== 'all') {
      params.set('state', options.state === 'open' ? 'opened' : options.state);
    }
    if (options.labels?.length > 0) {
      params.set('labels', options.labels.join(','));
    }
    if (options.limit) params.set('per_page', options.limit.toString());

    const issues = await this.apiRequest(`/projects/${this.projectPath}/issues?${params}`);

    return issues.map(issue => ({
      number: issue.iid,
      title: issue.title,
      state: issue.state === 'opened' ? 'open' : issue.state,
      author: issue.author?.username || 'unknown',
      labels: issue.labels || [],
      createdAt: issue.created_at
    }));
  }

  /**
   * Get a specific issue
   */
  async getIssue(issueNumber) {
    const issue = await this.apiRequest(`/projects/${this.projectPath}/issues/${issueNumber}`);

    return {
      number: issue.iid,
      title: issue.title,
      body: issue.description,
      state: issue.state === 'opened' ? 'open' : issue.state,
      author: issue.author?.username || 'unknown',
      labels: issue.labels || [],
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at
    };
  }

  /**
   * Search issues
   */
  async searchIssues(query, options = {}) {
    const params = new URLSearchParams();
    params.set('search', query);
    if (options.state) params.set('state', options.state === 'open' ? 'opened' : options.state);

    const issues = await this.apiRequest(`/projects/${this.projectPath}/issues?${params}`);

    return issues.map(issue => ({
      number: issue.iid,
      title: issue.title,
      state: issue.state === 'opened' ? 'open' : issue.state,
      author: issue.author?.username,
      labels: issue.labels || [],
      createdAt: issue.created_at
    }));
  }

  /**
   * Close an issue
   */
  async closeIssue(issueNumber, comment = null) {
    try {
      if (comment) {
        await this.apiRequest(`/projects/${this.projectPath}/issues/${issueNumber}/notes`, {
          method: 'POST',
          body: { body: comment }
        });
      }

      await this.apiRequest(`/projects/${this.projectPath}/issues/${issueNumber}`, {
        method: 'PUT',
        body: { state_event: 'close' }
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ==================== REPOSITORY OPERATIONS ====================

  /**
   * Get repository info
   */
  async getRepository() {
    const project = await this.apiRequest(`/projects/${this.projectPath}`);

    return {
      name: project.name,
      fullName: project.path_with_namespace,
      description: project.description,
      defaultBranch: project.default_branch,
      private: project.visibility === 'private',
      webUrl: project.web_url,
      sshUrl: project.ssh_url_to_repo,
      httpsUrl: project.http_url_to_repo
    };
  }

  /**
   * Get file content
   */
  async getFileContent(path, ref = null) {
    const params = new URLSearchParams();
    if (ref) params.set('ref', ref);

    const file = await this.apiRequest(
      `/projects/${this.projectPath}/repository/files/${encodeURIComponent(path)}?${params}`
    );

    return {
      content: Buffer.from(file.content, file.encoding).toString('utf8'),
      encoding: file.encoding,
      size: file.size,
      sha: file.blob_id
    };
  }

  /**
   * List directory contents
   */
  async listDirectory(path = '', ref = null) {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (ref) params.set('ref', ref);

    const items = await this.apiRequest(`/projects/${this.projectPath}/repository/tree?${params}`);

    return items.map(item => ({
      name: item.name,
      type: item.type === 'tree' ? 'dir' : 'file',
      path: item.path
    }));
  }

  /**
   * Get recent commits
   */
  async getCommits(options = {}) {
    const params = new URLSearchParams();
    if (options.branch) params.set('ref_name', options.branch);
    if (options.limit) params.set('per_page', options.limit.toString());

    const commits = await this.apiRequest(`/projects/${this.projectPath}/repository/commits?${params}`);

    return commits.map(commit => ({
      sha: commit.id,
      shortSha: commit.short_id,
      message: commit.message,
      author: commit.author_name,
      authorEmail: commit.author_email,
      date: commit.created_at
    }));
  }

  /**
   * Search repositories
   */
  async searchRepositories(query, options = {}) {
    const params = new URLSearchParams();
    params.set('search', query);
    if (options.limit) params.set('per_page', options.limit.toString());

    const projects = await this.apiRequest(`/projects?${params}`);

    return projects.map(project => ({
      name: project.name,
      fullName: project.path_with_namespace,
      description: project.description,
      url: project.web_url,
      stars: project.star_count
    }));
  }

  /**
   * Search code
   */
  async searchCode(query, options = {}) {
    // GitLab code search within a project
    const params = new URLSearchParams();
    params.set('search', query);
    params.set('scope', 'blobs');

    const results = await this.apiRequest(`/projects/${this.projectPath}/search?${params}`);

    return results.map(result => ({
      path: result.path,
      repository: this.projectId,
      content: result.data,
      ref: result.ref
    }));
  }

  // ==================== BRANCH OPERATIONS ====================

  /**
   * Create a branch
   */
  async createBranch(branchName, sourceBranch = 'main') {
    try {
      await this.apiRequest(`/projects/${this.projectPath}/repository/branches`, {
        method: 'POST',
        body: {
          branch: branchName,
          ref: sourceBranch
        }
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Delete a branch
   */
  async deleteBranch(branchName) {
    try {
      await this.apiRequest(
        `/projects/${this.projectPath}/repository/branches/${encodeURIComponent(branchName)}`,
        { method: 'DELETE' }
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List branches
   */
  async listBranches() {
    const branches = await this.apiRequest(`/projects/${this.projectPath}/repository/branches`);
    const project = await this.apiRequest(`/projects/${this.projectPath}`);

    return branches.map(branch => ({
      name: branch.name,
      protected: branch.protected,
      default: branch.name === project.default_branch
    }));
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get clone URL
   */
  getCloneUrl(useSSH = false) {
    if (useSSH) {
      return `git@${new URL(this.baseUrl).host}:${this.projectId}.git`;
    }
    return `${this.baseUrl}/${this.projectId}.git`;
  }

  /**
   * Get merge request URL
   */
  getMergeRequestUrl(mrNumber) {
    return `${this.baseUrl}/${this.projectId}/-/merge_requests/${mrNumber}`;
  }

  /**
   * Get issue URL
   */
  getIssueUrl(issueNumber) {
    return `${this.baseUrl}/${this.projectId}/-/issues/${issueNumber}`;
  }

  /**
   * Get terminology
   */
  getTerminology() {
    return {
      mergeRequest: 'merge request',
      pullRequest: 'merge request'  // GitLab uses MR terminology
    };
  }
}

export default GitLabProvider;
