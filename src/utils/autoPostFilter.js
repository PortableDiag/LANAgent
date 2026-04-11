/**
 * Shared filters for auto-post content across all social platforms (MindSwarm, Telegram, X).
 * Prevents the agent from posting about sensitive internal topics.
 */

// Commit messages matching these patterns are excluded from auto-post context
const SENSITIVE_COMMIT_PATTERNS = /outreach|proposal|business.plan|linkedin|strategy|monetiz|revenue|pricing|release.plan|contact.email|partner|investor|funding|pitch|competitive|roadmap/i;

// Git paths excluded from commit context gathering (pathspecs for git log)
const EXCLUDED_GIT_PATHS = [':!docs/proposals', ':!docs/sessions'];

// Topics that must never appear in auto-post output
const SENSITIVE_OUTPUT_RULES = [
  'NEVER post about business plans, outreach campaigns, partnership proposals, monetization strategy, LinkedIn posts, release strategy, or anything from internal proposals or documentation.',
  'NEVER mention contacting companies (Google, Anthropic, OpenAI, etc.) or any outreach/partnership activity.',
  'Never discuss investor relations, funding plans, competitive analysis, or internal roadmaps.',
  'Never discuss business plans, outreach campaigns, partnership proposals, monetization strategy, release plans, or any content from internal proposals or documentation.',
];

/**
 * Filter commit messages to remove sensitive topics.
 * @param {string[]} commits - Array of commit message strings
 * @returns {string[]} Filtered commits safe for public posting
 */
function filterSensitiveCommits(commits) {
  return commits.filter(c => !SENSITIVE_COMMIT_PATTERNS.test(c));
}

/**
 * Get git pathspec exclusions for auto-post context gathering.
 * @returns {string} Pathspec string to append to git log commands
 */
function getExcludedPathspecs() {
  return EXCLUDED_GIT_PATHS.map(p => `'${p}'`).join(' ');
}

/**
 * Get prompt rules that prevent sensitive content in AI-generated posts.
 * @returns {string} Rules to include in any auto-post AI prompt
 */
function getSensitiveContentRules() {
  return SENSITIVE_OUTPUT_RULES.map(r => `- ${r}`).join('\n');
}

export { filterSensitiveCommits, getExcludedPathspecs, getSensitiveContentRules, SENSITIVE_COMMIT_PATTERNS, EXCLUDED_GIT_PATHS, SENSITIVE_OUTPUT_RULES };
