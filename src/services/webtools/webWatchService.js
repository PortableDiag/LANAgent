import WebWatch, { priceHistoryLimit } from '../../models/WebWatch.js';
import { readFeed } from './feedReader.js';
import { extractPrice } from './priceExtractor.js';
import { fetchPublic } from './fetchPublic.js';
import { logger } from '../../utils/logger.js';

/**
 * Checks every due WebWatch (feeds and prices) and reports what changed. Runs from one Agenda
 * job ('web-watch-check', every 15 minutes); each watch keeps its own interval.
 */

export const JOB_NAME = 'web-watch-check';
const SEEN_CAP = 300;
const FAIL_ALERT_AT = 5;

/**
 * New feed items, oldest first. The first check only records what is already there, so
 * adding a watch does not flood the operator with the feed's back catalogue.
 */
export function diffFeedItems(watch, items) {
  const seen = new Set(watch.seen || []);
  const firstRun = seen.size === 0;
  const unseen = items.filter(i => i.id && !seen.has(i.id));
  const kw = (watch.keywords || []).map(k => k.toLowerCase()).filter(Boolean);
  const matches = i => !kw.length || kw.some(k => `${i.title} ${i.summary}`.toLowerCase().includes(k));
  const fresh = firstRun ? [] : unseen.filter(matches).reverse();
  const nextSeen = [...unseen.map(i => i.id), ...(watch.seen || [])].slice(0, SEEN_CAP);
  return { fresh, nextSeen, firstRun, seeded: firstRun ? unseen.length : 0 };
}

const money = (n, cur) => `${cur ? `${cur} ` : ''}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** What a new price reading means for a watch: the fields to save and the alert, if any. */
export function evaluatePrice(watch, reading) {
  const price = reading.price;
  const cur = reading.currency || watch.currency;
  const prev = watch.lastPrice;
  const update = {
    lastPrice: price,
    currency: cur,
    lowestPrice: watch.lowestPrice == null ? price : Math.min(watch.lowestPrice, price)
  };
  if (prev != null && prev !== price) update.lastChangeAt = new Date();
  const label = watch.name || reading.title || watch.url;
  let alert = null;

  if (watch.targetPrice != null) {
    const hit = price <= watch.targetPrice;
    if (hit && !watch.alertedTarget) {
      alert = `🎯 Price target reached: ${label}\nNow ${money(price, cur)} (target ${money(watch.targetPrice, cur)}${prev != null ? `, was ${money(prev, cur)}` : ''})\n${watch.url}`;
      update.alertedTarget = true;
    } else if (!hit && watch.alertedTarget) {
      update.alertedTarget = false; // re-arm once it goes back above the target
    }
  }
  if (!alert && prev != null && watch.changePct > 0) {
    const pct = ((price - prev) / prev) * 100;
    if (Math.abs(pct) >= watch.changePct) {
      alert = `${pct < 0 ? '📉' : '📈'} Price ${pct < 0 ? 'drop' : 'rise'} ${Math.abs(pct).toFixed(1)}%: ${label}\n${money(prev, cur)} → ${money(price, cur)}\n${watch.url}`;
    }
  }
  return { update, alert };
}

/**
 * Read a product page's price. A plain request first; when the shop refuses it or the
 * page has no machine-readable price (built by script), the scraper plugin's tiers
 * (browser, FlareSolverr) get a turn.
 */
export async function readPrice(url, { selector, scraper } = {}) {
  let reason = '';
  try {
    const res = await fetchPublic(url);
    if (res.status === 200) {
      const r = extractPrice(res.data, { selector });
      if (r && r.confidence !== 'low') return { ...r, via: 'http' };
      reason = r ? 'only a low-confidence price in the page text' : 'no price in the page';
      if (r && !scraper) return { ...r, via: 'http' };
    } else {
      reason = `HTTP ${res.status}`;
    }
  } catch (e) {
    reason = e.message;
    if (/private or local|not a valid URL|must be http/.test(e.message)) throw e;
  }
  if (scraper?.scrapePage) {
    const s = await scraper.scrapePage(url, { bypassCache: true });
    const html = s?._rawHtml;
    const r = html ? extractPrice(html, { selector }) : null;
    if (r) return { ...r, via: `scraper:${s.method || 'default'}` };
    reason += '; the scraper found none either';
  }
  throw new Error(`could not read a price (${reason})`);
}

export class WebWatchService {
  constructor({ notify, getScraper } = {}) {
    this.notify = notify || (async () => {});
    this.getScraper = getScraper || (() => null);
    this.running = false;
  }

  async checkOne(watch) {
    if (watch.kind === 'feed') {
      const feed = await readFeed(watch.url, { limit: 50 });
      const { fresh, nextSeen, firstRun, seeded } = diffFeedItems(watch, feed.items);
      const set = { seen: nextSeen, lastCheckedAt: new Date(), lastError: null, failCount: 0 };
      if (!watch.name && feed.title) set.name = feed.title;
      await WebWatch.updateOne({ _id: watch._id }, { $set: set });
      if (fresh.length) {
        const shown = fresh.slice(-8);
        const lines = shown.map(i => `• ${i.title}${i.link ? `\n  ${i.link}` : ''}`).join('\n');
        const more = fresh.length > shown.length ? `\n…and ${fresh.length - shown.length} more` : '';
        await this.notify(`📰 ${set.name || watch.name || feed.title || watch.url}: ${fresh.length} new\n${lines}${more}`);
      }
      return { kind: 'feed', newItems: fresh.length, firstRun, seeded, items: fresh };
    }

    const reading = await readPrice(watch.url, { selector: watch.selector, scraper: this.getScraper() });
    const { update, alert } = evaluatePrice(watch, reading);
    const set = { ...update, lastCheckedAt: new Date(), lastError: null, failCount: 0 };
    if (!watch.name && reading.title) set.name = reading.title;
    // Keep a bounded history of readings for trend reporting (priceWatch.trend).
    const observation = { price: reading.price, checkedAt: set.lastCheckedAt };
    await WebWatch.updateOne({ _id: watch._id }, {
      $set: set,
      $push: { priceHistory: { $each: [observation], $slice: -priceHistoryLimit(watch) } }
    });
    if (alert) await this.notify(alert);
    return { kind: 'price', price: reading.price, currency: reading.currency, source: reading.source, alerted: Boolean(alert) };
  }

  async recordFailure(watch, err) {
    const failCount = (watch.failCount || 0) + 1;
    await WebWatch.updateOne({ _id: watch._id }, { $set: { lastCheckedAt: new Date(), lastError: err.message, failCount } });
    if (failCount === FAIL_ALERT_AT) {
      await this.notify(`⚠️ Watch "${watch.name || watch.url}" has failed ${failCount} checks in a row: ${err.message}`);
    }
  }

  /** Check every active watch whose interval has elapsed (or every one, with force). */
  async checkDue(now = new Date(), { force = false, kind } = {}) {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    const summary = { checked: 0, failed: 0 };
    try {
      const watches = await WebWatch.find({ active: true, ...(kind ? { kind } : {}) }).lean();
      for (const w of watches) {
        const due = force || !w.lastCheckedAt || now - new Date(w.lastCheckedAt) >= (w.intervalMin || 60) * 60000;
        if (!due) continue;
        try {
          await this.checkOne(w);
          summary.checked++;
        } catch (err) {
          summary.failed++;
          logger.warn(`Web watch ${w.kind} ${w.url} failed: ${err.message}`);
          await this.recordFailure(w, err).catch(() => {});
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }
}

/**
 * Register the shared job once, whichever plugin gets there first. Called from the plugins'
 * defineSchedulerJobs() hook, which the agent runs once Agenda exists.
 */
let registered = false;
export async function ensureWatchJob(agent, service) {
  if (registered) return true;
  const agenda = agent?.scheduler?.agenda;
  if (!agenda) return false;
  agenda.define(JOB_NAME, async () => {
    const r = await service.checkDue();
    if (r.checked || r.failed) logger.info(`Web watches: ${r.checked} checked, ${r.failed} failed`);
  });
  await agenda.every('15 minutes', JOB_NAME);
  registered = true;
  logger.info('Web watch job scheduled (every 15 minutes)');
  return true;
}

let shared = null;
/** One service per process, shared by the feeds and priceWatch plugins. */
export function getWebWatchService(plugin) {
  if (!shared) {
    shared = new WebWatchService({
      notify: msg => plugin.notify(msg).catch(e => logger.warn(`Web watch notify failed: ${e.message}`)),
      getScraper: () => plugin.agent?.apiManager?.getPlugin('scraper') || null
    });
  }
  return shared;
}
