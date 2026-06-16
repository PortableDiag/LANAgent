import { logger } from '../../utils/logger.js';
import { retryOperation } from '../../utils/retryUtils.js';

/**
 * GitHostingProvider - Abstract base class for git hosting services
 *
 * Provides a common interface for GitHub, GitLab, and other git hosting platforms.
 * All methods throw NotImplementedError by default and must be overridden by subclasses.
 */
export class GitHostingProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
    this.baseUrl = null;
    this.token = null;
    this.initialized = false;
  }

  /**
   * Initialize the provider with credentials and configuration
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Check if the provider is properly configured and authenticated
   * @returns {Promise<{valid: boolean, message: string, user?: object}>}
   */
  async validateCredentials() {
    throw new Error('validateCredentials() must be implemented by subclass');
  }

  // ==================== MERGE/PULL REQUEST OPERATIONS ====================

  /**
   * Create a merge/pull request
   * @param {object} options
   * @param {string} options.title - MR/PR title
   * @param {string} options.body - MR/PR description
   * @param {string} options.sourceBranch - Source branch name
   * @param {string} options.targetBranch - Target branch name (default: main)
   * @param {boolean} options.draft - Create as draft (default: false)
   * @param {string[]} options.labels - Labels to apply
   * @param {string[]} options.assignees - Usernames to assign
   * @returns {Promise<{success: boolean, number: number, url: string, error?: string}>}
   */
  async createMergeRequest(options) {
    throw new Error('createMergeRequest() must be implemented by subclass');
  }

  /**
   * List open merge/pull requests
   * @param {object} options
   * @param {string} options.state - 'open', 'closed', 'merged', 'all'
   * @param {number} options.limit - Max results to return
   * @param {string} options.author - Filter by author username
   * @returns {Promise<Array<{number: number, title: string, author: string, createdAt: string, draft: boolean, sourceBranch: string}>>}
   */
  async listMergeRequests(options = {}) {
    throw new Error('listMergeRequests() must be implemented by subclass');
  }

  /**
   * Get details of a specific merge/pull request
   * @param {number} mrNumber - MR/PR number
   * @returns {Promise<{number: number, title: string, body: string, files: Array, additions: number, deletions: number, state: string}>}
   */
  async getMergeRequest(mrNumber) {
    throw new Error('getMergeRequest() must be implemented by subclass');
  }

  /**
   * Get the diff for a merge/pull request
   * @param {number} mrNumber - MR/PR number
   * @returns {Promise<string>} - The diff content
   */
  async getMergeRequestDiff(mrNumber) {
    throw new Error('getMergeRequestDiff() must be implemented by subclass');
  }

  /**
   * Add a comment to a merge/pull request
   * @param {number} mrNumber - MR/PR number
   * @param {string} body - Comment body
   * @returns {Promise<{success: boolean, commentId: number, error?: string}>}
   */
  async commentOnMergeRequest(mrNumber, body) {
    throw new Error('commentOnMergeRequest() must be implemented by subclass');
  }

  /**
   * Merge a merge/pull request
   * @param {number} mrNumber - MR/PR number
   * @param {object} options
   * @param {boolean} options.deleteBranch - Delete source branch after merge
   * @param {string} options.mergeMethod - 'merge', 'squash', 'rebase'
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async mergeMergeRequest(mrNumber, options = {}) {
    throw new Error('mergeMergeRequest() must be implemented by subclass');
  }

  /**
   * Close a merge/pull request without merging
   * @param {number} mrNumber - MR/PR number
   * @param {string} comment - Optional closing comment
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async closeMergeRequest(mrNumber, comment = null) {
    throw new Error('closeMergeRequest() must be implemented by subclass');
  }

  /**
   * Batch create merge/pull requests. Each item is processed in parallel via
   * Promise.allSettled so a single failure doesn't abort the rest of the
   * batch — callers get one result per request describing success/failure.
   * @param {Array<object>} requests - Array of options objects (one per createMergeRequest call)
   * @returns {Promise<Array<{success: boolean, number?: number, url?: string, error?: string}>>}
   */
  async batchCreateMergeRequests(requests) {
    const settled = await Promise.allSettled(requests.map(opts => this.createMergeRequest(opts)));
    return settled.map(r => r.status === 'fulfilled'
      ? { success: true, ...r.value }
      : { success: false, error: r.reason?.message || String(r.reason) });
  }

  /**
   * Batch merge merge/pull requests.
   * @param {Array<number>} mrNumbers
   * @param {object} options - Forwarded to each mergeMergeRequest call
   * @returns {Promise<Array<{success: boolean, error?: string}>>}
   */
  async batchMergeMergeRequests(mrNumbers, options = {}) {
    const settled = await Promise.allSettled(mrNumbers.map(n => this.mergeMergeRequest(n, options)));
    return settled.map((r, i) => r.status === 'fulfilled'
      ? { success: true, mrNumber: mrNumbers[i], ...r.value }
      : { success: false, mrNumber: mrNumbers[i], error: r.reason?.message || String(r.reason) });
  }

  /**
   * Batch close merge/pull requests without merging.
   * @param {Array<number>} mrNumbers
   * @param {string} comment - Optional closing comment forwarded to each call
   * @returns {Promise<Array<{success: boolean, error?: string}>>}
   */
  async batchCloseMergeRequests(mrNumbers, comment = null) {
    const settled = await Promise.allSettled(mrNumbers.map(n => this.closeMergeRequest(n, comment)));
    return settled.map((r, i) => r.status === 'fulfilled'
      ? { success: true, mrNumber: mrNumbers[i], ...r.value }
      : { success: false, mrNumber: mrNumbers[i], error: r.reason?.message || String(r.reason) });
  }

  // ==================== ISSUE OPERATIONS ====================

  /**
   * Create an issue
   * @param {object} options
   * @param {string} options.title - Issue title
   * @param {string} options.body - Issue body
   * @param {string[]} options.labels - Labels to apply
   * @param {string[]} options.assignees - Usernames to assign
   * @returns {Promise<{success: boolean, number: number, url: string, error?: string}>}
   */
  async createIssue(options) {
    throw new Error('createIssue() must be implemented by subclass');
  }

  /**
   * List issues
   * @param {object} options
   * @param {string} options.state - 'open', 'closed', 'all'
   * @param {string[]} options.labels - Filter by labels
   * @param {number} options.limit - Max results
   * @returns {Promise<Array<{number: number, title: string, state: string, author: string, labels: string[], createdAt: string}>>}
   */
  async listIssues(options = {}) {
    throw new Error('listIssues() must be implemented by subclass');
  }

  /**
   * Get a specific issue
   * @param {number} issueNumber
   * @returns {Promise<{number: number, title: string, body: string, state: string, author: string, labels: string[], createdAt: string}>}
   */
  async getIssue(issueNumber) {
    throw new Error('getIssue() must be implemented by subclass');
  }

  /**
   * Search issues
   * @param {string} query - Search query
   * @param {object} options - Additional filters
   * @returns {Promise<Array>}
   */
  async searchIssues(query, options = {}) {
    throw new Error('searchIssues() must be implemented by subclass');
  }

  /**
   * Close an issue
   * @param {number} issueNumber
   * @param {string} comment - Optional closing comment
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async closeIssue(issueNumber, comment = null) {
    throw new Error('closeIssue() must be implemented by subclass');
  }

  /**
   * Batch create issues. Failures don't abort the rest of the batch.
   * @param {Array<object>} issues - Array of options objects (one per createIssue call)
   * @returns {Promise<Array<{success: boolean, number?: number, url?: string, error?: string}>>}
   */
  async batchCreateIssues(issues) {
    const settled = await Promise.allSettled(issues.map(opts => this.createIssue(opts)));
    return settled.map(r => r.status === 'fulfilled'
      ? { success: true, ...r.value }
      : { success: false, error: r.reason?.message || String(r.reason) });
  }

  /**
   * Batch close issues. Failures don't abort the rest of the batch.
   * @param {Array<number>} issueNumbers
   * @param {string} comment - Optional closing comment forwarded to each call
   * @returns {Promise<Array<{success: boolean, error?: string}>>}
   */
  async batchCloseIssues(issueNumbers, comment = null) {
    const settled = await Promise.allSettled(issueNumbers.map(n => this.closeIssue(n, comment)));
    return settled.map((r, i) => r.status === 'fulfilled'
      ? { success: true, issueNumber: issueNumbers[i], ...r.value }
      : { success: false, issueNumber: issueNumbers[i], error: r.reason?.message || String(r.reason) });
  }

  // ==================== REPOSITORY OPERATIONS ====================

  /**
   * Get repository information
   * @returns {Promise<{name: string, fullName: string, description: string, defaultBranch: string, private: boolean}>}
   */
  async getRepository() {
    throw new Error('getRepository() must be implemented by subclass');
  }

  /**
   * Get file contents from the repository
   * @param {string} path - File path
   * @param {string} ref - Branch or commit ref (optional)
   * @returns {Promise<{content: string, encoding: string, size: number}>}
   */
  async getFileContent(path, ref = null) {
    throw new Error('getFileContent() must be implemented by subclass');
  }

  /**
   * List directory contents
   * @param {string} path - Directory path
   * @param {string} ref - Branch or commit ref (optional)
   * @returns {Promise<Array<{name: string, type: 'file'|'dir', path: string}>>}
   */
  async listDirectory(path = '', ref = null) {
    throw new Error('listDirectory() must be implemented by subclass');
  }

  /**
   * Get recent commits
   * @param {object} options
   * @param {string} options.branch - Branch name
   * @param {number} options.limit - Max commits to return
   * @returns {Promise<Array<{sha: string, message: string, author: string, date: string}>>}
   */
  async getCommits(options = {}) {
    throw new Error('getCommits() must be implemented by subclass');
  }

  /**
   * Search repositories (for feature discovery)
   * @param {string} query - Search query
   * @param {object} options - Additional filters
   * @returns {Promise<Array<{name: string, fullName: string, description: string, url: string, stars: number}>>}
   */
  async searchRepositories(query, options = {}) {
    throw new Error('searchRepositories() must be implemented by subclass');
  }

  /**
   * Search code across repositories
   * @param {string} query - Search query
   * @param {object} options - Additional filters
   * @returns {Promise<Array<{path: string, repository: string, content: string}>>}
   */
  async searchCode(query, options = {}) {
    throw new Error('searchCode() must be implemented by subclass');
  }

  // ==================== BRANCH OPERATIONS ====================

  /**
   * Create a new branch
   * @param {string} branchName - New branch name
   * @param {string} sourceBranch - Source branch to create from
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createBranch(branchName, sourceBranch = 'main') {
    throw new Error('createBranch() must be implemented by subclass');
  }

  /**
   * Delete a branch
   * @param {string} branchName - Branch to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteBranch(branchName) {
    throw new Error('deleteBranch() must be implemented by subclass');
  }

  /**
   * List branches
   * @returns {Promise<Array<{name: string, protected: boolean, default: boolean}>>}
   */
  async listBranches() {
    throw new Error('listBranches() must be implemented by subclass');
  }

  // ==================== BRANCH PROTECTION OPERATIONS ====================

  /**
   * Create branch protection rules
   * @param {string} branchName - Branch to protect
   * @param {object} options - Protection options
   * @param {string[]} options.requiredStatusChecks - Required status checks
   * @param {boolean} options.requireReviews - Require reviews before merging
   * @param {string[]} options.restrictions - Users or teams allowed to push
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createBranchProtection(branchName, options) {
    throw new Error('createBranchProtection() must be implemented by subclass');
  }

  /**
   * Update branch protection rules
   * @param {string} branchName - Branch to update protection
   * @param {object} options - Updated protection options
   * @param {string[]} options.requiredStatusChecks - Required status checks
   * @param {boolean} options.requireReviews - Require reviews before merging
   * @param {string[]} options.restrictions - Users or teams allowed to push
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateBranchProtection(branchName, options) {
    throw new Error('updateBranchProtection() must be implemented by subclass');
  }

  /**
   * Delete branch protection rules
   * @param {string} branchName - Branch to remove protection
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteBranchProtection(branchName) {
    throw new Error('deleteBranchProtection() must be implemented by subclass');
  }

  // ==================== WEBHOOK OPERATIONS ====================

  /**
   * Create a webhook
   * @param {object} options
   * @param {string} options.url - Webhook URL
   * @param {string[]} options.events - Events to subscribe to
   * @param {boolean} options.active - Whether the webhook is active
   * @returns {Promise<{success: boolean, id: number, error?: string}>}
   */
  async createWebhook(options) {
    throw new Error('createWebhook() must be implemented by subclass');
  }

  /**
   * List webhooks
   * @returns {Promise<Array<{id: number, url: string, events: string[], active: boolean}>>}
   */
  async listWebhooks() {
    throw new Error('listWebhooks() must be implemented by subclass');
  }

  /**
   * Delete a webhook
   * @param {number} webhookId - Webhook ID to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteWebhook(webhookId) {
    throw new Error('deleteWebhook() must be implemented by subclass');
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get the clone URL for the repository
   * @param {boolean} useSSH - Use SSH URL instead of HTTPS
   * @returns {string}
   */
  getCloneUrl(useSSH = false) {
    throw new Error('getCloneUrl() must be implemented by subclass');
  }

  /**
   * Get the web URL for a merge/pull request
   * @param {number} mrNumber
   * @returns {string}
   */
  getMergeRequestUrl(mrNumber) {
    throw new Error('getMergeRequestUrl() must be implemented by subclass');
  }

  /**
   * Get the web URL for an issue
   * @param {number} issueNumber
   * @returns {string}
   */
  getIssueUrl(issueNumber) {
    throw new Error('getIssueUrl() must be implemented by subclass');
  }

  /**
   * Get terminology for this provider
   * @returns {{mergeRequest: string, pullRequest: string}}
   */
  getTerminology() {
    return {
      mergeRequest: 'merge request',  // GitLab
      pullRequest: 'pull request'      // GitHub
    };
  }

  /**
   * Log with provider context
   */
  log(level, message, meta = {}) {
    logger[level](`[${this.name}] ${message}`, meta);
  }

  /**
   * Perform a network operation with retry logic
   * @param {Function} asyncCall - The asynchronous function to execute
   * @param {object} options - Retry options
   * @returns {Promise<any>}
   */
  async performNetworkOperation(asyncCall, options = { retries: 3, minTimeout: 1000, maxTimeout: 5000 }) {
    try {
      return await retryOperation(asyncCall, options);
    } catch (error) {
      this.log('error', 'Network operation failed after retries', { error: error.message });
      throw error;
    }
  }
}

export default GitHostingProvider;
