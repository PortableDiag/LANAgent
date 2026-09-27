import mongoose from 'mongoose';
import WebWatch from '../../models/WebWatch.js';
import { assertPublicUrl } from '../../utils/publicUrl.js';

/** Watch CRUD shared by the feeds and priceWatch plugins. */

export async function findWatch(kind, { id, url, name, watch, originalInput, _context } = {}) {
  const key = String(id || url || name || watch || '').trim();
  try {
    return await findWatchByKey(kind, key);
  } catch (err) {
    // Fall back to the request's own words ("stop watching the Node.js blog feed" names the
    // watch "Node.js Blog"): the one watch whose name words all appear in the request.
    const said = String(originalInput || _context?.originalInput || '').toLowerCase();
    if (!said) throw err;
    const all = await WebWatch.find({ kind });
    const hits = all.filter(w => {
      const words = String(w.name || '').toLowerCase().split(/[^a-z0-9.]+/).filter(x => x.length > 2);
      return words.length && words.every(x => said.includes(x.replace(/\.$/, '')));
    });
    if (hits.length === 1) return hits[0];
    throw err;
  }
}

async function findWatchByKey(kind, key) {
  if (!key) throw new Error('say which watch (its url, name or id)');
  if (mongoose.isValidObjectId(key)) {
    const byId = await WebWatch.findOne({ _id: key, kind });
    if (byId) return byId;
  }
  const byUrl = await WebWatch.findOne({ kind, url: key });
  if (byUrl) return byUrl;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = await WebWatch.find({ kind, $or: [{ name: new RegExp(esc, 'i') }, { url: new RegExp(esc, 'i') }] }).limit(5);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${key}" matches ${matches.length} watches: ${matches.map(m => m.name || m.url).join('; ')}`);
  throw new Error(`no ${kind} watch matches "${key}"`);
}

export async function upsertWatch(kind, url, fields) {
  const clean = await assertPublicUrl(url);
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const existing = await WebWatch.findOne({ kind, url: clean });
  if (existing) {
    Object.assign(existing, set, { active: true });
    await existing.save();
    return { watch: existing, created: false };
  }
  const watch = await WebWatch.create({ kind, url: clean, ...set });
  return { watch, created: true };
}

export function describe(w) {
  const base = { id: String(w._id), name: w.name || '', url: w.url, active: w.active, everyMinutes: w.intervalMin,
    lastChecked: w.lastCheckedAt || null, lastError: w.lastError || null };
  if (w.kind === 'feed') return { ...base, keywords: w.keywords, itemsSeen: (w.seen || []).length };
  return { ...base, price: w.lastPrice, lowest: w.lowestPrice, currency: w.currency, target: w.targetPrice,
    changePct: w.changePct || 0, lastChange: w.lastChangeAt || null };
}

export const interval = v => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error('interval must be a number of minutes');
  return Math.max(15, Math.min(n, 7 * 24 * 60));
};

export const toList = v => (v == null ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean));
