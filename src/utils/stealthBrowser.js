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

  // v2.25.89: prefer rebrowser-puppeteer-core as the underlying Puppeteer
  // implementation under puppeteer-extra. rebrowser is a Puppeteer fork
  // specifically patched against modern CDP-detection vectors
  // (Runtime.evaluate timing, isolated-world detection, the console.log
  // slowdown that's used as a "DevTools open" tell). Stealth plugin still
  // applies on top — they complement each other rather than conflict.
  //
  // rebrowser-puppeteer-core has no bundled Chromium, so we point it at
  // the Chromium that the regular `puppeteer` package downloaded into
  // node_modules. Falls back to plain puppeteer-extra → plain puppeteer.
  try {
    const { addExtra } = await import('puppeteer-extra');
    let baseImpl;
    let basePath = 'puppeteer';
    try {
      const rebrowser = (await import('rebrowser-puppeteer-core')).default;
      // Resolve Chromium path from the regular puppeteer install
      const plainPuppeteer = (await import('puppeteer')).default;
      const chromiumPath = typeof plainPuppeteer.executablePath === 'function'
        ? plainPuppeteer.executablePath()
        : null;
      if (chromiumPath) {
        // Wrap launch() to inject executablePath so callers don't have to
        const origLaunch = rebrowser.launch.bind(rebrowser);
        rebrowser.launch = (opts = {}) => origLaunch({ executablePath: chromiumPath, ...opts });
        baseImpl = rebrowser;
        basePath = `rebrowser-puppeteer-core (chromium: ${chromiumPath})`;
      } else {
        baseImpl = plainPuppeteer;
        logger.warn('rebrowser-puppeteer-core present but Chromium path unresolved — falling back to plain puppeteer');
      }
    } catch {
      // rebrowser-puppeteer-core not installed — use the bundled puppeteer
      baseImpl = (await import('puppeteer')).default;
    }
    const puppeteerExtra = addExtra(baseImpl);
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteerExtra.use(StealthPlugin());
    puppeteerImpl = puppeteerExtra;
    stealthApplied = true;
    logger.info(`Stealth Puppeteer loaded (${basePath} + puppeteer-extra + stealth plugin)`);
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
  // When the caller EXPLICITLY asks for headless, honor it and skip the Xvfb /
  // shared-DISPLAY override entirely (v2.25.107). The non-headless-on-Xvfb path
  // exists for anti-detection on LIVE navigations, but it forces every browser
  // onto the single :99 display — concurrent rasters then serialize on one X
  // compositor (a tall screenshot ballooned to 175s under load). The screenshot
  // browser renders pre-fetched setContent HTML (no live bot wall), so it wants
  // true headless: off-display, no compositor contention.
  const explicitHeadless = Object.prototype.hasOwnProperty.call(options, 'headless');
  if (!explicitHeadless) {
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
  }

  // v2.25.89: GPU detection. DataDome's fingerprint check treats SwiftShader
  // (software rendering) as a near-definitive bot tell. Real users render via
  // an actual GPU, so the WebGL vendor string is "AMD/ATI", "Intel", "Apple",
  // etc. — never "Google SwiftShader" or "ANGLE software". If we have a DRI
  // render node and pasing --disable-gpu was forcing Chrome to SwiftShader, we
  // now enable hardware acceleration and let Chrome talk to /dev/dri.
  let gpuArgs;
  // Hardware desktop-GL (--use-gl=desktop) needs a real/Xvfb display. In TRUE
  // headless (no X) it crashes the renderer mid-capture ("Target closed"), so a
  // headless browser must use software raster. Only the non-headless (Xvfb)
  // path gets hardware GL — which is also the only path that needs it (the
  // anti-detection WebGL-vendor reason below applies to live navigations).
  const trulyHeadless = useHeadless !== false;
  try {
    const { existsSync } = await import('fs');
    const hasRenderNode = existsSync('/dev/dri/renderD128') || existsSync('/dev/dri/card0');
    if (hasRenderNode && !trulyHeadless) {
      gpuArgs = [
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--ignore-gpu-blocklist',
        '--use-gl=desktop'
      ];
      logger.info('GPU args: hardware acceleration enabled (/dev/dri present)');
    } else {
      gpuArgs = ['--disable-gpu', '--disable-accelerated-2d-canvas'];
      logger.info(`GPU args: software raster (${trulyHeadless ? 'headless' : 'no /dev/dri'})`);
    }
  } catch {
    gpuArgs = ['--disable-gpu', '--disable-accelerated-2d-canvas'];
  }

  const defaults = {
    headless: useHeadless,
    // Default 30s protocolTimeout was triggering unhandledRejection on CDP
    // Network.enable for slow Cloudflare-gated pages. Bump to 180s so the
    // initial frame/network setup has room to complete on hostile WAFs.
    protocolTimeout: 180000,
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
      ...gpuArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      // Parameterized so a second, isolated browser (e.g. the dedicated
      // screenshot browser) can run concurrently. Two Chromium processes CANNOT
      // share one --user-data-dir — they collide on the profile SingletonLock and
      // the second launch fails/attaches to the first. Pass a distinct
      // `userDataDir` for any concurrent instance.
      `--user-data-dir=${options.userDataDir || '/tmp/puppeteer-profile'}`
    ]
  };

  // userDataDir is consumed into an arg above, not a launch option.
  const { userDataDir: _udd, ...optionsRest } = options;

  const merged = {
    ...defaults,
    ...optionsRest,
    headless: useHeadless,
    args: [...(defaults.args), ...(optionsRest.args || [])].filter((v, i, a) => a.indexOf(v) === i)
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
