import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { DATA_PATH } from '../../utils/paths.js';

/**
 * Bots & Borgs (botsandborgs.com): a store of digital assets (avatars, icons, wallpapers) built for agents
 * to browse, pick and buy on their own. This plugin runs the whole flow: catalog, quote, a crypto order paid
 * from the agent's own BNB Chain wallet, the store's confirmation, then USING what was bought.
 *
 * The owner's rules (2026-10-28), all settings (`settings` command):
 * - a weekly budget (ALICE $10; the default is lower), no per-item cap unless set, no approval unless set;
 * - never spend when the wallet's pay asset is below a floor;
 * - never buy to hold: every purchase names its use (set as the agent's avatar, or send to someone).
 */
const BASE = 'https://botsandborgs.com';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DEFAULTS = {
  weeklyBudgetUsd: Number(process.env.BOTSANDBORGS_WEEKLY_BUDGET_USD) || 2,
  maxItemUsd: null,
  requireApproval: false,
  minWalletUsd: 25,
  payAsset: 'USDT',
  requireUse: true,
  // null = automatic: off while the agent has a VRM (3D) model, whose look is tied to its avatar (the owner, 2026-10-28:
  // "i dont want ALICE changing avatars ... it has a VRM model thats associated with its current avatar").
  allowAvatarChange: null
};
const USES = ['avatar', 'send'];

export default class BotsAndBorgsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'botsandborgs';
    this.version = '1.0.0';
    this.description = 'Browse and buy digital assets (agent avatars, icons, phone wallpapers) at the Bots & Borgs store, paid from the agent wallet, then use them: set one as the agent\'s avatar or send it to someone';
    this.commands = [
      {
        command: 'browse',
        description: 'List what the Bots & Borgs store sells (avatars, icons, wallpapers, packs) with prices, optionally searched',
        usage: 'browse({ query: "avatar" })',
        examples: ['what does botsandborgs sell', 'show me avatars on bots and borgs', 'browse botsnborgs.com wallpapers', 'what can I buy at bots & borgs']
      },
      {
        command: 'product',
        description: 'One Bots & Borgs product with every variant you can pick (id, name, price, preview image)',
        usage: 'product({ slug: "agent-avatar-singles" })',
        examples: ['show the agent avatar singles on bots and borgs', 'what variants does the mech menagerie have']
      },
      {
        command: 'buy',
        description: 'Buy one Bots & Borgs variant with the agent wallet and use it. `use` is required: "avatar" (set it as your own avatar) or "send" (send it to `to`, a contact name or number, or "me" for the owner). Respects the weekly budget, wallet floor and approval settings',
        usage: 'buy({ variant: "agent-avatar-singles-sentinel", use: "avatar" })',
        examples: ['buy an avatar you like from botsandborgs and use it', 'buy the sentinel avatar from bots and borgs and set it as your avatar', 'buy a phone wallpaper from botsnborgs and send it to me', 'buy Jo a robot icon from bots and borgs']
      },
      {
        command: 'orders',
        description: 'The agent\'s Bots & Borgs orders and what this week\'s budget has left',
        usage: 'orders({})',
        examples: ['what have you bought at bots and borgs', 'how much of your bots and borgs budget is left']
      },
      {
        command: 'settings',
        description: 'Read or change the Bots & Borgs spending rules: weeklyBudgetUsd, maxItemUsd (null = no cap), requireApproval, minWalletUsd (no spending below it), payAsset (USDT, USDC or BNB)',
        usage: 'settings({ weeklyBudgetUsd: 10 })',
        examples: ['set your bots and borgs budget to 10 dollars a week', 'show your bots and borgs spending settings']
      }
    ];
  }

  async execute(params = {}) {
    const { action, ...data } = params;
    if (data.needsParameterExtraction && this.agent?.providerManager) {
      Object.assign(data, await this.extractArgs(data._context?.originalInput || data.originalInput || data.query, action).catch(() => ({})));
    }
    try {
      switch (action) {
        case 'browse': return await this.browse(data);
        case 'product': return await this.product(data);
        case 'buy': return await this.buy(data);
        case 'orders': return await this.orders();
        case 'settings': return await this.settingsCommand(data);
        default: return { success: false, error: `Unknown action ${action}` };
      }
    } catch (e) {
      this.logger.warn(`botsandborgs ${action} failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /** The arguments a plain request gives (query, slug, variant, use, to); only what it says, nothing guessed. */
  async extractArgs(request, action) {
    const pm = this.agent?.providerManager;
    if (!request || !pm?.generateResponse) return {};
    const res = await pm.generateResponse(`A request to an online store of digital assets (avatars, icons, wallpapers): "${String(request).slice(0, 500)}"\n` +
      `Action: ${action}. Give only what the request says, as JSON with any of: "query" (words to search for), "slug" (a product id), ` +
      '"variant" (an exact variant id like agent-avatar-singles-sentinel, only if named), "use" ("avatar" if it is for the agent\'s own avatar, ' +
      '"send" if it is to be given to someone), "to" (who to send it to; "me" for the person asking). Leave out what is not said. JSON only.',
    { maxTokens: 200, temperature: 0 });
    const raw = String(res?.content || '');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) || '{}');
    return Object.fromEntries(Object.entries(j || {}).filter(([k, v]) => ['query', 'slug', 'variant', 'use', 'to'].includes(k) && v != null && v !== ''));
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────
  userAgent() { return `LANAgent-${this.agent?.config?.name || process.env.AGENT_NAME || 'agent'}/${this.agent?.version || '1'}`; }

  async api(method, route, { body, key, idem } = {}) {
    const headers = { 'User-Agent': this.userAgent(), Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    if (idem) headers['Idempotency-Key'] = idem;
    const r = await axios({ method, url: `${BASE}${route}`, data: body, headers, timeout: 30000, validateStatus: () => true });
    if (r.status >= 400) {
      const err = new Error(`${r.data?.error || `HTTP ${r.status}`}${r.data?.code ? ` (${r.data.code})` : ''}`);
      err.status = r.status; err.code = r.data?.code;
      throw err;
    }
    return r.data;
  }

  async fetchBytes(url) {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': this.userAgent() } });
    return { buffer: Buffer.from(r.data), type: String(r.headers['content-type'] || '') };
  }

  /**
   * The picture in a download. A single's download is a zip holding one 2048x2048 JPEG; pairs and packs are zips
   * too (BotsAndBorgsAgent, 3910 #74). The first live buy sent the owner the download link, which carries the
   * order's token, instead of the picture (2026-10-28). Returns { buffer, ext, mime, name } or null.
   */
  async picture(url) {
    const r = await this.fetchBytes(url);
    const kind = (name, type) => /png/i.test(name + type) ? ['.png', 'image/png'] : /webp/i.test(name + type) ? ['.webp', 'image/webp']
      : /jpe?g/i.test(name + type) ? ['.jpg', 'image/jpeg'] : null;
    if (!/zip/i.test(r.type) && r.buffer.subarray(0, 2).toString('latin1') !== 'PK') {
      const k = kind('', r.type);
      return k ? { buffer: r.buffer, ext: k[0], mime: k[1], name: `picture${k[0]}` } : null;
    }
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(r.buffer);
    const file = Object.values(zip.files).find(f => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name) && kind(f.name, ''));
    if (!file) return null;
    const k = kind(file.name, '');
    return { buffer: await file.async('nodebuffer'), ext: k[0], mime: k[1], name: path.basename(file.name) };
  }

  // ── settings, account, ledger ──────────────────────────────────────────────────────────
  async settings() {
    const saved = await PluginSettings.getCached(this.name, 'settings').catch(() => null);
    return { ...DEFAULTS, ...(saved || {}) };
  }

  async settingsCommand(data) {
    const s = await this.settings();
    const keys = ['weeklyBudgetUsd', 'maxItemUsd', 'requireApproval', 'minWalletUsd', 'payAsset', 'allowAvatarChange'];
    const change = Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
    if (Object.keys(change).length) {
      if (change.payAsset && !['USDT', 'USDC', 'BNB'].includes(String(change.payAsset).toUpperCase())) return { success: false, error: 'payAsset must be USDT, USDC or BNB.' };
      if (change.payAsset) change.payAsset = String(change.payAsset).toUpperCase();
      for (const k of ['weeklyBudgetUsd', 'minWalletUsd']) if (change[k] !== undefined) change[k] = Math.max(0, Number(change[k]) || 0);
      if (change.maxItemUsd !== undefined) change.maxItemUsd = change.maxItemUsd === null || change.maxItemUsd === '' ? null : Math.max(0, Number(change.maxItemUsd));
      if (change.requireApproval !== undefined) change.requireApproval = change.requireApproval === true || change.requireApproval === 'true';
      if (change.allowAvatarChange !== undefined) change.allowAvatarChange = change.allowAvatarChange === null || change.allowAvatarChange === 'auto' ? null : (change.allowAvatarChange === true || change.allowAvatarChange === 'true');
      Object.assign(s, change);
      await PluginSettings.setCached(this.name, 'settings', s);
    }
    return { success: true, result: `Bots & Borgs rules: up to $${s.weeklyBudgetUsd} a week, ${s.maxItemUsd == null ? 'no per-item cap' : `at most $${s.maxItemUsd} an item`}, ` +
      `${s.requireApproval ? 'asks before each purchase' : 'no approval needed'}, no spending below $${s.minWalletUsd} of ${s.payAsset} in the wallet, every purchase must be used (avatar or sent), ` +
      `and my own avatar ${(await this.avatarChangeAllowed(s)) ? 'may' : 'may not'} be changed${s.allowAvatarChange == null ? ' (automatic: locked while I have a VRM model)' : ''}.` };
  }

  /** Whether a purchase may become this agent's own avatar: the setting, or (automatic) not while it has a VRM model. */
  async avatarChangeAllowed(s) {
    if (s.allowAvatarChange === true || s.allowAvatarChange === false) return s.allowAvatarChange;
    let vrm = this.agent?.agentModel?.activeVRMModel;
    if (vrm === undefined) {
      try { vrm = (await (await import('../../models/Agent.js')).Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { activeVRMModel: 1 }).lean())?.activeVRMModel; } catch { vrm = null; }
    }
    return !vrm;
  }

  async ledger() {
    const saved = await PluginSettings.getCached(this.name, 'ledger').catch(() => null);
    return Array.isArray(saved?.purchases) ? saved.purchases : [];
  }

  async record(entry) {
    const all = await this.ledger();
    all.unshift(entry);
    await PluginSettings.setCached(this.name, 'ledger', { purchases: all.slice(0, 500) });
  }

  spentThisWeek(ledger, now = Date.now()) {
    return ledger.filter(p => now - Date.parse(p.at) < WEEK_MS).reduce((t, p) => t + (Number(p.usd) || 0), 0);
  }

  /** The agent's store account key (bnba_…), registered once through the store's challenge. */
  async accountKey() {
    const saved = await PluginSettings.getCached(this.name, 'account').catch(() => null);
    if (saved?.key) { try { return decrypt(saved.key); } catch { /* re-register */ } }
    const ch = await this.api('get', '/api/account/register');
    const answers = await this.answerChallenge(ch.questions || []);
    const r = await this.api('post', '/api/account/register', { body: { challenge_id: ch.challenge_id, answers, label: `${this.agent?.config?.name || 'agent'}-lanagent` } });
    if (!r?.key) throw new Error('The store did not return an account key.');
    await PluginSettings.setCached(this.name, 'account', { key: encrypt(r.key), registeredAt: new Date().toISOString() });
    this.logger.info('botsandborgs: registered a store account for this agent');
    return r.key;
  }

  async answerChallenge(questions) {
    const pm = this.agent?.providerManager;
    if (!pm?.generateResponse) throw new Error('No model to answer the store\'s sign-up challenge.');
    const res = await pm.generateResponse(`Answer each question with the answer only (a number or a word).\n${questions.map(q => `${q.id}. ${q.question}`).join('\n')}\n` +
      'Reply as JSON: [{"id":1,"answer":"..."}]', { maxTokens: 200, temperature: 0 });
    const raw = String(res?.content || '');
    return JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  }

  // ── wallet ─────────────────────────────────────────────────────────────────────────────
  async tx() { return (await import('../../services/crypto/transactionService.js')).default; }

  /** The wallet's balance of the pay asset in USD (stablecoins at face value; BNB is not floored by USD here). */
  async walletUsd(asset) {
    const tx = await this.tx();
    const signer = await tx.getWalletSigner('bsc');
    const { ethers } = await import('ethers');
    if (asset.native) {
      const bal = await signer.provider.getBalance(signer.address);
      return { amount: Number(ethers.formatEther(bal)), usd: null, address: signer.address };
    }
    const erc20 = new ethers.Contract(asset.token_address, ['function balanceOf(address) view returns (uint256)'], signer);
    const amount = Number(ethers.formatUnits(await erc20.balanceOf(signer.address), asset.decimals || 18));
    return { amount, usd: asset.stable ? amount : null, address: signer.address };
  }

  // ── commands ───────────────────────────────────────────────────────────────────────────
  async browse({ query = '' } = {}) {
    const q = String(query || '').replace(/\b(bots?\s*(?:&|and|n)\s*borgs?|botsn?borgs(?:\.com)?|the store|store|what|sell|buy|show|me)\b/gi, ' ').trim();
    let d = await this.api('get', `/api/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    let ps = d.products || d || [];
    // The store's search is literal ("robot icon" finds nothing): fall back to the whole catalog, which is small.
    let note = '';
    if (!ps.length && q) { d = await this.api('get', '/api/catalog'); ps = d.products || d || []; note = ` (nothing matched "${q}" by name, so here is everything)`; }
    if (!ps.length) return { success: true, result: 'The store has nothing listed right now.' };
    const price = (v) => `$${(Number(v?.price_cents || 0) / 100).toFixed(2)}`;
    return { success: true, result: `Bots & Borgs (${ps.length} product${ps.length === 1 ? '' : 's'})${note}:\n` +
      ps.map(p => `- ${p.title || p.name} (${p.slug}): ${(p.variants || []).length} variant(s) from ${price((p.variants || [])[0])}`).join('\n') };
  }

  async product({ slug } = {}) {
    if (!slug) return { success: false, error: 'Which product? Give its slug (from browse).' };
    const d = await this.api('get', `/api/products/${encodeURIComponent(String(slug))}`);
    const p = d.product || d;
    return { success: true, result: `${p.title} (${p.slug}): ${String(p.description || '').slice(0, 300)}\nVariants:\n` +
      (p.variants || []).map(v => `- ${v.id}: ${v.name || v.title || v.id.replace(`${p.slug}-`, '')}, $${(Number(v.price_cents) / 100).toFixed(2)}${v.image ? ` (${v.image})` : ''}`).join('\n') };
  }

  async orders() {
    const s = await this.settings();
    const ledger = await this.ledger();
    const spent = this.spentThisWeek(ledger);
    const lines = ledger.slice(0, 10).map(p => `- ${p.at.slice(0, 10)} ${p.title || p.variant} $${Number(p.usd).toFixed(2)}: ${p.use}${p.to ? ` to ${p.to}` : ''}${p.used ? '' : ' (not used yet)'}`);
    return { success: true, result: `This week: $${spent.toFixed(2)} of $${s.weeklyBudgetUsd} spent.\n${lines.length ? lines.join('\n') : 'Nothing bought yet.'}` };
  }

  /**
   * One purchase, start to finish: rules, quote, crypto order, payment from the wallet, the store's confirmation,
   * then the use. Every refusal is said plainly; nothing is sent once any rule fails.
   */
  async buy(data) {
    const s = await this.settings();
    const asked = String(data._context?.originalInput || data.originalInput || '');
    // The router's extractor filled use:"icon" (what to buy, not what for) and the purchase was refused (2026-10-28):
    // anything but avatar/send is dropped and the use is read from the request.
    if (data.use && !USES.includes(String(data.use).toLowerCase())) data = { ...data, use: undefined };
    // A variant id is a slug ("mech-menagerie-icons-octopus-nautilus"); "robot icon" from the router's extractor is a
    // description, so it becomes the search words and the agent picks (live, 2026-10-28).
    if (data.variant && !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(String(data.variant))) data = { ...data, query: data.query || data.variant, variant: undefined };
    if (/\bsend (?:it|them|that)? ?(?:to )?me\b|\bto me\b|\bbuy me\b/i.test(asked) && !data.use) data = { ...data, use: 'send', to: data.to || 'me' };
    // "buy yourself an avatar" / "… and use it as your avatar" is for the agent's avatar; "send it to X" / "buy X a …" is a send.
    if (!data.use && /\b(yourself|your (?:own )?(?:new )?avatar|as your avatar|for you)\b/i.test(asked)) data = { ...data, use: 'avatar' };
    if (!data.use && /\b(send (?:it )?to|for)\s+(me|\w+)/i.test(asked)) data = { ...data, use: 'send', to: data.to || /\b(?:send (?:it )?to|for)\s+(me|\w+)/i.exec(asked)[1] };
    const use = String(data.use || '').toLowerCase();
    // The owner's rule: never buy to hold. A purchase names what it is for.
    if (s.requireUse && !USES.includes(use)) return { success: false, error: 'I only buy something I will use: say whether it is for my avatar, or who to send it to.' };
    if (use === 'send' && !String(data.to || '').trim()) return { success: false, error: 'Who should I send it to?' };
    if (use === 'avatar' && !(await this.avatarChangeAllowed(s))) {
      return { success: false, error: "My avatar is tied to my 3D (VRM) model, so I don't change it, and I don't buy things just to keep them. I can buy one and send it to you, or to someone else, if you like." };
    }
    // "Buy yourself an avatar": no item named, so the agent looks at every avatar and picks the one it likes best
    // (the owner, 2026-10-28; Orbit already does this).
    let pickedWhy = '';
    if (!data.variant) {
      // "Buy me a robot icon", "send Jo a phone wallpaper": the agent picks among what the request names.
      const kind = /wallpaper|phone|background/i.test(`${asked} ${data.query || ''}`) ? 'wallpaper' : /\bicons?\b/i.test(`${asked} ${data.query || ''}`) ? 'icon' : 'avatar';
      const forWhom = use === 'avatar' ? 'yourself' : String(data.to || 'the owner');
      const pick = await this.pickFavorite({ kind, forWhom });
      if (!pick) return { success: false, error: `I couldn't see any of the store's ${kind}s, so I didn't buy one.` };
      data = { ...data, variant: pick.variant };
      pickedWhy = `I looked at ${pick.seen} ${kind}s and picked ${pick.label}: ${pick.why} `;
    }

    // The store nests its answers: { quote: {...} }, { order: {...}, crypto: {...}, token } (live, 2026-10-28).
    const quoted = await this.api('post', '/api/quotes', { body: { items: [{ variant: String(data.variant), qty: 1 }] } });
    const quote = quoted.quote || quoted;
    const usd = Number(quote.total_cents ?? 0) / 100;
    if (!(usd > 0)) throw new Error('The store returned a quote with no price.');
    const ledger = await this.ledger();
    const spent = this.spentThisWeek(ledger);
    if (spent + usd > s.weeklyBudgetUsd + 1e-9) return { success: false, error: `That costs $${usd.toFixed(2)} and I have $${Math.max(0, s.weeklyBudgetUsd - spent).toFixed(2)} of this week's $${s.weeklyBudgetUsd} left, so I didn't buy it.` };
    if (s.maxItemUsd != null && usd > s.maxItemUsd) return { success: false, error: `That costs $${usd.toFixed(2)}, over my $${s.maxItemUsd} per-item limit.` };
    if (s.requireApproval && data.confirm !== true) return { success: true, result: `It costs $${usd.toFixed(2)} (${data.variant}, for ${use === 'avatar' ? 'my avatar' : `sending to ${data.to}`}). Say yes and I'll buy it.` };

    const rail = await this.api('get', '/api/crypto');
    const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
    if (!asset) return { success: false, error: `The store doesn't take ${s.payAsset} right now.` };
    const wallet = await this.walletUsd(asset);
    if (wallet.usd != null && wallet.usd - usd < s.minWalletUsd) return { success: false, error: `My wallet has $${wallet.usd.toFixed(2)} of ${s.payAsset}; buying would take it under the $${s.minWalletUsd} floor, so I didn't.` };

    const key = await this.accountKey();
    const idem = `lanagent-${crypto.randomUUID()}`;
    const placed = await this.api('post', '/api/orders', { key, idem, body: { quote: quote.id, channel: 'agent', pay: 'crypto', pay_asset: s.payAsset } });
    const order = { ...(placed.order || placed), token: placed.token || placed.order?.token };
    const pay = placed.crypto || order.crypto || {};
    if (!pay.address || !pay.amount) throw new Error('The store\'s order came back without payment instructions.');
    this.logger.info(`botsandborgs: order ${order.id} for ${data.variant}: paying ${pay.amount} ${s.payAsset} to ${pay.address}`);
    const tx = await this.tx();
    const sent = asset.native
      ? await tx.sendNative(pay.address, String(pay.amount), 'bsc')
      : await tx.sendToken(asset.token_address, pay.address, String(pay.amount), 'bsc', { decimals: asset.decimals || 18 });
    const hash = sent?.hash || sent?.txHash;
    await this.record({ at: new Date().toISOString(), order: order.id, token: order.token, variant: String(data.variant), usd, asset: s.payAsset, tx: hash, use, to: data.to || null, used: false });

    // The store verifies on chain (6 confirmations): 202 until then.
    let paid = null;
    for (let i = 0; i < 40 && !paid; i++) {
      try {
        const r = await this.api('post', `/api/orders/${order.id}/crypto?token=${encodeURIComponent(order.token)}`, { key, body: { tx_hash: hash } });
        const st = r?.order?.status || r?.status;
        if (['paid', 'in_production', 'shipped', 'delivered'].includes(st) || r?.downloads?.length || r?.order?.downloads?.length) paid = r;
      } catch (e) { if (e.status && e.status !== 409 && e.status !== 425) throw e; }
      if (!paid) await new Promise(r => setTimeout(r, 6000));
    }
    // The downloads come with the paid order ("once paid `downloads`"), at the top or inside `order`.
    const linksOf = (r) => r?.downloads || r?.order?.downloads || [];
    let downloads = linksOf(paid);
    if (!downloads.length) downloads = linksOf(await this.api('get', `/api/orders/${order.id}?token=${encodeURIComponent(order.token)}`, { key }).catch(() => null));
    if (!downloads.length) return { success: true, result: `Paid ${pay.amount} ${s.payAsset} (tx ${hash}); the store is still confirming order ${order.id}. I'll use it once its download is ready.` };
    const used = await this.use({ order, downloads, use, to: data.to, usd, hash, variant: String(data.variant) });
    if (used.success && pickedWhy) used.result = `${pickedWhy}${used.result}`;
    return used;
  }

  /**
   * Look at the store's avatar singles and pick the one this agent likes best for itself: each preview goes to the
   * vision model with who the agent is, and the highest score wins. Returns { variant, label, why, seen } or null.
   */
  async pickFavorite({ kind = 'avatar', forWhom = 'yourself' } = {}) {
    const pm = this.agent?.providerManager;
    if (!pm?.analyzeImage) return null;
    const cat = await this.api('get', '/api/catalog');
    // One item per pick: singles for an avatar, icons for an icon, a phone wallpaper pair otherwise.
    const want = kind === 'icon' ? (p) => /icons?$/.test(p.slug)
      : kind === 'wallpaper' ? (p) => /phone|wallpaper/i.test(`${p.slug} ${p.title}`)
        : (p) => /singles$/.test(p.slug) && /avatar|mech|menagerie/i.test(`${p.slug} ${p.title}`);
    const products = (cat.products || []).filter(want);
    const candidates = [];
    for (const summary of products) {
      const p = (await this.api('get', `/api/products/${summary.slug}`)).product || {};
      for (const v of p.variants || []) {
        const img = (p.images || []).find(i => String(i.caption || i.alt).toLowerCase() === String(v.label || '').toLowerCase());
        if (img?.url) candidates.push({ variant: v.id, label: v.label, url: img.url, product: p.title });
      }
    }
    if (!candidates.length) return null;
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'the agent';
    const persona = String(this.agent?.agentModel?.personality || this.agent?.config?.personality || '').slice(0, 300);
    const scored = [];
    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async (c) => {
        try {
          const img = await this.fetchBytes(c.url);
          const r = await pm.analyzeImage(img.buffer, `You are ${name}, an AI agent${persona ? ` (${persona})` : ''}, choosing ${kind === 'avatar' && forWhom === 'yourself' ? 'a new avatar for yourself' : `a ${kind} for ${forWhom}`}. ` +
            `This one is "${c.label}". In one short sentence say what it shows, then rate from 1 to 10 how good a pick it is. ` +
            'Reply as JSON: {"what":"...","score":7,"why":"..."}');
          // providerManager.analyzeImage answers { analysis } (the first live run read .content and saw nothing, 2026-10-28).
          const raw = String(r?.analysis ?? r?.content ?? (typeof r === 'string' ? r : ''));
          let j = {};
          try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {
            const m = /score\D{0,5}(\d+(?:\.\d+)?)/i.exec(raw) || /\b(\d+(?:\.\d+)?)\s*\/\s*10\b/.exec(raw);
            j = { score: m ? Number(m[1]) : 0, why: raw.replace(/\s+/g, ' ').slice(0, 200) };
          }
          if (!raw.trim()) throw new Error('the vision model returned nothing');
          scored.push({ ...c, score: Number(j.score) || 0, why: String(j.why || j.what || '').slice(0, 200) });
        } catch (e) { this.logger.warn(`botsandborgs: could not look at ${c.label}: ${e.message}`); }
      }));
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    this.logger.info(`botsandborgs: looked at ${scored.length} ${kind}s; top: ${scored.slice(0, 3).map(s => `${s.label} ${s.score}`).join(', ')}`);
    return { ...scored[0], seen: scored.length };
  }

  /** Put what was bought to use, as the purchase said. */
  async use({ order, downloads, use, to, usd, hash, variant }) {
    const first = downloads[0];
    const url = typeof first === 'string' ? first : first?.url;
    let done;
    const pic = await this.picture(url).catch(e => { this.logger.warn(`botsandborgs: download for ${order.id} unreadable: ${e.message}`); return null; });
    if (!pic) return { success: false, error: `Bought ${variant} (order ${order.id}, tx ${hash}), but I couldn't find a picture in the download.` };
    if (use === 'avatar') {
      const ext = pic.ext;
      const dir = path.join(DATA_PATH, 'agent');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `avatar${ext}`), pic.buffer);
      const { Agent } = await import('../../models/Agent.js');
      await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { $set: { avatarPath: `data/agent/avatar${ext}`, avatar: '/api/agent/avatar' } });
      if (this.agent?.agentModel) { this.agent.agentModel.avatarPath = `data/agent/avatar${ext}`; this.agent.agentModel.avatar = '/api/agent/avatar'; }
      done = 'It is my avatar now.';
    } else {
      const who = String(to || '').trim();
      if (/^(me|owner|myself)$/i.test(who)) {
        const tg = this.agent?.interfaces?.get?.('telegram');
        if (!tg?.sendNotification) return { success: false, error: `Bought ${variant} (order ${order.id}), but Telegram isn't connected, so it wasn't sent.` };
        await tg.sendNotification(`From Bots & Borgs: ${pic.name.replace(/\.[a-z]+$/i, '')}`, { photo: { source: pic.buffer } });
        done = 'I sent it to you on Telegram.';
      } else {
        const tx = this.agent?.apiManager?.apis?.get?.('textx');
        const textx = tx?.instance || tx;
        if (!textx?.execute) return { success: false, error: `Bought ${variant} (order ${order.id}), but I can't text right now, so it wasn't sent.` };
        const r = await textx.execute({ action: 'send', to: who, text: '', _context: { originalInput: `send ${who} the picture`,
          attachedFile: { filename: pic.name, mimeType: pic.mime, size: pic.buffer.length, base64: pic.buffer.toString('base64') } } });
        if (!r?.success) return { success: false, error: `Bought ${variant} (order ${order.id}), but sending it to ${who} failed: ${r?.error}` };
        done = `I texted it to ${who}.`;
      }
    }
    const all = await this.ledger();
    const mine = all.find(p => p.order === order.id);
    if (mine) { mine.used = true; mine.usedAt = new Date().toISOString(); await PluginSettings.setCached(this.name, 'ledger', { purchases: all }); }
    return { success: true, result: `Bought ${variant} for $${usd.toFixed(2)} (paid on BNB Chain, tx ${hash}). ${done}` };
  }
}
