import { BasePlugin } from '../core/basePlugin.js';
import { extractParams, asksToWatch } from '../../services/webtools/extractParams.js';
import WebWatch from '../../models/WebWatch.js';
import { assertPublicUrl } from '../../utils/publicUrl.js';
import { getWebWatchService, ensureWatchJob, readPrice } from '../../services/webtools/webWatchService.js';
import { findWatch, upsertWatch, describe, interval } from '../../services/webtools/watchCommands.js';

/**
 * Product price watching: read a product page's price now, or watch it and get an alert when
 * it reaches a target price or moves by a set percentage.
 */
export default class PriceWatchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'priceWatch';
    this.version = '1.0.0';
    this.description = 'Check a product page\'s price, or watch it and alert when it drops to a target price';
    this.commands = [
      { command: 'check', description: 'Read the current price on a product page (any shop that publishes its price; a CSS selector helps on the rest)',
        usage: 'check({ url: "https://shop.example.com/item/123" })',
        examples: ['what is the price on this product page', 'how much is this item right now', 'check the price of https://shop.example.com/item/123'] },
      { command: 'watch', description: 'Watch a product page\'s price and alert when it falls to a target price, or moves by a percentage',
        usage: 'watch({ url: "https://shop.example.com/item/123", targetPrice: 199.99, changePct: 10, name: "Monitor", interval: 360 })',
        examples: ['tell me when this drops below 200', 'watch the price of this product', 'alert me if this item goes on sale', 'track the price of this laptop and let me know when it is under $900'] },
      { command: 'unwatch', description: 'Stop watching a product\'s price',
        usage: 'unwatch({ name: "<the watched product\'s name>" })  // or url / id',
        examples: ['stop watching the monitor price', 'remove that price alert'] },
      { command: 'list', description: 'List the prices being watched, with the latest and lowest seen',
        usage: 'list', examples: ['what prices am I tracking', 'list my price alerts'] },
      { command: 'recheck', description: 'Check watched prices now (one, or all of them)',
        usage: 'recheck({ name: "Monitor" })  // no name = all',
        examples: ['check my price watches now', 'has the monitor price changed'] },
      { command: 'trend', description: 'Show how a watched price has moved over its recent checks: change, low, high and direction',
        usage: 'trend({ name: "Monitor", window: 10 })  // or url / id; window = last N checks, default all kept',
        examples: ['how has the monitor price moved', 'show the price trend for the laptop', 'is the price of that item going up or down'] }
    ];
    this.watcher = getWebWatchService(this);
  }

  async defineSchedulerJobs() {
    await ensureWatchJob(this.agent, this.watcher);
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    try {
      switch (action) {
        case 'check': return asksToWatch(p.originalInput || p._context?.originalInput) ? await this.watch(p) : await this.check(p);
        case 'watch': return await this.watch(p);
        case 'unwatch': return await this.unwatch(p);
        case 'list': return await this.list();
        case 'recheck': return await this.recheck(p);
        case 'trend': return await this.trend(p);
        default: return { success: false, error: `Unknown action '${action}'. Use: check, watch, unwatch, list, recheck, trend` };
      }
    } catch (error) {
      this.logger.warn(`priceWatch ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  scraper() {
    return this.agent?.apiManager?.getPlugin('scraper') || null;
  }

  async check({ url, selector }) {
    if (!url) throw new Error('a product page url is required');
    const r = await readPrice(await assertPublicUrl(url), { selector, scraper: this.scraper() });
    const note = r.confidence === 'low' ? ' (read from the page text, not the shop\'s price data — confirm it)' : '';
    return { success: true, ...r, url, result: `${r.title ? `${r.title}: ` : ''}${r.currency ? `${r.currency} ` : ''}${r.price}${r.availability ? ` — ${r.availability}` : ''}${note}` };
  }

  async watch({ url, targetPrice, target, price, changePct, name, selector, interval: every }) {
    if (!url) throw new Error('a product page url is required');
    const goal = [targetPrice, target, price].map(v => (v == null || v === '' ? null : Number(String(v).replace(/[^\d.]/g, '')))).find(v => Number.isFinite(v) && v > 0) ?? null;
    const pct = changePct == null || changePct === '' ? undefined : Math.max(0, Number(changePct) || 0);
    const { watch, created } = await upsertWatch('price', url, {
      name: name || undefined, selector: selector || undefined, targetPrice: goal ?? undefined,
      changePct: pct ?? (goal == null ? 5 : undefined), intervalMin: interval(every), alertedTarget: false
    });
    // Shop prices move slowly and shops rate-limit: a new price watch defaults to every 6 hours.
    if (created && every == null) { watch.intervalMin = 360; await watch.save(); }
    const first = await this.watcher.checkOne(watch.toObject());
    const w = await WebWatch.findById(watch._id);
    const cur = w.currency ? `${w.currency} ` : '';
    const rule = w.targetPrice != null ? `alert at ${cur}${w.targetPrice} or below` : `alert on a ${w.changePct}% move`;
    return { success: true, created, watch: describe(w),
      result: `${created ? 'Watching' : 'Updated'} ${w.name || w.url}: now ${cur}${first.price}; ${rule}; checked every ${w.intervalMin} min.${first.alerted ? ' It is already at or below the target — alert sent.' : ''}` };
  }

  async unwatch(p) {
    const w = await findWatch('price', p);
    await WebWatch.deleteOne({ _id: w._id });
    return { success: true, result: `Stopped watching ${w.name || w.url}` };
  }

  async list() {
    const all = await WebWatch.find({ kind: 'price' }).sort({ createdAt: 1 });
    const fmt = (n, c) => (n == null ? '—' : `${c ? `${c} ` : ''}${n}`);
    return { success: true, watches: all.map(describe),
      result: all.length ? all.map(w => `• ${w.name || w.url}: ${fmt(w.lastPrice, w.currency)} (lowest ${fmt(w.lowestPrice, w.currency)}${w.targetPrice != null ? `, target ${fmt(w.targetPrice, w.currency)}` : ''})${w.lastError ? ` — last error: ${w.lastError}` : ''}`).join('\n') : 'No prices are being watched.' };
  }

  async recheck(p) {
    if (p.url || p.name || p.id) {
      const w = await findWatch('price', p);
      const r = await this.watcher.checkOne(w.toObject());
      return { success: true, ...r, result: `${w.name || w.url}: ${r.currency ? `${r.currency} ` : ''}${r.price}${r.alerted ? ' — alert sent' : ''}` };
    }
    const r = await this.watcher.checkDue(new Date(), { force: true, kind: 'price' });
    return { success: true, ...r, result: `Checked ${r.checked || 0} price watch(es)${r.failed ? `, ${r.failed} failed` : ''}; any alert was sent.` };
  }

  async trend(p) {
    const w = await findWatch('price', p);
    const t = await WebWatch.getPriceTrend(w._id, p.window == null || p.window === '' ? undefined : Number(p.window));
    const label = w.name || w.url;
    if (!t || t.observations.length === 0) {
      return { success: true, trend: t, result: `No price history for ${label} yet — it builds up as the watch is checked.` };
    }
    const cur = w.currency ? `${w.currency} ` : '';
    const n = t.observations.length;
    const first = t.observations[0];
    const last = t.observations[n - 1];
    const pct = t.percentageChange == null ? '' : ` (${t.percentageChange > 0 ? '+' : ''}${t.percentageChange.toFixed(1)}%)`;
    const result = n === 1
      ? `${label}: one reading so far, ${cur}${last.price} on ${last.checkedAt.toISOString().slice(0, 10)}.`
      : `${label} over the last ${n} checks (${first.checkedAt.toISOString().slice(0, 10)} → ${last.checkedAt.toISOString().slice(0, 10)}): ` +
        `${cur}${first.price} → ${cur}${last.price}, ${t.direction}${t.absoluteChange ? ` ${t.absoluteChange > 0 ? '+' : ''}${Number(t.absoluteChange.toFixed(2))}` : ''}${pct}; ` +
        `low ${cur}${t.minimum}, high ${cur}${t.maximum}.`;
    return { success: true, trend: t, result };
  }
}
