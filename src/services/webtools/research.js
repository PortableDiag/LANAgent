import axios from 'axios';
import NodeCache from 'node-cache';
import { parseStringPromise } from 'xml2js';
import { readFeed } from './feedReader.js';

/**
 * Papers and discussions, keyless.
 *
 * arXiv: the export API (export.arxiv.org/api/query) asks for one request per 3 seconds and,
 * as of 2026-09-26, answered this agent's addresses with 406/429 more often than not. So:
 * API first, paced; on refusal, OpenAlex restricted to the arXiv source (S4306400194), which
 * indexes the same papers. "Latest in a category" uses arXiv's RSS, which is not throttled.
 *
 * Reddit: the .json endpoints answer 403 to unauthenticated servers (checked from the dev box
 * and ALICE, 2026-09-26); the RSS endpoints answer 200, so Reddit is read through them.
 */

const UA = `LANAgent/${process.env.npm_package_version || '2'} (+https://lanagent.net)`;
const cache = new NodeCache({ stdTTL: 1800, maxKeys: 500 });
const ARXIV_SOURCE = 'S4306400194';

let lastArxiv = 0;
async function arxivApi(params) {
  const wait = lastArxiv + 3100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastArxiv = Date.now();
  const res = await axios.get('https://export.arxiv.org/api/query', { params, headers: { 'User-Agent': UA }, timeout: 25000, validateStatus: () => true, responseType: 'text' });
  if (res.status !== 200) throw new Error(`arXiv API HTTP ${res.status}`);
  return parseArxivAtom(res.data);
}

const t = v => (v == null ? '' : typeof v === 'string' ? v : v._ || '').replace(/\s+/g, ' ').trim();
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

export async function parseArxivAtom(xml) {
  const doc = await parseStringPromise(String(xml), { explicitArray: false });
  return arr(doc?.feed?.entry).filter(e => e?.id).map(e => {
    const absUrl = t(e.id);
    const id = absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
    const links = arr(e.link).map(l => l.$ || {});
    return {
      id, title: t(e.title), summary: t(e.summary),
      authors: arr(e.author).map(a => t(a.name)).filter(Boolean),
      published: t(e.published).slice(0, 10), updated: t(e.updated).slice(0, 10),
      categories: arr(e.category).map(c => c.$?.term).filter(Boolean),
      url: absUrl, pdf: links.find(l => l.title === 'pdf')?.href || `https://arxiv.org/pdf/${id}`,
      source: 'arxiv'
    };
  });
}

function openAlexAbstract(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.join(' ');
}

function fromOpenAlex(w) {
  const arxivLoc = (w.locations || []).find(l => /arxiv\.org\/abs\//.test(l.landing_page_url || ''));
  const id = arxivLoc ? arxivLoc.landing_page_url.split('/abs/')[1] : (w.doi || '').split('arxiv.')[1] || '';
  return {
    id, title: w.title || w.display_name || '', summary: openAlexAbstract(w.abstract_inverted_index),
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
    published: w.publication_date || '', updated: '', categories: [],
    url: id ? `https://arxiv.org/abs/${id}` : (w.doi || w.id), pdf: id ? `https://arxiv.org/pdf/${id}` : null,
    citedBy: w.cited_by_count ?? null, source: 'openalex'
  };
}

async function openAlex(params) {
  const res = await axios.get('https://api.openalex.org/works', { params, headers: { 'User-Agent': UA }, timeout: 25000, validateStatus: () => true });
  if (res.status === 429) throw new Error(`OpenAlex is rate-limiting anonymous search too${res.data?.retryAfter ? ` (retry in ${res.data.retryAfter}s)` : ''}`);
  if (res.status !== 200) throw new Error(`OpenAlex HTTP ${res.status}`);
  return (res.data?.results || []).map(fromOpenAlex);
}

export async function searchArxiv(query, { max = 10, sort = 'relevance', category } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('a search query is required');
  const n = Math.max(1, Math.min(Number(max) || 10, 50));
  const byDate = /date|new|recent|latest/i.test(String(sort));
  const key = `ax:${q}:${n}:${byDate}:${category || ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result;
  try {
    const terms = q.split(/\s+/).map(w => `all:${w.replace(/[^\w.-]/g, '')}`).filter(w => w !== 'all:').join(' AND ');
    const search_query = category ? `(${terms}) AND cat:${category}` : terms;
    const papers = await arxivApi({ search_query, start: 0, max_results: n, sortBy: byDate ? 'submittedDate' : 'relevance', sortOrder: 'descending' });
    result = { source: 'arxiv', papers };
  } catch (err) {
    // "Recent" keeps relevance ranking inside the last year: sorting OpenAlex by date alone
    // returns whatever arXiv item was touched last, relevant or not (seen 2026-09-26).
    const since = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
    // title_and_abstract.search ranks far better than the `search` parameter, which matched
    // full texts and put a mis-attributed 2018 record first for "llm agents tool use". It is
    // a filter, so the characters that separate filters are removed from the words.
    const words = q.replace(/[,|:!]/g, ' ').replace(/\s+/g, ' ').trim();
    const filter = `locations.source.id:${ARXIV_SOURCE},title_and_abstract.search:${words}${byDate ? `,from_publication_date:${since}` : ''}`;
    const papers = await openAlex({ filter, 'per-page': n }).catch(e => { throw new Error(`arXiv's API refused (${err.message}) and ${e.message}`); });
    result = { source: 'openalex', note: `arXiv's API refused (${err.message}); results from OpenAlex's index of arXiv`, papers };
  }
  try { cache.set(key, result); } catch { cache.flushAll(); }
  return result;
}

export async function getArxivPaper(idOrUrl) {
  const id = String(idOrUrl || '').trim().replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//, '').replace(/\.pdf$/, '').replace(/^arxiv:/i, '');
  if (!/^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i.test(id)) throw new Error(`"${idOrUrl}" is not an arXiv id (like 2305.14314)`);
  try {
    const [paper] = await arxivApi({ id_list: id });
    if (paper) return paper;
  } catch { /* fall through to OpenAlex */ }
  const res = await axios.get(`https://api.openalex.org/works/doi:10.48550/arXiv.${id.replace(/v\d+$/, '')}`, { headers: { 'User-Agent': UA }, timeout: 25000, validateStatus: () => true });
  if (res.status !== 200) throw new Error(`arXiv paper ${id} not found`);
  return fromOpenAlex(res.data);
}

/** Newest papers announced in an arXiv category (cs.AI, math.CO, …). */
export async function latestArxiv(category = 'cs.AI', { max = 15 } = {}) {
  const cat = String(category).trim();
  if (!/^[a-z-]+(\.[A-Za-z-]+)?$/.test(cat)) throw new Error(`"${category}" is not an arXiv category like cs.AI`);
  const n = Math.min(Number(max) || 15, 100);
  const feed = await readFeed(`https://rss.arxiv.org/rss/${cat}`, { limit: n });
  // The RSS carries only the latest announcement and is empty on days arXiv does not announce
  // (weekends, holidays): fall back to the newest submissions in the category.
  if (!feed.items.length) {
    const papers = await arxivApi({ search_query: `cat:${cat}`, start: 0, max_results: n, sortBy: 'submittedDate', sortOrder: 'descending' })
      .catch(err => { throw new Error(`arXiv announced nothing in ${cat} today (it does not announce on weekends) and its API refused a fallback query (${err.message})`); });
    return papers.map(x => ({ id: x.id, title: x.title, url: x.url, summary: x.summary, published: x.published }));
  }
  return feed.items.map(i => ({
    id: (i.link || '').split('/abs/')[1] || i.id, title: i.title, url: i.link,
    summary: i.summary.replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*Abstract:\s*/i, ''), published: i.published?.slice(0, 10) || ''
  }));
}

// ── Reddit ────────────────────────────────────────────────────────────────

const SUB = /^[A-Za-z0-9_]{2,21}$/;

// Reddit answers a quick second request with 429: space calls and retry a 429 once.
let lastReddit = 0;
async function readReddit(url, limit) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastReddit + 2000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastReddit = Date.now();
    try {
      return await readFeed(url, { limit });
    } catch (err) {
      if (attempt || !/HTTP 429/.test(err.message)) throw /HTTP 429/.test(err.message) ? new Error('Reddit is rate-limiting this agent; try again in a minute') : err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

export async function redditPosts(subreddit, { sort = 'hot', time = 'week', limit = 15 } = {}) {
  const sub = String(subreddit || '').replace(/^\/?r\//i, '').trim();
  if (!SUB.test(sub)) throw new Error(`"${subreddit}" is not a subreddit name`);
  const s = ['hot', 'new', 'top', 'rising'].includes(String(sort).toLowerCase()) ? String(sort).toLowerCase() : 'hot';
  const tq = s === 'top' ? `?t=${['hour', 'day', 'week', 'month', 'year', 'all'].includes(time) ? time : 'week'}` : '';
  const feed = await readReddit(`https://www.reddit.com/r/${sub}/${s}/.rss${tq}`, Math.min(Number(limit) || 15, 50));
  return feed.items.map(redditItem);
}

export async function redditSearch(query, { subreddit, sort = 'relevance', limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('a search query is required');
  const sub = subreddit ? String(subreddit).replace(/^\/?r\//i, '') : null;
  if (sub && !SUB.test(sub)) throw new Error(`"${subreddit}" is not a subreddit name`);
  const s = ['relevance', 'new', 'top', 'comments'].includes(sort) ? sort : 'relevance';
  const base = sub ? `https://www.reddit.com/r/${sub}/search.rss?restrict_sr=1&` : 'https://www.reddit.com/search.rss?';
  const feed = await readReddit(`${base}q=${encodeURIComponent(q)}&sort=${s}`, Math.min(Number(limit) || 15, 50));
  return feed.items.map(redditItem);
}

/** A post and its top comments (the thread's RSS lists the post first, then comments). */
export async function redditThread(url, { limit = 20 } = {}) {
  const m = String(url || '').match(/reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([a-z0-9]+)/i) || String(url || '').match(/redd\.it\/([a-z0-9]+)/i);
  if (!m) throw new Error('a reddit post link is required (…/r/<sub>/comments/<id>/…)');
  const feedUrl = m.length === 3 ? `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/.rss` : `https://www.reddit.com/comments/${m[1]}/.rss`;
  const feed = await readReddit(feedUrl, Math.min(Number(limit) || 20, 100));
  const [post, ...comments] = feed.items;
  return { post: post ? redditItem(post) : null, comments: comments.map(c => ({ text: c.summary, link: c.link, published: c.published })) };
}

function redditItem(i) {
  const m = (i.link || '').match(/\/r\/([^/]+)\//);
  return { title: i.title, link: i.link, subreddit: m ? m[1] : null, published: i.published, text: i.summary.replace(/\s*submitted by\s+\/u\/\S+.*$/i, '').trim() };
}
