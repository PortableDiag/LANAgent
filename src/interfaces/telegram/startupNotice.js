import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The "I'm online" Telegram notice, as one rich card instead of the two legacy-Markdown
 * messages every boot used to send (the base interface's and the dashboard's override).
 *
 * It says which version came up and how long the boot took, and — when the version changed
 * since the last notice — what is new, from the CHANGELOG headlines of every version in
 * between. The last announced version is kept in SystemSettings, so a plain restart is a
 * one-line card and an update lists what arrived.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../../..');
export const LAST_VERSION_SETTING = 'telegram.startupNoticeVersion';
const MAX_HEADLINES = 8;
const CHANGELOG_READ_BYTES = 256 * 1024; // newest entries are at the top; the file is >1 MB

/** -1 / 0 / 1 for dotted numeric versions ("2.25.518"). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The bold lead of each bullet in the versions after `from` up to and including `to`.
 * Returns null when the changelog has no entry for `to` (a stale copy), so the caller can
 * say "updated" without inventing a list.
 */
export function changelogHeadlines(changelog, from, to) {
  const sections = String(changelog || '').split(/^## \[/m).slice(1);
  let sawTarget = false;
  const out = [];
  for (const sec of sections) {
    const version = sec.slice(0, sec.indexOf(']'));
    if (compareVersions(version, to) > 0) continue;
    if (from && compareVersions(version, from) <= 0) break;
    if (compareVersions(version, to) === 0) sawTarget = true;
    if (!sawTarget) return null;
    for (const m of sec.matchAll(/^- \*\*(.+?)\*\*(.*)$/gm)) {
      const h = headline(m[1], m[2]);
      if (h && !out.includes(h)) out.push(h);
    }
    if (!from) break; // first boot with no record: only the current version
  }
  return sawTarget ? out : null;
}

/**
 * A bullet's bold lead is usually a sentence ("**RSS reading uses conditional requests.**").
 * A label lead ("**Email:** waits for…") says nothing alone, so its first sentence follows it.
 */
function headline(bold, rest) {
  const lead = bold.trim();
  if (!lead.endsWith(':')) return lead.replace(/\.\s*$/, '');
  const sentence = String(rest).trim().replace(/`/g, '').split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  const text = `${lead.slice(0, -1)}: ${sentence}`;
  return text.length > 110 ? `${text.slice(0, 109).trimEnd()}…` : text;
}

async function readChangelogHead(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(CHANGELOG_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Headlines from the deployed CHANGELOG, or from the agent's repo checkout when that copy is stale. */
export async function loadHeadlines(from, to) {
  const candidates = [path.join(PROJECT_ROOT, 'CHANGELOG.md')];
  if (process.env.AGENT_REPO_PATH) candidates.push(path.join(process.env.AGENT_REPO_PATH, 'CHANGELOG.md'));
  for (const file of candidates) {
    const h = changelogHeadlines(await readChangelogHead(file), from, to);
    if (h) return h;
  }
  return null;
}

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * @param {object} p
 * @param {string} p.agentName
 * @param {string} p.version
 * @param {string} [p.previousVersion]  last announced version; absent on the first notice
 * @param {string[]|null} [p.headlines] what is new (null = changelog unavailable)
 * @param {number} [p.bootSeconds]
 * @param {string} [p.provider]         active AI provider
 * @param {number} [p.plugins]          loaded plugins
 * @returns {{ rich: string, text: string }}
 */
export function formatStartupNotice(p) {
  const name = p.agentName || 'LANAgent';
  const updated = p.previousVersion && compareVersions(p.version, p.previousVersion) !== 0;
  const downgraded = updated && compareVersions(p.version, p.previousVersion) < 0;
  const facts = [
    `**v${p.version}**`,
    p.bootSeconds ? `booted in ${duration(p.bootSeconds)}` : null
  ].filter(Boolean).join(' · ');

  const rows = [
    p.provider && ['AI', p.provider],
    Number.isFinite(p.plugins) && p.plugins > 0 && ['Plugins', String(p.plugins)]
  ].filter(Boolean);

  const heads = (p.headlines || []).slice(0, MAX_HEADLINES);
  const more = (p.headlines?.length || 0) - heads.length;

  let whatsNew = '';
  let whatsNewText = '';
  if (updated) {
    const line = downgraded ? `Rolled back from v${p.previousVersion}` : `Updated from v${p.previousVersion}`;
    whatsNew = `**${line}**`;
    whatsNewText = line;
    if (!downgraded && heads.length) {
      whatsNew += `\n\n${heads.map(h => `- ${h}`).join('\n')}${more > 0 ? `\n- …and ${more} more` : ''}`;
      whatsNewText += `:\n${heads.map(h => `• ${h}`).join('\n')}${more > 0 ? `\n• …and ${more} more` : ''}`;
    }
  }

  const rich = [
    `### 🟢 ${name} is online`,
    facts,
    whatsNew,
    rows.length ? `| ${rows.map(r => r[0]).join(' | ')} |\n|${rows.map(() => '---').join('|')}|\n| ${rows.map(r => String(r[1]).replace(/\|/g, '/')).join(' | ')} |` : '',
    'Ask me anything, or /help for commands.'
  ].filter(Boolean).join('\n\n');

  const text = [
    `🟢 ${name} is online`,
    facts.replace(/\*\*/g, ''),
    whatsNewText,
    rows.length ? rows.map(r => `${r[0]}: ${r[1]}`).join(' · ') : '',
    'Ask me anything, or /help for commands.'
  ].filter(Boolean).join('\n\n');

  return { rich, text };
}
