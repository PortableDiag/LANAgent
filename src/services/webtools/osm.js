import axios from 'axios';
import NodeCache from 'node-cache';

/**
 * OpenStreetMap services, all keyless:
 *   Nominatim   — place search and reverse geocoding (usage policy: at most 1 request/second,
 *                 an identifying User-Agent, cache results — all three are enforced here)
 *   OSRM (FOSSGIS routing.openstreetmap.de) — car, bike and foot routes
 *   Overpass    — nearby places by OSM tag, with a mirror for when the main server is busy
 *   Open-Meteo  — the time zone of a coordinate
 */

const UA = `LANAgent/${process.env.npm_package_version || '2'} (+https://lanagent.net)`;
const cache = new NodeCache({ stdTTL: 24 * 3600, maxKeys: 2000 });
const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v = await fn();
  try { cache.set(key, v); } catch { cache.flushAll(); }
  return v;
};

let nominatimChain = Promise.resolve();
let lastNominatim = 0;
/** Serialise Nominatim calls at least 1.1 s apart, process-wide. */
function nominatim(path, params) {
  const run = async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    const res = await axios.get(`https://nominatim.openstreetmap.org/${path}`, {
      params: { format: 'jsonv2', ...params },
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      timeout: 15000
    });
    return res.data;
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.catch(() => {});
  return p;
}

const place = r => ({
  name: r.name || r.display_name?.split(',')[0] || '',
  address: r.display_name,
  lat: Number(r.lat), lon: Number(r.lon),
  type: [r.category, r.type].filter(Boolean).join('/'),
  osm: r.osm_type && r.osm_id ? `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}` : null
});

export async function geocode(query, { limit = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('a place or address is required');
  const rows = await cached(`geo:${q}:${limit}`, () => nominatim('search', { q, limit: Math.min(Number(limit) || 3, 10), addressdetails: 0 }));
  return rows.map(place);
}

export async function reverse(lat, lon) {
  const [la, lo] = coords(lat, lon);
  const r = await cached(`rev:${la.toFixed(5)},${lo.toFixed(5)}`, () => nominatim('reverse', { lat: la, lon: lo, zoom: 18 }));
  if (!r || r.error) throw new Error(r?.error || 'nothing at that location');
  return place(r);
}

export function coords(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw new Error('latitude/longitude are not valid coordinates');
  return [la, lo];
}

/** "48.85,2.29" or a place name → { lat, lon, name } */
export async function resolvePoint(v) {
  if (v && typeof v === 'object' && v.lat != null) { const [lat, lon] = coords(v.lat, v.lon ?? v.lng); return { lat, lon, name: v.name || `${lat},${lon}` }; }
  const m = String(v || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) { const [lat, lon] = coords(m[1], m[2]); return { lat, lon, name: `${lat},${lon}` }; }
  const [hit] = await geocode(v, { limit: 1 });
  if (!hit) throw new Error(`could not find "${v}"`);
  return { lat: hit.lat, lon: hit.lon, name: hit.address };
}

const PROFILES = { car: 'routed-car', drive: 'routed-car', driving: 'routed-car', bike: 'routed-bike', bicycle: 'routed-bike', cycling: 'routed-bike', foot: 'routed-foot', walk: 'routed-foot', walking: 'routed-foot' };

export async function route(from, to, { mode = 'car', steps = true } = {}) {
  const profile = PROFILES[String(mode).toLowerCase()] || 'routed-car';
  const [a, b] = [await resolvePoint(from), await resolvePoint(to)];
  const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}`;
  const res = await axios.get(url, { params: { overview: 'false', steps: steps ? 'true' : 'false' }, headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: () => true });
  if (res.data?.code !== 'Ok' || !res.data.routes?.length) throw new Error(`no route found (${res.data?.code || `HTTP ${res.status}`})`);
  const r = res.data.routes[0];
  // Unnamed short steps (footpath jogs, car-park exits) are noise in written directions.
  const directions = steps ? r.legs.flatMap(l => l.steps)
    .filter(s => ['depart', 'arrive'].includes(s.maneuver?.type) || s.name || s.ref || s.distance >= 150)
    .map(describeStep).filter(Boolean).slice(0, 60) : [];
  return { from: a, to: b, mode: profile.replace('routed-', ''), distanceKm: +(r.distance / 1000).toFixed(2), durationMin: Math.round(r.duration / 60), directions };
}

function describeStep(s) {
  const m = s.maneuver || {};
  const road = s.name || s.ref || '';
  const dist = s.distance >= 1000 ? `${(s.distance / 1000).toFixed(1)} km` : `${Math.round(s.distance)} m`;
  if (m.type === 'depart') return `Start${road ? ` on ${road}` : ''} (${dist})`;
  if (m.type === 'arrive') return 'Arrive';
  const turn = [m.type === 'turn' || m.type === 'end of road' ? 'Turn' : m.type === 'roundabout' || m.type === 'rotary' ? `At the roundabout take exit ${m.exit || ''}`.trim() : m.type === 'merge' ? 'Merge' : m.type === 'fork' ? 'Keep' : m.type === 'on ramp' ? 'Take the ramp' : m.type === 'off ramp' ? 'Exit' : 'Continue',
    m.type === 'roundabout' || m.type === 'rotary' ? '' : m.modifier || ''].filter(Boolean).join(' ');
  return `${turn}${road ? ` onto ${road}` : ''} (${dist})`;
}

export async function timezone(lat, lon) {
  const [la, lo] = coords(lat, lon);
  const d = await cached(`tz:${la.toFixed(2)},${lo.toFixed(2)}`, async () => (await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: { latitude: la, longitude: lo, timezone: 'auto', forecast_days: 1 }, timeout: 15000 })).data);
  const tz = d.timezone;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  const off = d.utc_offset_seconds / 3600;
  return { timezone: tz, utcOffset: `UTC${off >= 0 ? '+' : ''}${Number.isInteger(off) ? off : off.toFixed(1)}`, localTime: local };
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
// Words people use → OSM tags
const CATEGORY = {
  cafe: 'amenity=cafe', coffee: 'amenity=cafe', restaurant: 'amenity=restaurant', bar: 'amenity=bar', pub: 'amenity=pub',
  pharmacy: 'amenity=pharmacy', hospital: 'amenity=hospital', atm: 'amenity=atm', bank: 'amenity=bank', fuel: 'amenity=fuel',
  gas: 'amenity=fuel', 'gas station': 'amenity=fuel', parking: 'amenity=parking', toilets: 'amenity=toilets', school: 'amenity=school',
  library: 'amenity=library', 'fast food': 'amenity=fast_food', police: 'amenity=police', 'post office': 'amenity=post_office',
  'charging station': 'amenity=charging_station', ev: 'amenity=charging_station', supermarket: 'shop=supermarket',
  grocery: 'shop=supermarket', bakery: 'shop=bakery', hotel: 'tourism=hotel', museum: 'tourism=museum', park: 'leisure=park',
  gym: 'leisure=fitness_centre', playground: 'leisure=playground', 'hardware store': 'shop=hardware', convenience: 'shop=convenience'
};

export function categoryTag(what) {
  const w = String(what || '').toLowerCase().trim().replace(/s$/, '');
  if (/^[a-z_]+=[\w:.-]+$/.test(w)) return w;
  return CATEGORY[w] || CATEGORY[`${w}s`] || null;
}

export async function nearby(near, what, { radius = 1000, limit = 10 } = {}) {
  const tag = categoryTag(what);
  if (!tag) throw new Error(`don't know what "${what}" is on the map; try one of: ${Object.keys(CATEGORY).slice(0, 20).join(', ')} — or an OSM tag like amenity=cafe`);
  const p = await resolvePoint(near);
  const [k, v] = tag.split('=');
  const r = Math.max(50, Math.min(Number(radius) || 1000, 10000));
  const q = `[out:json][timeout:20];nwr(around:${r},${p.lat},${p.lon})["${k}"="${v}"];out center ${Math.min(Number(limit) || 10, 50) * 3};`;
  let data, lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await axios.get(url, { params: { data: q }, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000, validateStatus: () => true });
      if (res.status === 200 && Array.isArray(res.data?.elements)) { data = res.data; break; }
      lastErr = `HTTP ${res.status}${typeof res.data === 'string' && /too busy|timeout/i.test(res.data) ? ' (server busy)' : ''}`;
    } catch (e) { lastErr = e.message; }
  }
  if (!data) return nearbyViaNominatim(p, what, v, r, limit, lastErr);
  const out = data.elements.map(e => {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    return { name: e.tags?.name || `(unnamed ${v})`, lat, lon, distanceM: Math.round(haversine(p.lat, p.lon, lat, lon)),
      address: [e.tags?.['addr:housenumber'], e.tags?.['addr:street'], e.tags?.['addr:city']].filter(Boolean).join(' ') || null,
      openingHours: e.tags?.opening_hours || null, website: e.tags?.website || e.tags?.['contact:website'] || null,
      phone: e.tags?.phone || e.tags?.['contact:phone'] || null };
  }).filter(e => e.lat != null).sort((a, b) => a.distanceM - b.distanceM);
  // prefer named places, then fill with unnamed ones
  const named = out.filter(e => !e.name.startsWith('(unnamed'));
  return { near: p, category: tag, radiusM: r, places: [...named, ...out.filter(e => e.name.startsWith('(unnamed'))].slice(0, Math.min(Number(limit) || 10, 50)) };
}

/**
 * Overpass is often busy (20-30 s timeouts seen 2026-09-26). Nominatim's bounded search finds
 * the same kind of place by name ("cafe", "pharmacy") inside a box around the point: fewer
 * details, but an answer.
 */
async function nearbyViaNominatim(p, what, tagValue, r, limit, overpassErr) {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos((p.lat * Math.PI) / 180));
  const rows = await nominatim('search', {
    q: String(what).trim() || tagValue.replace(/_/g, ' '), limit: Math.min(Number(limit) || 10, 40), bounded: 1,
    viewbox: `${p.lon - dLon},${p.lat + dLat},${p.lon + dLon},${p.lat - dLat}`
  });
  const places = rows.map(place).map(x => ({ name: x.name || `(unnamed ${tagValue})`, lat: x.lat, lon: x.lon,
    distanceM: Math.round(haversine(p.lat, p.lon, x.lat, x.lon)), address: x.address, openingHours: null, website: null, phone: null }))
    .filter(x => x.distanceM <= r * 1.5).sort((a, b) => a.distanceM - b.distanceM);
  return { near: p, category: tagValue, radiusM: r, places, source: 'nominatim', note: `Overpass unavailable (${overpassErr})` };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = d => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
