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

  /**
   * Detect the VPN and record its current exit.
   *
   * This reported "ExpressVPN not available or not installed" for ~8 months while the
   * tunnel was up the entire time: ExpressVPN renamed its CLI `expressvpn` →
   * `expressvpnctl` on 2025-12-18, and this method (last touched the same day) kept
   * shelling out to the old name, which now ENOENTs straight into the catch.
   *
   * Prefer the VPN plugin, which was migrated and already owns the new CLI, the connect
   * serialization and the circuit breaker. Fall back to the raw new CLI so dev boxes
   * without a registered plugin still detect correctly; the pre-rename binary is gone
   * everywhere, so it is not worth a third branch.
   *
   * Detection only — nothing here changes the tunnel.
   */
  async checkExpressVPN() {
    const vpn = this._vpnPlugin();
    if (vpn?.status) {
      try {
        const st = await vpn.status({});
        const ex = st?.expressvpn || st || {};
        this.expressVPN.enabled = true;
        this.expressVPN.currentLocation = ex.location || null;
        logger.info(`ExpressVPN detected via plugin — ${ex.connected ? `Connected (${ex.location || 'unknown exit'})` : 'Disconnected'}`);
        return;
      } catch (err) {
        logger.warn(`VPN plugin status failed, falling back to CLI: ${err.message}`);
      }
    }

    try {
      const { stdout } = await execAsync('expressvpnctl status');
      this.expressVPN.enabled = true;
      this.expressVPN.currentLocation = this.parseVPNLocation(stdout);
      logger.info(`ExpressVPN detected - Status: ${stdout.includes('Connected') ? 'Connected' : 'Disconnected'}`);
    } catch (error) {
      logger.info('ExpressVPN not available or not installed');
      this.expressVPN.enabled = false;
      this.expressVPN.currentLocation = null;
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

  // Resolve the VPNPlugin via the agent so we go through its serialization
  // and circuit-breaker logic. Avoids the race that hits when two raw
  // expressvpn calls overlap and both time out at 5s.
  _vpnPlugin() {
    const entry = this.agent?.apiManager?.apis?.get('vpn');
    return entry?.instance || entry || null;
  }

  // connectVPN() / disconnectVPN() REMOVED (2026-08-11) along with rotateVPNLocation().
  //
  // Both were provably uncalled — the only call site in the codebase was the dead
  // `handle403` branch below — and both mutated the tunnel through an explicit-location
  // connect, the branch VPN_EXIT_COUNTRY does not filter. connectVPN() with no argument
  // resolved to connect({location:'smart'}), which can land on a non-US exit. They also
  // still shelled out to the pre-rename `expressvpn` binary in their fallback path, so
  // the fallback could not have worked since 2025-12-18 either.
  //
  // This service now READS VPN state and never changes it. Deliberate: ALICE's egress is
  // shared, Network Lock is enabled, and a tunnel flap takes crypto RPC and every
  // in-flight scrape with it. Exit changes belong to the VPN plugin, driven by the
  // external scrape route's US-only pool.

  // rotateVPNLocation() REMOVED (2026-08-11).
  //
  // It picked a UNIFORMLY RANDOM region from the full ExpressVPN list and connected to
  // it on any scrape 403. Three reasons it is gone rather than repaired:
  //
  //   1. It never ran. `rotating VPN location` appears ZERO times in ALICE's logs. It
  //      was dead the whole time because checkExpressVPN() above had been failing since
  //      the 2025-12-18 CLI rename — restoring detection would have ARMED it for the
  //      first time, eight months after it was last looked at.
  //   2. The region list is unfiltered, so it breaks the US exit pin — and the pin does
  //      not catch it, because VPN_EXIT_COUNTRY is enforced only inside smartConnect(),
  //      never on the explicit connect({location}) this took. vpn.js:375 records a live
  //      incident of exactly this (overlapping rotations to canada-vancouver).
  //   3. A rotation is a host-wide disconnect/reconnect under an enabled Network Lock,
  //      so it takes crypto RPC and in-flight scrapes with it.
  //
  // The anti-block rotation that actually does the work lives in
  // api/external/routes/scraping.js: US-only VPN_ROTATION_POOL, MAX_VPN_ROTATIONS cap,
  // budget-aware. 25 rotations on record, zero non-US destinations ever. That one is the
  // product feature and is deliberately untouched — this was a stale duplicate of it.

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
      // The `handle403` pre-emptive reconnect was removed with the rotation above. No
      // caller anywhere in the codebase ever set the option, and it resolved to
      // connect({location:'smart'}) — an explicit-location connect, which is the branch
      // the VPN_EXIT_COUNTRY pin does NOT filter, so "smart" could legitimately land on
      // a non-US exit. Dead for eight months behind the same broken detection flag;
      // restoring detection would have armed it.

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

      // Navigate with retry logic.
      // waitUntil defaults to 'domcontentloaded' (not 'networkidle2'): on
      // tracker/ad-heavy pages the network never goes idle, so networkidle2 hits
      // the full timeout every time — and retried 3× that's a 90s hang for a page
      // that actually loaded fine. We only RETRY recoverable HTTP errors
      // (403/429/5xx); a navigation *timeout* means the DOM is most likely usable
      // already, so we proceed and extract rather than retry the hang.
      await retryOperation(async () => {
        let response;
        try {
          response = await page.goto(url, {
            waitUntil: options.waitUntil || 'domcontentloaded',
            timeout: options.timeout || 30000
          });
        } catch (navErr) {
          if (/timeout|timed out/i.test(navErr.message)) {
            logger.warn(`Navigation wait timed out for ${url} (${navErr.message}) — proceeding with the loaded DOM`);
            return; // do not retry; extract whatever rendered
          }
          throw navErr; // genuine connection error — let retryOperation handle it
        }
        if (!response) return;

        // A 403 used to trigger the random-region rotation removed above. Deleting the
        // branch outright preserves TODAY's behaviour exactly: expressVPN.enabled has
        // been false since the 2025-12-18 CLI rename, so this never fired — it did not
        // rotate and it did not throw. Restoring detection without deleting it would
        // have silently introduced a host-wide VPN flap on every blocked page.
        // Anti-block rotation for paid scrapes is handled in the external scrape route,
        // which rotates within a US-only pool.

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

      // Give JS-rendered (SPA) content a bounded chance to populate after
      // domcontentloaded — wait up to 6s for real body text, but never hang on it.
      // If it never fills (a true JS shell or a genuinely short page), we extract
      // what's there and let the caller's quality gate decide.
      await page.waitForFunction(
        () => document.body && document.body.innerText && document.body.innerText.trim().length > 500,
        { timeout: options.contentSettleTimeout || 6000 }
      ).catch(() => { /* shell or short page — extract anyway */ });

      // Wait for selector if specified
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: options.selectorTimeout || 10000
        }).catch(() => { /* selector optional — don't fail the whole render */ });
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
