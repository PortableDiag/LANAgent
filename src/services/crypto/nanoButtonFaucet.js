import { cryptoLogger as logger } from '../../utils/logger.js';
import { launchBrowser } from '../../utils/stealthBrowser.js';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const FAUCET_URL = 'https://thenanobutton.com';
const CLICK_COUNT = 50;
const CLICK_DELAY_MS = 150;
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between claims
const SCREENSHOT_DIR = '/tmp/nanofaucet';
const XVFB_DISPLAY = ':99';
const DISABLED = true; // Disabled: Turnstile captcha doesn't auto-solve in headless or Xvfb

class NanoButtonFaucet {
    constructor() {
        this.lastClaim = 0;
        this.running = false;
        this.stats = { totalClaims: 0, totalNyano: 0, lastTxHash: null, lastError: null };
        this.xvfbProcess = null;
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}
    }

    canClaim() {
        if (DISABLED) return { can: false, reason: 'Faucet automation is disabled' };
        if (this.running) return { can: false, reason: 'Faucet claim already in progress' };
        if (Date.now() - this.lastClaim < COOLDOWN_MS) {
            const remaining = Math.ceil((this.lastClaim + COOLDOWN_MS - Date.now()) / (60 * 1000));
            return { can: false, reason: `On cooldown, ${remaining} minutes remaining` };
        }
        return { can: true };
    }

    _startXvfb() {
        try {
            // Kill any existing Xvfb on this display
            try { execSync(`pkill -f "Xvfb ${XVFB_DISPLAY}"`, { stdio: 'ignore' }); } catch {}
            this._sleep(500);

            this.xvfbProcess = spawn('Xvfb', [
                XVFB_DISPLAY,
                '-screen', '0', '1280x800x24',
                '-ac', // disable access control
                '-nolisten', 'tcp'
            ], { stdio: 'ignore', detached: true });

            this.xvfbProcess.unref();

            // Give Xvfb time to start
            execSync('sleep 1');
            logger.info(`NanoButton faucet: Xvfb started on display ${XVFB_DISPLAY}`);
            return true;
        } catch (error) {
            logger.error(`NanoButton faucet: Failed to start Xvfb: ${error?.message}`);
            return false;
        }
    }

    _stopXvfb() {
        try {
            if (this.xvfbProcess) {
                this.xvfbProcess.kill();
                this.xvfbProcess = null;
            }
            try { execSync(`pkill -f "Xvfb ${XVFB_DISPLAY}"`, { stdio: 'ignore' }); } catch {}
            logger.info('NanoButton faucet: Xvfb stopped');
        } catch {}
    }

    async claim(nanoAddress) {
        const check = this.canClaim();
        if (!check.can) return { success: false, error: check.reason };

        if (!nanoAddress || !nanoAddress.startsWith('nano_')) {
            return { success: false, error: 'Invalid Nano address' };
        }

        this.running = true;
        let browser = null;

        // Clear old screenshots
        try {
            const files = fs.readdirSync(SCREENSHOT_DIR);
            for (const f of files) fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
        } catch {}

        try {
            logger.info(`NanoButton faucet: starting claim for ${nanoAddress}`);

            // Start Xvfb virtual display
            const xvfbStarted = this._startXvfb();
            if (!xvfbStarted) {
                throw new Error('Failed to start Xvfb virtual display');
            }

            // Launch in non-headless mode on the virtual display
            browser = await launchBrowser({
                headless: false,
                executablePath: '/usr/bin/chromium',
                args: [
                    '--disable-features=VizDisplayCompositor',
                    `--display=${XVFB_DISPLAY}`,
                    '--window-size=1280,800',
                    '--disable-gpu'
                ],
                env: { ...process.env, DISPLAY: XVFB_DISPLAY }
            });

            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1280, height: 800 });

            // Mask webdriver detection
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                window.chrome = { runtime: {} };
                // Additional stealth: override permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters);
            });

            // Navigate to the faucet
            logger.info('NanoButton faucet: navigating to site (non-headless + Xvfb)');
            await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for the React app to render
            await page.waitForSelector('button', { timeout: 15000 });
            await this._sleep(2000);

            await this._screenshot(page, '01-loaded');

            // STEP 1: Wait for Turnstile captcha FIRST
            const captchaSolved = await this._waitForCaptcha(page);
            await this._screenshot(page, '02-after-captcha');

            if (!captchaSolved) {
                logger.error('NanoButton faucet: captcha NOT solved - aborting (clicks won\'t count)');
                this.stats.lastError = 'Turnstile captcha did not auto-solve';
                return { success: false, error: 'Turnstile captcha did not auto-solve' };
            }

            // Log page state before clicking
            const preClickState = await page.evaluate(() => {
                const text = document.body.innerText || '';
                const nyanoMatch = text.match(/(?:Nyano|nyano|earned|balance)[\s\S]{0,50}/gi);
                return {
                    buttonCount: document.querySelectorAll('button').length,
                    snippets: nyanoMatch || [],
                    hasTurnstile: !!document.querySelector('iframe[src*="turnstile"], [class*="turnstile"]')
                };
            }).catch(() => ({}));
            logger.info(`NanoButton faucet: pre-click state: ${JSON.stringify(preClickState)}`);

            // STEP 2: Click the big nano button
            logger.info(`NanoButton faucet: clicking ${CLICK_COUNT} times`);
            let clicksSuccessful = 0;
            for (let i = 0; i < CLICK_COUNT; i++) {
                try {
                    const clicked = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        let largest = null;
                        let maxArea = 0;
                        for (const btn of buttons) {
                            const rect = btn.getBoundingClientRect();
                            const area = rect.width * rect.height;
                            if (area > maxArea && rect.width > 50) {
                                maxArea = area;
                                largest = btn;
                            }
                        }
                        if (largest) { largest.click(); return true; }
                        return false;
                    });
                    if (clicked) clicksSuccessful++;
                    await this._sleep(CLICK_DELAY_MS);
                } catch {
                    break;
                }
            }
            logger.info(`NanoButton faucet: ${clicksSuccessful} clicks completed`);

            await this._screenshot(page, '03-after-clicks');

            // Check Nyano count after clicking
            const nyanoAfterClicks = await page.evaluate(() => {
                const text = document.body.innerText || '';
                // Look for the Nyano counter near the top
                const m = text.match(/(\d[\d,]*)\s*Nyano/i);
                return m ? parseInt(m[1].replace(/,/g, '')) : 0;
            }).catch(() => 0);
            logger.info(`NanoButton faucet: Nyano after clicks: ${nyanoAfterClicks}`);

            if (nyanoAfterClicks === 0) {
                logger.warn('NanoButton faucet: 0 Nyano earned after clicking - captcha may not have registered');
                await this._screenshot(page, '03b-zero-nyano');
            }

            // STEP 3: Wait for state to settle
            await this._sleep(2000);

            // STEP 4: Attempt withdrawal
            const result = await this._withdraw(page, nanoAddress);

            await this._screenshot(page, '04-after-withdraw');

            this.lastClaim = Date.now();
            this.stats.totalClaims++;
            if (result.nyano) this.stats.totalNyano += result.nyano;
            if (result.txHash) this.stats.lastTxHash = result.txHash;
            this.stats.lastError = null;

            logger.info(`NanoButton faucet: claim done - ${result.nyano || '?'} Nyano, tx: ${result.txHash || 'N/A'}, messages: ${JSON.stringify(result.messages)}`);

            // Auto-pocket after withdrawal (wait 15s for block to propagate)
            setTimeout(async () => {
                try {
                    const nanoService = (await import('./nanoService.js')).default;
                    await nanoService.receiveAll(nanoAddress);
                    logger.info('NanoButton faucet: auto-pocketed received funds');
                } catch (err) {
                    logger.warn('NanoButton faucet: auto-pocket failed:', err.message);
                }
            }, 15000);

            return { success: true, clicks: clicksSuccessful, nyanoEarned: nyanoAfterClicks, ...result };
        } catch (error) {
            const msg = error?.message || String(error);
            this.stats.lastError = msg;
            logger.error(`NanoButton faucet error: ${msg}`);
            return { success: false, error: msg };
        } finally {
            this.running = false;
            if (browser) {
                try { await browser.close(); } catch {}
            }
            this._stopXvfb();
        }
    }

    async _waitForCaptcha(page) {
        try {
            const hasCaptcha = await page.evaluate(() => {
                return !!document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], [class*="turnstile"]');
            }).catch(() => false);

            if (!hasCaptcha) {
                logger.info('NanoButton faucet: no captcha detected');
                return true;
            }

            logger.info('NanoButton faucet: waiting for Turnstile captcha to auto-solve (Xvfb mode)...');

            // Try clicking the Turnstile checkbox to help trigger it
            try {
                const turnstileFrame = page.frames().find(f => f.url().includes('turnstile') || f.url().includes('challenges.cloudflare'));
                if (turnstileFrame) {
                    logger.info('NanoButton faucet: found Turnstile iframe, attempting click');
                    await turnstileFrame.click('input[type="checkbox"]').catch(() => {});
                    await this._sleep(2000);
                }
            } catch {}

            for (let i = 0; i < 45; i++) {
                await this._sleep(1000);
                const solved = await page.evaluate(() => {
                    const resp = document.querySelector('[name="cf-turnstile-response"]');
                    return resp && resp.value && resp.value.length > 0;
                }).catch(() => false);

                if (solved) {
                    logger.info(`NanoButton faucet: Turnstile captcha solved after ${i + 1}s`);
                    return true;
                }

                // Log progress every 10s
                if ((i + 1) % 10 === 0) {
                    logger.info(`NanoButton faucet: still waiting for captcha... ${i + 1}s`);
                    await this._screenshot(page, `02-captcha-wait-${i + 1}s`);
                }
            }

            logger.warn('NanoButton faucet: Turnstile did not auto-solve within 45s');
            return false;
        } catch (error) {
            logger.warn(`NanoButton faucet: captcha check error: ${error?.message}`);
            return false;
        }
    }

    async _withdraw(page, nanoAddress) {
        // Type the nano address into the input field
        const inputFound = await page.evaluate((addr) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            for (const inp of inputs) {
                const ph = (inp.placeholder || '').toLowerCase();
                if (ph.includes('nano') || ph.includes('address') || inp.type === 'text') {
                    inp.focus();
                    inp.value = '';
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeInputValueSetter.call(inp, addr);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return inp.value === addr;
                }
            }
            return false;
        }, nanoAddress).catch(() => false);

        if (!inputFound) {
            throw new Error('Could not find address input field or value not set');
        }
        logger.info('NanoButton faucet: address entered into input field');

        await this._sleep(1000);

        // Click the withdraw button
        const withdrawClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            for (const btn of buttons) {
                const text = (btn.textContent || '').toLowerCase();
                if (text.includes('withdraw')) {
                    btn.click();
                    return text;
                }
            }
            return false;
        }).catch(() => false);

        if (!withdrawClicked) {
            throw new Error('Could not find withdraw button');
        }
        logger.info(`NanoButton faucet: clicked withdraw button (text: "${withdrawClicked}")`);

        // Wait for the withdrawal to process
        await this._sleep(8000);

        await this._screenshot(page, '04b-withdrawal-result');

        // Check for result
        const result = await page.evaluate((ourAddr) => {
            const text = document.body.innerText || '';

            // Look for tx hash in links
            const links = Array.from(document.querySelectorAll('a[href*="nanexplorer"], a[href*="nanocrawler"], a[href*="blocks"], a[href*="nanolooker"]'));
            let txHash = null;
            for (const link of links) {
                const match = link.href.match(/(?:block|blocks)\/([A-F0-9]{64})/i);
                if (match) txHash = match[1];
            }

            // Notification messages
            const notificationSelectors = [
                '.ant-message-custom-content', '.ant-notification-notice',
                '.toast', '.notification', '.alert',
                '[class*="success"]', '[class*="error"]'
            ];
            let messages = [];
            for (const sel of notificationSelectors) {
                const els = document.querySelectorAll(sel);
                els.forEach(el => {
                    const t = (el.textContent || '').trim();
                    if (t && t.length < 500 && !messages.includes(t)) messages.push(t);
                });
            }

            // Nyano amounts
            let nyano = null;
            const patterns = [
                /(\d[\d,]*)\s*Nyano/i,
                /Your Nyano Earned[\s\S]*?([\d,]+)/i,
                /earned[\s:]*?([\d,]+)\s*nyano/i
            ];
            for (const pat of patterns) {
                const m = text.match(pat);
                if (m) {
                    nyano = parseInt(m[1].replace(/,/g, ''));
                    if (nyano > 0) break;
                }
            }

            const addressOnPage = text.includes(ourAddr) || text.includes(ourAddr.substring(0, 20));
            const hasSuccess = messages.some(m => /success|sent|transaction|withdraw/i.test(m)) || !!txHash;
            const errorMsg = messages.find(m => /error|fail|captcha|invalid|insufficient/i.test(m));

            return { hasSuccess, txHash, nyano, errorMsg, messages, addressOnPage };
        }, nanoAddress).catch(() => ({ hasSuccess: false, txHash: null, nyano: null, errorMsg: 'Page evaluation failed' }));

        logger.info(`NanoButton faucet: withdrawal result - success=${result.hasSuccess}, txHash=${result.txHash}, nyano=${result.nyano}, addressOnPage=${result.addressOnPage}, messages=${JSON.stringify(result.messages)}`);

        if (result.errorMsg && !result.hasSuccess) {
            throw new Error(`Withdrawal error: ${result.errorMsg}`);
        }

        return {
            withdrawn: result.hasSuccess,
            txHash: result.txHash,
            nyano: result.nyano,
            messages: result.messages,
            addressOnPage: result.addressOnPage
        };
    }

    async _screenshot(page, name) {
        try {
            const filePath = path.join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
            await page.screenshot({ path: filePath, fullPage: true });
            logger.info(`NanoButton faucet: screenshot saved to ${filePath}`);
        } catch (err) {
            logger.warn(`NanoButton faucet: screenshot failed: ${err?.message}`);
        }
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    getStatus() {
        return {
            ...this.stats,
            lastClaim: this.lastClaim ? new Date(this.lastClaim).toISOString() : null,
            running: this.running,
            canClaim: this.canClaim()
        };
    }
}

export default new NanoButtonFaucet();
