import { BasePlugin } from '../core/basePlugin.js';
import { launchBrowser } from '../../utils/stealthBrowser.js';
import { fsRequestGet, isFlareSolverrAvailable } from '../../utils/flareSolverr.js';
import { logger } from '../../utils/logger.js';
import { safeJsonStringify } from '../../utils/jsonUtils.js';
import ScrapeCookieJar from '../../models/ScrapeCookieJar.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import jsonld from 'jsonld';

// Title fragments seen on JS interstitials we want to wait out before doing
// anything user-visible (HTML extraction, screenshot, PDF). Cloudflare's
// "Just a moment" / "Checking your browser", Akamai's "Access denied",
// wp.com / Jetpack's "Checking your browser", etc.
const CHALLENGE_TITLES = ['Just a moment', 'Checking your browser', 'Checking', 'Attention Required', 'Access denied', 'Please Wait'];

// v2.25.89: pull the hostname's persistent anti-bot cookie jar (datadome,
// cf_clearance, _abck, etc.) into the Puppeteer page BEFORE goto(). Once
// we've gotten past a host's challenge even once, the datadome cookie persists
// for ~1y and subsequent visits sail through without the captcha. Safe to call
// before every Puppeteer launch — returns 0 if no jar exists for the host.
async function primePageWithSavedCookies(page, url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const saved = await ScrapeCookieJar.getCookiesForHostname(hostname);
    if (saved.length === 0) return 0;
    // Puppeteer setCookie rejects entries without name+value; pre-filter.
    const safe = saved.filter(c => c.name && c.value != null).map(c => ({
      ...c, value: String(c.value)
    }));
    if (safe.length === 0) return 0;
    await page.setCookie(...safe);
    logger.info(`[CookieJar] Primed ${safe.length} saved cookie(s) for ${hostname} (incl. ${safe.map(c => c.name).join(', ')})`);
    return safe.length;
  } catch (err) {
    logger.debug(`[CookieJar] Prime failed for ${url}: ${err.message}`);
    return 0;
  }
}

// v2.25.89: harvest anti-bot cookies from the page after a successful navigation.
// Only persists the cookies that ScrapeCookieJar.shouldPersist() recognizes —
// analytics/session-id cookies are noise and risk cross-session tracking
// artifacts.
async function harvestPageCookies(page, url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const cookies = await page.cookies();
    const saved = await ScrapeCookieJar.saveCookiesForHostname(hostname, cookies);
    if (saved) {
      const persistableNames = cookies.filter(c => ScrapeCookieJar.shouldPersist(c.name)).map(c => c.name);
      logger.info(`[CookieJar] Harvested ${persistableNames.length} anti-bot cookie(s) from ${hostname}: ${persistableNames.join(', ')}`);
    }
    return saved;
  } catch (err) {
    logger.debug(`[CookieJar] Harvest failed for ${url}: ${err.message}`);
    return false;
  }
}

// Block until the page title no longer matches one of CHALLENGE_TITLES, then
// give the post-challenge page a beat to render. Returns true if we ended up
// on a non-challenge title (real content), false if the challenge is still
// up after `timeoutMs`. The caller decides what to do with `false`.
//
// This is the same pattern that was previously inlined inside
// scrapeWithPuppeteer; extracted because the screenshot path needs it too —
// before this, takeScreenshot() did goto+screenshot with no wait, so
// networkidle2 could fire before a JS bot-check resolved and we'd ship a
// screenshot of the interstitial back to the caller while the HTML pass
// (which DID wait) correctly returned the real article. wp.com / Jetpack
// articles hit this every time on 2026-06-08.
async function waitForChallengeResolution(page, { url = '', timeoutMs = 30000 } = {}) {
  const pageTitle = await page.title();
  const isChallenged = CHALLENGE_TITLES.some(t => pageTitle.includes(t));
  if (!isChallenged) return true;

  logger.info(`Challenge interstitial detected for ${url} (title: "${pageTitle}"), waiting up to ${timeoutMs}ms`);
  try {
    await page.waitForFunction(
      (titles) => !titles.some(t => document.title.includes(t)),
      { timeout: timeoutMs },
      CHALLENGE_TITLES
    );
    // Post-challenge: real content has started rendering but JS may still be
    // wiring up. 3s is what the inline version used; keep parity.
    await new Promise(r => setTimeout(r, 3000));
    logger.info(`Challenge resolved for ${url}, title: "${await page.title()}"`);
  } catch {
    logger.warn(`Challenge did not resolve within ${timeoutMs}ms for ${url}`);
  }

  const postTitle = await page.title();
  return !CHALLENGE_TITLES.some(t => postTitle.includes(t));
}

// After the challenge title clears, poll the DOM for actual article content
// before declaring the page safe to capture. Title-only resolution isn't
// enough on some Jetpack-protected WP sites: the title flips to the real
// article (so waitForChallengeResolution returns true), but a SECONDARY JS
// verification then replaces the body with "Error; please refresh to try
// again." before networkidle settles. Title says ✓, body says ✗,
// screenshot captures the error overlay.
//
// Strategy: poll for one of the standard article containers to have a real
// painted size + a minimum amount of innerText, with a body-text fallback
// for SPA / minimal-template layouts. Returns true once content is real,
// false on timeout — caller bails on the screenshot/PDF rather than
// shipping the error overlay.
async function waitForRealContent(page, { url = '', timeoutMs = 10000 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        const ARTICLE_SELECTORS = [
          'article', '.entry-content', 'main', '[role="main"]',
          '.post-content', '#content', '#main', '.article-body'
        ];
        for (const sel of ARTICLE_SELECTORS) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          // A bot-check overlay or empty container is small; real article
          // containers paint at least a couple hundred pixels in each dim.
          if (rect.width < 200 || rect.height < 200) continue;
          if ((el.innerText || '').trim().length >= 200) return true;
        }
        // Fallback for SPAs / minimal layouts that don't use any of the
        // common article container conventions: body has substantial text.
        // Threshold is higher than the per-selector check because we're
        // counting nav/footer noise too.
        const bodyText = (document.body?.innerText || '').trim();
        if (bodyText.length >= 800) return true;
        return false;
      },
      { timeout: timeoutMs, polling: 250 }
    );
    return true;
  } catch {
    logger.warn(`Content render check did not pass within ${timeoutMs}ms for ${url}`);
    return false;
  }
}

export default class ScraperPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'scraper';
    this.version = '1.2.0';
    this.description = 'Web page scraping and content extraction with JSON-LD and Microdata support';
    this.commands = [
      {
        command: 'scrape',
        description: 'Scrape content from a webpage with optional user agent and 1-hour cache',
        usage: 'scrape({ url: "https://example.com", options: { userAgent: "chrome", bypassCache: false } })',
        offerAsService: true
      },
      {
        command: 'screenshot',
        description: 'Take a screenshot of a webpage',
        usage: 'screenshot({ url: "https://example.com", options: { fullPage: true, format: "png" } })',
        offerAsService: true
      },
      {
        command: 'pdf',
        description: 'Generate PDF from a webpage with 1-hour cache',
        usage: 'pdf({ url: "https://example.com", options: { format: "A4", userAgent: "chrome", bypassCache: false } })',
        offerAsService: true
      },
      {
        command: 'extract',
        description: 'Extract structured data (JSON-LD, Microdata) from a webpage',
        usage: 'extract({ url: "https://example.com", options: { type: "jsonld" } })',
        offerAsService: true
      },
      {
        command: 'bulk',
        description: 'Scrape multiple URLs in batch',
        usage: 'bulk({ urls: ["https://example.com", "https://example.org"], options: { userAgent: "chrome" } })',
        offerAsService: true
      }
    ];
    this.browser = null;
    
    // Initialize caching with 1 hour TTL
    this.cache = new Map();
    this.cacheTimeout = 3600000; // 1 hour (60 * 60 * 1000 milliseconds)
    this.cacheCleanupInterval = null;
    
    // Default user agents
    this.defaultUserAgents = {
      chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
      safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      bot: 'LANAgent/1.0 (+https://github.com/alicelanagent/lanagent)',
      googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      // Twitterbot is the canonical UA Twitter/X uses to fetch URLs for card
      // previews. Many metered paywalls (NYT, WaPo, etc.) historically allow
      // it through for social-preview rendering, which incidentally lets us
      // read the article body when we'd otherwise hit a paywall stub.
      twitterbot: 'Twitterbot/1.0'
    };
    
    // Initialize axios with connection pooling
    this.axiosInstance = axios.create({
      timeout: 30000,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
      maxRedirects: 5
    });
  }

  getCachedData(key) {
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      } else {
        this.cache.delete(key);
      }
    }
    return null;
  }

  setCachedData(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  generateCacheKey(url, options) {
    return `${url}_${safeJsonStringify(options)}`;
  }

  async initialize() {
    logger.info('Scraper plugin initialized');
    
    // Start cache cleanup interval - run every 30 minutes
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 1800000); // 30 minutes
  }
  
  cleanupCache() {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.cache.delete(key);
        removed++;
      }
    }
    
    if (removed > 0) {
      logger.info(`Scraper cache cleanup: removed ${removed} expired entries`);
    }
  }
  
  /**
   * Known ad/tracker domains and URL patterns to filter from image results
   */
  static AD_TRACKER_PATTERNS = [
    // Domain-based patterns
    /ads\.rmbl\.ws/i,
    /doubleclick\.net/i,
    /googlesyndication\.com/i,
    /googleadservices\.com/i,
    /adservice\.google\./i,
    /facebook\.com\/tr/i,
    /pixel\.facebook\.com/i,
    /analytics\.twitter\.com/i,
    /bat\.bing\.com/i,
    /amazon-adsystem\.com/i,
    /adnxs\.com/i,
    /criteo\.com/i,
    /taboola\.com/i,
    /outbrain\.com/i,
    /pubmatic\.com/i,
    /rubiconproject\.com/i,
    /scorecardresearch\.com/i,
    /quantserve\.com/i,
    // URL path patterns (tracking pixels/beacons)
    /\/t\?a=/i,
    /\/pixel\?/i,
    /\/beacon\?/i,
    /\/track\?/i,
    /1x1\./i,
    /transparent\./i,
    /spacer\./i
  ];

  /**
   * Check if a URL matches known ad/tracker patterns
   */
  isAdOrTracker(url) {
    if (!url) return true;
    return ScraperPlugin.AD_TRACKER_PATTERNS.some(pattern => pattern.test(url));
  }

  /**
   * Filter images array: remove ad/tracker URLs and tiny tracking pixels
   */
  filterImages(images) {
    return images.filter(img => !this.isAdOrTracker(img.src));
  }

  /**
   * Validate an image URL with a HEAD request — returns true if it responds 2xx with content-type image/*
   */
  async validateImageUrl(url) {
    if (!url) return false;
    try {
      const response = await axios.head(url, {
        timeout: 5000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const contentType = response.headers['content-type'] || '';
      return response.status >= 200 && response.status < 300 && contentType.startsWith('image/');
    } catch {
      return false;
    }
  }

  /**
   * Get the best image from scrape results: prefer validated og:image, then first valid non-ad image
   */
  async getBestImage(ogImage, images) {
    // Try og:image first (if it passes ad filter and validation)
    if (ogImage && !this.isAdOrTracker(ogImage)) {
      const valid = await this.validateImageUrl(ogImage);
      if (valid) return ogImage;
    }

    // Fall back to first non-ad image from the page that validates
    const filtered = this.filterImages(images);
    for (const img of filtered.slice(0, 5)) { // check up to 5 candidates
      const valid = await this.validateImageUrl(img.src);
      if (valid) return img.src;
    }

    return ogImage || ''; // last resort: return unvalidated og:image or empty
  }

  async cleanup() {
    // Clear the cleanup interval when plugin is unloaded
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }
    
    // Close browser if open
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async execute(params) {
    const { action, url, options = {} } = params;
    
    // For bulk processing, validate differently
    if (action === 'bulk') {
      this.validateParams(params, {
        action: { required: true, type: 'string' },
        urls: { required: true, type: 'array' }
      });
    } else {
      this.validateParams(params, {
        action: { 
          required: true, 
          type: 'string',
          enum: ['scrape', 'screenshot', 'pdf', 'extract', 'bulk']
        },
        url: { required: true, type: 'string' },
        options: { required: false, type: 'object' }
      });
    }
    
    const cacheKey = this.generateCacheKey(url, { action, ...options });
    
    if ((action === 'scrape' || action === 'extract') && !options.bypassCache) {
      const cachedResult = this.getCachedData(cacheKey);
      if (cachedResult) {
        logger.info(`Returning cached result for ${url}`);
        return cachedResult;
      }
    }
    
    let result;
    switch (action) {
      case 'scrape':
        result = await this.scrapePage(url, options);
        break;
      case 'screenshot':
        result = await this.takeScreenshot(url, options);
        break;
      case 'pdf':
        result = await this.generatePDF(url, options);
        break;
      case 'extract':
        result = await this.extractContent(url, options);
        break;
      case 'bulk':
        result = await this.processBulk(params.urls, options);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    if ((action === 'scrape' || action === 'extract') && result.success) {
      this.setCachedData(cacheKey, result);
    }
    
    return result;
  }

  async scrapePage(url, options) {
    const { usePuppeteer = false, useFlareSolverr = false, selector, waitForSelector, bypassCache = false } = options;

    // Check cache first unless explicitly bypassed
    if (!bypassCache) {
      const cacheKey = this.generateCacheKey(url, { usePuppeteer, useFlareSolverr, selector, waitForSelector, userAgent: options.userAgent });
      const cachedData = this.getCachedData(cacheKey);

      if (cachedData) {
        logger.info(`Returning cached data for ${url} (cache hit)`);
        return {
          ...cachedData,
          cached: true,
          cacheAge: Date.now() - (this.cache.get(cacheKey)?.timestamp || 0)
        };
      }
    }

    try {
      let result;
      if (useFlareSolverr) {
        result = await this.scrapeWithFlareSolverr(url, options);
      } else if (usePuppeteer) {
        result = await this.scrapeWithPuppeteer(url, options);
      } else {
        result = await this.scrapeWithCheerio(url, options);
      }

      // Cache the successful result
      if (!bypassCache && result) {
        const cacheKey = this.generateCacheKey(url, { usePuppeteer, useFlareSolverr, selector, waitForSelector, userAgent: options.userAgent });
        this.setCachedData(cacheKey, result);
        logger.info(`Cached scraping result for ${url}`);
      }

      return result;
    } catch (error) {
      logger.error(`Scraping error for ${url}:`, error.message);
      throw new Error(`Failed to scrape ${url}: ${error.message}`);
    }
  }

  /**
   * Parse HTML with cheerio and extract the same content shape as scrapeWithCheerio.
   * Shared between scrapeWithCheerio (after axios fetch) and scrapeWithFlareSolverr.
   */
  parseHtmlContent(html, url, selector) {
    const $ = cheerio.load(html);

    const content = {
      title: $('meta[property="og:title"]').first().attr('content') || $('title').text() || $('h1').first().text(),
      description: $('meta[property="og:description"]').first().attr('content') ||
                   $('meta[name="description"]').attr('content') || '',
      ogImage: $('meta[property="og:image"]').first().attr('content') || '',
      text: '',
      links: [],
      images: [],
      jsonld: [],
      microdata: []
    };

    if (selector) {
      content.text = $(selector).text().trim();
    } else {
      // Clone before stripping scripts/styles so we don't mutate the source
      $('script, style').remove();
      const mainSelectors = ['main', 'article', '[role="main"]', '#content', '.content'];
      let mainContent = '';
      for (const sel of mainSelectors) {
        if ($(sel).length) {
          mainContent = $(sel).text().trim();
          break;
        }
      }
      content.text = mainContent || $('body').text().trim();
    }

    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().trim();
      if (href && text) content.links.push({ href, text });
    });

    $('img[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      const alt = $(elem).attr('alt') || '';
      if (src) content.images.push({ src, alt });
    });

    content.text = content.text.replace(/\s+/g, ' ').trim();
    if (content.text.length > 5000) {
      content.text = content.text.substring(0, 5000) + '...';
    }

    return { content, $ };
  }

  /**
   * Scrape via FlareSolverr — bypasses Cloudflare Turnstile / managed challenges.
   * Returns the same shape as scrapeWithCheerio/scrapeWithPuppeteer plus a
   * `_rawHtml` field so callers (render tier) can attach the raw HTML cheaply.
   */
  async scrapeWithFlareSolverr(url, options = {}) {
    const { selector, userAgent } = options;

    const fsOptions = { maxTimeout: 60000 };
    if (userAgent && this.defaultUserAgents[userAgent]) {
      fsOptions.userAgent = this.defaultUserAgents[userAgent];
    } else if (typeof userAgent === 'string' && userAgent.length > 0) {
      fsOptions.userAgent = userAgent;
    }

    const solution = await fsRequestGet(url, fsOptions);
    const html = solution.response || '';
    const httpStatus = solution.status;

    if (httpStatus >= 400) {
      throw new Error(`FlareSolverr fetched ${url} but target returned HTTP ${httpStatus}`);
    }

    const { content, $ } = this.parseHtmlContent(html, url, selector);
    content.jsonld = await this.extractJsonLd($);
    content.microdata = this.extractMicrodata($);

    return {
      success: true,
      url: solution.url || url,
      content,
      method: 'flaresolverr',
      _rawHtml: html,
      _cookies: solution.cookies || [],
      _userAgent: solution.userAgent || ''
    };
  }

  async scrapeWithCheerio(url, options) {
    const { selector, userAgent } = options;
    
    const cacheKey = `headers_${url}`;
    const cachedHeaders = this.getCachedData(cacheKey) || {};
    
    // Select user agent
    let agent;
    if (userAgent) {
      agent = this.defaultUserAgents[userAgent] || userAgent;
    } else {
      agent = this.defaultUserAgents.chrome;
    }
    
    const headers = {
      'User-Agent': agent
    };
    
    if (cachedHeaders.etag) {
      headers['If-None-Match'] = cachedHeaders.etag;
    }
    
    if (cachedHeaders.lastModified) {
      headers['If-Modified-Since'] = cachedHeaders.lastModified;
    }
    
    try {
      const response = await this.axiosInstance.get(url, { headers });
      
      const newHeaders = {};
      if (response.headers.etag) {
        newHeaders.etag = response.headers.etag;
      }
      if (response.headers['last-modified']) {
        newHeaders.lastModified = response.headers['last-modified'];
      }
      if (Object.keys(newHeaders).length > 0) {
        this.setCachedData(cacheKey, newHeaders);
      }
      
      const $ = cheerio.load(response.data);
      
      let content = {
        title: $('meta[property="og:title"]').first().attr('content') || $('title').text() || $('h1').first().text(),
        description: $('meta[property="og:description"]').first().attr('content') ||
                     $('meta[name="description"]').attr('content') || '',
        ogImage: $('meta[property="og:image"]').first().attr('content') || '',
        text: '',
        links: [],
        images: [],
        jsonld: [],
        microdata: []
      };
      
      if (selector) {
        content.text = $(selector).text().trim();
      } else {
        $('script, style').remove();
        
        const mainSelectors = ['main', 'article', '[role="main"]', '#content', '.content'];
        let mainContent = '';
        
        for (const sel of mainSelectors) {
          if ($(sel).length) {
            mainContent = $(sel).text().trim();
            break;
          }
        }
        
        content.text = mainContent || $('body').text().trim();
      }
      
      $('a[href]').each((i, elem) => {
        const href = $(elem).attr('href');
        const text = $(elem).text().trim();
        if (href && text) {
          content.links.push({ href, text });
        }
      });
      
      $('img[src]').each((i, elem) => {
        const src = $(elem).attr('src');
        const alt = $(elem).attr('alt') || '';
        if (src) {
          content.images.push({ src, alt });
        }
      });
      
      content.text = content.text.replace(/\s+/g, ' ').trim();
      
      if (content.text.length > 5000) {
        content.text = content.text.substring(0, 5000) + '...';
      }
      
      content.jsonld = await this.extractJsonLd($);
      content.microdata = this.extractMicrodata($);
      
      return {
        success: true,
        url,
        content,
        method: 'cheerio'
      };
    } catch (error) {
      if (error.response && error.response.status === 304) {
        const contentCacheKey = `content_${url}`;
        const cachedContent = this.getCachedData(contentCacheKey);
        if (cachedContent) {
          return cachedContent;
        }
        throw new Error('Content not modified but no cached content available');
      }
      // Sanitize axios errors — they contain circular refs (TLSSocket)
      const status = error.response?.status;
      const statusText = error.response?.statusText || '';
      const msg = status
        ? `HTTP ${status} ${statusText} from ${url}`
        : `${error.code || error.message || 'Request failed'} for ${url}`;
      throw new Error(msg);
    }
  }

  // Return a live shared browser, relaunching if the previous one disconnected.
  // A bare `if (!this.browser)` guard is insufficient: when Chromium crashes or is
  // killed (heavy Cloudflare/Akamai challenge pages, OOM), `this.browser` stays a
  // non-null but dead handle, so every subsequent `newPage()` throws "Protocol
  // error: Connection closed" until the process restarts — which is what wedged
  // the gov-site scrapes (all four failing in the same second). Check liveness,
  // not just null, and recycle a dead handle.
  async _ensureBrowser() {
    const alive = this.browser && (this.browser.connected ?? this.browser.isConnected?.());
    if (!alive) {
      if (this.browser) { try { await this.browser.close(); } catch { /* already dead */ } }
      this.browser = await launchBrowser();
    }
    return this.browser;
  }

  async scrapeWithPuppeteer(url, options) {
    const { selector, waitForSelector, viewport, userAgent } = options;

    await this._ensureBrowser();

    const page = await this.browser.newPage();

    try {
      // v2.25.89: stealth plugin (puppeteer-extra-plugin-stealth) handles
      // navigator.webdriver, window.chrome, permissions.query, plugins,
      // languages, and WebGL vendor/renderer spoofing via 17 individual
      // evasions, all maintained as a moving target against the latest
      // detection scripts. The hand-rolled overrides that used to live here
      // were both narrower (e.g., hardcoded "Intel Iris" WebGL even when the
      // real iGPU was AMD Radeon — that mismatch was itself a fingerprint
      // tell) and out of date. Letting the plugin do the work avoids the
      // double-patching and lets the real iGPU's WebGL vendor string come
      // through (which now matches normal consumer-hardware fingerprints).

      // Set realistic headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      });

      // Set custom user agent if provided
      if (userAgent) {
        const agent = this.defaultUserAgents[userAgent] || userAgent;
        await page.setUserAgent(agent);
        logger.info(`Using user agent: ${agent.substring(0, 50)}...`);
      } else {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      }

      await page.setViewport(viewport || { width: 1920, height: 1080, deviceScaleFactor: 1 });

      // v2.25.89: replay saved anti-bot cookies for this hostname BEFORE
      // navigation. Once we've solved a DataDome/Cloudflare challenge once
      // (manually, or via a P2P real-browser agent), the resulting datadome
      // cookie persists and lets us through on subsequent visits.
      await primePageWithSavedCookies(page, url);

      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 45000
      });

      // v2.25.89: harvest any anti-bot cookies the host issued during this
      // navigation. Fire-and-forget — failure here shouldn't block the scrape.
      harvestPageCookies(page, url).catch(() => {});

      // Wait out any JS bot-check interstitial before extracting content.
      const resolved = await waitForChallengeResolution(page, { url, timeoutMs: 30000 });
      if (!resolved) {
        logger.error(`Cloudflare Turnstile/managed challenge could not be bypassed for ${url}`);
        return {
          success: false,
          url,
          error: `Cloudflare protection active — managed challenge could not be bypassed for this site`,
          method: 'puppeteer',
          cloudflareBlocked: true
        };
      }

      // Title cleared but the body may still be settling — or a second-stage
      // JS verification may be about to replace it with an error overlay.
      // Wait for actual article content to be present before extracting.
      const contentReady = await waitForRealContent(page, { url, timeoutMs: 10000 });
      if (!contentReady) {
        logger.warn(`Scrape ${url}: content did not paint after challenge — extracting anyway from current DOM`);
        // Don't fail outright — we can still read meta tags + whatever text is
        // there. The HTML pass returning empty article text is preferable to
        // returning success=false on edge-case sites.
      }

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 10000 });
      }
      
      const content = await page.evaluate((selector) => {
        const getTextContent = (element) => {
          return element ? element.innerText || element.textContent : '';
        };
        
        const result = {
          title: document.querySelector('meta[property="og:title"]')?.content || document.title,
          description: document.querySelector('meta[property="og:description"]')?.content ||
                       document.querySelector('meta[name="description"]')?.content || '',
          ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
          text: '',
          links: [],
          images: [],
          jsonld: [],
          microdata: []
        };
        
        if (selector) {
          const element = document.querySelector(selector);
          result.text = getTextContent(element);
        } else {
          const mainContent = document.querySelector('main, article, [role="main"], #content, .content');
          result.text = getTextContent(mainContent || document.body);
        }
        
        document.querySelectorAll('a[href]').forEach(link => {
          result.links.push({
            href: link.href,
            text: link.innerText.trim()
          });
        });
        
        document.querySelectorAll('img[src]').forEach(img => {
          result.images.push({
            src: img.src,
            alt: img.alt || ''
          });
        });
        
        return result;
      }, selector);
      
      content.text = content.text.replace(/\s+/g, ' ').trim();
      
      if (content.text.length > 5000) {
        content.text = content.text.substring(0, 5000) + '...';
      }
      
      content.jsonld = await this.extractJsonLdFromPage(page);
      content.microdata = await this.extractMicrodataFromPage(page);
      
      return {
        success: true,
        url,
        content,
        method: 'puppeteer'
      };
      
    } finally {
      await page.close();
    }
  }

  async takeScreenshot(url, options) {
    const { fullPage = false, viewport, userAgent, cookies, html } = options;

    await this._ensureBrowser();

    const page = await this.browser.newPage();

    try {
      // v2.25.89: stealth plugin owns webdriver/chrome/etc. evasions globally;
      // the hand-rolled in-page overrides that used to be here were redundant.

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      });

      if (userAgent) {
        const agent = this.defaultUserAgents[userAgent] || userAgent;
        await page.setUserAgent(agent);
      } else {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      }

      // Inject cookies (used by render tier to carry CF clearance from FlareSolverr)
      if (Array.isArray(cookies) && cookies.length > 0) {
        try {
          await page.setCookie(...cookies.map(c => ({
            name: c.name,
            value: String(c.value),
            domain: c.domain,
            path: c.path || '/',
            expires: typeof c.expires === 'number' ? c.expires : undefined,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite
          })).filter(c => c.name && c.domain));
        } catch (err) {
          logger.warn(`Failed to inject cookies for screenshot: ${err.message}`);
        }
      }

      await page.setViewport(viewport || { width: 1920, height: 1080, deviceScaleFactor: 1 });

      if (html && typeof html === 'string' && html.length > 100) {
        // Screenshot from pre-rendered HTML (e.g. FlareSolverr's output for a
        // render-tier scrape) instead of re-navigating the live site. The live
        // page is behind a bot-block that issued cf_clearance to FlareSolverr's
        // browser fingerprint; puppeteer presenting the same cookie re-challenges,
        // so the screenshot used to be skipped on exactly the hardest pages (e.g.
        // congress.gov). Rendering the already-fetched HTML sidesteps the block.
        // <base> makes relative CSS/img resolve against the origin so it paints.
        const baseTag = `<base href="${url}">`;
        const htmlWithBase = /<head[^>]*>/i.test(html)
          ? html.replace(/<head[^>]*>/i, m => `${m}${baseTag}`)
          : `${baseTag}${html}`;
        try {
          // domcontentloaded (not 'load'): 'load' waits for EVERY asset to fetch
          // from the live origin, which on asset-heavy pages (e.g. presidency.ucsb.edu)
          // ran the full timeout every time and blew the screenshot budget → no
          // thumbnail. Set the DOM fast, then give images a bounded beat to paint.
          await page.setContent(htmlWithBase, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch { /* slow DOM — screenshot what painted */ }
        // Let above-the-fold images/CSS paint, but cap it so we never approach the budget.
        try {
          await page.evaluate(() => Promise.race([
            Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))),
            new Promise(r => setTimeout(r, 3500))
          ]));
        } catch { /* ignore */ }
        // No challenge wait — we never navigated to the live bot-block.
      } else {
        // v2.25.89: prime with persistent anti-bot cookies (datadome, cf_clearance, etc.)
        await primePageWithSavedCookies(page, url);

        // domcontentloaded (not networkidle2): tracker/ad-heavy pages never go
        // network-idle, so networkidle2 burned the full timeout on every capture.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // v2.25.89: harvest anti-bot cookies the host set during this navigation.
        harvestPageCookies(page, url).catch(() => {});

        // Wait out any JS bot-check interstitial (wp.com Jetpack, Cloudflare,
        // Akamai, etc.) before capturing. Without this we'd ship a screenshot of
        // "Checking your browser..." while the HTML pass returns the real article.
        const resolved = await waitForChallengeResolution(page, { url, timeoutMs: 30000 });
        if (!resolved) {
          logger.warn(`Screenshot skipped for ${url}: bot-check interstitial did not resolve`);
          return {
            success: false,
            url,
            error: 'Challenge interstitial did not resolve — not screenshotting the interstitial',
            challengeUnresolved: true
          };
        }

        // Wait for real article content (not just title-clear). Some
        // Jetpack-protected WP sites do a SECOND verification after the main
        // interstitial that briefly replaces the body with "Error; please
        // refresh to try again." Title is already the real one by then, so
        // the title-only check is fooled.
        const contentReady = await waitForRealContent(page, { url, timeoutMs: 10000 });
        if (!contentReady) {
          logger.warn(`Screenshot skipped for ${url}: post-challenge content did not paint (likely secondary JS verification overlay)`);
          return {
            success: false,
            url,
            error: 'Page content did not render after challenge resolution — likely a second-stage verification or JS error overlay',
            contentUnresolved: true
          };
        }
      }

      // fullPage on very tall pages (e.g. a multi-thousand-px congress.gov bill)
      // makes captureBeyondViewport lay out the whole surface while late assets
      // stream in — that capture alone ran 30s+ and blew the budget, so no
      // thumbnail shipped at all. Cap the captured height with clip(): a tall
      // top-of-page thumbnail is what the frozen-copy preview needs, and it's
      // bounded regardless of document height.
      const MAX_SS_HEIGHT = Number(process.env.RENDER_SCREENSHOT_MAX_HEIGHT) || 6000;
      let shotOpts = { fullPage, encoding: 'base64' };
      let capNote = '';
      if (fullPage) {
        const dims = await page.evaluate(() => ({
          w: Math.min(Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, 1920), 1920),
          h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 1080)
        })).catch(() => ({ w: 1920, h: 1080 }));
        if (dims.h > MAX_SS_HEIGHT) {
          shotOpts = { clip: { x: 0, y: 0, width: dims.w, height: MAX_SS_HEIGHT }, encoding: 'base64' };
          capNote = ` (capped ${dims.h}->${MAX_SS_HEIGHT}px)`;
        }
      }
      const _ssStart = Date.now();
      const screenshot = await page.screenshot(shotOpts);
      logger.info(`[Screenshot] captured ${Math.round(screenshot.length / 1024)}KB in ${Date.now() - _ssStart}ms${capNote} for ${url}`);

      return {
        success: true,
        url,
        screenshot: `data:image/png;base64,${screenshot}`,
        format: 'base64'
      };

    } finally {
      await page.close();
    }
  }

  async generatePDF(url, options) {
    const { format = 'A4', userAgent, bypassCache = false } = options;
    
    // Check cache first unless explicitly bypassed
    if (!bypassCache) {
      const cacheKey = this.generateCacheKey(url, { format, userAgent, type: 'pdf' });
      const cachedData = this.getCachedData(cacheKey);
      
      if (cachedData) {
        logger.info(`Returning cached PDF for ${url} (cache hit)`);
        return {
          ...cachedData,
          cached: true,
          cacheAge: Date.now() - (this.cache.get(cacheKey)?.timestamp || 0)
        };
      }
    }
    
    await this._ensureBrowser();

    const page = await this.browser.newPage();
    
    try {
      // Set custom user agent if provided
      if (userAgent) {
        const agent = this.defaultUserAgents[userAgent] || userAgent;
        await page.setUserAgent(agent);
      } else {
        await page.setUserAgent(this.defaultUserAgents.chrome);
      }
      
      await page.goto(url, {
        waitUntil: 'domcontentloaded', // Use faster load strategy for slow sites
        timeout: 120000 // 120 seconds for PDF generation for slow sites like bestbuy
      });

      // Wait out any JS bot-check interstitial before rendering the PDF.
      // Without this, a wp.com / Cloudflare "Checking your browser" interstitial
      // ends up in the rendered PDF.
      const resolved = await waitForChallengeResolution(page, { url, timeoutMs: 30000 });
      if (!resolved) {
        logger.warn(`PDF skipped for ${url}: bot-check interstitial did not resolve`);
        return {
          success: false,
          url,
          error: 'Challenge interstitial did not resolve — not generating a PDF of the interstitial',
          challengeUnresolved: true
        };
      }

      // Wait for real article content. Same secondary-verification issue
      // as takeScreenshot — title clears but body briefly becomes an error
      // overlay on some Jetpack-protected sites.
      const contentReady = await waitForRealContent(page, { url, timeoutMs: 10000 });
      if (!contentReady) {
        logger.warn(`PDF skipped for ${url}: post-challenge content did not paint`);
        return {
          success: false,
          url,
          error: 'Page content did not render after challenge resolution — likely a second-stage verification or JS error overlay',
          contentUnresolved: true
        };
      }

      const pdfBuffer = await page.pdf({
        format,
        printBackground: true
      });
      
      // Extract filename from URL or use default
      const urlParts = new URL(url);
      const hostname = urlParts.hostname.replace(/\./g, '_');
      const filename = `${hostname}_${Date.now()}.pdf`;
      
      const result = {
        success: true,
        url,
        pdf: pdfBuffer,
        filename,
        format: 'buffer',
        base64: pdfBuffer.toString('base64')
      };
      
      // Cache the successful result
      if (!bypassCache) {
        const cacheKey = this.generateCacheKey(url, { format, userAgent, type: 'pdf' });
        this.setCachedData(cacheKey, result);
        logger.info(`Cached PDF generation result for ${url}`);
      }
      
      return result;
      
    } finally {
      await page.close();
    }
  }

  async extractContent(url, options) {
    try {
      const result = await this.scrapeWithCheerio(url, options);
      
      if (result.content.text.length < 100) {
        logger.info('Content too short, trying Puppeteer...');
        return await this.scrapeWithPuppeteer(url, options);
      }
      
      return result;
    } catch (error) {
      logger.warn('Cheerio failed, falling back to Puppeteer:', error.message);
      return await this.scrapeWithPuppeteer(url, options);
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    this.cache.clear();
  }

  async scrapeUrl(url) {
    return await this.extractContent(url, {});
  }

  /**
   * Extract JSON-LD data from a Cheerio-loaded HTML document
   * @param {CheerioStatic} $ - Cheerio instance
   * @returns {Promise<Array>} - Extracted JSON-LD data
   */
  async extractJsonLd($) {
    const jsonldScripts = $('script[type="application/ld+json"]');
    const jsonldData = [];
    
    jsonldScripts.each((i, elem) => {
      try {
        const jsonData = JSON.parse($(elem).html());
        jsonldData.push(jsonData);
      } catch (error) {
        logger.warn('Failed to parse JSON-LD:', error.message);
      }
    });
    
    return jsonldData;
  }

  /**
   * Extract Microdata from a Cheerio-loaded HTML document
   * @param {CheerioStatic} $ - Cheerio instance
   * @returns {Array} - Extracted Microdata
   */
  extractMicrodata($) {
    const microdataItems = [];
    
    $('[itemscope]').each((i, elem) => {
      const item = {};
      item['@type'] = $(elem).attr('itemtype') || '';
      
      $(elem).find('[itemprop]').each((j, propElem) => {
        const propName = $(propElem).attr('itemprop');
        const propValue = $(propElem).attr('content') || $(propElem).text().trim();
        item[propName] = propValue;
      });
      
      microdataItems.push(item);
    });
    
    return microdataItems;
  }

  /**
   * Extract JSON-LD data from a Puppeteer page
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<Array>} - Extracted JSON-LD data
   */
  async extractJsonLdFromPage(page) {
    return await page.evaluate(() => {
      const jsonldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      const jsonldData = [];
      
      jsonldScripts.forEach(script => {
        try {
          const jsonData = JSON.parse(script.innerText);
          jsonldData.push(jsonData);
        } catch (error) {
          this.logger.warn('Failed to parse JSON-LD:', error.message);
        }
      });
      
      return jsonldData;
    });
  }

  /**
   * Extract Microdata from a Puppeteer page
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<Array>} - Extracted Microdata
   */
  async extractMicrodataFromPage(page) {
    return await page.evaluate(() => {
      const microdataItems = [];
      
      document.querySelectorAll('[itemscope]').forEach(itemScope => {
        const item = {};
        item['@type'] = itemScope.getAttribute('itemtype') || '';
        
        itemScope.querySelectorAll('[itemprop]').forEach(propElem => {
          const propName = propElem.getAttribute('itemprop');
          const propValue = propElem.getAttribute('content') || propElem.innerText.trim();
          item[propName] = propValue;
        });
        
        microdataItems.push(item);
      });
      
      return microdataItems;
    });
  }

  /**
   * Bulk processing capability
   * @param {Array} urls - List of URLs to process
   * @param {Object} options - Options for processing
   * @returns {Promise<Array>} - Results of processing
   */
  async processBulk(urls, options = {}) {
    const results = [];
    const batchSize = options.batchSize || 10;
    const includeScreenshots = options.includeScreenshots || false;
    const outputFormat = options.outputFormat || 'text';
    
    logger.info(`Starting bulk processing of ${urls.length} URLs in batches of ${batchSize}`);
    
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(urls.length / batchSize)}`);
      
      const batchResults = await Promise.all(
        batch.map(url => 
          this.scrapeUrl(url, { includeScreenshots, outputFormat })
            .catch(error => ({
              success: false,
              url,
              error: error.message
            }))
        )
      );
      
      results.push(...batchResults);
    }
    
    logger.info(`Bulk processing completed. Processed ${results.length} URLs`);
    return {
      success: true,
      totalProcessed: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }
}