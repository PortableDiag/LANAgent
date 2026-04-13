import { logger } from '../utils/logger.js';
import { launchBrowser, launchPlaywright } from '../utils/stealthBrowser.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';

const execAsync = promisify(exec);

export class WebScraperService {
  constructor(agent) {
    this.agent = agent;
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    this.currentUserAgent = null;
    this.expressVPN = {
      enabled: false,
      currentLocation: null,
      locations: []
    };
    this.browserPool = [];
    this.maxPoolSize = 5;
    this.cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
  }

  async initialize() {
    logger.info('Initializing Web Scraper Service...');
    
    // Check if ExpressVPN is available
    await this.checkExpressVPN();
    
    logger.info('Web Scraper Service initialized');
  }

  async checkExpressVPN() {
    try {
      const { stdout } = await execAsync('expressvpn status');
      this.expressVPN.enabled = true;
      this.expressVPN.currentLocation = this.parseVPNLocation(stdout);
      
      // Get available locations
      const { stdout: locations } = await execAsync('expressvpn list');
      this.expressVPN.locations = this.parseVPNLocations(locations);
      
      logger.info(`ExpressVPN detected - Status: ${stdout.includes('Connected') ? 'Connected' : 'Disconnected'}`);
    } catch (error) {
      logger.info('ExpressVPN not available or not installed');
      this.expressVPN.enabled = false;
    }
  }

  parseVPNLocation(output) {
    const match = output.match(/Connected to (.+)/);
    return match ? match[1].trim() : null;
  }

  parseVPNLocations(output) {
    const locations = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^(\w+)\s+(.+?)\s+\d+/);
      if (match) {
        locations.push({
          alias: match[1],
          name: match[2].trim()
        });
      }
    }
    
    return locations;
  }

  async connectVPN(location = null) {
    if (!this.expressVPN.enabled) {
      logger.warn('ExpressVPN is not available');
      return false;
    }

    try {
      if (location) {
        logger.info(`Connecting to ExpressVPN location: ${location}`);
        await execAsync(`expressvpn connect ${location}`);
      } else {
        logger.info('Connecting to ExpressVPN (auto location)');
        await execAsync('expressvpn connect');
      }
      
      await this.checkExpressVPN();
      return true;
    } catch (error) {
      logger.error('Failed to connect VPN:', error);
      return false;
    }
  }

  async disconnectVPN() {
    if (!this.expressVPN.enabled) {
      return false;
    }

    try {
      logger.info('Disconnecting ExpressVPN');
      await execAsync('expressvpn disconnect');
      await this.checkExpressVPN();
      return true;
    } catch (error) {
      logger.error('Failed to disconnect VPN:', error);
      return false;
    }
  }

  async rotateVPNLocation() {
    if (!this.expressVPN.enabled || this.expressVPN.locations.length === 0) {
      return false;
    }

    // Pick a random location
    const randomLocation = this.expressVPN.locations[
      Math.floor(Math.random() * this.expressVPN.locations.length)
    ];
    
    return await this.connectVPN(randomLocation.alias);
  }

  getRandomUserAgent() {
    this.currentUserAgent = this.userAgents[
      Math.floor(Math.random() * this.userAgents.length)
    ];
    return this.currentUserAgent;
  }

  setUserAgent(userAgent) {
    this.currentUserAgent = userAgent;
    logger.info(`User agent set to: ${userAgent}`);
  }

  async getBrowserInstance(options = {}) {
    if (this.browserPool.length > 0) {
      return this.browserPool.pop();
    }
    return await launchBrowser({
      headless: options.headless !== false ? 'new' : false,
      args: options.args || []
    });
  }

  async releaseBrowserInstance(browser) {
    if (this.browserPool.length < this.maxPoolSize) {
      this.browserPool.push(browser);
    } else {
      await browser.close();
    }
  }

  async scrapeWithPuppeteer(url, options = {}) {
    let browser = null;
    
    try {
      // Handle 403 errors by rotating VPN if available
      if (options.handle403 && this.expressVPN.enabled) {
        await this.connectVPN();
      }

      const browserOptions = {
        headless: options.headless !== false ? 'new' : false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          `--user-agent=${options.userAgent || this.getRandomUserAgent()}`
        ]
      };

      if (options.proxy) {
        browserOptions.args.push(`--proxy-server=${options.proxy}`);
      }

      browser = await this.getBrowserInstance(browserOptions);
      const page = await browser.newPage();
      
      // Set additional headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      });

      // Set viewport
      await page.setViewport({
        width: options.width || 1920,
        height: options.height || 1080
      });

      // Navigate with retry logic
      await retryOperation(async () => {
        const response = await page.goto(url, {
          waitUntil: options.waitUntil || 'networkidle2',
          timeout: options.timeout || 30000
        });

        if (response.status() === 403 && this.expressVPN.enabled) {
          logger.warn(`Got 403, rotating VPN location...`);
          await this.rotateVPNLocation();
          throw new Error('403 Forbidden');
        }

        if (response.status() === 429) {
          logger.warn('Received 429 Too Many Requests, applying exponential backoff...');
          throw new Error('429 Too Many Requests');
        }

        if (response.status() >= 500) {
          logger.warn(`Received ${response.status()} error, retrying immediately...`);
          throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }

        if (response.status() >= 400) {
          throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }
      }, { retries: 3 });

      // Wait for selector if specified
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: options.selectorTimeout || 10000
        });
      }

      // Execute custom function if provided
      let result = {};
      
      if (options.evaluate) {
        result.data = await page.evaluate(options.evaluate);
      } else {
        result.content = await page.content();
        result.url = page.url();
        result.title = await page.title();
      }

      // Take screenshot if requested
      if (options.screenshot) {
        result.screenshot = await page.screenshot({
          type: 'png',
          fullPage: options.fullPage !== false
        });
      }

      await this.releaseBrowserInstance(browser);
      return result;

    } catch (error) {
      if (browser) await this.releaseBrowserInstance(browser);
      throw error;
    }
  }

  async scrapeWithPlaywright(url, options = {}) {
    let browser = null;
    
    try {
      const browserType = options.browser || 'chromium';

      const launchOptions = {
        headless: options.headless !== false,
      };

      if (options.proxy) {
        launchOptions.proxy = {
          server: options.proxy
        };
      }

      browser = await launchPlaywright(browserType, launchOptions);
      const context = await browser.newContext({
        userAgent: options.userAgent || this.getRandomUserAgent(),
        viewport: {
          width: options.width || 1920,
          height: options.height || 1080
        },
        ...options.contextOptions
      });

      const page = await context.newPage();

      // Similar navigation and retry logic as puppeteer
      await retryOperation(async () => {
        const response = await page.goto(url, {
          waitUntil: options.waitUntil || 'networkidle',
          timeout: options.timeout || 30000
        });

        if (response.status() === 429) {
          logger.warn('Received 429 Too Many Requests, applying exponential backoff...');
          throw new Error('429 Too Many Requests');
        }

        if (response.status() >= 500) {
          logger.warn(`Received ${response.status()} error, retrying immediately...`);
          throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }

        if (response.status() >= 400) {
          throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
        }
      }, { retries: 3 });

      let result = {};
      
      if (options.evaluate) {
        result.data = await page.evaluate(options.evaluate);
      } else {
        result.content = await page.content();
        result.url = page.url();
        result.title = await page.title();
      }

      await browser.close();
      return result;

    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  async scrape(url, options = {}) {
    const engine = options.engine || 'puppeteer';
    
    logger.info(`Scraping ${url} with ${engine}`);
    
    if (engine === 'playwright') {
      return await this.scrapeWithPlaywright(url, options);
    } else {
      return await this.scrapeWithPuppeteer(url, options);
    }
  }

  getVPNStatus() {
    return this.expressVPN;
  }

  getUserAgent() {
    return this.currentUserAgent || this.getRandomUserAgent();
  }
}

// Singleton instance
let scraperInstance = null;

export function getWebScraper(agent) {
  if (!scraperInstance) {
    scraperInstance = new WebScraperService(agent);
  }
  return scraperInstance;
}
