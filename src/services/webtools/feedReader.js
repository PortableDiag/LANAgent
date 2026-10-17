import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import { fetchPublic } from './fetchPublic.js';

/**
 * RSS 2.0, Atom and RSS 1.0 (RDF) feeds, parsed with xml2js (already a dependency).
 * Items are normalised to { id, title, link, published, summary }; `id` is what the
 * watcher remembers to tell new items from old, so it prefers the feed's own guid.
 */

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = v => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return text(v._ ?? v['#text'] ?? '');
  return String(v);
};
const clean = (s, max = 400) => {
  const t = cheerio.load(`<div>${String(s || '')}</div>`)('div').text().replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const isoDate = v => {
  const d = new Date(text(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function atomLink(links) {
  // lenient (non-strict) parsing upper-cases attribute names: read them case-blind
  const lower = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const all = arr(links).map(l => (typeof l === 'string' ? { href: l } : lower(l?.$)));
  const alt = all.find(l => !l.rel || l.rel === 'alternate') || all[0];
  return alt?.href || '';
}

/** Parse feed XML. Throws when the document is not a feed. */
export async function parseFeed(xml, baseUrl = '') {
  let doc;
  try {
    doc = await parseStringPromise(String(xml), { explicitArray: false, trim: true, strict: false, normalizeTags: true });
  } catch (e) {
    throw new Error(`not a readable feed (${e.message.split('\n')[0]})`);
  }
  const abs = href => { try { return href ? new URL(href, baseUrl || undefined).toString() : ''; } catch { return href || ''; } };

  if (doc?.rss?.channel || doc?.['rdf:rdf']) {
    const channel = doc.rss?.channel || doc['rdf:rdf'].channel || {};
    const items = arr(doc.rss?.channel?.item ?? doc['rdf:rdf']?.item).map(it => {
      const link = abs(text(it.link));
      const guid = text(it.guid);
      return {
        id: guid || link || `${text(it.title)}|${text(it.pubdate)}`,
        title: clean(text(it.title), 300) || '(untitled)',
        link,
        published: isoDate(it.pubdate ?? it['dc:date']),
        summary: clean(text(it['content:encoded']) || text(it.description))
      };
    });
    return { format: doc.rss ? 'rss' : 'rdf', title: clean(text(channel.title), 200), link: abs(text(channel.link)), items };
  }

  if (doc?.feed) {
    const f = doc.feed;
    const items = arr(f.entry).map(e => {
      const link = abs(atomLink(e.link));
      return {
        id: text(e.id) || link || `${text(e.title)}|${text(e.updated)}`,
        title: clean(text(e.title), 300) || '(untitled)',
        link,
        published: isoDate(e.published ?? e.updated),
        summary: clean(text(e.summary) || text(e.content))
      };
    });
    return { format: 'atom', title: clean(text(f.title), 200), link: abs(atomLink(f.link)), items };
  }

  throw new Error('not a feed (no RSS channel or Atom feed element)');
}

/**
 * Fetch and parse a feed URL, optionally as a conditional GET.
 *
 * @param {string} url - Feed URL.
 * @param {Object} [opts]
 * @param {number} [opts.limit=20] - Max items to return (1..100).
 * @param {{etag?: string, lastModified?: string}} [opts.previousHeaders] - Validators from an
 *   earlier read's `headers`. When given, they are sent as If-None-Match / If-Modified-Since;
 *   a 304 then returns `{ notModified: true, items: [], url, headers }` — the caller already
 *   holds what it read last time (the web watcher keeps its seen ids), so nothing is
 *   re-downloaded or re-parsed. Pass them back exactly as returned: an ETag is an opaque
 *   quoted string (W/"…" for weak ones) and a server only matches it verbatim.
 * @param {Function} [opts.fetch] - Fetch implementation (tests); defaults to fetchPublic.
 * @returns {Promise<Object>} Parsed feed plus `headers: { etag?, lastModified? }`.
 */
export async function readFeed(url, { limit = 20, previousHeaders = null, fetch = fetchPublic } = {}) {
  const headers = { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
  if (previousHeaders?.etag) headers['If-None-Match'] = previousHeaders.etag;
  if (previousHeaders?.lastModified) headers['If-Modified-Since'] = previousHeaders.lastModified;
  const conditional = Boolean(headers['If-None-Match'] || headers['If-Modified-Since']);

  const res = await fetch(url, { headers });
  if (res.status === 304 && conditional) {
    // A 304 may omit the validators; keep the ones we sent so the next check still asks.
    const fresh = extractConditionalHeaders(res.headers);
    return {
      notModified: true,
      url: res.url,
      items: [],
      headers: { ...pickValidators(previousHeaders), ...fresh }
    };
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}`);
  const feed = await parseFeed(res.data, res.url);
  return {
    ...feed,
    url: res.url,
    items: feed.items.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))),
    headers: extractConditionalHeaders(res.headers)
  };
}

/**
 * Feeds a web page advertises (<link rel="alternate" type="application/rss+xml">), plus the
 * usual paths when it advertises none. A URL that already is a feed is returned as itself.
 */
export async function discoverFeeds(pageUrl) {
  const res = await fetchPublic(pageUrl);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${pageUrl}`);
  const body = String(res.data || '');
  if (/^\s*(<\?xml[^>]*>\s*)?<(rss|feed|rdf:RDF)\b/i.test(body)) {
    const feed = await parseFeed(body, res.url);
    return [{ url: res.url, title: feed.title, format: feed.format }];
  }
  const $ = cheerio.load(body);
  const found = [];
  $('link[rel~="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!/rss|atom|rdf|feed\+json/.test(type)) return;
    try { found.push({ url: new URL($(el).attr('href'), res.url).toString(), title: $(el).attr('title') || '', format: type }); } catch { /* bad href */ }
  });
  if (found.length) return dedupe(found);

  for (const guess of ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/blog/feed']) {
    const candidate = new URL(guess, res.url).toString();
    try {
      const feed = await readFeed(candidate, { limit: 1 });
      found.push({ url: feed.url, title: feed.title, format: feed.format });
      break;
    } catch { /* not there */ }
  }
  return found;
}

/**
 * ETag and Last-Modified from a response's headers (axios lower-cases names), kept verbatim
 * for the next call's `previousHeaders`.
 */
function extractConditionalHeaders(resHeaders = {}) {
  const out = {};
  const etag = resHeaders.etag ?? resHeaders.ETag;
  if (etag) out.etag = String(etag);
  const lastModified = resHeaders['last-modified'] ?? resHeaders['Last-Modified'];
  if (lastModified) out.lastModified = String(lastModified);
  return out;
}

function pickValidators(h) {
  const out = {};
  if (h?.etag) out.etag = h.etag;
  if (h?.lastModified) out.lastModified = h.lastModified;
  return out;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(f => (seen.has(f.url) ? false : seen.add(f.url)));
}
