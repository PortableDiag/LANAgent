/**
 * Telegram notices about the agent's own pull requests and deploys.
 *
 * Each notice is built twice: Rich Markdown (a heading, a short table, a bullet list of what
 * the PR adds) for sendNotification's rich path, and plain text for the fallback, where
 * nothing needs escaping. The old notices sent **bold** and escapeMarkdown() output through
 * legacy Markdown, which has neither: the asterisks and every backslash before ( ) . - showed
 * up literally. The PR link rides as an inline button, not a bare URL.
 */

const TYPE_LABELS = {
  upgrade_core_capabilities: 'Core capability upgrade',
  extend_plugin_apis: 'Plugin API extension',
  enhance_plugin_features: 'Plugin feature',
  optimize_plugin_performance: 'Plugin performance',
  github_discovered_feature: 'Feature from GitHub discovery'
};

/** `upgrade_core_capabilities` → "Core capability upgrade"; unknown types are de-snaked. */
export function typeLabel(type) {
  if (!type) return 'Improvement';
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  const words = String(type).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An absolute path inside the agent's repo checkout → repo-relative (`src/…`). */
export function repoPath(file) {
  if (!file) return '';
  const s = String(file);
  const i = s.search(/(^|\/)(src|tests|scripts|docs)\//);
  return i > 0 ? s.slice(s[i] === '/' ? i + 1 : i) : s;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Text for a Markdown table cell or heading: no pipes or line breaks. */
function cell(text) {
  return clip(text, 60).replace(/\|/g, '/');
}

function prButton(prUrl, prNumber) {
  if (!/^https?:\/\//.test(String(prUrl || ''))) return undefined;
  return { inline_keyboard: [[{ text: prNumber ? `Open PR #${prNumber}` : 'Open pull request', url: prUrl }]] };
}

/**
 * A pull request the agent opened.
 * @param {object} p
 * @param {string} [p.agentName]
 * @param {string} [p.type]          improvement type, e.g. upgrade_core_capabilities
 * @param {string} [p.title]         overrides the type label (plugin PRs)
 * @param {string} [p.file]          target file (absolute or repo-relative)
 * @param {string} [p.description]
 * @param {string[]} [p.capabilities]
 * @param {string} [p.priority]
 * @param {string} [p.impact]
 * @param {boolean} [p.safeForProduction]
 * @param {string} [p.branch]
 * @param {string} [p.prUrl]
 * @param {number} [p.prNumber]
 * @returns {{ rich: string, text: string, replyMarkup?: object }}
 */
export function formatPrNotice(p = {}) {
  const who = p.agentName || 'The agent';
  const what = p.title || typeLabel(p.type);
  const file = repoPath(p.file);
  const num = p.prNumber ? ` #${p.prNumber}` : '';
  const caps = (Array.isArray(p.capabilities) ? p.capabilities : [])
    .map(c => clip(c, 160)).filter(Boolean).slice(0, 6);
  const review = p.safeForProduction === undefined ? null
    : (p.safeForProduction ? '✅ Low risk' : '⚠️ Needs review');
  const description = clip(p.description, 600);

  const rows = [
    p.priority && ['Priority', p.priority],
    p.impact && ['Impact', p.impact],
    review && ['Risk', review]
  ].filter(Boolean);

  const rich = [
    `### 🛠️ ${cell(who)} opened pull request${num}`,
    `**${cell(what)}**${file ? ` · \`${file}\`` : ''}`,
    description,
    caps.length ? `**Adds**\n${caps.map(c => `- ${c}`).join('\n')}` : '',
    rows.length ? `| ${rows.map(r => r[0]).join(' | ')} |\n|${rows.map(() => '---').join('|')}|\n| ${rows.map(r => cell(r[1])).join(' | ')} |` : '',
    p.branch ? `Branch \`${p.branch}\`` : ''
  ].filter(Boolean).join('\n\n');

  const text = [
    `🛠️ ${who} opened pull request${num}`,
    `${what}${file ? ` · ${file}` : ''}`,
    description,
    caps.length ? `Adds:\n${caps.map(c => `• ${c}`).join('\n')}` : '',
    rows.length ? rows.map(r => `${r[0]}: ${r[1]}`).join(' · ') : '',
    p.prUrl || (p.branch ? `Branch ${p.branch}` : '')
  ].filter(Boolean).join('\n\n');

  return { rich, text, replyMarkup: prButton(p.prUrl, p.prNumber) };
}

/**
 * A deploy of merged changes, or one that was rolled back.
 * @param {object} p
 * @param {string} [p.agentName]
 * @param {boolean} [p.blocked]   true = rolled back, nothing deployed
 * @param {string[]} [p.files]
 * @param {string} [p.description] used when files is not given
 * @returns {{ rich: string, text: string }}
 */
export function formatDeployNotice(p = {}) {
  const who = p.agentName || 'The agent';
  const files = (Array.isArray(p.files) ? p.files : []).map(repoPath).filter(Boolean);
  const shown = files.slice(0, 10);
  const more = files.length > shown.length ? files.length - shown.length : 0;
  const heading = p.blocked
    ? `⛔ ${who}: deploy rolled back`
    : `📦 ${who} deployed ${files.length ? `${files.length} merged file${files.length === 1 ? '' : 's'}` : 'merged changes'}`;
  const lead = p.blocked
    ? 'These files failed to load, so the previous code was restored and nothing changed:'
    : 'Every file loaded before the restart.';

  const list = shown;
  const rich = [
    `### ${heading}`,
    files.length ? lead : clip(p.description, 600),
    list.length ? `${list.map(f => `- \`${f}\``).join('\n')}${more ? `\n- …and ${more} more` : ''}` : ''
  ].filter(Boolean).join('\n\n');
  const text = [
    heading,
    files.length ? lead : clip(p.description, 600),
    list.length ? `${list.map(f => `• ${f}`).join('\n')}${more ? `\n• …and ${more} more` : ''}` : ''
  ].filter(Boolean).join('\n\n');
  return { rich, text };
}

/**
 * The self-modification cycle stopped with an error.
 * @returns {{ rich: string, text: string }}
 */
export function formatSelfModError(p = {}) {
  const who = p.agentName || 'The agent';
  const err = clip(p.error, 500);
  return {
    rich: `### ⚠️ ${cell(who)}: self-improvement run stopped\n\n\`\`\`\n${err.replace(/```/g, "'''")}\n\`\`\`\n\nNo pull request was opened.`,
    text: `⚠️ ${who}: self-improvement run stopped\n\n${err}\n\nNo pull request was opened.`
  };
}
