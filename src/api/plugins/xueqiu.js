import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';
import { retryOperation } from '../../utils/retryUtils.js';

export default class XueqiuPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'xueqiu';
    this.version = '1.0.0';
    this.description = 'Xueqiu (雪球) stock quotes and community posts with zero-config session cookie bootstrap';
    this.commands = [
      {
        command: 'quote',
        description: 'Get real-time stock quote (A/HK/US). Accepts plain code or prefixed symbol',
        usage: 'quote [symbol] (e.g., 600519 | SH600519 | 00700 | HK00700 | TSLA)'
      },
      {
        command: 'search',
        description: 'Search stocks by name or code',
        usage: 'search [query]'
      },
      {
        command: 'hotPosts',
        description: 'Get trending community posts',
        usage: 'hotPosts [limit]'
      },
      {
        command: 'hotStocks',
        description: 'Get popular stocks leaderboard by market',
        usage: 'hotStocks [limit] [market: CN|HK|US]'
      }
    ];

    this.cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
    this.http = axios.create({ timeout: 12000, validateStatus: (s) => s >= 200 && s < 500 });
    this.cookieHeader = null;
    this.cookieExpiry = 0;
    this.ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
    this.baseUrl = 'https://xueqiu.com';
    this.stockApi = 'https://stock.xueqiu.com';
  }

  async initialize() {
    // Zero-config; optionally accept overrides from serviceConfigs.xueqiu.
    // Session bootstrap is deferred to the first execute() call so a
    // network blip on xueqiu.com (or being firewalled, e.g. running outside
    // China) doesn't fail plugin init and disable the whole plugin.
    this.config = this.agent?.serviceConfigs?.xueqiu || {};
  }

  async execute(params = {}) {
    const { action } = params;
    try {
      switch (action) {
        case 'quote': {
          const { symbol } = params;
          if (!symbol) return { success: false, error: 'Missing required param: symbol' };
          const data = await this.getStockQuote(symbol);
          return { success: true, data };
        }

        case 'search': {
          const { query, size } = params;
          if (!query) return { success: false, error: 'Missing required param: query' };
          const data = await this.searchStock(query, Number(size) || 10);
          return { success: true, data };
        }

        case 'hotPosts': {
          const { limit } = params;
          const data = await this.getHotPosts(Number(limit) || 10);
          return { success: true, data };
        }

        case 'hotStocks': {
          const { limit, market } = params;
          const data = await this.getHotStocks(Number(limit) || 10, (market || 'CN').toUpperCase());
          return { success: true, data };
        }

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Supported actions: ${this.commands.map(c => c.command).join(', ')}`
          };
      }
    } catch (err) {
      this.logger.error(`Xueqiu ${action || ''} error:`, err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  // Session and HTTP helpers

  async ensureSession(force = false) {
    if (!force && this.cookieHeader && Date.now() < this.cookieExpiry) return;
    const headers = {
      'User-Agent': this.ua,
      Referer: this.baseUrl + '/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      Connection: 'keep-alive'
    };

    const fetchHome = async () => this.http.get(this.baseUrl + '/', { headers });
    const res = await retryOperation(fetchHome, { retries: 3, minTimeout: 400, factor: 1.6 });

    const setCookie = res?.headers?.['set-cookie'];
    if (Array.isArray(setCookie) && setCookie.length) {
      this.cookieHeader = this.buildCookieHeader(setCookie);
      this.cookieExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes
      this.logger.info('Xueqiu session initialized');
    } else if (!this.cookieHeader) {
      // Fallback: proceed without cookies (might still work for some endpoints)
      this.cookieHeader = '';
      this.cookieExpiry = Date.now() + 5 * 60 * 1000;
      this.logger.warn('Xueqiu: No Set-Cookie received; proceeding without session cookie');
    }
  }

  buildCookieHeader(setCookieArr) {
    // Take name=value pairs and join
    return setCookieArr
      .map((c) => (typeof c === 'string' ? c.split(';')[0]?.trim() : ''))
      .filter(Boolean)
      .join('; ');
  }

  baseHeaders() {
    const extra = this.config?.headers || {};
    return {
      'User-Agent': this.ua,
      Referer: this.baseUrl + '/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      Cookie: this.cookieHeader || '',
      ...extra
    };
  }

  async doGet(url, { params } = {}, retryOnAuth = true) {
    await this.ensureSession();
    const fn = () => this.http.get(url, { headers: this.baseHeaders(), params });
    let res = await retryOperation(fn, { retries: 3, minTimeout: 350, factor: 1.5 });

    // If unauthorized or forbidden, refresh session once
    if (retryOnAuth && (res?.status === 401 || res?.status === 403)) {
      await this.ensureSession(true);
      res = await retryOperation(fn, { retries: 2, minTimeout: 400, factor: 1.5 });
    }

    if (!res || res.status >= 400) {
      const msg = res?.data?.error?.message || res?.statusText || `HTTP ${res?.status || 'ERR'}`;
      throw new Error(`Request failed: ${msg}`);
    }

    return res.data;
  }

  // Feature methods

  normalizeSymbol(input) {
    if (!input) return '';
    let s = String(input).trim().toUpperCase();

    // Already prefixed for A/HK
    if (/^(SH|SZ)\d{6}$/.test(s)) return s;
    if (/^HK\d{5}$/.test(s)) return s;

    // Pure numeric (A or HK)
    if (/^\d{6}$/.test(s)) {
      // A-shares
      if (s.startsWith('6')) return 'SH' + s;
      return 'SZ' + s;
    }
    if (/^\d{5}$/.test(s)) {
      // HK without prefix
      return 'HK' + s;
    }

    // Prefixed lowercase
    if (/^(sh|sz)\d{6}$/.test(s)) return s.toUpperCase();
    if (/^(hk)\d{5}$/.test(s)) return s.toUpperCase();

    // US tickers: keep as-is (e.g., TSLA, AAPL)
    if (/^[A-Z]{1,6}$/.test(s)) return s;

    // Fallback: return raw
    return s;
  }

  async getStockQuote(symbol) {
    const norm = this.normalizeSymbol(symbol);
    const cacheKey = `xq:quote:${norm}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const url = `${this.stockApi}/v5/stock/quote.json`;
    const data = await this.doGet(url, { params: { symbol: norm, extend: 'detail' } });

    // Try multiple shapes
    const quote =
      data?.data?.quote ||
      data?.data ||
      data?.quote ||
      null;

    if (!quote) {
      throw new Error('Unexpected response structure from Xueqiu quote API');
    }

    const result = {
      symbol: quote.symbol || norm,
      name: quote.name || quote.stockName || null,
      price: quote.current ?? quote.last ?? quote.price ?? null,
      change: quote.chg ?? quote.change ?? null,
      percent: quote.percent ?? quote.changePercent ?? null,
      open: quote.open ?? null,
      high: quote.high ?? null,
      low: quote.low ?? null,
      lastClose: quote.last_close ?? quote.prevClose ?? null,
      volume: quote.volume ?? null,
      turnoverRate: quote.turnover_rate ?? quote.turnoverRate ?? null,
      market: quote.exchange ?? quote.market?.region ?? null,
      time: quote.time ?? quote.timestamp ?? Date.now()
    };

    // Short TTL for quotes
    this.cache.set(cacheKey, result, 20);
    return result;
  }

  async searchStock(query, size = 10) {
    const key = `xq:search:${query}:${size}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const url = `${this.baseUrl}/query/v1/symbol/search.json`;
    const data = await this.doGet(url, { params: { q: query, size } });

    const list = data?.data?.list || data?.list || data?.stocks || [];
    const mapped = list.map((it) => ({
      symbol: it.symbol || it.code || null,
      name: it.name || it.cn_name || it.en_name || null,
      exchange: it.exchange || it.market || null,
      type: it.type || null,
      region: it.region || null
    }));

    this.cache.set(key, mapped, 600);
    return mapped;
  }

  async getHotPosts(limit = 10) {
    const key = `xq:hotPosts:${limit}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const url = `${this.baseUrl}/statuses/hot/listV2.json`;
    const data = await this.doGet(url, { params: { since_id: -1, max_id: -1, count: limit } });

    const items = data?.items || data?.list || [];
    const posts = items.map((it) => {
      const s = it?.status || it;
      return {
        id: s?.id || s?.status_id || null,
        title: s?.title || null,
        text: s?.text || s?.description || '',
        user: s?.user?.screen_name || s?.user?.name || null,
        likedCount: s?.like_count ?? s?.liked_count ?? 0,
        retweetCount: s?.retweet_count ?? 0,
        replyCount: s?.reply_count ?? 0,
        createdAt: s?.created_at || null,
        target: s?.target || null
      };
    });

    this.cache.set(key, posts, 90);
    return posts;
  }

  async getHotStocks(limit = 10, market = 'CN') {
    const key = `xq:hotStocks:${market}:${limit}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Primary: hot stock leaderboard
    const primaryUrl = `${this.baseUrl}/service/v5/stock/hot_stock/list.json`;
    try {
      const data = await this.doGet(primaryUrl, { params: { size: limit, category: market } });
      const list = data?.data?.items || data?.data || data?.items || [];
      const mapped = list.map((it) => {
        const q = it?.quote || it;
        return {
          rank: it?.rank ?? null,
          symbol: q?.symbol || null,
          name: q?.name || null,
          price: q?.current ?? null,
          percent: q?.percent ?? null,
          change: q?.chg ?? null,
          volume: q?.volume ?? null,
          market: q?.exchange ?? q?.market?.region ?? null
        };
      });
      if (mapped.length) {
        this.cache.set(key, mapped, 120);
        return mapped;
      }
    } catch (e) {
      this.logger.warn(`Xueqiu hot_stock primary failed: ${e?.message || e}`);
    }

    // Fallback: screener sorted by volume (proxy for popularity)
    const screenerUrl = `${this.baseUrl}/service/v5/stock/screener/quote/list.json`;
    const screenerParams = this.screenerParamsForMarket(market, limit);
    const data2 = await this.doGet(screenerUrl, { params: screenerParams });
    const list2 = data2?.data?.list || [];
    const mapped2 = list2.map((q, idx) => ({
      rank: idx + 1,
      symbol: q?.symbol || null,
      name: q?.name || null,
      price: q?.current ?? null,
      percent: q?.percent ?? null,
      change: q?.chg ?? null,
      volume: q?.volume ?? null,
      market: q?.exchange ?? q?.market?.region ?? null
    }));
    this.cache.set(key, mapped2, 90);
    return mapped2;
  }

  screenerParamsForMarket(market, size) {
    const m = market.toUpperCase();
    // Xueqiu screener expects market and type combinations
    if (m === 'CN') {
      return { page: 1, size, order: 'desc', order_by: 'volume', market: 'CN', type: 'sh_sz' };
    }
    if (m === 'HK') {
      return { page: 1, size, order: 'desc', order_by: 'volume', market: 'HK', type: 'hk' };
    }
    // US
    return { page: 1, size, order: 'desc', order_by: 'volume', market: 'US', type: 'us' };
  }
}
