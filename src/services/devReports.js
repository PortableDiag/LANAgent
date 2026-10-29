import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { DevReport } from '../models/DevReport.js';
import { Transcript } from '../models/Transcript.js';
import { LOGS_PATH } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * Bug reports for the developer, filed by the owner by voice or chat ("log a bug: you hung up while
 * I was still talking"). The developer works on a machine that is often off, so a report goes to two
 * places that are not: ALICE's own database first (it is never lost), then a card in the "Dev Inbox"
 * basket on Trellis, where the developer reads it. A card that could not be written is retried.
 *
 * Each report carries what a fix needs, captured at the moment it is filed: the owner's words, the
 * conversation leading up to it, the errors logged in the minutes before, the version and the model.
 */

export const DEV_INBOX = process.env.DEV_REPORTS_BASKET || 'Dev Inbox';
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const MAX_TURNS = 20;
const MAX_ERRORS = 25;

const require = createRequire(import.meta.url);
let VERSION = 'unknown';
try { VERSION = require('../../package.json').version; } catch { /* tooling */ }

/** `[ERROR]` lines from errors.log in the last few minutes, stack frames dropped, newest last. */
export async function recentErrors({ now = Date.now(), windowMs = ERROR_WINDOW_MS, file = path.join(LOGS_PATH, 'errors.log'), max = MAX_ERRORS } = {}) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[ERROR\] (.*)/.exec(line);
      if (!m) continue;
      const at = new Date(m[1].replace(' ', 'T')).getTime();
      if (Number.isFinite(at) && now - at <= windowMs && at <= now + 60000) out.push(`${m[1].slice(11)} ${m[2].slice(0, 300)}`);
    }
    return out.slice(-max);
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The conversation before the report: the call's own turns when given, else the user's stored transcript. */
export async function recentConversation({ turns, userId } = {}) {
  if (Array.isArray(turns) && turns.length) {
    return turns.slice(-MAX_TURNS).map(t => ({ role: String(t.role || ''), text: String(t.text || '').slice(0, 600) }));
  }
  try {
    const q = userId ? { userId: String(userId) } : {};
    const rows = await Transcript.find(q).sort({ createdAt: -1 }).limit(MAX_TURNS).lean();
    return rows.reverse().map(r => ({ role: r.role, text: String(r.content || '').slice(0, 600), at: r.createdAt }));
  } catch {
    return [];
  }
}

function modelOf(agent) {
  const p = agent?.providerManager?.activeProvider;
  return p ? `${p.name || 'provider'}${p.models?.chat ? `/${p.models.chat}` : ''}` : 'unknown';
}

function notesPlugin(agent) {
  const entry = agent?.apiManager?.apis?.get?.('trellis-notes');
  const notes = entry?.instance || entry;
  return notes?.execute ? notes : null;
}

let inboxId = null;
async function inboxBasket(notes) {
  if (inboxId) return inboxId;
  const list = await notes.execute({ action: 'listBaskets' });
  let hit = (list?.baskets || []).find(b => String(b.title).toLowerCase() === DEV_INBOX.toLowerCase() && (b.depth ?? 0) === 0);
  if (!hit) {
    const made = await notes.execute({ action: 'createBasket', title: DEV_INBOX });
    hit = made?.created ? { id: made.created.basket } : null;
    if (hit) logger.info(`[dev-reports] created the Trellis "${DEV_INBOX}" basket (${hit.id})`);
  }
  inboxId = hit?.id ?? null;
  if (!inboxId) throw new Error(`no "${DEV_INBOX}" basket`);
  return inboxId;
}

export function cardBody(r) {
  const convo = (r.conversation || []).map(t => `${t.role}: ${t.text}`).join('\n') || '(none)';
  const errs = (r.errors || []).join('\n') || '(none in the 5 minutes before)';
  return `${r.text}\n\n` +
    `--- conversation before the report ---\n${convo}\n\n` +
    `--- errors logged ---\n${errs}\n\n` +
    `report:: ${r._id}\nfrom:: ${process.env.AGENT_NAME || 'ALICE'}\ninterface:: ${r.interface}\n` +
    (r.callId ? `call:: ${r.callId}\n` : '') +
    `version:: ${r.version}\nmodel:: ${r.model}\nstatus:: open\nat:: ${new Date(r.createdAt).toISOString()}`;
}

/** Writes one stored report to Trellis; records the card or the reason it failed. */
async function pushToTrellis(agent, r) {
  const notes = notesPlugin(agent);
  try {
    if (!notes) throw new Error('the Trellis notes plugin is not available');
    const basket = await inboxBasket(notes);
    const title = `Bug: ${r.text.split(/\s+/).slice(0, 8).join(' ').replace(/[,;:.!?]+$/, '')}`.slice(0, 120);
    const res = await notes.execute({ action: 'createNote', basket, title, body: cardBody(r), tags: ['bug', 'dev-inbox'] });
    if (res?.success === false) throw new Error(res.error || 'createNote failed');
    const card = res?.created?.card != null ? String(res.created.card) : null;
    await DevReport.updateOne({ _id: r._id }, { $set: { trellisCard: card, syncedAt: new Date() }, $unset: { syncError: 1 } });
    return card;
  } catch (e) {
    inboxId = null; // a deleted basket is looked up again next time
    await DevReport.updateOne({ _id: r._id }, { $set: { syncError: e.message } }).catch(() => {});
    logger.warn(`[dev-reports] report ${r._id} kept in the database, not yet in Trellis: ${e.message}`);
    return null;
  }
}

/**
 * File a report. Saved to the database before anything else, so a Trellis failure loses nothing.
 * @returns {{ saved: true, id: string, card: string|null }}
 */
export async function fileDevReport(agent, { text, interface: iface = 'unknown', userId = null, callId = null, turns = null } = {}) {
  const words = String(text || '').trim();
  if (!words) throw new Error('A bug report needs a description.');
  const [conversation, errors] = await Promise.all([recentConversation({ turns, userId }), recentErrors()]);
  const r = await DevReport.create({
    text: words, interface: iface, userId: userId ? String(userId) : undefined, callId: callId ? String(callId) : undefined,
    conversation, errors, version: VERSION, model: modelOf(agent)
  });
  logger.info(`[dev-reports] report ${r._id} filed from ${iface}: "${words.slice(0, 80)}"`);
  const card = await pushToTrellis(agent, r.toObject());
  syncPending(agent).catch(() => {});
  return { saved: true, id: String(r._id), card };
}

/** Retries every report that has not reached Trellis yet. */
export async function syncPending(agent) {
  const pending = await DevReport.find({ syncedAt: null }).sort({ createdAt: 1 }).limit(20).lean();
  let done = 0;
  for (const r of pending) if (await pushToTrellis(agent, r)) done++;
  if (pending.length) logger.info(`[dev-reports] retry: ${done} of ${pending.length} pending report(s) now in Trellis`);
  return { pending: pending.length, synced: done };
}

export async function listDevReports({ status = 'open', limit = 10 } = {}) {
  const q = status && status !== 'all' ? { status } : {};
  return DevReport.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 10, 50)).lean();
}
