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

export { BraveSearchProvider, YandexSearchProvider, parseYandexXml, stripTags };
