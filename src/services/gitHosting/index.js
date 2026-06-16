import { GitHostingProvider } from './GitHostingProvider.js';
import { GitHubProvider } from './GitHubProvider.js';
import { GitLabProvider } from './GitLabProvider.js';
import { logger } from '../../utils/logger.js';

/**
 * Git Hosting Provider Factory
 *
 * Creates and manages git hosting provider instances based on configuration.
 */

// Singleton instance cache
let providerInstance = null;
let currentProviderType = null;

/**
 * Available provider types
 */
export const PROVIDER_TYPES = {
  GITHUB: 'github',
  GITLAB: 'gitlab'
};

/**
 * Create a git hosting provider instance
 * @param {string} type - Provider type ('github' or 'gitlab')
 * @param {object} config - Provider-specific configuration
 * @returns {GitHostingProvider} Provider instance
 */
export function createProvider(type, config = {}) {
  switch (type?.toLowerCase()) {
    case PROVIDER_TYPES.GITHUB:
      return new GitHubProvider(config);

    case PROVIDER_TYPES.GITLAB:
      return new GitLabProvider(config);

    default:
      throw new Error(`Unknown git hosting provider type: ${type}. Valid types: ${Object.values(PROVIDER_TYPES).join(', ')}`);
  }
}

/**
 * Get or create the default provider based on settings
 * @param {object} settings - Application settings object
 * @param {boolean} forceNew - Force creation of new instance
 * @returns {Promise<GitHostingProvider>} Initialized provider instance
 */
export async function getProvider(settings = {}, forceNew = false) {
  const providerType = settings.gitHosting?.provider || process.env.GIT_HOSTING_PROVIDER || PROVIDER_TYPES.GITHUB;

  // Return cached instance if type hasn't changed
  if (!forceNew && providerInstance && currentProviderType === providerType) {
    return providerInstance;
  }

  // Build config based on provider type
  let config = {};

  if (providerType === PROVIDER_TYPES.GITHUB) {
    config = {
      token: settings.gitHosting?.github?.token || process.env.GITHUB_TOKEN,
      owner: settings.gitHosting?.github?.owner || process.env.GITHUB_OWNER,
      repo: settings.gitHosting?.github?.repo || process.env.GITHUB_REPO
    };
  } else if (providerType === PROVIDER_TYPES.GITLAB) {
    config = {
      token: settings.gitHosting?.gitlab?.token || process.env.GITLAB_TOKEN,
      baseUrl: settings.gitHosting?.gitlab?.baseUrl || process.env.GITLAB_URL || 'https://gitlab.com',
      projectId: settings.gitHosting?.gitlab?.projectId || process.env.GITLAB_PROJECT_ID
    };
  }

  // Create and initialize provider
  const provider = createProvider(providerType, config);
  await provider.initialize();

  // Cache the instance
  providerInstance = provider;
  currentProviderType = providerType;

  logger.info(`Git hosting provider initialized: ${providerType}`);

  return provider;
}

/**
 * Clear the cached provider instance
 */
export function clearProviderCache() {
  providerInstance = null;
  currentProviderType = null;
}

/**
 * Get the current provider type from settings
 * @param {object} settings - Application settings
 * @returns {string} Provider type
 */
export function getCurrentProviderType(settings = {}) {
  return settings.gitHosting?.provider || process.env.GIT_HOSTING_PROVIDER || PROVIDER_TYPES.GITHUB;
}

/**
 * Check if a provider is properly configured
 * @param {string} type - Provider type
 * @param {object} settings - Application settings
 * @returns {object} Configuration status
 */
export function checkProviderConfig(type, settings = {}) {
  const result = {
    configured: false,
    missing: []
  };

  if (type === PROVIDER_TYPES.GITHUB) {
    const token = settings.gitHosting?.github?.token || process.env.GITHUB_TOKEN;
    if (!token) result.missing.push('GITHUB_TOKEN');
    result.configured = result.missing.length === 0;
  } else if (type === PROVIDER_TYPES.GITLAB) {
    const token = settings.gitHosting?.gitlab?.token || process.env.GITLAB_TOKEN;
    if (!token) result.missing.push('GITLAB_TOKEN');
    result.configured = result.missing.length === 0;
  }

  return result;
}

// Export classes for direct use
export { GitHostingProvider, GitHubProvider, GitLabProvider };

// Default export
export default {
  createProvider,
  getProvider,
  clearProviderCache,
  getCurrentProviderType,
  checkProviderConfig,
  PROVIDER_TYPES,
  GitHostingProvider,
  GitHubProvider,
  GitLabProvider
};
