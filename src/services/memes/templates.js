/**
 * Where meme pictures come from.
 *
 * - "popular" (`pop:<id>`): the well-known templates (Drake, Distracted Boyfriend...), listed from Imgflip's public
 *   template list. They are copyrighted photos and stills: the agent uses them for its own owner, and they are NEVER
 *   served to a paid caller (owner's decision, 2026-11-09).
 * - "free" (`free:<id>`): public-domain and CC0 pictures found on Openverse. These may be sold; each keeps its licence.
 *
 * Pictures are fetched once and kept under DATA_PATH/memes.
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { DATA_PATH } from '../../utils/paths.js';

const DIR = path.join(DATA_PATH, 'memes');
const POPULAR_TTL = 7 * 24 * 3600 * 1000;
const UA = { 'User-Agent': 'LANAgent/1.0 (memes)' };

/**
 * Text boxes (fractions of the picture) of the best-known templates, checked by eye against the pictures. A template
 * not listed gets top/bottom (or even bands).
 */
export const LAYOUTS = {
  181913649: [{ x: 0.53, y: 0.04, w: 0.44, h: 0.42, style: 'plain', valign: 'middle' }, { x: 0.53, y: 0.54, w: 0.44, h: 0.42, style: 'plain', valign: 'middle' }], // Drake Hotline Bling (text on white)
  87743020: [{ x: 0.1, y: 0.12, w: 0.3, h: 0.1, style: 'plain', valign: 'middle' }, { x: 0.45, y: 0.08, w: 0.3, h: 0.1, style: 'plain', valign: 'middle' }, { x: 0.02, y: 0.84, w: 0.96, h: 0.15 }], // Two Buttons (labels on the white panels)
  112126428: [{ x: 0.1, y: 0.62, w: 0.32, h: 0.2 }, { x: 0.45, y: 0.4, w: 0.25, h: 0.2 }, { x: 0.7, y: 0.45, w: 0.28, h: 0.2 }], // Distracted Boyfriend
  124822590: [{ x: 0.2, y: 0.08, w: 0.27, h: 0.22 }, { x: 0.5, y: 0.08, w: 0.3, h: 0.22 }, { x: 0.35, y: 0.75, w: 0.4, h: 0.2 }], // Left Exit 12 Off Ramp
  129242436: [{ x: 0.02, y: 0.02, w: 0.96, h: 0.2 }, { x: 0.33, y: 0.6, w: 0.5, h: 0.22, style: 'plain', valign: 'middle' }], // Change My Mind (the sign)
  188390779: [{ x: 0.02, y: 0.02, w: 0.46, h: 0.3 }, { x: 0.52, y: 0.02, w: 0.46, h: 0.3 }], // Woman Yelling At Cat
  438680: [{ x: 0.03, y: 0.02, w: 0.44, h: 0.17, style: 'plain', valign: 'middle' }, { x: 0.53, y: 0.02, w: 0.44, h: 0.17, style: 'plain', valign: 'middle' }], // Batman Slapping Robin (speech bubbles)
  131940431: [{ x: 0.28, y: 0.12, w: 0.19, h: 0.3, style: 'plain', valign: 'middle' }, { x: 0.795, y: 0.12, w: 0.18, h: 0.3, style: 'plain', valign: 'middle' }, { x: 0.28, y: 0.62, w: 0.19, h: 0.3, style: 'plain', valign: 'middle' }, { x: 0.795, y: 0.62, w: 0.18, h: 0.3, style: 'plain', valign: 'middle' }] // Gru's Plan (the boards)
};

/** What each box of the measured templates is, in box order: the model writes texts in this order. */
export const ROLES = {
  181913649: ['what Drake rejects', 'what Drake prefers'],
  87743020: ['left button (option A)', 'right button (option B)', 'the sweating person who must choose'],
  112126428: ['the woman in red (the new temptation)', 'the boyfriend (the subject, e.g. "me")', 'the girlfriend (what is being neglected)'],
  124822590: ['left sign: the sensible way', 'right sign: the exit taken', 'the car swerving to the exit (the subject)'],
  129242436: ['caption above', 'the statement on the sign'],
  188390779: ['the yelling woman', 'the unbothered cat'],
  438680: ['what Robin starts to say', "Batman's slap reply"],
  131940431: ['step 1 of the plan', 'step 2', 'step 3: the flaw', 'step 4: the same flaw again, realised']
};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

/** The popular templates: [{ id, name, boxes, width, height, url, source }]. Refreshed weekly. */
export async function popularTemplates({ get = axios.get } = {}) {
  const file = path.join(DIR, 'popular', 'index.json');
  const cached = await readJson(file, null);
  if (cached && Date.now() - cached.at < POPULAR_TTL) return cached.templates;
  try {
    const r = await get('https://api.imgflip.com/get_memes', { timeout: 15000, headers: UA });
    const templates = (r.data?.data?.memes || []).map(m => ({
      id: `pop:${m.id}`, name: m.name, url: m.url, width: m.width, height: m.height, boxCount: m.box_count,
      layout: LAYOUTS[m.id] ? 'known' : 'default', source: 'popular', sellable: false
    }));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ at: Date.now(), templates }));
    return templates;
  } catch (e) {
    if (cached) return cached.templates;
    throw new Error(`the popular template list is unavailable: ${e.message}`);
  }
}

const FREE_LICENSE = /^(cc0|public domain|pdm|cc0 1\.0)$/i;

/** Commons file pages as templates; only files whose licence reads CC0 or public domain. */
function fromCommons(pages) {
  return Object.values(pages || {}).map(p => {
    const ii = p.imageinfo?.[0] || {};
    const m = ii.extmetadata || {};
    const lic = String(m.LicenseShortName?.value || '').trim();
    if (!FREE_LICENSE.test(lic) || !(ii.thumburl || ii.url)) return null;
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim() || null;
    return {
      id: `free:wm-${p.pageid}`, name: p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), url: ii.thumburl || ii.url,
      width: ii.thumbwidth || ii.width, height: ii.thumbheight || ii.height, boxCount: 2, layout: 'default', source: 'free', sellable: true,
      license: { name: lic, url: m.LicenseUrl?.value || null, author: strip(m.Artist?.value), page: ii.descriptionurl }
    };
  }).filter(Boolean);
}

const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_INFO = { prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: 1200, format: 'json' };

/**
 * Public-domain and CC0 pictures for `query`: Wikimedia Commons first (files tagged CC0 or public domain, checked again
 * against each file's licence), then Openverse. Openverse alone was too slow and flaky for a paid call (504s and 45 s
 * answers on 2026-11-09).
 */
export async function freeTemplates(query, { limit = 10, get = axios.get } = {}) {
  const n = Math.min(limit, 20);
  try {
    const r = await get(COMMONS, { params: { action: 'query', generator: 'search', gsrnamespace: 6, gsrlimit: Math.min(n * 2, 40),
      gsrsearch: `${query} haswbstatement:P275=Q6938433|P6216=Q19652 filetype:bitmap`, ...COMMONS_INFO }, timeout: 15000, headers: UA });
    const found = fromCommons(r.data?.query?.pages).slice(0, n);
    if (found.length) return found;
  } catch {}
  const r = await get('https://api.openverse.org/v1/images/', {
    params: { q: query, license: 'cc0,pdm', page_size: n, mature: false }, timeout: 25000, headers: UA
  });
  return (r.data?.results || []).map(p => ({
    id: `free:${p.id}`, name: p.title || query, url: p.url, width: p.width, height: p.height, boxCount: 2, layout: 'default',
    source: 'free', sellable: true,
    license: { name: String(p.license || '').toUpperCase(), version: p.license_version || null, url: p.license_url, author: p.creator || null, page: p.foreign_landing_url }
  }));
}

/** One free picture by id (free:wm-<pageid> or free:<openverse id>), licence checked; null if not free. */
export async function freeById(id, { get = axios.get } = {}) {
  const kept = (await keptFree()).find(t => t.id === id);
  if (kept) return kept;
  const ref = id.slice(5);
  if (ref.startsWith('wm-')) {
    const r = await get(COMMONS, { params: { action: 'query', pageids: ref.slice(3), ...COMMONS_INFO }, timeout: 15000, headers: UA });
    return fromCommons(r.data?.query?.pages)[0] || null;
  }
  const r = await get(`https://api.openverse.org/v1/images/${encodeURIComponent(ref)}/`, { timeout: 20000, headers: UA });
  const p = r.data;
  if (!/^(cc0|pdm)$/i.test(p?.license || '')) return null;
  return { id, name: p.title, url: p.url, source: 'free', sellable: true,
    license: { name: String(p.license).toUpperCase(), version: p.license_version, url: p.license_url, author: p.creator, page: p.foreign_landing_url } };
}

/** Words of a name, for matching "drake" or "distracted boyfriend". */
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);

/** The popular template best matching `name`, or null. */
export async function findPopular(name, opts) {
  const list = await popularTemplates(opts);
  const q = words(name);
  if (!q.length) return null;
  let best = null, score = 0;
  for (const t of list) {
    const n = words(t.name);
    const s = q.filter(w => n.includes(w)).length / Math.max(q.length, 1) + (t.name.toLowerCase() === String(name).toLowerCase() ? 1 : 0);
    if (s > score) { score = s; best = t; }
  }
  return score >= 0.5 ? best : null;
}

/** The text boxes of a template for `count` texts. */
export function boxesFor(template, count) {
  const known = template?.id?.startsWith('pop:') ? LAYOUTS[template.id.slice(4)] : null;
  if (known && count <= known.length) return known.slice(0, count);
  return null;
}

/** The picture of a template, fetched once and kept. */
export async function templateImage(template, { get = axios.get } = {}) {
  const sub = template.source === 'free' ? 'free' : 'popular';
  const ext = (path.extname(new URL(template.url).pathname) || '.jpg').slice(0, 5);
  const file = path.join(DIR, sub, `${template.id.split(':')[1].replace(/[^a-zA-Z0-9-]/g, '')}${ext}`);
  try { return await fs.readFile(file); } catch {}
  const r = await get(template.url, { responseType: 'arraybuffer', timeout: 25000, maxContentLength: 15 * 1024 * 1024, headers: UA });
  const buf = Buffer.from(r.data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  if (template.source === 'free') {
    const idx = path.join(DIR, 'free', 'index.json');
    const all = await readJson(idx, {});
    all[template.id] = { ...template, file: path.basename(file), savedAt: new Date().toISOString() };
    await fs.writeFile(idx, JSON.stringify(all, null, 1));
  }
  return buf;
}

/** Free pictures already kept, with their licences. */
export async function keptFree() {
  return Object.values(await readJson(path.join(DIR, 'free', 'index.json'), {}));
}
