import { toRichMarkdown } from './richMessage.js';

/**
 * Telegram notice for a post the agent published on its own (X, MindSwarm).
 *
 * Built twice, like the PR notices: Rich Markdown (a heading, who and how many today, the post
 * as a quote) for sendNotification's rich path, and plain text for the fallback. The old notice
 * sent `*X post (1/3):*` through legacy Markdown, so a post holding an _ or * broke the send
 * and the link was a bare "[View tweet](…)". The link now rides as an inline button.
 */

const PLATFORMS = {
  x: { icon: '𝕏', name: 'X', button: 'View on X' },
  mindswarm: { icon: '🐝', name: 'MindSwarm', button: 'View on MindSwarm' }
};

/**
 * @param {object} p
 * @param {'x'|'mindswarm'} p.platform
 * @param {string} p.text              the post as published
 * @param {string} [p.url]             the post's link
 * @param {string} [p.handle]          the account, without @
 * @param {number} [p.count]           this post's number today
 * @param {number} [p.max]             the daily limit
 * @param {string} [p.agentName]
 * @returns {{ rich: string, text: string, replyMarkup?: object }}
 */
export function formatSocialPostNotice(p = {}) {
  const pf = PLATFORMS[p.platform] || { icon: '📣', name: p.platform || 'social', button: 'View post' };
  const who = p.agentName || 'The agent';
  const body = String(p.text ?? '').trim();
  const handle = p.handle ? `@${String(p.handle).replace(/^@/, '')}` : null;
  const today = Number.isFinite(p.count) && Number.isFinite(p.max) ? `post ${p.count} of ${p.max} today` : null;
  const meta = [handle, today, `${[...body].length} chars`].filter(Boolean);

  const quote = toRichMarkdown(body).split('\n').map(l => `> ${l}`).join('\n');
  const rich = [
    `### ${pf.icon} ${who} posted on ${pf.name}`,
    meta.map((m, i) => (i === 0 && handle ? `**${m}**` : m)).join(' · '),
    quote
  ].join('\n\n');

  const text = [`${pf.icon} ${who} posted on ${pf.name}`, meta.join(' · '), body, p.url || ''].filter(Boolean).join('\n\n');

  const replyMarkup = /^https?:\/\//.test(String(p.url || ''))
    ? { inline_keyboard: [[{ text: pf.button, url: p.url }]] }
    : undefined;
  return { rich, text, replyMarkup };
}
