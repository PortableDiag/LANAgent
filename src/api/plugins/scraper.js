import { BasePlugin } from '../core/basePlugin.js';
import { launchBrowser } from '../../utils/stealthBrowser.js';
import { logger } from '../../utils/logger.js';
import { safeJsonStringify } from '../../utils/jsonUtils.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import jsonld from 'jsonld';

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
      googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
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
    const { usePuppeteer = false, selector, waitForSelector, bypassCache = false } = options;
    
    // Check cache first unless explicitly bypassed
    if (!bypassCache) {
      const cacheKey = this.generateCacheKey(url, { usePuppeteer, selector, waitForSelector, userAgent: options.userAgent });
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
      if (usePuppeteer) {
        result = await this.scrapeWithPuppeteer(url, options);
      } else {
        result = await this.scrapeWithCheerio(url, options);
      }
      
      // Cache the successful result
      if (!bypassCache && result) {
        const cacheKey = this.generateCacheKey(url, { usePuppeteer, selector, waitForSelector, userAgent: options.userAgent });
        this.setCachedData(cacheKey, result);
        logger.info(`Cached scraping result for ${url}`);
      }
      
      return result;
    } catch (error) {
      logger.error(`Scraping error for ${url}:`, error.message);
      throw new Error(`Failed to scrape ${url}: ${error.message}`);
    }
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

  async scrapeWithPuppeteer(url, options) {
    const { selector, waitForSelector, viewport, userAgent } = options;

    if (!this.browser) {
      this.browser = await launchBrowser();
    }

    const page = await this.browser.newPage();

    try {
      // Inject realistic browser properties before navigation
      await page.evaluateOnNewDocument(() => {
        // Override navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // Chrome runtime
        window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
        // Permissions
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
        // Plugins (Chrome typically has 5)
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        // Languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
        // WebGL vendor/renderer spoofing
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return 'Intel Inc.';
          if (param === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.call(this, param);
        };
      });

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

      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 45000
      });

      // Detect and wait for Cloudflare/bot challenge pages
      const challengeTitles = ['Just a moment', 'Checking your browser', 'Checking', 'Attention Required', 'Access denied', 'Please Wait'];
      const pageTitle = await page.title();
      const isChallenged = challengeTitles.some(t => pageTitle.includes(t));

      if (isChallenged) {
        logger.info(`Cloudflare challenge detected for ${url} (title: "${pageTitle}"), waiting for resolution...`);
        try {
          // Wait up to 30s for the challenge to resolve (title changes when done)
          await page.waitForFunction(
            (titles) => !titles.some(t => document.title.includes(t)),
            { timeout: 30000 },
            challengeTitles
          );
          // Give the page time to fully render after challenge
          await new Promise(r => setTimeout(r, 3000));
          logger.info(`Cloudflare challenge resolved for ${url}, new title: "${await page.title()}"`);
        } catch {
          logger.warn(`Cloudflare challenge did not resolve within 30s for ${url}`);
        }

        // After waiting, check if challenge is still present
        const postTitle = await page.title();
        const challengeTitlesCheck = ['Just a moment', 'Checking your browser', 'Checking', 'Attention Required', 'Access denied', 'Please Wait'];
        if (challengeTitlesCheck.some(t => postTitle.includes(t))) {
          logger.error(`Cloudflare Turnstile/managed challenge could not be bypassed for ${url}`);
          return {
            success: false,
            url,
            error: `Cloudflare protection active — managed challenge could not be bypassed for this site`,
            method: 'puppeteer',
            cloudflareBlocked: true
          };
        }
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
    const { fullPage = false, viewport, userAgent } = options;

    if (!this.browser) {
      this.browser = await launchBrowser();
    }

    const page = await this.browser.newPage();

    try {
      // Inject stealth properties for screenshot too
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
      });

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

      await page.setViewport(viewport || { width: 1920, height: 1080, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      
      const screenshot = await page.screenshot({
        fullPage,
        encoding: 'base64'
      });
      
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
    
    if (!this.browser) {
      this.browser = await launchBrowser();
    }
    
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
      
      // Wait a bit for dynamic content to load
      await new Promise(resolve => setTimeout(resolve, 5000));
      
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