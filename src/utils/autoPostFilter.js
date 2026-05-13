/**
 * Shared filters for auto-post content across all social platforms (MindSwarm, Telegram, X).
 * Prevents the agent from posting about sensitive internal topics.
 */

// Commit messages matching these patterns are excluded from auto-post context.
// `session` covers docs/sessions/* commits — the pathspec excludes pure-session
// commits, but a commit touching both src/ AND docs/sessions/ slips through
// the pathspec since git log still shows it. Defense in depth.
const SENSITIVE_COMMIT_PATTERNS = /outreach|proposal|business.plan|linkedin|strategy|monetiz|revenue|pricing|release.plan|contact.email|partner|investor|funding|pitch|competitive|roadmap|session.*\d{4}-\d{2}-\d{2}|docs\(session/i;

// Git paths excluded from commit context gathering (pathspecs for git log)
const EXCLUDED_GIT_PATHS = [':!docs/proposals', ':!docs/sessions'];

// Topics that must never appear in auto-post output
const SENSITIVE_OUTPUT_RULES = [
  'NEVER post about business plans, outreach campaigns, partnership proposals, monetization strategy, LinkedIn posts, release strategy, or anything from internal proposals or documentation.',
  'NEVER mention contacting companies (Google, Anthropic, OpenAI, etc.) or any outreach/partnership activity.',
  'Never discuss investor relations, funding plans, competitive analysis, or internal roadmaps.',
  'Never discuss business plans, outreach campaigns, partnership proposals, monetization strategy, release plans, or any content from internal proposals or documentation.',
  'NEVER mention internal development sessions, session reports, session wrap-ups, debug sessions, or anything about your operator\'s workflow — those are private dev notes, not public-facing content.',
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
