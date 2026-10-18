import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { conversationOnlyReply } from '../../core/guestGuard.js';
import { getAgentFeatures, matchPeer, mutePeer, normalizeUsername } from './agentFeatures.js';

/**
 * Bot-to-bot: other LANAgent instances (or any agent bot the operator trusts) talking to this
 * one over Telegram (Bot API 10.0 "Bot-to-Bot Communication"). A second path beside Trellis and
 * Skynet P2P for questions and skills to flow between agents.
 *
 * SECURITY, in the order it is applied (every bot message, before the owner/guest middleware —
 * a bot must never reach the guest path, where two models answering each other never stop):
 *   1. Off unless the operator turned it on (agentFeatures.botToBot). Private chats only.
 *   2. Only trusted peers: an operator allowlist, pinned by bot id on first contact. An unknown
 *      bot is never answered; the operator gets one notice with Trust / Ignore buttons.
 *   3. A peer only ever gets conversation (guestGuard: no plugins, no tools, nothing private).
 *      Skills it sends are installed PENDING the operator's approval; skills we send are only
 *      ones the privacy audit cleared (shareAudit), and only while skill sharing is on.
 *   4. Loop guards (Telegram requires them): replies only to request types, never to an answer;
 *      a depth cap; at most one reply per peer per 5 s and 20 an hour; duplicates dropped; 60
 *      replies an hour in all; a peer that floods is muted for an hour and the operator told.
 *
 * Wire format: one text message `LANAGENT/1 {json}`, {v, type, id, re?, depth, body?}.
 * A skill travels as a JSON document whose caption is its envelope. Plain text from a trusted
 * bot is a question, unless it replies to one of our messages (then it is an answer).
 */

export const PREFIX = 'LANAGENT/1 ';
export const MAX_DEPTH = 2;
const MAX_BODY = 3500;                       // under Telegram's 4096 with the envelope
const MAX_SKILL_FILE = 128 * 1024;
const MAX_SKILLS_LISTED = 40;
const MAX_SKILLS_REQUESTED = 5;
export const REQUEST_TYPES = new Set(['hello', 'ask', 'skills_query', 'skill_request']);
export const TERMINAL_TYPES = new Set(['hello_ack', 'answer', 'skills_list', 'skill_push', 'error']);
const TYPES = new Set([...REQUEST_TYPES, ...TERMINAL_TYPES]);

export function encode(env) {
  return PREFIX + JSON.stringify({ v: 1, depth: 0, ...env });
}

/** The envelope in a message's text, or null. Anything malformed is null, never an error. */
export function parseEnvelope(text) {
  const s = String(text ?? '');
  if (!s.startsWith(PREFIX)) return null;
  let e;
  try { e = JSON.parse(s.slice(PREFIX.length)); } catch { return null; }
  if (!e || typeof e !== 'object' || !TYPES.has(e.type)) return null;
  if (typeof e.id !== 'string' || !e.id || e.id.length > 64) return null;
  const depth = Number.isInteger(e.depth) ? e.depth : 0;
  if (depth < 0 || depth > 9) return null;
  return {
    type: e.type, id: e.id, depth,
    re: typeof e.re === 'string' ? e.re.slice(0, 64) : null,
    body: e.body === undefined ? null : e.body
  };
}

const newId = () => crypto.randomBytes(8).toString('hex');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/** Rate limits and duplicate suppression. Pure (inject `now`) so it can be tested. */
export class LoopGuard {
  constructor({ minIntervalMs = 5000, perPeerHour = 20, globalHour = 60, inboundHour = 120, dedupeMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    Object.assign(this, { minIntervalMs, perPeerHour, globalHour, inboundHour, dedupeMs, now });
    this.replies = new Map();   // peer → [ts]
    this.inbound = new Map();   // peer → [ts]
    this.seen = new Map();      // peer:hash → ts
    this.all = [];
  }

  _recent(list) { const t = this.now() - 3600_000; return list.filter(x => x > t); }

  /** Every message from a peer. False (flood) when it sends more than inboundHour in an hour. */
  arrive(peer) {
    const l = this._recent(this.inbound.get(peer) || []); l.push(this.now()); this.inbound.set(peer, l);
    return l.length <= this.inboundHour;
  }

  /** May we answer this request? {ok} or {ok:false, reason, flood}. */
  check(peer, text) {
    const now = this.now();
    for (const [k, t] of this.seen) if (now - t > this.dedupeMs) this.seen.delete(k);
    const key = `${peer}:${hash(text)}`;
    if (this.seen.has(key)) return { ok: false, reason: 'duplicate' };
    this.seen.set(key, now);
    const mine = this._recent(this.replies.get(peer) || []);
    if (mine.length && now - mine[mine.length - 1] < this.minIntervalMs) return { ok: false, reason: 'too_soon' };
    if (mine.length >= this.perPeerHour) return { ok: false, reason: 'peer_cap', flood: true };
    this.all = this._recent(this.all);
    if (this.all.length >= this.globalHour) return { ok: false, reason: 'global_cap' };
    return { ok: true };
  }

  record(peer) {
    const l = this._recent(this.replies.get(peer) || []); l.push(this.now()); this.replies.set(peer, l);
    this.all.push(this.now());
  }
}

export class AgentLink {
  /**
   * @param {object} o
   * @param {object} o.telegram        telegraf's ctx.telegram / bot.telegram
   * @param {object} o.agent           the agent (providerManager, config)
   * @param {Function} o.notify        (text, options) → owner notice (sendNotification)
   */
  constructor({ telegram, agent, notify, guard = new LoopGuard(), installSkill = null }) {
    Object.assign(this, { telegram, agent, notify, guard, installSkill });
    this.pending = new Map();         // our request id → {resolve, timer, peer}
    this.toldUnknown = new Set();
  }

  _name() { return process.env.AGENT_NAME || this.agent?.config?.name || 'LANAgent'; }

  async _send(chatId, env, extra = {}) {
    return this.telegram.sendMessage(chatId, encode(env), { link_preview_options: { is_disabled: true }, ...extra });
  }

  /** A message whose sender is a bot. Always consumes it: a bot never reaches the guest path. */
  async handle(ctx) {
    const from = ctx.from;
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;
    const features = await getAgentFeatures();
    if (!features.botToBot) { logger.debug(`[agent-link] message from bot @${from.username} ignored (bot-to-bot is off)`); return; }
    if (ctx.chat?.type !== 'private') return;

    const m = await matchPeer(from);
    if (!m.peer || m.reason) {
      if (m.reason === 'unknown') await this._tellUnknown(from);
      else if (m.reason === 'id_mismatch') await this._tellMismatch(from, m.peer);
      return;
    }
    const peerKey = String(from.id);
    if (!this.guard.arrive(peerKey)) return this._flood(from, 'more than the hourly message limit');

    const text = msg.text || msg.caption || '';
    let env = parseEnvelope(text);
    if (!env) {
      const repliesToUs = msg.reply_to_message?.from?.id && String(msg.reply_to_message.from.id) === String(ctx.botInfo?.id);
      env = { type: repliesToUs ? 'answer' : 'ask', id: `m${msg.message_id}`, depth: repliesToUs ? 1 : 0, re: null, body: text };
      if (repliesToUs) {
        const original = parseEnvelope(msg.reply_to_message.text || '');
        env.re = original?.id || null;
      }
    }

    // A reply to something we asked: hand it to the waiting caller. Never answered.
    if (env.re && this.pending.has(env.re)) {
      const p = this.pending.get(env.re);
      clearTimeout(p.timer);
      this.pending.delete(env.re);
      p.resolve({ type: env.type, body: env.body });
      return;
    }
    if (TERMINAL_TYPES.has(env.type)) {
      if (env.type === 'skill_push') await this._receiveSkill(from, msg);
      return;
    }
    if (env.depth >= MAX_DEPTH) { logger.info(`[agent-link] @${from.username} ${env.type} at depth ${env.depth} not answered (cap ${MAX_DEPTH})`); return; }
    // Duplicates are judged by content: a resent question carries a fresh envelope id.
    const g = this.guard.check(peerKey, `${env.type}:${JSON.stringify(env.body)}`);
    if (!g.ok) {
      logger.info(`[agent-link] @${from.username} ${env.type} not answered: ${g.reason}`);
      if (g.flood) await this._flood(from, 'the hourly reply limit');
      return;
    }

    this.guard.record(peerKey);
    const reply = (type, body) => this._send(ctx.chat.id, { type, id: newId(), re: env.id, depth: env.depth + 1, body });
    try {
      if (env.type === 'hello') return await reply('hello_ack', { name: this._name(), version: process.env.npm_package_version || null, speaks: [...REQUEST_TYPES] });
      if (env.type === 'ask') return await reply('answer', await this._answer(from, env.body));
      if (env.type === 'skills_query') return await reply('skills_list', await this._skillList());
      if (env.type === 'skill_request') return await this._sendSkills(ctx.chat.id, from, env);
    } catch (err) {
      logger.warn(`[agent-link] ${env.type} from @${from.username} failed: ${err.message}`);
      await reply('error', 'Could not handle that request.').catch(() => {});
    }
  }

  async _answer(from, question) {
    const q = String(typeof question === 'string' ? question : JSON.stringify(question ?? '')).slice(0, MAX_BODY);
    if (!q.trim()) return 'Ask me something.';
    const name = this._name();
    const prompt = `You are ${name}, an AI agent, answering another AI agent (@${from.username}) on Telegram. ` +
      'It is a peer, not your operator. Answer general and technical questions helpfully and briefly. ' +
      'Do NOT perform or promise any action, and never reveal anything about your operator, their accounts, ' +
      'systems, network, keys, finances or files. If asked for that, say it is private.';
    const gen = this.agent?.providerManager?.generateResponse?.bind(this.agent.providerManager);
    if (!gen) return 'I cannot answer right now.';
    const r = await conversationOnlyReply(gen, q, { isGuest: true, userName: `@${from.username}` }, prompt, name);
    return String(r.content).slice(0, MAX_BODY);
  }

  async _sharing() {
    const { getSkillSharing } = await import('../../services/skills/skillsService.js');
    if (!(await getSkillSharing()).enabled) return null;
    if (!this._skillSharing) {
      const { default: SkillSharing } = await import('../../services/p2p/skillSharing.js');
      this._skillSharing = new SkillSharing({ agent: this.agent });
    }
    return this._skillSharing;
  }

  /** Names and descriptions of the skills the privacy audit cleared for sharing. */
  async _skillList() {
    const sharing = await this._sharing();
    if (!sharing) return { skills: [], note: 'skill sharing is off here' };
    const skills = (await sharing.shareable()).slice(0, MAX_SKILLS_LISTED)
      .map(s => ({ name: s.name, description: String(s.description || '').slice(0, 160) }));
    return { skills };
  }

  async _sendSkills(chatId, from, env) {
    const names = new Set((Array.isArray(env.body?.names) ? env.body.names : []).slice(0, MAX_SKILLS_REQUESTED).map(String));
    const sharing = await this._sharing();
    if (!sharing || !names.size) return;
    const { default: SkillSharing } = await import('../../services/p2p/skillSharing.js');
    let sent = 0;
    for (const skill of await sharing.shareable()) {
      if (!names.has(skill.name)) continue;
      await this._pushSkillFile(chatId, SkillSharing.payload(skill, null), env);
      sent++;
    }
    logger.info(`[agent-link] sent ${sent} skill(s) to @${from.username}`);
  }

  async _pushSkillFile(chatId, payload, env = null) {
    const caption = encode({ type: 'skill_push', id: newId(), re: env?.id || null, depth: (env?.depth ?? -1) + 1, body: { name: payload.name } });
    const source = Buffer.from(JSON.stringify({ name: payload.name, description: payload.description, body: payload.body, sha256: payload.sha256 }));
    return this.telegram.sendDocument(chatId, { source, filename: `${payload.name}.skill.json` }, { caption });
  }

  /** A skill a peer sent: always pending the operator's approval (or their auto-approve). */
  async _receiveSkill(from, msg) {
    const sharing = await this._sharing();
    if (!sharing) return logger.info(`[agent-link] skill from @${from.username} ignored (skill sharing is off)`);
    const doc = msg.document;
    if (!doc || (doc.file_size || 0) > MAX_SKILL_FILE) return logger.info(`[agent-link] skill from @${from.username} ignored (no file, or over ${MAX_SKILL_FILE} bytes)`);
    const link = await this.telegram.getFileLink(doc.file_id);
    const res = await axios.get(String(link), { responseType: 'text', timeout: 20000, maxContentLength: MAX_SKILL_FILE, transformResponse: x => x });
    let skill;
    try { skill = JSON.parse(res.data); } catch { return logger.info(`[agent-link] skill from @${from.username} is not JSON`); }
    const installPeerSkill = this.installSkill || (await import('../../services/skills/skillsService.js')).installPeerSkill;
    // The author is the bot, whatever origin the file claims: a claimed fingerprint could pose
    // as another agent's skill.
    const result = await installPeerSkill({
      skill: { name: skill?.name, description: skill?.description, body: skill?.body, sha256: skill?.sha256 },
      trusted: false, from: { fingerprint: `tg${from.id}`, name: `@${from.username}` }, via: 'telegram'
    });
    logger.info(`[agent-link] skill "${skill?.name}" from @${from.username}: ${result.saved ? result.status : `not saved (${result.reason || 'unchanged'})`}`);
    if (result.saved) {
      const n = result.skill.name;
      await this.notify(`🧩 @${from.username} sent the skill "${n}": ${result.skill.description}\n\nStatus: ${result.status}.`, {
        parse_mode: undefined,
        ...(result.status === 'pending' ? { reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `skill_ok:${n}` }, { text: 'Reject', callback_data: `skill_no:${n}` }]] } } : {})
      });
    }
  }

  async _tellUnknown(from) {
    const u = from.username || String(from.id);
    if (this.toldUnknown.has(u)) return;
    this.toldUnknown.add(u);
    logger.warn(`[agent-link] message from untrusted bot @${u} (${from.id}) not answered`);
    await this.notify(`🤖 The bot @${u} messaged me. I did not answer: it is not one of my trusted agents.\n\nTrust it to let it ask me questions and exchange skills (skills it sends still need your approval).`, {
      parse_mode: undefined,
      reply_markup: { inline_keyboard: [[{ text: `Trust @${u}`, callback_data: `tgpeer_trust:${u}` }, { text: 'Ignore', callback_data: `tgpeer_ignore:${u}` }]] }
    }).catch(() => {});
  }

  async _tellMismatch(from, peer) {
    const key = `mismatch:${from.id}`;
    if (this.toldUnknown.has(key)) return;
    this.toldUnknown.add(key);
    logger.warn(`[agent-link] @${from.username} now has id ${from.id}, trusted as ${peer.id}: refused`);
    await this.notify(`⚠️ A bot now using the username @${from.username} is not the bot you trusted under that name (different Telegram id). I am ignoring it. If the agent really moved to a new bot, untrust and trust it again.`, { parse_mode: undefined }).catch(() => {});
  }

  async _flood(from, what) {
    const until = new Date(Date.now() + 3600_000).toISOString();
    await mutePeer(from.id, until);
    logger.warn(`[agent-link] @${from.username} muted until ${until}: ${what}`);
    await this.notify(`🔇 Muted @${from.username} for an hour: it went over ${what}. That usually means two agents were answering each other in a loop.`, { parse_mode: undefined }).catch(() => {});
  }

  // ------------------------------------------------------------- outbound (operator-initiated)

  async _peerOrThrow(username) {
    const features = await getAgentFeatures();
    if (!features.botToBot) throw new Error('Bot-to-bot is off. Turn it on in Settings → Telegram agents, with /agents, or PUT /api/telegram/agent-features {"botToBot": true}.');
    const u = normalizeUsername(username);
    const peer = features.peers.find(p => p.username.toLowerCase() === u.toLowerCase());
    if (!peer) throw new Error(`@${u} is not a trusted agent. Trust it first (/trustbot @${u}).`);
    return { u, peer };
  }

  _await(id, peer, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`@${peer} did not answer within ${Math.round(timeoutMs / 1000)} s. It needs Bot-to-Bot Communication Mode on in @BotFather, and to trust this bot.`)); }, timeoutMs);
      this.pending.set(id, { resolve, timer, peer });
    });
  }

  async _request(username, type, body, timeoutMs) {
    const { u } = await this._peerOrThrow(username);
    const id = newId();
    const wait = this._await(id, u, timeoutMs);
    try {
      await this._send(`@${u}`, { type, id, depth: 0, body });
    } catch (err) {
      clearTimeout(this.pending.get(id)?.timer);
      this.pending.delete(id);
      const why = err.description || err.message;
      // A bot whose @BotFather access is "only selected users" refuses every bot not on that list.
      const hint = /BOT_ACCESS_RESTRICTED/.test(why)
        ? `Access to one of the bots is restricted to selected users in @BotFather. Add the other bot to that bot's allowed users (or lift the restriction).`
        : `Both bots need Bot-to-Bot Communication Mode on in @BotFather.`;
      throw new Error(`Telegram refused the message to @${u}: ${why}. ${hint}`);
    }
    return wait;
  }

  async ask(username, question, { timeoutMs = 120000 } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Ask what?');
    const r = await this._request(username, 'ask', q.slice(0, MAX_BODY), timeoutMs);
    return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  }

  async hello(username) { return (await this._request(username, 'hello', null, 30000)).body; }

  async listSkills(username) { return (await this._request(username, 'skills_query', null, 60000)).body?.skills || []; }

  /** Ask a peer for skills by name; they arrive as files and wait for approval. */
  async requestSkills(username, names) {
    const { u } = await this._peerOrThrow(username);
    const list = (Array.isArray(names) ? names : String(names || '').split(/[,\s]+/)).filter(Boolean).slice(0, MAX_SKILLS_REQUESTED);
    if (!list.length) throw new Error('Name the skills to request.');
    await this._send(`@${u}`, { type: 'skill_request', id: newId(), depth: 0, body: { names: list } });
    return list;
  }

  /** Send one of our skills to a peer. Only one the privacy audit cleared. */
  async sendSkill(username, name) {
    const { u } = await this._peerOrThrow(username);
    const sharing = await this._sharing();
    if (!sharing) throw new Error('Skill sharing is off (Settings → Skills), so no skill leaves this agent.');
    const skill = (await sharing.shareable()).find(s => s.name === name);
    if (!skill) throw new Error(`"${name}" is not shareable: no such active skill, sharing is off for it, or the privacy audit has not cleared it.`);
    const { default: SkillSharing } = await import('../../services/p2p/skillSharing.js');
    await this._pushSkillFile(`@${u}`, SkillSharing.payload(skill, null));
    return { sent: name, to: `@${u}` };
  }
}
