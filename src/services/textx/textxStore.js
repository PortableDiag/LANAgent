import mongoose from 'mongoose';
import { encrypt, decrypt } from '../../utils/encryption.js';

/**
 * Persistence for the TextX hub. Two implementations of one interface:
 *   mongoStore()  — production (devices, outbox, 7-day dedupe of inbound ids)
 *   memoryStore() — unit tests
 *
 * A device is { id, name, kid, key, base, deviceId, boundAt, lastSeenAt, appVersion, replyMode,
 * maxAttachmentBytes, capabilities[], notify, watches[], revokedAt, createdAt }. `key` is the pairing's AES key:
 * the agent must hold it to decrypt, so it is stored encrypted under ENCRYPTION_KEY, never hashed.
 */

const WEEK_S = 7 * 24 * 3600;
/** The source name for contacts from TextX's contacts_list (the whole address book). */
export const BOOK = 'the address book';

/** Digits only, the last 10: "+1 (405) 555-0100" and "4055550100" are one number. */
export const sameNumber = (a, b) => String(a).replace(/\D/g, '').slice(-10) === String(b).replace(/\D/g, '').slice(-10);
// A name that is only a number (a sender not in the address book) is not a contact.
const contactKey = (name) => {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return /^[\d\s()+.-]*$/.test(k) ? '' : k;
};

/**
 * Folds { name, number | numbers, email | emails } into an existing record. Returns the merged
 * record and whether anything changed. A contact with no name is only a number: not kept.
 */
export function mergeContact(old, c, source) {
  const name = String(c.name || '').trim();
  // The address book is the authority on a contact's numbers: an entry from it replaces them.
  const fromBook = source === BOOK;
  const numbers = fromBook ? [] : [...(old?.numbers || [])];
  for (const n of [c.number, ...(c.numbers || [])].filter(Boolean).map(String))
    if (/\d{5,}/.test(n.replace(/\D/g, '')) && !numbers.some(x => sameNumber(x, n))) numbers.push(n.trim());
  const emails = fromBook ? [] : [...(old?.emails || [])];
  for (const e of [c.email, ...(c.emails || [])].filter(Boolean).map(x => String(x).trim().toLowerCase()))
    if (/^[^\s@]+@[^\s@]+$/.test(e) && !emails.includes(e)) emails.push(e);
  const sources = [...new Set([...(old?.sources || []), source].filter(Boolean))];
  const bookIds = [...new Set([...(old?.bookIds || []), c.id].filter(Boolean).map(String))];
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...(b || [])].sort());
  const changed = !old || !same(numbers, old.numbers) || !same(emails, old.emails);
  return { rec: { key: contactKey(name), name: old?.name || name, numbers, emails, sources, bookIds }, changed };
}

/**
 * What is left of a record once address-book data is withdrawn: null when the book was its only
 * source (or the ids given covered all of its book entries), else the record without the book.
 */
function withoutBook(rec, ids) {
  const left = ids ? (rec.bookIds || []).filter(i => !ids.includes(i)) : [];
  if (left.length) return { ...rec, bookIds: left };
  const sources = (rec.sources || []).filter(s => s !== BOOK);
  return sources.length ? { ...rec, sources, bookIds: [] } : null;
}

/** Saved contacts matching a name: exact first, else ones holding every word of it. */
function matchContacts(all, query) {
  const q = contactKey(query);
  if (!q) return [];
  const exact = all.filter(c => c.key === q);
  if (exact.length) return exact;
  const words = q.split(' ').filter(w => w.length >= 2);
  return all.filter(c => words.every(w => c.key.split(' ').some(k => k.startsWith(w))));
}

const deviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  kid: { type: String, required: true, unique: true },
  keyEnc: { type: String, required: true },
  base: String,
  deviceId: String,
  boundAt: Date,
  lastSeenAt: Date,
  appVersion: String,
  client: String,
  replyMode: String, // text | voice | both, the phone's per-agent choice (TextX 0.3.21)
  maxAttachmentBytes: Number, // the carrier MMS cap the phone reports in hello
  capabilities: { type: [String], default: [] },
  notify: { type: Boolean, default: false },
  watches: { type: [mongoose.Schema.Types.Mixed], default: [] },
  nextSeq: { type: Number, default: 0 },
  contactsSyncAt: Date, // last full address-book sync (contacts_list); null = none kept
  notifyLevel: String,  // from the LANAgent app's hello: 'all' | 'owner' | 'off' (TextX sends none)
  revokedAt: Date
}, { timestamps: true, collection: 'textx_devices' });

const outboxSchema = new mongoose.Schema({
  device: { type: mongoose.Schema.Types.ObjectId, required: true },
  seq: { type: Number, required: true },
  envId: { type: String, required: true },
  env: { type: mongoose.Schema.Types.Mixed, required: true },
  ackedAt: Date,
  createdAt: { type: Date, default: Date.now, expires: 2 * WEEK_S }
}, { collection: 'textx_outbox' });
outboxSchema.index({ device: 1, seq: 1 }, { unique: true });
outboxSchema.index({ device: 1, envId: 1 });

const inboxSchema = new mongoose.Schema({
  device: { type: mongoose.Schema.Types.ObjectId, required: true },
  envId: { type: String, required: true },
  // A user message being answered: set when it is accepted, cleared when the reply is queued.
  // Still set at start-up means a restart cut the answer off.
  pending: { type: Boolean, default: false },
  preview: String,
  createdAt: { type: Date, default: Date.now, expires: WEEK_S } // the replay window (§3.3)
}, { collection: 'textx_inbox' });
inboxSchema.index({ device: 1, envId: 1 }, { unique: true });

// The owner's phone contacts as ALICE has seen them (lookups, shared threads): name → numbers.
const contactSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  numbers: { type: [String], default: [] },
  emails: { type: [String], default: [] },
  bookIds: { type: [String], default: [] }, // TextX contacts_list ids this record came from
  sources: { type: [String], default: [] },
  seenAt: { type: Date, default: Date.now }
}, { timestamps: true, collection: 'textx_contacts' });

export const TextXContact = mongoose.models.TextXContact || mongoose.model('TextXContact', contactSchema);
export const TextXDevice = mongoose.models.TextXDevice || mongoose.model('TextXDevice', deviceSchema);
export const TextXOutbox = mongoose.models.TextXOutbox || mongoose.model('TextXOutbox', outboxSchema);
export const TextXInbox = mongoose.models.TextXInbox || mongoose.model('TextXInbox', inboxSchema);

const PUBLIC_FIELDS = ['name', 'kid', 'base', 'deviceId', 'boundAt', 'lastSeenAt', 'appVersion', 'client', 'replyMode', 'maxAttachmentBytes',
  'capabilities', 'notify', 'notifyLevel', 'watches', 'contactsSyncAt', 'revokedAt', 'createdAt'];

function toDevice(doc) {
  if (!doc) return null;
  const d = { id: String(doc._id) };
  for (const f of PUBLIC_FIELDS) d[f] = doc[f];
  try { d.key = decrypt(doc.keyEnc); } catch { d.key = null; }
  return d;
}

export function mongoStore() {
  // Devices are few and read on every frame: keep them in memory, write through.
  let cache = null;
  const load = async () => {
    if (!cache) cache = new Map((await TextXDevice.find({}).lean()).map(doc => [String(doc._id), toDevice(doc)]));
    return cache;
  };
  return {
    async createDevice({ name, kid, key, base }) {
      const doc = await TextXDevice.create({ name, kid, keyEnc: encrypt(key), base });
      const d = toDevice(doc.toObject());
      (await load()).set(d.id, d);
      return d;
    },
    async getByKid(kid) {
      for (const d of (await load()).values()) if (d.kid === kid) return d;
      return null;
    },
    async getDevice(id) { return (await load()).get(String(id)) || null; },
    async listDevices() { return [...(await load()).values()]; },
    async updateDevice(id, patch) {
      const doc = await TextXDevice.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
      const d = toDevice(doc);
      if (d) (await load()).set(d.id, d);
      return d;
    },
    async deleteDevice(id) {
      await TextXDevice.deleteOne({ _id: id });
      await TextXOutbox.deleteMany({ device: id });
      await TextXInbox.deleteMany({ device: id });
      (await load()).delete(String(id));
    },
    async outboxAdd(id, env) {
      const { nextSeq } = await TextXDevice.findByIdAndUpdate(id, { $inc: { nextSeq: 1 } }, { new: true }).lean();
      await TextXOutbox.create({ device: id, seq: nextSeq, envId: env.id, env });
      return nextSeq;
    },
    async outboxSince(id, seq, limit) {
      return TextXOutbox.find({ device: id, seq: { $gt: seq }, ackedAt: null }).sort({ seq: 1 }).limit(limit).lean();
    },
    async outboxUnacked(id) {
      return TextXOutbox.find({ device: id, ackedAt: null }).sort({ seq: 1 }).limit(500).lean();
    },
    async outboxAckThrough(id, seq) {
      await TextXOutbox.updateMany({ device: id, seq: { $lte: seq }, ackedAt: null }, { $set: { ackedAt: new Date() } });
    },
    async outboxAckId(id, envId) {
      if (envId) await TextXOutbox.updateOne({ device: id, envId: String(envId) }, { $set: { ackedAt: new Date() } });
    },
    async outboxAckType(id, type) {
      await TextXOutbox.updateMany({ device: id, 'env.type': type, ackedAt: null }, { $set: { ackedAt: new Date() } });
    },
    async inboxDone(id, envId) {
      await TextXInbox.updateOne({ device: id, envId }, { $set: { pending: false }, $unset: { preview: 1 } });
    },
    async inboxPending() {
      return (await TextXInbox.find({ pending: true }).lean()).map(r => ({ device: String(r.device), envId: r.envId, preview: r.preview }));
    },
    /** Saves contacts seen on the phone; returns the ones that are new or gained a number or email. */
    async contactsLearn(list, source) {
      const out = [];
      for (const c of list || []) {
        const key = contactKey(c?.name);
        if (!key) continue;
        const old = await TextXContact.findOne({ key }).lean();
        const { rec, changed } = mergeContact(old, c, source);
        if (!rec.numbers.length && !rec.emails.length) continue;
        await TextXContact.updateOne({ key }, { $set: { ...rec, seenAt: new Date() } }, { upsert: true });
        if (changed) out.push(rec);
      }
      return out;
    },
    async contactsFind(query) {
      return matchContacts(await TextXContact.find({}).sort({ name: 1 }).limit(5000).lean(), query);
    },
    async contactsList(limit = 500) {
      return TextXContact.find({}).sort({ name: 1 }).limit(limit).lean();
    },
    /** Withdraws address-book data: the given contacts_list ids, or (no ids) the whole book. */
    async contactsDropBook(ids = null) {
      const q = ids ? { bookIds: { $in: ids.map(String) } } : { sources: BOOK };
      let n = 0;
      for (const rec of await TextXContact.find(q).lean()) {
        const left = withoutBook(rec, ids && ids.map(String));
        if (left) await TextXContact.updateOne({ _id: rec._id }, { $set: { sources: left.sources, bookIds: left.bookIds } });
        else { await TextXContact.deleteOne({ _id: rec._id }); n++; }
      }
      return n;
    },
    /** True when this id was already seen (a resend or a replay); records it otherwise. */
    async inboxSeen(id, envId, extra = {}) {
      try {
        await TextXInbox.create({ device: id, envId, ...extra });
        return false;
      } catch (e) {
        if (e?.code === 11000) return true;
        throw e;
      }
    }
  };
}

export function memoryStore() {
  const devices = new Map();
  const outbox = [];
  const inbox = new Set();
  const pending = new Map();
  const contacts = new Map();
  let n = 0;
  return {
    async createDevice({ name, kid, key, base }) {
      const d = { id: String(++n), name, kid, key, base, capabilities: [], notify: false, watches: [], createdAt: new Date(), nextSeq: 0 };
      devices.set(d.id, d);
      return { ...d };
    },
    async getByKid(kid) { const d = [...devices.values()].find(x => x.kid === kid); return d ? { ...d } : null; },
    async getDevice(id) { const d = devices.get(String(id)); return d ? { ...d } : null; },
    async listDevices() { return [...devices.values()].map(d => ({ ...d })); },
    async updateDevice(id, patch) { const d = devices.get(String(id)); if (!d) return null; Object.assign(d, patch); return { ...d }; },
    async deleteDevice(id) { devices.delete(String(id)); },
    async outboxAdd(id, env) { const d = devices.get(String(id)); d.nextSeq += 1; outbox.push({ device: String(id), seq: d.nextSeq, env, acked: false }); return d.nextSeq; },
    async outboxSince(id, seq, limit) { return outbox.filter(r => r.device === String(id) && r.seq > seq && !r.acked).slice(0, limit); },
    async outboxUnacked(id) { return outbox.filter(r => r.device === String(id) && !r.acked); },
    async outboxAckThrough(id, seq) { outbox.forEach(r => { if (r.device === String(id) && r.seq <= seq) r.acked = true; }); },
    async outboxAckId(id, envId) { outbox.forEach(r => { if (r.device === String(id) && r.env.id === envId) r.acked = true; }); },
    async outboxAckType(id, type) { outbox.forEach(r => { if (r.device === String(id) && r.env.type === type) r.acked = true; }); },
    async inboxSeen(id, envId, extra = {}) {
      const k = `${id}:${envId}`;
      if (inbox.has(k)) return true;
      inbox.add(k);
      if (extra.pending) pending.set(k, { device: String(id), envId, preview: extra.preview });
      return false;
    },
    async inboxDone(id, envId) { pending.delete(`${id}:${envId}`); },
    async contactsLearn(list, source) {
      const out = [];
      for (const c of list || []) {
        const key = contactKey(c?.name);
        if (!key) continue;
        const { rec, changed } = mergeContact(contacts.get(key), c, source);
        if (!rec.numbers.length && !rec.emails.length) continue;
        contacts.set(key, rec);
        if (changed) out.push(rec);
      }
      return out;
    },
    async contactsFind(query) { return matchContacts([...contacts.values()], query); },
    async contactsList(limit = 500) { return [...contacts.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit); },
    async contactsDropBook(ids = null) {
      let n = 0;
      for (const [key, rec] of contacts) {
        if (ids ? !(rec.bookIds || []).some(i => ids.map(String).includes(i)) : !(rec.sources || []).includes(BOOK)) continue;
        const left = withoutBook(rec, ids && ids.map(String));
        if (left) contacts.set(key, left); else { contacts.delete(key); n++; }
      }
      return n;
    },
    async inboxPending() { return [...pending.values()]; },
    _outbox: outbox
  };
}
