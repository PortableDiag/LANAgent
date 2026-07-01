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
/**
 * Clear a STALE Chromium SingletonLock before launching.
 *
 * Chromium guards a profile with `<profile>/SingletonLock`, a symlink whose
 * target is `<hostname>-<pid>`. If a browser crashes or is killed without a
 * clean shutdown (a timed-out launch, an OOM, a `kill -9`), the symlink is left
 * behind pointing at a now-dead PID. Every subsequent launch on that profile
 * then fails instantly with "Failed to launch the browser process! undefined"
 * — and each failed attempt re-creates the stale lock, so the profile stays
 * wedged until the process is restarted by hand. Seen on DELTA 2026-06-27: the
 * failover's browser scraping was silently dead for over an hour.
 *
 * This removes the lock ONLY when its owning PID is not alive — so it's a no-op
 * when a real browser legitimately holds the profile (the concurrent-instance
 * case the userDataDir comment below warns about), and self-heals the crash case.
 */
async function clearStaleSingletonLock(profileDir) {
  try {
    const { readlinkSync, unlinkSync, existsSync } = await import('fs');
    const path = (await import('path')).default;
    const lockPath = path.join(profileDir, 'SingletonLock');
    if (!existsSync(lockPath)) return;
    let ownerPid = null;
    try {
      const target = readlinkSync(lockPath); // e.g. "squid-1395727"
      const m = String(target).match(/-(\d+)$/);
      if (m) ownerPid = parseInt(m[1], 10);
    } catch { /* not a symlink / unreadable — treat as stale below */ }
    let alive = false;
    if (ownerPid) {
      try { process.kill(ownerPid, 0); alive = true; } catch { alive = false; }
    }
    if (!alive) {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { unlinkSync(path.join(profileDir, f)); } catch { /* already gone */ }
      }
      logger.info(`Cleared stale Chromium SingletonLock in ${profileDir} (owner pid ${ownerPid || '?'} dead)`);
    }
  } catch (e) {
    logger.debug(`SingletonLock stale-check skipped: ${e.message}`);
  }
}

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
  if (!explicitHeadless && useHeadless !== false) {
    // Non-headless on Xvfb gives better anti-detection, but ONLY if the display
    // is actually connectable. The old check was `pgrep -x Xvfb || start :99` —
    // which is wrong: a STRAY Xvfb on some other display (seen on DELTA 2026-06-27:
    // `Xvfb :1867971576` from an unrelated process) makes pgrep succeed, so :99 is
    // never started, yet DISPLAY=:99 is set anyway → :99 is dead → Chrome fails to
    // launch with the opaque "Failed to launch the browser process! undefined", and
    // the scraper's browser scraping goes silently dead. Validate the SPECIFIC
    // display's socket (/tmp/.X11-unix/X99), start a dedicated :99 if absent, and
    // fall back to true headless if it never comes up — so a missing/broken Xvfb
    // degrades to working-headless instead of breaking all browser scrapes.
    const displayNum = 99;
    const sock = `/tmp/.X11-unix/X${displayNum}`;
    try {
      const { existsSync } = await import('fs');
      const alreadyOnDisplay = process.env.DISPLAY === `:${displayNum}` && existsSync(sock);
      let xvfbUp = existsSync(sock);
      if (!xvfbUp && !alreadyOnDisplay) {
        const { spawn } = await import('child_process');
        // Detached + unref so it outlives this call; gate on the socket, not pgrep.
        try {
          spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
            { detached: true, stdio: 'ignore' }).unref();
        } catch { /* Xvfb binary missing — handled by the fallback below */ }
        for (let i = 0; i < 16 && !xvfbUp; i++) {
          await new Promise(r => setTimeout(r, 250));
          xvfbUp = existsSync(sock);
        }
      }
      if (xvfbUp) {
        process.env.DISPLAY = `:${displayNum}`;
        useHeadless = false;
        logger.info(`Using Xvfb :${displayNum} for non-headless stealth mode`);
      } else {
        useHeadless = 'new';
        logger.warn(`Xvfb :${displayNum} not connectable — falling back to headless (browser scraping stays up)`);
      }
    } catch (e) {
      useHeadless = 'new';
      logger.debug(`Xvfb setup skipped (${e.message}) — using headless`);
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
      //
      // DISK-backed by default (/var/tmp), NOT /tmp. /tmp is a RAM tmpfs on the
      // agents; the profile's Chrome cache grows unbounded (12G seen on DELTA
      // 2026-06-27) and filling the tmpfs took the whole box down (a full /tmp
      // made dns-pin write an empty /etc/hosts → localhost dead → Mongo → outage).
      // On disk it can grow harmlessly. Override with PUPPETEER_PROFILE_DIR.
      `--user-data-dir=${options.userDataDir || process.env.PUPPETEER_PROFILE_DIR || '/var/tmp/puppeteer-profile'}`
    ]
  };

  // Self-heal a stale SingletonLock on the target profile before launching, so a
  // previously-crashed browser doesn't wedge every future launch (see helper).
  const resolvedProfileDir = options.userDataDir || process.env.PUPPETEER_PROFILE_DIR || '/var/tmp/puppeteer-profile';
  await clearStaleSingletonLock(resolvedProfileDir);

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
