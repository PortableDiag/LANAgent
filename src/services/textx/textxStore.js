import mongoose from 'mongoose';
import { encrypt, decrypt } from '../../utils/encryption.js';

/**
 * Persistence for the TextX hub. Two implementations of one interface:
 *   mongoStore()  — production (devices, outbox, 7-day dedupe of inbound ids)
 *   memoryStore() — unit tests
 *
 * A device is { id, name, kid, key, base, deviceId, boundAt, lastSeenAt, appVersion,
 * capabilities[], notify, watches[], revokedAt, createdAt }. `key` is the pairing's AES key:
 * the agent must hold it to decrypt, so it is stored encrypted under ENCRYPTION_KEY, never hashed.
 */

const WEEK_S = 7 * 24 * 3600;

const deviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  kid: { type: String, required: true, unique: true },
  keyEnc: { type: String, required: true },
  base: String,
  deviceId: String,
  boundAt: Date,
  lastSeenAt: Date,
  appVersion: String,
  capabilities: { type: [String], default: [] },
  notify: { type: Boolean, default: false },
  watches: { type: [mongoose.Schema.Types.Mixed], default: [] },
  nextSeq: { type: Number, default: 0 },
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
  createdAt: { type: Date, default: Date.now, expires: WEEK_S } // the replay window (§3.3)
}, { collection: 'textx_inbox' });
inboxSchema.index({ device: 1, envId: 1 }, { unique: true });

export const TextXDevice = mongoose.models.TextXDevice || mongoose.model('TextXDevice', deviceSchema);
export const TextXOutbox = mongoose.models.TextXOutbox || mongoose.model('TextXOutbox', outboxSchema);
export const TextXInbox = mongoose.models.TextXInbox || mongoose.model('TextXInbox', inboxSchema);

const PUBLIC_FIELDS = ['name', 'kid', 'base', 'deviceId', 'boundAt', 'lastSeenAt', 'appVersion', 'capabilities',
  'notify', 'watches', 'revokedAt', 'createdAt'];

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
    /** True when this id was already seen (a resend or a replay); records it otherwise. */
    async inboxSeen(id, envId) {
      try {
        await TextXInbox.create({ device: id, envId });
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
    async inboxSeen(id, envId) { const k = `${id}:${envId}`; if (inbox.has(k)) return true; inbox.add(k); return false; },
    _outbox: outbox
  };
}
