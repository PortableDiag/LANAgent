import { logger } from '../../utils/logger.js';
import { peerManager } from './peerManager.js';
import { sanitizeString } from './sanitizer.js';
import {
  getSkillsService, skillEvents, skillHash, getSkillSharing, peerSkillsTrusted, installPeerSkill
} from '../skills/skillsService.js';
import { getShareAudit } from '../skills/shareAudit.js';

const MAX_OFFER = 200;           // skills listed in one skill_sync
const MAX_REQUEST = 50;          // skills asked for in one skill_request
const PEER_FINGERPRINT = /^[0-9a-f]{32}$/i;

/**
 * Skill sharing over the Skynet P2P network (on by default; `skills.p2pShare`).
 *
 * An agent that learns a skill teaches it to its trusted peers, so they do not have to learn
 * it again. "Trusted" is peerSkillsTrusted(): the genesis agent, a peer the operator marked
 * trusted, or a peer whose trust score reaches `skills.p2pMinTrustScore` (default 50: that
 * takes proven stake and identity, see P2PPeer.getTrustScoreBreakdown).
 *
 *   skill_sync     {skills:[{name, sha256, origin}]}   what I can teach (sent to trusted peers
 *                                                      after each capabilities exchange)
 *   skill_request  {names:[...]}                       the ones I lack or have an older copy of
 *   skill_push     {skill:{name, description, body, sha256, origin, originName}}
 *                                                      one skill; also sent unasked when a
 *                                                      skill becomes active locally
 *
 * Messages are already signed and encrypted per peer. What is shared is sanitized first
 * (IPs, paths, emails and key-shaped strings redacted), and the hash covers the sanitized
 * text, so both sides compare the same thing. A received skill is active at once from a
 * trusted peer and pending (operator approval) from anyone else; a skill written locally is
 * never overwritten by a peer's.
 */
export default class SkillSharing {
  constructor({ service = null, peers = peerManager, selfFingerprint = null, agent = null, notifyDelayMs = 20000, audit = null } = {}) {
    this._service = service;
    this._audit = audit;
    this._auditQueue = Promise.resolve();
    this._queued = new Set();
    this.peers = peers;
    this._self = selfFingerprint;
    this.agent = agent;
    this.notifyDelayMs = notifyDelayMs;
    this._notices = [];
    this._noticeTimer = null;
    this.sendFn = null;
    this._onActivated = (e) => this.broadcast(e.name).catch(err =>
      logger.debug(`P2P skill broadcast of ${e.name} failed: ${err.message}`));
  }

  get service() {
    return this._service || getSkillsService();
  }

  /** Start pushing locally activated skills to trusted online peers. */
  start(sendFn) {
    this.sendFn = sendFn;
    skillEvents.off('activated', this._onActivated);
    skillEvents.on('activated', this._onActivated);
  }

  stop() {
    skillEvents.off('activated', this._onActivated);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
  }

  /** The shareable form of a skill: sanitized, with the hash of exactly what is sent. */
  static payload(skill, selfFingerprint = null) {
    const description = sanitizeString(String(skill.description));
    const body = sanitizeString(String(skill.body));
    // origin names the skill's author for "newer version from the same author" matching, and
    // only a peer fingerprint means anything to another agent. A local source such as
    // "trellis:<document id>" is private (it carried the operator's document id to peers until
    // 2026-09-30); a skill from anywhere but a peer is this agent's to teach.
    const peerOrigin = PEER_FINGERPRINT.test(String(skill.meta?.origin || '')) ? skill.meta.origin : null;
    const origin = peerOrigin || selfFingerprint || '';
    const originName = peerOrigin ? sanitizeString(String(skill.meta?.origin_name || '')) : (process.env.AGENT_NAME || '');
    return { name: skill.name, description, body, sha256: skillHash({ name: skill.name, description, body }), origin, originName };
  }

  get audit() {
    return this._audit || getShareAudit();
  }

  /** Active, non-bundled skills not marked `share: false`: what COULD be shared. */
  async _candidates() {
    await this.service.scan();
    return [...this.service.skills.values()].filter(s =>
      !s.bundled
      && (s.meta?.status || 'active') === 'active'
      && String(s.meta?.share ?? 'true').toLowerCase() !== 'false');
  }

  /**
   * What MAY be shared: candidates whose exact outgoing payload passed the privacy audit
   * (shareAudit.js) or was released by the operator. Every path out (sync offers, requests,
   * broadcasts) reads this. A candidate without a verdict for its current content is queued
   * for an audit and taught to peers once it clears.
   */
  async shareable() {
    const self = await this._selfFingerprint();
    const out = [];
    for (const skill of await this._candidates()) {
      const payload = SkillSharing.payload(skill, self);
      if (await this.audit.cleared(payload)) out.push(skill);
      else this._queueAudit(skill.name, payload);
    }
    return out;
  }

  _queueAudit(name, payload) {
    if (this._queued.has(payload.sha256)) return;
    this._queued.add(payload.sha256);
    this._auditQueue = this._auditQueue.then(async () => {
      try {
        const known = await this.audit.recordFor(payload);
        if (known && known.verdict !== 'error') return; // blocked stays blocked until released or edited
        const r = await this.audit.audit(payload);
        if (r.verdict === 'clear' && this.sendFn) await this.broadcast(name);
      } catch (err) {
        logger.warn(`Skill share audit of "${name}" failed: ${err.message}`);
      } finally {
        this._queued.delete(payload.sha256);
      }
    });
  }

  async _selfFingerprint() {
    if (this._self) return this._self;
    try {
      const { cryptoManager } = await import('./cryptoManager.js');
      return cryptoManager.identity?.fingerprint || null;
    } catch {
      return null;
    }
  }

  async _trusted(fingerprint) {
    const peer = await this.peers.getPeer(fingerprint);
    if (!peer) return { peer: null, trusted: false };
    const { minTrustScore } = await getSkillSharing();
    return { peer, trusted: peerSkillsTrusted(peer, minTrustScore) };
  }

  /** Offer our skills to a peer (after its capabilities, so its trust is current). */
  async syncWithPeer(fingerprint, sendFn = this.sendFn) {
    if (!sendFn || !(await getSkillSharing()).enabled) return false;
    const { trusted } = await this._trusted(fingerprint);
    if (!trusted) return false;
    const self = await this._selfFingerprint();
    const offer = (await this.shareable()).slice(0, MAX_OFFER).map(s => {
      const p = SkillSharing.payload(s, self);
      return { name: p.name, sha256: p.sha256, origin: p.origin };
    });
    if (!offer.length) return false;
    await sendFn(fingerprint, { type: 'skill_sync', skills: offer });
    logger.debug(`P2P offered ${offer.length} skill(s) to ${fingerprint.slice(0, 8)}...`);
    return true;
  }

  /** A peer listed its skills: ask for the ones we lack or hold an older copy of. */
  async handleSync(fingerprint, message, sendFn) {
    if (!(await getSkillSharing()).enabled) return [];
    const { trusted } = await this._trusted(fingerprint);
    if (!trusted) return []; // we only pull from peers we trust; others can still be approved by hand
    await this.service.scan();
    const want = [];
    for (const item of (Array.isArray(message.skills) ? message.skills : []).slice(0, MAX_OFFER)) {
      if (!item || typeof item.name !== 'string' || typeof item.sha256 !== 'string') continue;
      const local = this.service.skills.get(item.name);
      if (await this.service.isPeerSkillRejected?.(item.name, item.origin || fingerprint)) continue;
      if (!local) {
        want.push(item.name);
      } else if (!local.bundled && local.meta?.source === 'peer' && local.meta?.sha256 !== item.sha256
                 && (local.meta?.origin || '') === (item.origin || fingerprint)) {
        want.push(item.name); // a newer version of a skill we got from the same author
      }
      if (want.length >= MAX_REQUEST) break;
    }
    if (want.length) {
      await sendFn(fingerprint, { type: 'skill_request', names: want });
      logger.info(`P2P requesting ${want.length} skill(s) from ${fingerprint.slice(0, 8)}...: ${want.join(', ')}`);
    }
    return want;
  }

  /** A trusted peer asked for skills: send each one we can share. */
  async handleRequest(fingerprint, message, sendFn) {
    if (!(await getSkillSharing()).enabled) return 0;
    const { trusted } = await this._trusted(fingerprint);
    if (!trusted) {
      logger.info(`P2P skill request from untrusted peer ${fingerprint.slice(0, 8)}... ignored`);
      return 0;
    }
    const names = new Set((Array.isArray(message.names) ? message.names : []).slice(0, MAX_REQUEST));
    const self = await this._selfFingerprint();
    let sent = 0;
    for (const skill of await this.shareable()) {
      if (!names.has(skill.name)) continue;
      await sendFn(fingerprint, { type: 'skill_push', skill: SkillSharing.payload(skill, self) });
      sent++;
    }
    if (sent) {
      await this.peers.incrementTransferCount?.(fingerprint);
      logger.info(`P2P taught ${sent} skill(s) to ${fingerprint.slice(0, 8)}...`);
    }
    return sent;
  }

  /** A peer sent a skill. */
  async handlePush(fingerprint, message) {
    if (!(await getSkillSharing()).enabled) return { saved: false, reason: 'skill sharing is off' };
    const { peer, trusted } = await this._trusted(fingerprint);
    if (!peer) return { saved: false, reason: 'unknown peer' };
    const result = await installPeerSkill({
      service: this.service,
      skill: message.skill,
      trusted,
      from: { fingerprint, name: peer.displayName || fingerprint.slice(0, 8) }
    });
    if (result.saved) {
      logger.info(`P2P learned skill "${result.skill.name}" from ${peer.displayName || fingerprint.slice(0, 8)} (${result.status}${result.updated ? ', updated' : ''})`);
      this._queueNotice({ name: result.skill.name, description: result.skill.description, status: result.status, updated: result.updated, from: peer.displayName || fingerprint.slice(0, 8) });
    } else if (result.reason) {
      logger.info(`P2P skill from ${peer.displayName || fingerprint.slice(0, 8)} not saved: ${result.reason}`);
    }
    return result;
  }

  /**
   * Tell the operator on Telegram what was learned. Batched: the first sync with a peer can
   * bring many skills, and that should be one message, not one per skill.
   */
  _queueNotice(item) {
    this._notices.push(item);
    if (this._noticeTimer) return;
    this._noticeTimer = setTimeout(() => this._flushNotices().catch(err =>
      logger.debug(`P2P skill notice failed: ${err.message}`)), this.notifyDelayMs);
    this._noticeTimer.unref?.();
  }

  async _flushNotices() {
    const items = this._notices.splice(0);
    this._noticeTimer = null;
    const tg = this.agent?.interfaces?.get?.('telegram');
    if (!items.length || !tg?.sendNotification) return false;
    const active = items.filter(i => i.status === 'active');
    const pending = items.filter(i => i.status !== 'active');
    const from = [...new Set(items.map(i => i.from))].join(', ');
    const line = (i) => `• ${i.name}${i.updated ? ' (updated)' : ''} — ${String(i.description).substring(0, 160)}`;
    let text = `🧠 ${from} taught me ${items.length} skill(s) over the Skynet network:\n\n`;
    if (active.length) text += `In use now:\n${active.slice(0, 15).map(line).join('\n')}${active.length > 15 ? `\n…and ${active.length - 15} more` : ''}\n\n`;
    if (pending.length) text += `Waiting for your approval:\n${pending.slice(0, 15).map(line).join('\n')}${pending.length > 15 ? `\n…and ${pending.length - 15} more` : ''}\n\n`;
    text += 'Skills come in automatically only from the genesis agent, peers you trust, and peers with a high trust score. Skill sharing can be turned off in the web UI (P2P → Settings) or by asking me.';
    const keyboard = [];
    if (items.length === 1 && `skill_ok:${items[0].name}`.length <= 64) {
      keyboard.push(pending.length
        ? [{ text: '✅ Approve', callback_data: `skill_ok:${items[0].name}` }, { text: '🗑 Reject', callback_data: `skill_no:${items[0].name}` }]
        : [{ text: '🗑 Reject', callback_data: `skill_no:${items[0].name}` }]);
    } else if (pending.length) {
      keyboard.push([{ text: `✅ Approve all pending (${pending.length})`, callback_data: 'skill_ok_all' }]);
    }
    // No "turn off sharing" button here: it sat under the skill list and was nearly pressed by
    // accident (2026-09-27). Sharing is switched off in Web UI → P2P → Settings or by asking.
    await tg.sendNotification(text, { parse_mode: undefined, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
    return true;
  }

  /** Push one skill to every trusted online peer (called when a skill becomes active). */
  async broadcast(name, { except = null } = {}) {
    if (!this.sendFn || !(await getSkillSharing()).enabled) return 0;
    const skill = (await this.shareable()).find(s => s.name === name);
    if (!skill) return 0;
    const self = await this._selfFingerprint();
    const payload = SkillSharing.payload(skill, self);
    const { minTrustScore } = await getSkillSharing();
    const online = (await this.peers.getAllPeers()).filter(p => p.isOnline && p.fingerprint !== except && p.fingerprint !== payload.origin);
    let sent = 0;
    for (const peer of online) {
      if (!peerSkillsTrusted(peer, minTrustScore)) continue;
      if (await this.sendFn(peer.fingerprint, { type: 'skill_push', skill: payload })) sent++;
    }
    if (sent) logger.info(`P2P taught skill "${name}" to ${sent} peer(s)`);
    return sent;
  }
}
