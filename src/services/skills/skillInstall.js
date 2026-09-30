/**
 * Install a skill from a URL (after hermes-agent's skills hub): a SKILL.md on GitHub (file or
 * folder link, or `owner/repo[/path]` shorthand) or any https link to a raw SKILL.md.
 *
 * Same approval rule as a skill another agent teaches: active at once when auto-approve is on
 * (the operator is told on Telegram with a Reject button), pending otherwise (Telegram asks,
 * with Approve / Reject). A URL skill never replaces a skill of the same name from anywhere else.
 */
import { getSkillsService, parseSkill, getAutoApprove } from './skillsService.js';

const MAX_BYTES = 64 * 1024;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Candidate raw URLs for what the operator gave. */
export function candidateUrls(input) {
  const s = String(input || '').trim();
  let m = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(blob|tree)\/([^/]+)\/(.+?)\/?$/);
  if (m) {
    const [, o, r, kind, ref, p] = m;
    const file = kind === 'tree' || !/\.md$/i.test(p) ? `${p}/SKILL.md` : p;
    return [`https://raw.githubusercontent.com/${o}/${r}/${ref}/${file}`];
  }
  m = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return ['main', 'master'].map(ref => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/SKILL.md`);
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+?))?\/?$/);
  if (m && !s.includes('://')) {
    const file = !m[3] ? 'SKILL.md' : /\.md$/i.test(m[3]) ? m[3] : `${m[3]}/SKILL.md`;
    return ['main', 'master'].map(ref => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/${file}`);
  }
  if (/^https:\/\//.test(s)) return [s];
  return [];
}

/**
 * @returns {Promise<{installed: boolean, name?: string, status?: string, source?: string, reason?: string}>}
 */
export async function installSkillFromUrl(input, { service = getSkillsService(), fetchImpl = fetch, autoApprove = null } = {}) {
  const urls = candidateUrls(input);
  if (!urls.length) return { installed: false, reason: 'Give a GitHub link to a SKILL.md (or its folder), owner/repo/path, or an https link to a raw SKILL.md' };
  let text = null, from = null, lastErr = '';
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'LANAgent-skills' } });
      if (!res.ok) { lastErr = `HTTP ${res.status} from ${url}`; continue; }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) { lastErr = 'The file is larger than 64 KB'; continue; }
      const body = await res.text();
      if (body.length > MAX_BYTES) { lastErr = 'The file is larger than 64 KB'; continue; }
      text = body; from = url; break;
    } catch (e) { lastErr = e.message; }
  }
  if (!text) return { installed: false, reason: lastErr || 'Could not fetch the skill' };
  const parsed = parseSkill(text);
  const name = String(parsed?.meta?.name || '').trim();
  const description = String(parsed?.meta?.description || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!parsed || !name || !description) return { installed: false, reason: 'That is not a SKILL.md: it needs front matter with name and description' };
  if (!NAME_RE.test(name) || name.length > 64) return { installed: false, reason: `"${name}" is not a valid skill name (lowercase letters, digits, hyphens)` };
  if (description.length > 1024 || !parsed.body.trim()) return { installed: false, reason: 'The description is too long or the skill has no steps' };
  const existing = await service.get(name);
  if (existing && existing.meta?.origin_url !== from) return { installed: false, reason: `A skill named "${name}" already exists (${existing.bundled ? 'built in' : existing.meta?.source || 'local'}); it is not replaced` };
  const auto = autoApprove === null ? (await getAutoApprove()).enabled : !!autoApprove;
  const status = auto ? 'active' : 'pending';
  const saved = await service.create({
    name, description, body: parsed.body, overwrite: !!existing,
    extra: { source: 'url', origin_url: from, status, ...(auto ? { auto_approved: 'true' } : {}), ...(parsed.meta.license ? { license: parsed.meta.license } : {}), ...(parsed.meta.author ? { author: parsed.meta.author } : {}) }
  });
  return { installed: !!saved, name, status, source: from, updated: !!existing, description, skill: saved };
}
