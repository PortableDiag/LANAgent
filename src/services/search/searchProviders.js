/**
 * Direct search-API backends — ranked results with no LLM in the loop.
 *
 * Why this exists: `options.enableWebSearch` is a tool call only the Anthropic
 * and OpenAI providers implement, so under an AI provider lock pinned anywhere
 * else the agent has no web search at all. These backends are
 * plain HTTP against a search API, so the provider lock is irrelevant to them —
 * there is no model involved and therefore no spend to pin.
 *
 * Backends are deliberately behind one normalised interface because they churn:
 * Bing's API retired, Google's CSE is crippled, terms shift. The interface is
 * the durable part; a backend is a config change.
 *
 * Every backend exposes:
 *   name            — stable id used in env vars, logs and the `provider` field
 *   isConfigured()  — false when its credentials are absent (never throws)
 *   search(q, opts) — resolves { provider, results: [{title,url,snippet}], tookMs }
 *
 * Contracts below were verified live from the deployment host on 2026-08-31 by
 * probing each endpoint without credentials; the request shape and auth scheme
 * are confirmed, the result *shape* is from each vendor's documented response
 * and is normalised defensively because it has not been seen with a live key.
 */
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import * as cheerio from 'cheerio';
import { logger } from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_COUNT = 10;

/**
 * Brave Search API.
 *
 * Verified 2026-08-31: `GET https://api.search.brave.com/res/v1/web/search?q=`
 * with header `X-Subscription-Token`. Missing header → HTTP 422 naming
 * `header.x-subscription-token` as required; bad key → HTTP 422 with
 * `code: SUBSCRIPTION_TOKEN_INVALID`, `meta.component: authentication`.
 * Note both are 422, NOT 401 — do not treat a 401 as the auth failure case.
 */
class BraveSearchProvider {
  constructor(env = process.env) {
    this.name = 'brave';
    this.apiKey = env.BRAVE_SEARCH_API_KEY || null;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async search(query, opts = {}) {
    const started = Date.now();
    const count = Math.min(Math.max(parseInt(opts.count, 10) || DEFAULT_COUNT, 1), 20);

    const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count },
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      // Read the body on an error status so the caller gets Brave's reason
      // instead of a bare "Request failed with status code 422".
      validateStatus: () => true
    });

    if (res.status !== 200) {
      throw new Error(`brave: HTTP ${res.status} ${describeBraveError(res.data)}`);
    }

    const results = (res.data?.web?.results || []).map(r => ({
      title: stripTags(r.title),
      url: r.url,
      snippet: stripTags(r.description)
    })).filter(r => r.url);

    return { provider: this.name, results, tookMs: Date.now() - started };
  }
}

/**
 * Yandex Cloud Search API v2.
 *
 * Verified 2026-08-31: `POST https://searchapi.api.cloud.yandex.net/v2/web/search`,
 * body `{query:{searchType,queryText}, folderId}`, auth
 * `Authorization: Api-Key <key>` (an IAM `Bearer <token>` is also accepted).
 * The service validates the BODY BEFORE auth — an empty body returns
 * "query: Field is required" even with a key present — so a validation error
 * does not mean the credentials are wrong.
 *
 * NOT the legacy `yandex.com/search/xml` endpoint: that authenticates by
 * REGISTERED IP, which cannot be kept current on a host whose egress IP changes
 * (e.g. behind a rotating VPN exit).
 *
 * The synchronous endpoint answers with the result document base64-encoded in
 * `rawData`, hence the decode + XML parse below.
 */
class YandexSearchProvider {
  constructor(env = process.env) {
    this.name = 'yandex';
    this.apiKey = env.YANDEX_SEARCH_API_KEY || null;
    this.folderId = env.YANDEX_SEARCH_FOLDER_ID || null;
    // SEARCH_TYPE_COM = yandex.com (international). _RU/_TR are the alternatives.
    this.searchType = env.YANDEX_SEARCH_TYPE || 'SEARCH_TYPE_COM';
  }

  isConfigured() {
    return Boolean(this.apiKey && this.folderId);
  }

  async search(query, opts = {}) {
    const started = Date.now();

    const res = await axios.post(
      'https://searchapi.api.cloud.yandex.net/v2/web/search',
      {
        query: { searchType: this.searchType, queryText: query },
        folderId: this.folderId
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${this.apiKey}` },
        timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        validateStatus: () => true
      }
    );

    if (res.status !== 200) {
      throw new Error(`yandex: HTTP ${res.status} ${res.data?.message || ''}`.trim());
    }

    const raw = res.data?.rawData;
    if (!raw) {
      throw new Error('yandex: response carried no rawData');
    }

    const xml = Buffer.from(raw, 'base64').toString('utf-8');
    const count = Math.min(Math.max(parseInt(opts.count, 10) || DEFAULT_COUNT, 1), 20);
    const results = await parseYandexXml(xml, count);
    return { provider: this.name, results, tookMs: Date.now() - started };
  }
}

/**
 * SearXNG — a self-hosted metasearch instance (SEARXNG_URL, e.g. http://192.0.2.10:8888).
 * `GET /search?q=&format=json` answers `{ results: [{ title, url, content }] }`. The instance
 * must have `json` enabled under `search.formats` in its settings.yml, or it answers 403.
 * No key: whoever runs the instance controls it.
 */
class SearxngSearchProvider {
  constructor(env = process.env) {
    this.name = 'searxng';
    this.baseUrl = (env.SEARXNG_URL || '').replace(/\/+$/, '') || null;
  }

  isConfigured() {
    return Boolean(this.baseUrl);
  }

  async search(query, opts = {}) {
    const started = Date.now();
    const count = Math.min(Math.max(parseInt(opts.count, 10) || DEFAULT_COUNT, 1), 20);
    const res = await axios.get(`${this.baseUrl}/search`, {
      params: { q: query, format: 'json' },
      headers: { Accept: 'application/json' },
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      validateStatus: () => true
    });
    if (res.status === 403) throw new Error('searxng: HTTP 403 (enable the json format in the instance settings)');
    if (res.status !== 200) throw new Error(`searxng: HTTP ${res.status}`);
    const results = (res.data?.results || []).map(r => ({
      title: stripTags(r.title) || r.url,
      url: r.url,
      snippet: stripTags(r.content)
    })).filter(r => r.url).slice(0, count);
    return { provider: this.name, results, tookMs: Date.now() - started };
  }
}

/**
 * DuckDuckGo, keyless — the last resort so search works on an install with no search key.
 *
 * Uses the lite page (`GET https://lite.duckduckgo.com/lite/?q=`). Verified 2026-09-26 from
 * the dev box and from ALICE's VPN exit: 200 with ten `a.result-link` rows, each followed by a
 * `td.result-snippet`. The `html.duckduckgo.com` POST form answered an "anomaly" (bot) page
 * from the same box, so it is not used. Links arrive wrapped as
 * `//duckduckgo.com/l/?uddg=<encoded target>`; ads go through `/y.js` and are dropped.
 * Scraping a results page is fragile by nature: zero parsed rows on a page that is not a
 * genuine "no results" page is reported as a failure, never as an empty answer.
 */
class DuckDuckGoSearchProvider {
  constructor(env = process.env) {
    this.name = 'duckduckgo';
    // Keyless: callers try it only after every keyed backend AND the model's own search tool.
    this.keyless = true;
    this.disabled = /^(0|false|off)$/i.test(env.DUCKDUCKGO_SEARCH || '');
  }

  isConfigured() {
    return !this.disabled;
  }

  async search(query, opts = {}) {
    const started = Date.now();
    const count = Math.min(Math.max(parseInt(opts.count, 10) || DEFAULT_COUNT, 1), 20);
    const res = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q: query },
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html'
      },
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      responseType: 'text',
      validateStatus: () => true
    });
    if (res.status !== 200) throw new Error(`duckduckgo: HTTP ${res.status}`);
    const html = String(res.data || '');
    const results = parseDuckDuckGoLite(html).slice(0, count);
    if (!results.length && !/No results\.|No more results/i.test(html)) {
      throw new Error(/anomaly/i.test(html) ? 'duckduckgo: refused as automated traffic' : 'duckduckgo: could not read the results page');
    }
    return { provider: this.name, results, tookMs: Date.now() - started };
  }
}

/** Rows of the DuckDuckGo lite results page. Exported for tests. */
function parseDuckDuckGoLite(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a.result-link').each((_, a) => {
    const href = $(a).attr('href') || '';
    let url = href;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      if (u.hostname.endsWith('duckduckgo.com')) {
        if (u.pathname.startsWith('/y.js')) return; // ad
        url = u.searchParams.get('uddg') || '';
      } else {
        url = u.toString();
      }
    } catch { return; }
    if (!/^https?:\/\//i.test(url)) return;
    const snippet = $(a).closest('tr').nextAll('tr').find('td.result-snippet').first().text();
    out.push({ title: stripTags($(a).text()) || url, url, snippet: stripTags(snippet) });
  });
  return out;
}

/**
 * Pull `<doc>` entries out of a Yandex result document.
 *
 * Kept tolerant on purpose: the passage text arrives as `<passages><passage>`
 * with inline `<hlword>` highlight tags, and headline/title may be absent on
 * some docs. Anything without a URL is dropped rather than surfaced empty.
 *
 * Uses xml2js, already a project dependency — no new package.
 *
 * @param {string} xml
 * @param {number} limit
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
async function parseYandexXml(xml, limit) {
  let doc;
  try {
    // Strip the highlight tags BEFORE parsing. Yandex marks matched terms inline
    // ("Latest <hlword>release</hlword> notes"), and xml2js splits mixed content
    // into separate keys — flattening those joins them in KEY order, not document
    // order, which silently reorders the words ("Latest notes release"). Removing
    // the tags first leaves one contiguous text node and preserves the sentence.
    const flat = xml.replace(/<\/?hlword\b[^>]*>/g, '');
    // explicitArray:false keeps single children as values rather than 1-length
    // arrays; toArray() below still handles the repeated ones.
    doc = await parseStringPromise(flat, { explicitArray: false, trim: true });
  } catch (err) {
    logger.warn(`yandex: could not parse result document (${err.message})`);
    return [];
  }

  const groups = toArray(doc?.yandexsearch?.response?.results?.grouping?.group);
  const out = [];
  for (const group of groups) {
    for (const d of toArray(group?.doc)) {
      const url = typeof d?.url === 'string' ? d.url : null;
      if (!url) continue;
      out.push({
        title: stripTags(flatten(d.title)) || url,
        url,
        snippet: stripTags(flatten(d.passages?.passage ?? d.headline))
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Brave returns its reason under a couple of shapes depending on the failure. */
function describeBraveError(data) {
  const e = data?.error;
  if (!e) return '';
  if (e.code === 'SUBSCRIPTION_TOKEN_INVALID') return '(BRAVE_SEARCH_API_KEY is not valid)';
  const missing = e.meta?.errors?.some(x => (x.loc || []).includes('x-subscription-token'));
  if (missing) return '(BRAVE_SEARCH_API_KEY is not set)';
  return `(${e.code || ''} ${e.detail || ''})`.trim();
}

/** Values arrive as a string, an object with mixed text nodes, or an array. */
function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flatten).join(' ');
  if (typeof v === 'object') return Object.values(v).map(flatten).join(' ');
  return String(v);
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export { BraveSearchProvider, YandexSearchProvider, SearxngSearchProvider, DuckDuckGoSearchProvider,
  parseYandexXml, parseDuckDuckGoLite, stripTags };
