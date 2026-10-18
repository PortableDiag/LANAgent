import { PluginSettings } from '../../models/PluginSettings.js';

/**
 * Switches for Telegram's agent features (Bot API 10.x), in one stored record that the web UI
 * (Settings → Telegram agents), Telegram (/agents) and the API (/api/telegram/agent-features)
 * all read and write, so a change in one shows in the others.
 *
 *   botToBot   other agents' bots may talk to this one (default OFF). Also needs Bot-to-Bot
 *              Communication Mode in @BotFather, on both bots for private chats.
 *   guestMode  'owner' (default) | 'everyone' | 'off' — who may summon the bot into a chat it
 *              is not in (@mention). Needs Guest Mode in @BotFather.
 *   topics     keep each private-chat topic its own conversation and title new ones (default
 *              on; only matters once topics are enabled for the bot in @BotFather).
 *   peers      the bots allowed to talk to this one: [{username, id, addedAt, muted?}]. `id` is
 *              pinned on first contact, and a later message under that username from another
 *              id is refused (usernames can change hands; ids cannot).
 *   ignored    bot usernames the operator chose to ignore (no more notices).
 */

const PLUGIN = 'telegram';
const KEY = 'agentFeatures';
export const GUEST_MODES = ['owner', 'everyone', 'off'];
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
export const DEFAULTS = Object.freeze({ botToBot: false, guestMode: 'owner', topics: true, peers: [], ignored: [] });

export function normalizeUsername(name) {
  const u = String(name ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  if (!USERNAME_RE.test(u)) throw new Error(`"${name}" is not a Telegram username.`);
  if (!/bot$/i.test(u)) throw new Error(`@${u} is not a bot username (bot usernames end in "bot").`);
  return u;
}

export async function getAgentFeatures() {
  const saved = await PluginSettings.getCached(PLUGIN, KEY).catch(() => null);
  const s = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  s.peers = Array.isArray(s.peers) ? s.peers : [];
  s.ignored = Array.isArray(s.ignored) ? s.ignored : [];
  if (!GUEST_MODES.includes(s.guestMode)) s.guestMode = DEFAULTS.guestMode;
  return s;
}

async function save(s) {
  await PluginSettings.setCached(PLUGIN, KEY, s);
  return s;
}

/** Change the switches. Unknown keys and bad values are refused, not dropped. */
export async function setAgentFeatures(patch = {}) {
  const s = await getAgentFeatures();
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'botToBot' || k === 'topics') {
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false.`);
      s[k] = v;
    } else if (k === 'guestMode') {
      if (!GUEST_MODES.includes(v)) throw new Error(`guestMode must be one of ${GUEST_MODES.join(', ')}.`);
      s.guestMode = v;
    } else {
      throw new Error(`Unknown setting "${k}". Settings: botToBot, guestMode, topics (peers have their own calls).`);
    }
  }
  return save(s);
}

export async function trustPeer(username) {
  const u = normalizeUsername(username);
  const s = await getAgentFeatures();
  if (!s.peers.some(p => p.username.toLowerCase() === u.toLowerCase())) {
    s.peers.push({ username: u, id: null, addedAt: new Date().toISOString() });
  }
  s.ignored = s.ignored.filter(x => x.toLowerCase() !== u.toLowerCase());
  return save(s);
}

export async function untrustPeer(username) {
  const u = normalizeUsername(username);
  const s = await getAgentFeatures();
  const before = s.peers.length;
  s.peers = s.peers.filter(p => p.username.toLowerCase() !== u.toLowerCase());
  await save(s);
  return before !== s.peers.length;
}

export async function ignoreBot(username) {
  const u = normalizeUsername(username);
  const s = await getAgentFeatures();
  if (!s.ignored.some(x => x.toLowerCase() === u.toLowerCase())) s.ignored.push(u);
  return save(s);
}

/**
 * The trusted peer a bot message came from, or why it is not one.
 * Pins the peer's id on first contact.
 * @returns {Promise<{peer?: object, reason?: 'unknown'|'id_mismatch'|'muted'|'ignored'}>}
 */
export async function matchPeer(from) {
  const s = await getAgentFeatures();
  const id = String(from?.id ?? '');
  const uname = String(from?.username || '');
  const byId = s.peers.find(p => p.id && String(p.id) === id);
  if (byId) return byId.muted && Date.parse(byId.muted) > Date.now() ? { reason: 'muted', peer: byId } : { peer: byId };
  const byName = s.peers.find(p => p.username.toLowerCase() === uname.toLowerCase());
  if (byName) {
    if (byName.id && String(byName.id) !== id) return { reason: 'id_mismatch', peer: byName };
    byName.id = id;   // first contact: pin it
    await save(s);
    return { peer: byName };
  }
  if (s.ignored.some(x => x.toLowerCase() === uname.toLowerCase())) return { reason: 'ignored' };
  return { reason: 'unknown' };
}

/** Mute a peer until `until` (ISO); the loop guard does this when a peer floods. */
export async function mutePeer(id, until) {
  const s = await getAgentFeatures();
  const p = s.peers.find(x => String(x.id) === String(id));
  if (!p) return false;
  p.muted = until;
  await save(s);
  return true;
}
