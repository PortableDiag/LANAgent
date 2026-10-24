/**
 * Who is who, across channels (models/Person.js). Every channel resolves the human it is talking
 * to through here, so an SMS from Wayne, a DialX call with Wayne and an email from Wayne land on
 * one person.
 *
 * Rules, each a way the old per-channel keys went wrong:
 * - Only an exact identifier finds a person: number (last 10 digits), email, Telegram id, bot id,
 *   P2P fingerprint. A name never joins two records ("Sam" the plumber is not Sam the friend;
 *   textx_contacts keyed by name merged them).
 * - New identifiers join a person only if no other person already owns them. When the identifiers
 *   given point at two different people, nothing is merged: the strongest match wins for this
 *   message and the clash is kept on the person for the owner to settle.
 * - The owner is one person on every channel (Telegram id, master email, TextX/web as master).
 */
export const numberKey = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
};
const lower = (s) => String(s || '').trim().toLowerCase();
const KINDS = ['number', 'email', 'telegramId', 'botId', 'fingerprint']; // strongest first
const FIELD = { number: 'numberKeys', email: 'emails', telegramId: 'telegramIds', botId: 'botIds', fingerprint: 'fingerprints' };

/** {kind: value} with values normalized; empty ones dropped. */
export function normalizeIds(ids = {}) {
  const out = {};
  if (numberKey(ids.number)) out.number = numberKey(ids.number);
  if (lower(ids.email).includes('@')) out.email = lower(ids.email);
  for (const k of ['telegramId', 'botId', 'fingerprint']) if (ids[k] != null && String(ids[k]).trim()) out[k] = String(ids[k]).trim();
  return out;
}

export class PersonDirectory {
  constructor({ store, logger = console, ownerIds = {} } = {}) {
    this.store = store;
    this.logger = logger;
    this.ownerIds = ownerIds;
  }

  /**
   * The person behind these identifiers, created on first contact (unless create is false).
   * @param {object} ids {number, email, telegramId, botId, fingerprint}
   * @param {object} opts {name, channel, rawNumber, create}
   */
  async resolve(ids = {}, { name = '', channel = '', rawNumber = '', create = true } = {}) {
    const norm = normalizeIds(ids);
    const kinds = KINDS.filter(k => norm[k]);
    if (!kinds.length) return null;
    const hits = new Map(); // personId -> {person, kinds}
    for (const k of kinds) {
      for (const p of await this.store.findBy(FIELD[k], norm[k])) {
        const id = String(p._id);
        if (!hits.has(id)) hits.set(id, { person: p, kinds: [] });
        hits.get(id).kinds.push(k);
      }
    }
    let person;
    if (!hits.size) {
      if (!create) return null;
      person = await this.store.create({ name: String(name || '').trim(), ...this.fields(norm, rawNumber || ids.number) });
      this.logger.info?.(`people: new person ${person.name || '(unnamed)'} via ${kinds.join('+')}${channel ? ` on ${channel}` : ''}`);
    } else {
      // The strongest identifier decides; a clash is recorded, never merged.
      const ranked = [...hits.values()].sort((a, b) => KINDS.indexOf(a.kinds[0]) - KINDS.indexOf(b.kinds[0]));
      person = ranked[0].person;
      if (ranked.length > 1) {
        const others = ranked.slice(1).map(h => String(h.person._id));
        await this.store.addConflict(person._id, { at: new Date(), ids: norm, others });
        this.logger.warn?.(`people: identifiers point at ${ranked.length} people; kept ${person.name || person._id}, not merged`);
      }
      // Identifiers no other person owns join this one.
      const owned = new Set([...hits.values()].filter(h => String(h.person._id) !== String(person._id)).flatMap(h => h.kinds));
      const add = Object.fromEntries(kinds.filter(k => !owned.has(k)).map(k => [k, norm[k]]));
      await this.store.addIds(person._id, this.fields(add, rawNumber || ids.number));
      if (name && !person.name) await this.store.setName(person._id, String(name).trim());
      else if (name && lower(name) !== lower(person.name) && !(person.aliases || []).map(lower).includes(lower(name))) await this.store.addAlias(person._id, String(name).trim());
    }
    if (channel) await this.store.seen(person._id, channel, new Date());
    return this.store.get(person._id);
  }

  fields(norm, rawNumber) {
    const f = {};
    if (norm.number) { f.numberKeys = [norm.number]; f.numbers = [String(rawNumber || norm.number).trim()]; }
    if (norm.email) f.emails = [norm.email];
    if (norm.telegramId) f.telegramIds = [norm.telegramId];
    if (norm.botId) f.botIds = [norm.botId];
    if (norm.fingerprint) f.fingerprints = [norm.fingerprint];
    return f;
  }

  /** The owner, one person on every channel. */
  async owner() {
    const found = await this.store.findOwner();
    if (found) return found;
    const p = await this.store.create({ name: process.env.OWNER_NAME || 'Owner', isOwner: true, ...this.fields(normalizeIds(this.ownerIds)) });
    this.logger.info?.('people: owner record created');
    return p;
  }

  /** People with this name or alias (for lookups; never used to merge). */
  byName(name) { return this.store.findByName(String(name || '').trim()); }
}

/** In-memory store for tests and for running without a database. */
export function memoryPeopleStore() {
  const people = new Map();
  let n = 0;
  const arr = (p, f) => p[f] || [];
  return {
    people,
    async create(doc) {
      const p = { _id: `p${++n}`, name: '', aliases: [], numbers: [], numberKeys: [], emails: [], telegramIds: [], botIds: [], fingerprints: [], isOwner: false, channels: {}, conflicts: [], ...doc };
      people.set(p._id, p);
      return { ...p };
    },
    async findBy(field, value) { return [...people.values()].filter(p => arr(p, field).includes(value)).map(p => ({ ...p })); },
    async findByName(name) {
      const q = name.toLowerCase();
      return [...people.values()].filter(p => p.name.toLowerCase() === q || p.aliases.some(a => a.toLowerCase() === q)).map(p => ({ ...p }));
    },
    async findOwner() { const p = [...people.values()].find(x => x.isOwner); return p ? { ...p } : null; },
    async addIds(id, fields) {
      const p = people.get(String(id));
      for (const [f, vals] of Object.entries(fields)) for (const v of vals) if (!arr(p, f).includes(v)) p[f] = [...arr(p, f), v];
    },
    async setName(id, name) { people.get(String(id)).name = name; },
    async addAlias(id, alias) { const p = people.get(String(id)); p.aliases = [...p.aliases, alias]; },
    async addConflict(id, c) { const p = people.get(String(id)); p.conflicts = [...p.conflicts, c]; },
    async seen(id, channel, at) { people.get(String(id)).channels[channel] = at; },
    async get(id) { const p = people.get(String(id)); return p ? { ...p } : null; }
  };
}

/** MongoDB store (models/Person.js). */
export function mongoPeopleStore() {
  let Person;
  const model = async () => (Person ||= (await import('../../models/Person.js')).Person);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    async create(doc) { return (await (await model()).create(doc)).toObject(); },
    async findBy(field, value) { return (await model()).find({ [field]: value }).limit(5).lean(); },
    async findByName(name) {
      const re = new RegExp(`^${esc(name)}$`, 'i');
      return (await model()).find({ $or: [{ name: re }, { aliases: re }] }).limit(10).lean();
    },
    async findOwner() { return (await model()).findOne({ isOwner: true }).lean(); },
    async addIds(id, fields) {
      const add = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { $each: v }]));
      if (Object.keys(add).length) await (await model()).updateOne({ _id: id }, { $addToSet: add });
    },
    async setName(id, name) { await (await model()).updateOne({ _id: id }, { $set: { name } }); },
    async addAlias(id, alias) { await (await model()).updateOne({ _id: id }, { $addToSet: { aliases: alias } }); },
    async addConflict(id, c) { await (await model()).updateOne({ _id: id }, { $push: { conflicts: { $each: [c], $slice: -20 } } }); },
    async seen(id, channel, at) { await (await model()).updateOne({ _id: id }, { $set: { [`channels.${channel}`]: at } }); },
    async get(id) { return (await model()).findById(id).lean(); }
  };
}

let shared = null;
/** The directory the running agent uses (Mongo-backed). */
export function getPersonDirectory(logger) {
  if (!shared) {
    shared = new PersonDirectory({
      store: mongoPeopleStore(),
      logger,
      ownerIds: { telegramId: process.env.TELEGRAM_USER_ID, email: process.env.EMAIL_OF_MASTER }
    });
  }
  return shared;
}
