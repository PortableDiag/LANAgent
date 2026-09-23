/**
 * Provider-agnostic web search.
 *
 * Picks the first configured backend, falls through to the next on failure, and
 * caches identical queries briefly so a retry loop or several agents asking the
 * same thing do not each burn a quota unit (Brave's free tier is ~2k/month, so
 * a duplicate query is real money once it is exhausted).
 *
 * None of this involves a model, so the AI provider lock does not apply — that
 * is the whole point. See searchProviders.js for the per-backend contracts.
 *
 * Order is configurable via WEB_SEARCH_PROVIDER_ORDER (comma-separated), so a
 * backend can be preferred or disabled without a code change.
 */
import NodeCache from 'node-cache';
import { BraveSearchProvider, YandexSearchProvider } from './searchProviders.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_ORDER = ['brave', 'yandex'];

class WebSearchService {
  constructor(env = process.env) {
    this.env = env;
    // 10 minutes: long enough to absorb a retry storm, short enough that "news"
    // style queries are not served stale.
    this.cache = new NodeCache({ stdTTL: 600, maxKeys: 500 });
    this.providers = [new BraveSearchProvider(env), new YandexSearchProvider(env)];
  }

  /** Backends with credentials present, in configured preference order. */
  configuredProviders() {
    const order = (this.env.WEB_SEARCH_PROVIDER_ORDER || DEFAULT_ORDER.join(','))
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const byName = new Map(this.providers.map(p => [p.name, p]));
    return order.map(n => byName.get(n)).filter(p => p && p.isConfigured());
  }

  isAvailable() {
    return this.configuredProviders().length > 0;
  }

  /**
   * Why search is unavailable, in words a caller can act on. Distinguishes
   * "no key configured" from "the key is wrong", which the failure text alone
   * does not — Brave answers 422 for both a missing and an invalid token.
   */
  unavailableReason() {
    const names = this.providers.map(p => p.name).join(', ');
    return `no search backend is configured (set BRAVE_SEARCH_API_KEY, or YANDEX_SEARCH_API_KEY + YANDEX_SEARCH_FOLDER_ID; available backends: ${names})`;
  }

  /**
   * @param {string} query
   * @param {{count?:number, timeoutMs?:number, noCache?:boolean}} [opts]
   * @returns {Promise<{success:boolean, provider?:string, results?:Array, error?:string, cached?:boolean}>}
   */
  async search(query, opts = {}) {
    const q = String(query ?? '').trim();
    if (!q) return { success: false, error: 'Search query is required' };

    const available = this.configuredProviders();
    if (available.length === 0) {
      return { success: false, error: `Web search unavailable: ${this.unavailableReason()}` };
    }

    const count = Math.min(Math.max(parseInt(opts.count, 10) || 10, 1), 20);
    const cacheKey = `${q}::${count}`;
    if (!opts.noCache) {
      const hit = this.cache.get(cacheKey);
      if (hit) return { ...hit, cached: true };
    }

    const failures = [];
    for (const provider of available) {
      try {
        const { results, tookMs } = await provider.search(q, { ...opts, count });
        // An empty result set is a legitimate answer, not a failure — do not
        // fall through to the next backend and spend its quota on it.
        const payload = { success: true, provider: provider.name, results, tookMs, cached: false };
        if (!opts.noCache) {
          // maxKeys makes set() throw once the cache is full; a full cache must
          // never fail the search that filled it.
          try { this.cache.set(cacheKey, payload); } catch { this.cache.flushAll(); }
        }
        logger.info(`Web search "${q}" → ${results.length} result(s) via ${provider.name} (${tookMs}ms)`);
        return payload;
      } catch (err) {
        failures.push(`${provider.name}: ${err.message}`);
        logger.warn(`Web search backend ${provider.name} failed: ${err.message}`);
      }
    }

    return { success: false, error: `Web search failed on all backends — ${failures.join('; ')}` };
  }
}

// One shared instance: the cache and quota are process-wide concerns.
const webSearchService = new WebSearchService();

export { WebSearchService, webSearchService };
export default webSearchService;
