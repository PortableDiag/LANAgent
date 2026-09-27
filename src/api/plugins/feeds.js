import { BasePlugin } from '../core/basePlugin.js';
import { extractParams, asksToWatch } from '../../services/webtools/extractParams.js';
import WebWatch from '../../models/WebWatch.js';
import { readFeed, discoverFeeds } from '../../services/webtools/feedReader.js';
import { getWebWatchService, ensureWatchJob } from '../../services/webtools/webWatchService.js';
import { findWatch, upsertWatch, describe, interval, toList } from '../../services/webtools/watchCommands.js';

/**
 * RSS/Atom feeds: read one, find a site's feeds, and watch feeds for new posts (blogs,
 * release notes, competitors' news) with a Telegram alert for each batch of new items.
 */
export default class FeedsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'feeds';
    this.version = '1.0.0';
    this.description = 'Read RSS/Atom feeds, find a website\'s feeds, and watch feeds or blogs for new posts';
    this.commands = [
      { command: 'read', description: 'Read the latest items of an RSS or Atom feed (or of a website, by finding its feed)',
        usage: 'read({ url: "https://example.com/feed", limit: 10 })',
        examples: ['read the rss feed at https://blog.example.com/feed', 'what are the latest posts on the nodejs blog feed', 'show me the newest items in this rss feed'] },
      { command: 'discover', description: 'Find the RSS/Atom feeds a website publishes',
        usage: 'discover({ url: "https://example.com" })',
        examples: ['find the rss feed for example.com', 'does this site have an rss feed', 'what feeds does this blog publish'] },
      { command: 'watch', description: 'Watch a feed or blog and send an alert when it posts something new; optional keywords only alert on matching posts',
        usage: 'watch({ url: "https://example.com/feed", name: "Example blog", keywords: ["release"], interval: 60 })',
        examples: ['watch this blog for new posts', 'alert me when this rss feed has a new item', 'monitor the competitor news feed for posts about pricing', 'follow this feed and tell me about new releases'] },
      { command: 'unwatch', description: 'Stop watching a feed',
        usage: 'unwatch({ name: "<the watched feed\'s name>" })  // or url / id',
        examples: ['stop watching that feed', 'unfollow the example blog feed'] },
      { command: 'list', description: 'List the feeds being watched',
        usage: 'list', examples: ['what feeds am I watching', 'list my rss watches'] },
      { command: 'check', description: 'Check watched feeds now instead of waiting for the schedule (one, or all of them)',
        usage: 'check({ url: "https://example.com/feed" })  // no url = every feed watch',
        examples: ['check my feeds now', 'any new posts on the feeds I watch'] }
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
        case 'read': return asksToWatch(p.originalInput || p._context?.originalInput) && p.url ? await this.watch(p) : await this.read(p);
        case 'discover': return await this.discover(p);
        case 'watch': return await this.watch(p);
        case 'unwatch': return await this.unwatch(p);
        case 'list': return await this.list();
        case 'check': return await this.check(p);
        default: return { success: false, error: `Unknown action '${action}'. Use: read, discover, watch, unwatch, list, check` };
      }
    } catch (error) {
      this.logger.warn(`feeds ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /** A page URL rather than a feed URL is resolved to the page's first feed. */
  async resolveFeed(url) {
    if (!url) throw new Error('a feed or website url is required');
    try {
      return await readFeed(url, { limit: 50 });
    } catch (err) {
      if (!/not a (readable )?feed/.test(err.message)) throw err;
      const found = await discoverFeeds(url);
      if (!found.length) throw new Error(`${url} is not a feed and advertises none`);
      return await readFeed(found[0].url, { limit: 50 });
    }
  }

  async read({ url, limit = 10 }) {
    const feed = await this.resolveFeed(url);
    const items = feed.items.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    const result = items.map((i, n) => `${n + 1}. ${i.title}${i.published ? ` (${i.published.slice(0, 10)})` : ''}\n   ${i.link}`).join('\n');
    return { success: true, feed: { title: feed.title, url: feed.url, format: feed.format }, items, result: `${feed.title || feed.url}\n${result}` };
  }

  async discover({ url }) {
    if (!url) throw new Error('a website url is required');
    const feeds = await discoverFeeds(url);
    return { success: true, feeds, result: feeds.length ? feeds.map(f => `${f.title || '(untitled)'} — ${f.url}`).join('\n') : `No feeds found on ${url}` };
  }

  async watch({ url, name, keywords, interval: every }) {
    const feed = await this.resolveFeed(url);
    const { watch, created } = await upsertWatch('feed', feed.url, {
      name: name || feed.title || undefined, keywords: toList(keywords), intervalMin: interval(every)
    });
    // Record what is already there now, so the first scheduled check reports only newer posts.
    const first = await this.watcher.checkOne(watch.toObject());
    return { success: true, created, watch: describe(await WebWatch.findById(watch._id)),
      result: `${created ? 'Watching' : 'Updated watch on'} "${watch.name || feed.url}" every ${watch.intervalMin} min${watch.keywords?.length ? ` for: ${watch.keywords.join(', ')}` : ''}. ${first.seeded ? `${first.seeded} existing items noted; I'll report new ones.` : ''}`.trim() };
  }

  async unwatch(p) {
    const w = await findWatch('feed', p);
    await WebWatch.deleteOne({ _id: w._id });
    return { success: true, result: `Stopped watching ${w.name || w.url}` };
  }

  async list() {
    const all = await WebWatch.find({ kind: 'feed' }).sort({ createdAt: 1 });
    return { success: true, watches: all.map(describe),
      result: all.length ? all.map(w => `• ${w.name || w.url} — every ${w.intervalMin} min${w.lastError ? ` (last error: ${w.lastError})` : ''}\n  ${w.url}`).join('\n') : 'No feeds are being watched.' };
  }

  async check(p) {
    if (p.url || p.name || p.id) {
      const w = await findWatch('feed', p);
      const r = await this.watcher.checkOne(w.toObject());
      return { success: true, ...r, result: r.newItems ? `${r.newItems} new item(s) — sent as an alert` : `Nothing new on ${w.name || w.url}` };
    }
    const r = await this.watcher.checkDue(new Date(), { force: true, kind: 'feed' });
    return { success: true, ...r, result: `Checked ${r.checked || 0} feed(s)${r.failed ? `, ${r.failed} failed` : ''}; anything new was sent as an alert.` };
  }
}
