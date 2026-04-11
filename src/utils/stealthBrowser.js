/**
 * Stealth browser utility — wraps puppeteer-extra and playwright-extra
 * with anti-bot-detection stealth plugins applied.
 *
 * All browser automation in the codebase should import from here instead
 * of directly from 'puppeteer' or 'playwright' to get stealth by default.
 *
 * Falls back to plain puppeteer/playwright if stealth packages aren't installed.
 *
 * Usage:
 *   import { launchBrowser, launchPlaywright } from '../utils/stealthBrowser.js';
 *   const browser = await launchBrowser({ headless: 'new' });
 *   const browser = await launchPlaywright('chromium', { headless: true });
 */

import { logger } from './logger.js';

let puppeteerImpl = null;
let stealthApplied = false;

async function getPuppeteer() {
  if (puppeteerImpl) return puppeteerImpl;

  try {
    const puppeteerExtra = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteerExtra.use(StealthPlugin());
    puppeteerImpl = puppeteerExtra;
    stealthApplied = true;
    logger.info('Stealth Puppeteer loaded (puppeteer-extra + stealth plugin)');
  } catch (error) {
    logger.warn(`puppeteer-extra not available, falling back to plain puppeteer: ${error.message}`);
    puppeteerImpl = (await import('puppeteer')).default;
  }

  return puppeteerImpl;
}

/**
 * Launch a stealth Puppeteer browser.
 * Drop-in replacement for puppeteer.launch() with stealth pre-applied.
 * Includes aggressive anti-detection args to bypass Cloudflare and similar WAFs.
 *
 * Uses non-headless mode via Xvfb when available for better fingerprinting.
 * Falls back to headless: 'new' when no display is available.
 */
async function launchBrowser(options = {}) {
  const pptr = await getPuppeteer();

  // Check if Xvfb display is available for non-headless mode
  let useHeadless = options.headless ?? 'new';
  if (useHeadless !== false && !process.env.DISPLAY) {
    // Try to start Xvfb for non-headless (better anti-detection)
    try {
      const { execSync } = await import('child_process');
      execSync('pgrep -x Xvfb > /dev/null 2>&1 || (Xvfb :99 -screen 0 1920x1080x24 &)', { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 500));
      process.env.DISPLAY = ':99';
      useHeadless = false;
      logger.info('Started Xvfb :99 for non-headless stealth mode');
    } catch {
      logger.debug('Xvfb not available, using headless mode');
    }
  } else if (process.env.DISPLAY) {
    useHeadless = false;
  }

  const defaults = {
    headless: useHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized',
      '--lang=en-US,en',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--user-data-dir=/tmp/puppeteer-profile'
    ]
  };

  const merged = {
    ...defaults,
    ...options,
    headless: useHeadless,
    args: [...(defaults.args), ...(options.args || [])].filter((v, i, a) => a.indexOf(v) === i)
  };

  logger.debug('Launching Puppeteer browser', { headless: merged.headless, stealth: stealthApplied });
  return pptr.launch(merged);
}

/**
 * Launch a stealth Playwright browser.
 * Dynamically imports playwright-extra to avoid loading it when unused.
 * @param {string} browserType - 'chromium', 'firefox', or 'webkit'
 */
async function launchPlaywright(browserType = 'chromium', options = {}) {
  try {
    const playwrightExtra = await import('playwright-extra');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    const browser = playwrightExtra[browserType];

    if (!browser) {
      throw new Error(`Unknown playwright browser type: ${browserType}`);
    }

    browser.use(StealthPlugin());

    const defaults = {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    };

    const merged = {
      ...defaults,
      ...options,
      args: [...(defaults.args), ...(options.args || [])].filter((v, i, a) => a.indexOf(v) === i)
    };

    logger.debug(`Launching stealth Playwright ${browserType}`, { headless: merged.headless });
    return browser.launch(merged);
  } catch (error) {
    // Fall back to plain playwright if playwright-extra isn't available
    logger.warn(`playwright-extra not available, falling back to plain playwright: ${error.message}`);
    const playwright = await import('playwright');
    return playwright[browserType].launch(options);
  }
}

// Export a proxy that lazily loads puppeteer on access
const puppeteerProxy = new Proxy({}, {
  get(_, prop) {
    if (prop === 'launch') return launchBrowser;
    // For any other property, delegate to the actual puppeteer instance
    return async (...args) => {
      const pptr = await getPuppeteer();
      return typeof pptr[prop] === 'function' ? pptr[prop](...args) : pptr[prop];
    };
  }
});

export { puppeteerProxy as puppeteer, launchBrowser, launchPlaywright };
export default puppeteerProxy;
