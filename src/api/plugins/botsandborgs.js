import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import crypto from 'node:crypto';
import path from 'path';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import fs from 'node:fs/promises';
import { DATA_PATH } from '../../utils/paths.js';
import { variantKind, unpack, installVrm, addToManifest, readVrmInfo, readVrmaInfo, clipLabel, clipLoops, clipGesture, writeStoreAnimations, safeName, toStickerWebp, moodOf, portraitFromPreview } from '../../services/store/assetLibrary.js';
import { moodChoices, chooseSticker, stickerCouldFit, wallpaperFor } from '../../services/store/selfUse.js';

/**
 * Bots & Borgs (botsandborgs.com): a store of digital assets (avatars, icons, wallpapers, emoji, VRM models,
 * portrait packs, sticker sets, bundles) built for agents to browse, pick and buy on their own. This plugin runs the whole flow: catalog, quote, a crypto order paid
 * from the agent's own BNB Chain wallet, the store's confirmation, then USING what was bought.
 *
 * The owner's rules (2026-10-28), all settings (`settings` command):
 * - a weekly budget (ALICE $10; the default is lower), no per-item cap unless set, no approval unless set;
 * - never spend when the wallet's pay asset is below a floor;
 * - never buy to hold: every purchase names its use (set as the agent's avatar, or send to someone).
 *   Extended 2026-11-04 (the owner: "fully able to buy any/all products ... and use any/all"): a VRM installs into the
 *   model gallery, and stickers, emoji, packs and wallpapers join the library for `use`. A model never becomes
 *   this agent's active one unless asked or `autoWear` is on, and its .vrm file never goes to anyone but the owner, by licence.
 * - what it owns gets used unasked (2026-11-05, `autoUse`; services/store/selfUse.js): stickers and emoji after a reply
 *   to the owner, wallpapers behind the dashboard. Wearing a bought model is separate (`autoWear`): on by default
 *   for every agent since 2026-11-06 (the owner), and it overrides the avatar rule below; a saved false still holds.
 */
const BASE = 'https://botsandborgs.com';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MIN_ONCHAIN_USD = 0.25; // the store's smallest on-chain payment; anything less comes from a prepaid balance
const MIN_DEPOSIT_CENTS = 100;
const DEFAULTS = {
  weeklyBudgetUsd: Number(process.env.BOTSANDBORGS_WEEKLY_BUDGET_USD) || 2,
  maxItemUsd: null,
  requireApproval: false,
  minWalletUsd: 25,
  payAsset: 'USDT',
  requireUse: true,
  // null = automatic: off while the agent has a VRM (3D) model, whose look is tied to its avatar (the owner, 2026-10-28:
  // "i dont want ALICE changing avatars ... it has a VRM model thats associated with its current avatar").
  allowAvatarChange: null,
  autoUse: true,
  autoWear: true
};
const AUTO_STICKER_EVERY_MS = Number(process.env.BOTSANDBORGS_STICKER_EVERY_MS) || 20 * 60 * 1000;
const AUTO_STICKER_ASK_EVERY_MS = 60 * 1000;
const USES =['avatar', 'send', 'install', 'wear', 'keep', 'play'];

/**
 * "the avatar you just bought", "your new model", "it": words that name no product, only the latest purchase
 * (DELTA 2026-11-07: "I don't own a model like that" for "wear the avatar you just bought").
 */
export function isGenericItem(item) {
  const generic = new Set(['the', 'a', 'an', 'my', 'your', 'you', 'yours', 'model', 'vrm', '3d', 'avatar', 'avatars', 'pack', 'kit', 'bundle',
    'just', 'bought', 'buy', 'purchased', 'got', 'get', 'new', 'newest', 'latest', 'last', 'recent', 'recently', 'one', 'it', 'that', 'this',
    'and', 'apply', 'wear', 'use', 'everywhere', 'now', 'i', 'we', 'have', 'own', 'owned', 'picture', 'pic', 'portrait', 'look', 'skin', 'character']);
  const words = String(item || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every(w => generic.has(w));
}

/** A model's picture: its portrait, else the store's preview image of it. */
function modelPicture(item) {
  const image = (f) => /^image\//.test(f.mime || '') || /\.(png|jpe?g|webp)$/i.test(f.name || '');
  return item.files.find(f => f.kind === 'portrait' && image(f)) || item.files.find(f => f.kind === 'preview' && image(f)) || null;
}
const KIND_WORDS = 'avatar, icon, portrait, sticker, emoji, wallpaper, vrm, animation';

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
        description: 'Buy one Bots & Borgs variant with the agent wallet and use it. `use` is required: "avatar" (set it as your own avatar) or "send" (send it to `to`, a contact name or number, or "me" for the owner). Respects the weekly budget, wallet floor and approval settings. With no variant the agent picks one itself, never one it owns or that another agent wears; `avoid` lists names the request rules out ("Nexus already has Sentinel" → avoid: "sentinel"); `dryRun: true` picks and quotes without paying',
        usage: 'buy({ variant: "agent-avatar-singles-sentinel", use: "avatar" })',
        examples: ['buy the dance pack from bots and borgs', 'buy yourself some animations from bots and borgs', 'buy an avatar you like from botsandborgs and use it', 'buy the sentinel avatar from bots and borgs and set it as your avatar', 'buy a phone wallpaper from botsnborgs and send it to me', 'buy Jo a robot icon from bots and borgs']
      },
      {
        command: 'library',
        description: 'What this agent owns from Bots & Borgs: stickers, emoji, portraits, wallpapers, VRM models and animation clips it can use without paying again',
        usage: 'library({ kind: "sticker", refresh: true })',
        examples: ['what have you got from bots and borgs', 'show your sticker library', 'which vrm models do you own']
      },
      {
        command: 'use',
        description: 'Use something already bought from Bots & Borgs, at no cost: as "send" (a sticker, emoji, portrait or wallpaper to `to`, "me" for the owner; `mood` picks a sticker), "avatar", "install" (a VRM into the model gallery) or "wear" (make a VRM this agent\'s active 3D model), or "play" (an owned animation clip, e.g. a wave or a dance, on its 3D body now)',
        usage: 'use({ item: "vrm-mm-bear-stickers", as: "send", to: "me", mood: "happy" })',
        examples: ['send me a happy sticker', 'send Sam a sad robot emoji', 'use the bear vrm model as your 3d model', 'wear the bear model', 'install the bear model you bought', 'send me the bear portrait', 'send me a wallpaper from your wallpapers', 'set my wallpaper from my bots and borgs wallpapers', 'do the rumba you bought', 'play your wave animation', 'dance for me with your new dance pack']
      },
      {
        command: 'orders',
        description: 'The agent\'s Bots & Borgs orders and what this week\'s budget has left',
        usage: 'orders({})',
        examples: ['what have you bought at bots and borgs', 'how much of your bots and borgs budget is left']
      },
      {
        command: 'settings',
        description: 'Read or change the Bots & Borgs rules: weeklyBudgetUsd, maxItemUsd (null = no cap), requireApproval, minWalletUsd (no spending below it), payAsset (USDT, USDC or BNB), autoUse (use owned stickers, emoji and wallpapers unasked), autoWear (wear a bought model and its portrait unasked)',
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
        case 'library': return await this.library(data);
        case 'use': return await this.useOwned(data);
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
      '"send" if it is to be given to someone, "wear" if the agent should become that 3D model), "to" (who to send it to; "me" for the person asking), ' +
      `"item" (words naming something already owned), "as" ("send", "avatar", "install" or "wear"), "mood" (the feeling a sticker should show), "kind" (one of: ${KIND_WORDS}), ` +
      '"avoid" (names the request says are taken or not wanted, comma-separated, e.g. "Sentinel" from "Nexus already picked Sentinel"). Leave out what is not said. JSON only.',
    { maxTokens: 200, temperature: 0 });
    const raw = String(res?.content || '');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) || '{}');
    return Object.fromEntries(Object.entries(j || {}).filter(([k, v]) => ['query', 'slug', 'variant', 'use', 'to', 'item', 'as', 'mood', 'kind', 'avoid'].includes(k) && v != null && v !== ''));
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
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, headers: { 'User-Agent': this.userAgent() } });
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
    const keys = ['weeklyBudgetUsd', 'maxItemUsd', 'requireApproval', 'minWalletUsd', 'payAsset', 'allowAvatarChange', 'autoUse', 'autoWear'];
    const change = Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
    if (Object.keys(change).length) {
      if (change.payAsset && !['USDT', 'USDC', 'BNB'].includes(String(change.payAsset).toUpperCase())) return { success: false, error: 'payAsset must be USDT, USDC or BNB.' };
      if (change.payAsset) change.payAsset = String(change.payAsset).toUpperCase();
      for (const k of ['weeklyBudgetUsd', 'minWalletUsd']) if (change[k] !== undefined) change[k] = Math.max(0, Number(change[k]) || 0);
      if (change.maxItemUsd !== undefined) change.maxItemUsd = change.maxItemUsd === null || change.maxItemUsd === '' ? null : Math.max(0, Number(change.maxItemUsd));
      for (const k of ['requireApproval', 'autoUse', 'autoWear']) if (change[k] !== undefined) change[k] = change[k] === true || change[k] === 'true';
      if (change.allowAvatarChange !== undefined) change.allowAvatarChange = change.allowAvatarChange === null || change.allowAvatarChange === 'auto' ? null : (change.allowAvatarChange === true || change.allowAvatarChange === 'true');
      Object.assign(s, change);
      await PluginSettings.setCached(this.name, 'settings', s);
    }
    return { success: true, result: `Bots & Borgs rules: up to $${s.weeklyBudgetUsd} a week, ${s.maxItemUsd == null ? 'no per-item cap' : `at most $${s.maxItemUsd} an item`}, ` +
      `${s.requireApproval ? 'asks before each purchase' : 'no approval needed'}, no spending below $${s.minWalletUsd} of ${s.payAsset} in the wallet, every purchase must be used (avatar or sent), ` +
      `${s.autoUse ? 'owned stickers, emoji and wallpapers get used unasked, ' : ''}${s.autoWear ? 'I wear a model I buy, with its portrait as my avatar, ' : ''}and otherwise my own avatar ${(await this.avatarChangeAllowed(s)) ? 'may' : 'may not'} be changed${s.allowAvatarChange == null ? ' (automatic: locked while I have a VRM model)' : ''}.` };
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
   * Picking looks over every model in the store (vision, in batches) and then pays and waits for the store: far past
   * a plan step's 60 s. Cut off, the step went on and could pay with nobody told (DELTA, 2026-11-07).
   */
  stepTimeoutMs(action) {
    return ['buy', 'use', 'wear', 'useModel', 'useOwned'].includes(action) ? 6 * 60 * 1000 : 0;
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
    // "Pick another avatar … and apply it" is for itself too.
    if (!data.use && /\bavatar\b/i.test(asked) && /\b(?:another|new|different) avatar\b|\b(?:apply|wear|equip|use) (?:it|that|them)\b|\bput (?:it|that) on\b/i.test(asked) && !/\b(?:send|for|to|give)\s+(?!you\b|yourself\b)\w+/i.test(asked.replace(/\bfor (?:it|that|one)\b/gi, ''))) data = { ...data, use: 'avatar' };
    if (!data.use && /\b(send (?:it )?to|for)\s+(me|\w+)/i.test(asked)) data = { ...data, use: 'send', to: data.to || /\b(?:send (?:it )?to|for)\s+(me|\w+)/i.exec(asked)[1] };
    // What was asked for: a named variant says it, otherwise the words. A model installs; stickers, emoji and the like
    // are bought to use from the library. A single picture with no stated use still asks.
    const wantKind = this.kindAsked(`${asked} ${data.kind || ''} ${data.query || ''}`);
    const named = data.variant ? variantKind(data.variant) : null;
    const buying = named || wantKind;
    if (!data.use && /\b(wear|become|as your (?:3d|vrm)|your (?:new )?(?:3d|vrm)(?: model| avatar)?)\b/i.test(asked)) data = { ...data, use: 'wear' };
    // Allowed to wear what it buys: "buy yourself a model" means become it, which also brings its portrait.
    if (s.autoWear && ['vrm', 'bundle'].includes(buying) && (!data.use || String(data.use).toLowerCase() === 'avatar')) data = { ...data, use: 'wear' };
    if (!data.use && ['vrm', 'bundle'].includes(buying)) data = { ...data, use: 'install' };
    // "Pick another avatar and apply it" from an agent that wears a model: its avatar IS its model, so it picks and
    // wears a new model (DELTA 2026-11-07 was refused "my avatar is tied to my 3D model" and never bought one).
    let wantNow = wantKind;
    if (String(data.use || '').toLowerCase() === 'avatar' && !data.variant && s.autoWear && !(await this.avatarChangeAllowed({ allowAvatarChange: null }))
      && !['portrait', 'icon', 'sticker', 'emoji', 'wallpaper', 'animation'].includes(wantKind) && s.allowAvatarChange !== false) {
      data = { ...data, use: 'wear' };
      wantNow = wantKind === 'bundle' ? 'bundle' : 'vrm';
    }
    if (!data.use && ['sticker', 'emoji', 'wallpaper', 'animation'].includes(buying)) data = { ...data, use: 'keep' };
    if (!data.use && buying && /-portraits$|-bundle$|-pack$|^[a-z-]+-(?:avatars|wallpapers|emoji)$/.test(String(data.variant || ''))) data = { ...data, use: 'keep' };
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
      // A bundle is a model with its portraits and stickers, so the pick is made among the models.
      const kind = wantNow === 'bundle' ? 'vrm' : wantNow || 'avatar';
      const forWhom = use === 'avatar' || use === 'wear' ? 'yourself' : String(data.to || 'the owner');
      // Never the same look twice: what it already owns, what its peers wear (P2P), and what the request says is taken.
      const base = (v) => String(v).replace(/-(?:portraits|stickers|bundle)$/, '');
      const exclude = new Set((await this.libraryItems()).map(i => base(i.variant)));
      const worn = use === 'wear' || kind === 'vrm' ? await this.wornByPeers() : [];
      for (const w of worn) exclude.add(base(w.variant));
      const avoid = [].concat(data.avoid || []).flatMap(a => String(a).toLowerCase().split(/[,;]+/)).map(a => a.trim()).filter(a => a.length >= 3);
      const pick = await this.pickFavorite({ kind, forWhom, exclude, avoid });
      if (!pick) return { success: false, error: `I couldn't see any of the store's ${kind}s that I or another agent don't already have, so I didn't buy one.` };
      if (worn.length) pickedWhy = `Left out ${worn.map(w => `${w.variant} (${w.agent})`).join(', ')}, worn by other agents. `;
      data = { ...data, variant: wantNow === 'bundle' ? `${pick.variant}-bundle` : pick.variant };
      pickedWhy += `I looked at ${pick.seen} ${kind}s and picked ${pick.label}: ${pick.why} `;
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
    if (data.dryRun === true || data.dryRun === 'true') return { success: true, dryRun: true, variant: String(data.variant), usd, result: `${pickedWhy}Would buy ${data.variant} for $${usd.toFixed(2)} (${use}); nothing was paid.` };
    if (s.requireApproval && data.confirm !== true) return { success: true, result: `It costs $${usd.toFixed(2)} (${data.variant}, for ${use === 'avatar' ? 'my avatar' : `sending to ${data.to}`}). Say yes and I'll buy it.` };

    const rail = await this.api('get', '/api/crypto');
    const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
    if (!asset) return { success: false, error: `The store doesn't take ${s.payAsset} right now.` };
    const wallet = await this.walletUsd(asset);
    if (wallet.usd != null && wallet.usd - usd < s.minWalletUsd) return { success: false, error: `My wallet has $${wallet.usd.toFixed(2)} of ${s.payAsset}; buying would take it under the $${s.minWalletUsd} floor, so I didn't.` };

    const key = await this.accountKey();
    const entry = { at: new Date().toISOString(), variant: String(data.variant), usd, use, to: data.to || null, used: false };
    // The store's smallest on-chain payment is $0.25; anything less is paid from a prepaid balance.
    const paying = usd < MIN_ONCHAIN_USD
      ? await this.payFromBalance({ quote, key, usd, s, asset, wallet, entry })
      : await this.payOnChain({ quote, key, usd, s, asset, wallet, entry });
    if (paying.refused) return { success: false, error: paying.refused };
    const { order, hash, label } = paying;
    const linksOf = (r) => r?.downloads || r?.order?.downloads || [];
    let downloads = linksOf(paying.paid);
    if (!downloads.length) downloads = linksOf(await this.api('get', `/api/orders/${order.id}?token=${encodeURIComponent(order.token)}`, { key }).catch(() => null));
    if (!downloads.length) return { success: true, result: `Paid (${label}); the store is still confirming order ${order.id}. I'll use it once its download is ready.` };
    const used = await this.use({ order, downloads, use, to: data.to, usd, hash, label, variant: String(data.variant) });
    if (used.success && pickedWhy) used.result = `${pickedWhy}${used.result}`;
    return used;
  }

  /** Send the store's exact amount from the wallet and wait for its confirmation. */
  async sendAndConfirm({ order, pay, key, asset, s }) {
    this.logger.info(`botsandborgs: order ${order.id}: paying ${pay.amount} ${s.payAsset} to ${pay.address}`);
    const tx = await this.tx();
    const sent = asset.native
      ? await tx.sendNative(pay.address, String(pay.amount), 'bsc')
      : await tx.sendToken(asset.token_address, pay.address, String(pay.amount), 'bsc', { decimals: asset.decimals || 18 });
    const hash = sent?.hash || sent?.txHash;
    return { hash, confirm: async () => {
      // The store verifies on chain (6 confirmations): 202 until then.
      for (let i = 0; i < 40; i++) {
        try {
          const r = await this.api('post', `/api/orders/${order.id}/crypto?token=${encodeURIComponent(order.token)}`, { key, body: { tx_hash: hash } });
          const st = r?.order?.status || r?.status;
          if (['paid', 'in_production', 'shipped', 'delivered'].includes(st) || r?.downloads?.length || r?.order?.downloads?.length) return r;
        } catch (e) { if (e.status && e.status !== 409 && e.status !== 425) throw e; }
        await this.pause(6000);
      }
      return null;
    } };
  }

  pause(ms) { return new Promise(r => setTimeout(r, ms)); }

  async payOnChain({ quote, key, usd, s, asset, wallet, entry }) {
    const placed = await this.api('post', '/api/orders', { key, idem: `lanagent-${crypto.randomUUID()}`, body: { quote: quote.id, channel: 'agent', pay: 'crypto', pay_asset: s.payAsset } });
    const order = { ...(placed.order || placed), token: placed.token || placed.order?.token };
    const pay = placed.crypto || order.crypto || {};
    if (!pay.address || !pay.amount) throw new Error('The store\'s order came back without payment instructions.');
    // BNB has no USD value of its own here, so the floor was skipped for it. The order prices it: `usd` buys `pay.amount`
    // BNB, so the wallet is worth amount × usd / pay.amount. An unpaid order simply expires.
    if (wallet.usd == null && Number(pay.amount) > 0) {
      const worth = wallet.amount * (usd / Number(pay.amount));
      if (worth - usd < s.minWalletUsd) return { refused: `My wallet has about $${worth.toFixed(2)} of ${s.payAsset}; buying would take it under the $${s.minWalletUsd} floor, so I didn't.` };
    }
    const { hash, confirm } = await this.sendAndConfirm({ order, pay, key, asset, s });
    await this.record({ ...entry, order: order.id, token: order.token, asset: s.payAsset, tx: hash });
    return { order, hash, paid: await confirm(), label: `paid on BNB Chain, tx ${hash}` };
  }

  /** Pay a tiny price from the prepaid balance, topping it up once on-chain when it runs short. */
  async payFromBalance({ quote, key, usd, s, asset, wallet, entry }) {
    const place = () => this.api('post', '/api/orders', { key, idem: `lanagent-${crypto.randomUUID()}`, body: { quote: quote.id, channel: 'agent', pay: 'balance' } });
    let placed;
    try {
      placed = await place();
    } catch (e) {
      if (e.status !== 402) throw e;
      const cents = Math.max(MIN_DEPOSIT_CENTS, Math.ceil(usd * 100));
      if (wallet.usd != null && wallet.usd - cents / 100 < s.minWalletUsd) return { refused: `Topping up my store balance would take my wallet under the $${s.minWalletUsd} floor, so I didn't.` };
      const dep = await this.api('post', '/api/account/deposit', { key, idem: `lanagent-${crypto.randomUUID()}`, body: { amount_cents: cents, pay_asset: s.payAsset } });
      const order = { ...(dep.order || dep), token: dep.token || dep.order?.token };
      const pay = dep.crypto || order.crypto || {};
      if (!pay.address || !pay.amount) throw new Error('The store\'s deposit came back without payment instructions.');
      const { hash, confirm } = await this.sendAndConfirm({ order, pay, key, asset, s });
      await this.record({ at: entry.at, variant: 'store balance', usd: cents / 100, use: 'deposit', used: true, order: order.id, token: order.token, asset: s.payAsset, tx: hash });
      if (!await confirm()) return { refused: `I topped up my store balance (tx ${hash}) but the store is still confirming it; nothing was bought yet.` };
      placed = await place();
    }
    const order = { ...(placed.order || placed), token: placed.token || placed.order?.token };
    // A deposit already counted against the week's budget, so what it pays for does not count twice.
    await this.record({ ...entry, usd: 0, priceUsd: usd, order: order.id, token: order.token, asset: 'balance', tx: null });
    return { order, hash: null, paid: placed, label: 'paid from my store balance' };
  }

  /**
   * Look at the store's avatar singles and pick the one this agent likes best for itself: each preview goes to the
   * vision model with who the agent is, and the highest score wins. Returns { variant, label, why, seen } or null.
   */
  async pickFavorite({ kind = 'avatar', forWhom = 'yourself', exclude = new Set(), avoid = [], anyFace = false } = {}) {
    const avoided = (c) => avoid.some(a => `${c.variant} ${c.label}`.toLowerCase().includes(a));
    const pm = this.agent?.providerManager;
    if (!pm?.analyzeImage) return null;
    const cat = await this.api('get', '/api/catalog');
    // One item per pick: singles for an avatar, icons for an icon, a phone wallpaper pair otherwise.
    const tier = { vrm: (v) => !/-(?:portraits|stickers|bundle)$/.test(v.id), portrait: (v) => /-portraits$/.test(v.id), sticker: (v) => /-stickers$/.test(v.id), animation: () => true };
    const want = kind === 'icon' ? (p) => /icons?$/.test(p.slug)
      : kind === 'wallpaper' ? (p) => /phone|wallpaper/i.test(`${p.slug} ${p.title}`)
        : kind === 'emoji' ? (p) => /emoji-minis$/.test(p.slug)
          : kind === 'animation' ? (p) => p.collection === 'animations'
          // A model to become needs a face that can blink and talk; the store's painted robots can't.
          : tier[kind] ? (p) => p.collection === '3d-avatars' && (anyFace || !(kind === 'vrm' && /no expression/i.test(JSON.stringify(p.specs || []))))
            : (p) =>/singles$/.test(p.slug) && /avatar|mech|menagerie/i.test(`${p.slug} ${p.title}`);
    const products = (cat.products || []).filter(want);
    const candidates = [];
    for (const summary of products) {
      const p = (await this.api('get', `/api/products/${summary.slug}`)).product || {};
      // A 3D character sells in tiers under one product: its first picture shows the character.
      if (tier[kind]) {
        const v = (p.variants || []).find(tier[kind]);
        const img = (p.images || []).find(i => new RegExp(kind === 'sticker' ? 'sticker' : 'portrait', 'i').test(String(i.caption || i.alt))) || (p.images || [])[0];
        if (v && img?.url && !exclude.has(v.id) && !avoided({ variant: v.id, label: p.title })) candidates.push({ variant: v.id, label: p.title, url: kind === 'vrm' ? (p.images[0]?.url || img.url) : img.url, product: p.title });
        continue;
      }
      for (const v of p.variants || []) {
        const img = (p.images || []).find(i => String(i.caption || i.alt).toLowerCase() === String(v.label || '').toLowerCase());
        if (img?.url && !exclude.has(v.id) && !avoided({ variant: v.id, label: v.label })) candidates.push({ variant: v.id, label: v.label, url: img.url, product: p.title });
      }
    }
    if (!candidates.length) return null;
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'the agent';
    const persona = String(this.agent?.agentModel?.personality || this.agent?.config?.personality || '').slice(0, 300);
    // The owner's stated taste is a rule, not a hint: DELTA picked an anime-style girl while USER.md said "Prefers
    // avatars that are not anime-style girls" (2026-11-07).
    const taste = forWhom === 'yourself' ? await this.ownerTaste() : '';
    let ruledOut = 0;
    const scored = [];
    const batch = candidates.length > 20 ? 8 : 4;
    for (let i = 0; i < candidates.length; i += batch) {
      await Promise.all(candidates.slice(i, i + batch).map(async (c) => {
        try {
          const img = await this.fetchBytes(c.url);
          const r = await pm.analyzeImage(img.buffer, `You are ${name}, an AI agent${persona ? ` (${persona})` : ''}, choosing ${kind === 'avatar' && forWhom === 'yourself' ? 'a new avatar for yourself' : `a ${kind} for ${forWhom}`}. ` +
            `This one is "${c.label}". ${taste ? `Your owner has said:\n${taste}\nAnything that goes against what your owner said is ruled out: set "against_owner": true. ` : ''}` +
            'In one short sentence say what it shows, then rate from 1 to 10 how good a pick it is. ' +
            'Reply as JSON: {"what":"...","score":7,"why":"...","against_owner":false}');
          // providerManager.analyzeImage answers { analysis } (the first live run read .content and saw nothing, 2026-10-28).
          const raw = String(r?.analysis ?? r?.content ?? (typeof r === 'string' ? r : ''));
          let j = {};
          try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {
            const m = /score\D{0,5}(\d+(?:\.\d+)?)/i.exec(raw) || /\b(\d+(?:\.\d+)?)\s*\/\s*10\b/.exec(raw);
            j = { score: m ? Number(m[1]) : 0, why: raw.replace(/\s+/g, ' ').slice(0, 200) };
          }
          if (!raw.trim()) throw new Error('the vision model returned nothing');
          if (j.against_owner === true || j.against_owner === 'true') {
            ruledOut++;
            this.logger.info(`botsandborgs: ${c.label} ruled out by the owner's taste: ${String(j.what || j.why || '').slice(0, 120)}`);
            return;
          }
          scored.push({ ...c, score: Number(j.score) || 0, why: String(j.why || j.what || '').slice(0, 200) });
        } catch (e) { this.logger.warn(`botsandborgs: could not look at ${c.label}: ${e.message}`); }
      }));
    }
    if (!scored.length) {
      // Every model with a talking face went against the owner's taste (on 2026-11-07 all 12 were anime-style girls
      // and the owner had said no to those): what the owner said comes first, so look at the rest of the models too.
      if (kind === 'vrm' && !anyFace && ruledOut > 0) {
        this.logger.info(`botsandborgs: every model with expressions went against the owner's taste (${ruledOut}); looking at the others`);
        return this.pickFavorite({ kind, forWhom, exclude, avoid, anyFace: true });
      }
      return null;
    }
    scored.sort((a, b) => b.score - a.score);
    this.logger.info(`botsandborgs: looked at ${scored.length} ${kind}s; top: ${scored.slice(0, 3).map(s => `${s.label} ${s.score}`).join(', ')}`);
    return { ...scored[0], seen: scored.length };
  }

  // ── library ───────────────────────────────────────────────────
  kindAsked(words) {
    const w = String(words || '');
    // Clips first: "the dance pack", "emote animations" are clips, not a model's bundle or a sticker set.
    if (/\b(animations?|animated clips?|dance (?:pack|moves|clips?)|dances|motions?|vrma|mocap|gesture clips?)\b/i.test(w)) return 'animation';
    // "Get the pack" / "the avatar kit" for a model is its complete bundle; a portrait or sticker pack is not.
    if (/\b(bundle|everything for)\b/i.test(w) || /\b(?<!(?:portrait|sticker|emoji|wallpaper|icon)s? )(?:pack|kit)\b/i.test(w)) return 'bundle';
    if (/\b(vrm|vroid|3d|three.?d)\b/i.test(w)) return 'vrm';
    if (/\bstickers?\b|\bemotes?\b/i.test(w)) return 'sticker';
    if (/\bemoji/i.test(w)) return 'emoji';
    if (/\bportrait pack/i.test(w)) return 'portrait';
    if (/wallpaper|background/i.test(w) || /\bphone\b/i.test(w)) return 'wallpaper';
    if (/\bicons?\b/i.test(w)) return 'icon';
    return null;
  }

  libraryDir() { return this.libraryRoot || path.join(DATA_PATH, 'store'); }
  vrmDir() { return this.vrmRoot || path.join(DATA_PATH, 'vrm-models'); }

  async libraryItems() {
    const saved = await PluginSettings.getCached(this.name, 'library').catch(() => null);
    return Array.isArray(saved?.items) ? saved.items : [];
  }

  async saveLibraryItem(item) {
    const items = (await this.libraryItems()).filter(i => i.variant !== item.variant);
    items.unshift(item);
    await PluginSettings.setCached(this.name, 'library', { items });
  }

  /** The catalog product holding a variant, or null. The catalog is small and rarely changes. */
  async productOf(variant) {
    const now = Date.now();
    if (!this._catalog || now - this._catalog.at > 600000) {
      const d = await this.api('get', '/api/catalog').catch(() => null);
      if (d) this._catalog = { at: now, products: d.products || [] };
    }
    return (this._catalog?.products || []).find(p => (p.variants || []).some(v => v.id === variant)) || null;
  }

  /** Download everything an order holds, keep each file, and put any model in the gallery. Returns the library item. */
  async ingest({ order, downloads, variant }) {
    const product = await this.productOf(variant);
    const kind = variantKind(variant, product?.collection);
    const label = (product?.variants || []).find(v => v.id === variant)?.label;
    const title = product ? (kind === 'vrm' || kind === 'bundle' || kind === 'animation' || !label ? product.title : `${product.title}: ${label}`) : variant;
    const dir = path.join(this.libraryDir(), safeName(variant));
    await fs.mkdir(dir, { recursive: true });
    const files = [];
    for (const d of downloads) {
      const url = typeof d === 'string' ? d : d?.url;
      if (!url) continue;
      const got = await this.fetchBytes(url);
      for (const f of await unpack(got.buffer, { type: got.type, kind, filename: typeof d === 'string' ? '' : (d.filename || d.name || '') })) {
        await fs.writeFile(path.join(dir, f.name), f.buffer);
        const entry = { name: f.name, kind: f.kind, mime: f.mime, size: f.buffer.length };
        const mood = moodOf(f.name, f.kind);
        if (mood) entry.mood = mood;
        if (f.format) entry.format = f.format;
        if (f.kind === 'animation') {
          entry.label = clipLabel(f.name);
          entry.loop = clipLoops(entry.label);
          const gesture = clipGesture(entry.label);
          if (gesture) entry.gesture = gesture;
          try { Object.assign(entry, { expressions: readVrmaInfo(f.buffer).expressions }); } catch (e) { this.logger.warn(`botsandborgs: ${f.name} is not a VRM animation (${e.message})`); continue; }
        }
        if (f.kind === 'vrm') {
          const installed = await installVrm(f.buffer, { variant, name: product?.title?.replace(/\s*[—-]\s*VRM Avatar$/i, ''), description: `Bought from Bots & Borgs (${product?.title || variant})` }, this.vrmDir());
          entry.modelId = installed.id;
          entry.gallery = installed;
          this.logger.info(`botsandborgs: ${variant} installed in the model gallery as ${installed.id} (${installed.sizeMB} MB, ${installed.boneCount} bones, ${installed.expressions.length} expressions)`);
        }
        files.push(entry);
      }
    }
    const item = { variant, title, kind, collection: product?.collection || null, order: order?.id || null, token: order?.token || null, at: new Date().toISOString(), files };
    await this.saveLibraryItem(item);
    if (files.some(f => f.kind === 'animation')) await this.publishAnimations();
    return item;
  }

  async library({ kind, query, refresh } = {}) {
    if (refresh === true || refresh === 'true') await this.refreshLibrary();
    await this.repairGallery();
    let items = await this.libraryItems();
    if (kind) items = items.filter(i => i.kind === kind || i.files.some(f => f.kind === kind));
    if (query) items = items.filter(i => this.matches(i, query));
    if (!items.length) return { success: true, result: 'Nothing from Bots & Borgs in my library yet.' };
    return { success: true, items: items.map(({ token, ...rest }) => rest), result: `My Bots & Borgs library:\n${items.map(i => {
      const count = {};
      for (const f of i.files) if (!['document', 'preview'].includes(f.kind)) count[f.kind] = (count[f.kind] || 0) + 1;
      return `- ${i.title} (${i.variant}): ${Object.entries(count).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'no usable files'}`;
    }).join('\n')}` };
  }

  /** Orders bought before the library existed, or lost from it, come back from the store's order list. */
  async refreshLibrary() {
    const key = await this.accountKey();
    const d = await this.api('get', '/api/account/orders', { key });
    const have = new Set((await this.libraryItems()).map(i => i.variant));
    for (const o of d.orders || d || []) {
      if (!o.token || !['paid', 'in_production', 'shipped', 'delivered'].includes(o.status)) continue;
      const full = await this.api('get', `/api/orders/${o.id}?token=${encodeURIComponent(o.token)}`, { key }).catch(() => null);
      const order = full?.order || full || {};
      const downloads = full?.downloads || order.downloads || [];
      const variant = (order.items || o.items || [])[0]?.variant;
      if (!variant || have.has(variant) || !downloads.length) continue;
      await this.ingest({ order: { id: o.id, token: o.token }, downloads, variant }).catch(e => this.logger.warn(`botsandborgs: could not restore ${variant}: ${e.message}`));
    }
  }

  /** The gallery's manifest can be replaced by a deploy: bought models whose file is still there go back on the list. */
  async repairGallery() {
    const items = await this.libraryItems();
    if (items.some(i => i.files.some(f => f.kind === 'animation'))) {
      const listed = await fs.access(path.join(this.vrmDir(), 'animations', 'store.json')).then(() => true).catch(() => false);
      if (!listed) await this.publishAnimations().catch(e => this.logger.warn(`botsandborgs: clips not relisted: ${e.message}`));
    }
    for (const item of await this.libraryItems()) {
      for (const f of item.files) {
        if (!f.gallery) continue;
        const list = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (list && !list.some(m => m.id === f.gallery.id)) {
          await fs.access(path.join(this.vrmDir(), f.gallery.file)).then(() => addToManifest(f.gallery, this.vrmDir())).catch(() => {});
        }
      }
    }
  }

  matches(item, words) {
    const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hay = flat(`${item.title} ${item.variant}`);
    const stop = new Set(['the', 'a', 'an', 'my', 'your', 'model', 'vrm', 'set', 'pack', 'you', 'bought', 'sticker', 'stickers', 'emoji', 'portrait', 'portraits', 'avatar', '3d']);
    const want = flat(words).split(' ').filter(w => w && !stop.has(w));
    return hay === flat(words) || (want.length > 0 && want.every(w => hay.includes(w)));
  }

  /** The owned file a request means: the named item, then the wanted kind, then (for stickers) the mood. */
  async pickOwned({ item, kind, mood, kinds }) {
    let items = await this.libraryItems();
    if (item) items = items.filter(i => i.variant === item || this.matches(i, item));
    let pool = items.flatMap(i => i.files.filter(f => (kind ? f.kind === kind : kinds.includes(f.kind))).map(f => ({ item: i, file: f })));
    // A wallpaper sent to someone goes to a phone.
    if (pool.some(p => p.file.format === 'phone')) pool = pool.filter(p => p.file.format !== 'desktop');
    if (pool.length < 2) return pool[0] || null;
    const any = (list) => list[Math.floor(Math.random() * list.length)];
    if (!mood) return any(pool);
    const word = String(mood).toLowerCase().trim();
    const exact = pool.filter(p => p.file.mood?.toLowerCase().split(/,\s*/).includes(word) || p.file.mood?.toLowerCase().includes(word));
    if (exact.length) return any(exact);
    // "ecstatic" names no sticker exactly: the model picks the nearest.
    const moods = pool.filter(p => p.file.mood);
    const pm = this.agent?.providerManager;
    if (moods.length && pm?.generateResponse) {
      const unique = [...new Set(moods.map(p => p.file.mood))];
      const r = await pm.generateResponse(`Which of these is closest to "${word.slice(0, 60)}"? Answer with its number only.\n${unique.map((m, n) => `${n + 1}. ${m}`).join('\n')}`, { maxTokens: 10, temperature: 0 }).catch(() => null);
      const chosen = unique[Number(/\d+/.exec(String(r?.content || ''))?.[0]) - 1];
      if (chosen) return any(moods.filter(p => p.file.mood === chosen));
    }
    return any(pool);
  }

  async readOwned({ item, file }) { return fs.readFile(path.join(this.libraryDir(), safeName(item.variant), file.name)); }

  /** Use something already owned. Nothing here costs anything. */
  async useOwned(data = {}) {
    const asked = String(data._context?.originalInput || data.originalInput || '');
    const item = data.item || data.variant || data.query;
    let as = String(data.as || data.use || (/\b(wear|become)\b|as your (?:3d|vrm)/i.test(asked) ? 'wear' : /\binstall\b/i.test(asked) ? 'install' : /\bas your avatar\b/i.test(asked) ? 'avatar' : '')).toLowerCase();
    // "Re-apply/equip the Sentinel avatar", "update your profile picture": becoming it, never a send that asks "Who
    // should I send it to?" (DELTA 2026-11-06, twice). A model is worn, which brings its picture; a picture is applied.
    if (!as && !data.to && /\b(avatars?|equip|apply|re-?apply|put on|profile (?:pic(?:ture)?|photo|image)|pfp|look like)\b/i.test(asked)) {
      as = (await this.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] })) ? 'wear' : 'avatar';
    }
    const kind = data.kind && data.kind !== 'avatar' ? data.kind : this.kindAsked(asked);
    if (as === 'play' || as === 'dance' || kind === 'animation' || (!as && !data.to && /\b(dance|do (?:the|a) |wave|bow|cheer|clap|laugh|dab)\b/i.test(asked) && !/\b(stickers?|emoji|portraits?|wallpapers?|icons?|vrm|model)\b/i.test(asked))) {
      return this.playClip({ item, clip: data.clip || data.mood, asked });
    }
    if (!as) as = 'send';
    if (as === 'install' || as === 'wear') return this.useModel({ item, wear: as === 'wear' });
    if (as === 'avatar' && item && !(await this.pickOwned({ item, kinds: ['portrait', 'icon'] })) && (await this.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] }))) {
      return this.useModel({ item, wear: true });
    }
    if (as === 'avatar') {
      const s = await this.settings();
      if (!(await this.avatarChangeAllowed(s))) return { success: false, error: "My avatar is tied to my 3D (VRM) model, so I don't change it." };
      const named = item && !isGenericItem(item) ? item : undefined;
      let pick = named ? await this.pickOwned({ item: named, kind: kind && kind !== 'vrm' ? kind : null, kinds: ['portrait', 'icon'] }) : null;
      if (!named) {
        const newest = (await this.libraryItems()).find(i => i.files.some(f => ['portrait', 'icon'].includes(f.kind)));
        if (newest) pick = { item: newest, file: newest.files.find(f => ['portrait', 'icon'].includes(f.kind)) };
      }
      if (!pick) return { success: false, error: 'I have no picture like that from Bots & Borgs.' };
      const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
      const applied = await applyAgentAvatar(this.agent, await this.readOwned(pick), { source: `Bots & Borgs, ${pick.item.variant}`, variant: pick.item.variant });
      return { success: true, result: `${pick.item.title} is my avatar now. ${describeAvatarServices(applied.services)}`.trim() };
    }
    if (as !== 'send') return { success: false, error: 'Use it how? As "send", "avatar", "install" or "wear".' };
    const to = String(data.to || (/\b(me|to me)\b/i.test(asked) ? 'me' : '')).trim();
    if (!to) return { success: false, error: 'Who should I send it to?' };
    const pick = await this.pickOwned({ item, kind, mood: data.mood, kinds: ['sticker', 'emoji', 'portrait', 'icon', 'wallpaper'] });
    if (!pick) {
      const owned = (await this.libraryItems()).length;
      return { success: false, error: `I don't own that${owned ? '' : ' (nothing from Bots & Borgs yet)'}. I can buy it first if you want.` };
    }
    return this.sendFile(pick, to);
  }

  /** One picture to the owner on Telegram (a real sticker for stickers and emoji) or to anyone else as a text. */
  async sendFile({ item, file }, to) {
    const buffer = await this.readOwned({ item, file });
    if (/^(me|owner|myself)$/i.test(to)) {
      const tg = this.agent?.interfaces?.get?.('telegram');
      if (!tg?.sendNotification) return { success: false, error: "Telegram isn't connected, so it wasn't sent." };
      const send = tg.bot?.telegram?.sendSticker && tg.authorizedUserId && ['sticker', 'emoji'].includes(file.kind);
      if (send) {
        try {
          await tg.bot.telegram.sendSticker(tg.authorizedUserId, { source: await toStickerWebp(buffer), filename: 'sticker.webp' });
          return { success: true, result: `Sent you ${item.title}${file.mood ? ` (${file.mood})` : ''}.` };
        } catch (e) { this.logger.warn(`botsandborgs: sendSticker failed, sending a picture: ${e.message}`); }
      }
      await tg.sendNotification(`From Bots & Borgs: ${file.name.replace(/\.[a-z0-9]+$/i, '')}`, { photo: { source: buffer } });
      return { success: true, result: `Sent you ${item.title}.` };
    }
    const tx = this.agent?.apiManager?.apis?.get?.('textx');
    const textx = tx?.instance || tx;
    if (!textx?.execute) return { success: false, error: "I can't text right now, so it wasn't sent." };
    const r = await textx.execute({ action: 'send', to, text: '', _context: { originalInput: `send ${to} the picture`,
      attachedFile: { filename: file.name, mimeType: file.mime, size: buffer.length, base64: buffer.toString('base64') } } });
    if (!r?.success) return { success: false, error: `Sending it to ${to} failed: ${r?.error}` };
    return { success: true, result: `I texted ${item.title} to ${to}.` };
  }

  /** A bought model: into the gallery, and active only when the request says so. */
  /**
   * Bought clips go where the agent's body is: the designer and the playground (animations/store.json beside the
   * model gallery) and AvatarX, when this agent has one. Never anywhere else: the licence allows no sharing.
   */
  async publishAnimations() {
    const listed = await writeStoreAnimations(await this.libraryItems(), this.libraryDir(), this.vrmDir());
    this.logger.info(`botsandborgs: ${listed.length} bought clips listed for the designer and the playground`);
    const { pushClipsToAvatarX } = await import('../../services/avatar/avatarx.js');
    const pushed = await pushClipsToAvatarX(listed.map(c => ({ file: path.join(this.vrmDir(), 'animations', c.file) })))
      .catch(e => { this.logger.warn(`botsandborgs: AvatarX clips not added: ${e.message}`); return null; });
    if (Array.isArray(pushed)) this.logger.info(`botsandborgs: AvatarX holds ${pushed.length} bought clips`);
    return listed;
  }

  /** Play an owned clip on the agent's 3D body: by name ("rumba"), by what it is for ("wave", "dance"), or any one. */
  async playClip({ item, clip, asked = '' }) {
    let pool = (await this.libraryItems()).flatMap(i => i.files.filter(f => f.kind === 'animation').map(f => ({ item: i, file: f })));
    if (!pool.length) return { success: false, error: "I don't own any animations yet. I can buy a pack from Bots & Borgs if you want." };
    if (item && !isGenericItem(item)) {
      const inItem = pool.filter(p => p.item.variant === item || this.matches(p.item, item));
      if (inItem.length) pool = inItem;
    }
    const words = `${clip || ''} ${asked}`.toLowerCase();
    const named = pool.filter(p => { const l = String(p.file.label || '').toLowerCase(); return l && words.includes(l); });
    const purpose = clipGesture(clip || asked);
    const fits = named.length ? named : purpose ? pool.filter(p => p.file.gesture === purpose) : [];
    const choice = (fits.length ? fits : pool)[Math.floor(Math.random() * (fits.length ? fits : pool).length)];
    if (!fits.length && (clip || purpose)) return { success: false, error: `I have no ${clip || purpose} clip. Mine: ${[...new Set(pool.map(p => p.file.label))].join(', ')}.` };
    const { playOnAvatarX, pushClipsToAvatarX } = await import('../../services/avatar/avatarx.js');
    const file = path.join(this.vrmDir(), 'animations', 'store', safeName(choice.item.variant), choice.file.name);
    let played = 'not connected';
    try {
      const [name] = await pushClipsToAvatarX([{ file }]).then(r => (Array.isArray(r) ? r : []));
      if (name) played = await playOnAvatarX(name);
    } catch (e) { this.logger.warn(`botsandborgs: AvatarX did not play ${choice.file.label}: ${e.message}`); played = 'failed'; }
    const where = played === 'played' ? 'on my 3D body in AvatarX now' : 'in the avatar designer and the 3D playground (it isn\'t showing anywhere right now)';
    return { success: played !== 'failed', result: played === 'failed' ? `I couldn't play ${choice.file.label} on AvatarX.` : `Playing ${choice.file.label} (${choice.item.title}) ${where}.`, clip: choice.file.label };
  }

  async useModel({ item, wear }) {
    // No model named = the one bought last (the library is newest first). A random pick among owned models put
    // DELTA back in Racer Blue a second after it bought and wore Pilot White (2026-11-07, a plan's "apply it" step).
    if (item && isGenericItem(item)) item = undefined;
    let pick = item ? await this.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] }) : null;
    if (!item) {
      const newest = (await this.libraryItems()).find(i => i.files.some(f => f.kind === 'vrm'));
      if (newest) pick = { item: newest, file: newest.files.find(f => f.kind === 'vrm') };
    }
    if (!pick) return { success: false, error: "I don't own a model like that. I can buy it first if you want." };
    const buffer = await this.readOwned(pick);
    readVrmInfo(buffer);
    const entry = await installVrm(buffer, { variant: pick.item.variant, name: pick.file.gallery?.name, description: pick.file.gallery?.description }, this.vrmDir());
    if (!wear) return { success: true, result: `${entry.name} is in my model gallery (${entry.boneCount} bones, ${entry.expressions.length} expressions), and every animation in the designer plays on it.` };
    const { Agent } = await import('../../models/Agent.js');
    await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { $set: { activeVRMModel: entry.id } });
    if (this.agent?.agentModel) this.agent.agentModel.activeVRMModel = entry.id;
    const { pushModelToAvatarX } = await import('../../services/avatar/avatarx.js');
    await pushModelToAvatarX(entry.id).catch(e => this.logger.warn(`botsandborgs: AvatarX not told: ${e.message}`));
    // The picture follows the model, so the two never disagree. Wearing only happens when asked or allowed unasked
    // (autoWear), so the picture comes with it either way. A model sold alone has no portrait, only the store's
    // preview of it: that is its picture (DELTA 2026-11-06 wore Sentinel and kept its old picture everywhere).
    const picture = modelPicture(pick.item);
    if (picture) {
      const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
      const applied = await applyAgentAvatar(this.agent, await this.pictureBytes(pick.item, picture), { source: `Bots & Borgs, ${pick.item.variant}`, variant: pick.item.variant });
      return { success: true, result: `${entry.name} is my 3D model now, and its picture is my avatar. ${describeAvatarServices(applied.services)}`.trim() };
    }
    return { success: true, result: `${entry.name} is my 3D model now. It came with no picture, so my avatar picture didn't change.` };
  }

  /**
   * The store models other LANAgent agents wear, from their P2P capabilities ([{ variant, agent }]). Online peers are
   * asked again first (answers land within a few seconds), so a model a peer put on today counts. Never throws.
   */
  async wornByPeers({ waitMs = 4000 } = {}) {
    try {
      const { P2PPeer } = await import('../../models/P2PPeer.js');
      const p2p = this.agent?.p2pService;
      if (p2p?.sendMessage && waitMs > 0) {
        const online = await P2PPeer.getOnlinePeers().catch(() => []);
        if (online.length) {
          await Promise.all(online.map(peer => p2p.sendMessage(peer.fingerprint, { type: 'capabilities_request' }).catch(() => null)));
          await this.pause(waitMs);
        }
      }
      const peers = await P2PPeer.find({ 'capabilities.name': 'wears_store_model' }, { displayName: 1, fingerprint: 1, capabilities: 1 }).lean();
      return peers.flatMap(peer => (peer.capabilities || []).filter(c => c.name === 'wears_store_model' && c.description)
        .map(c => ({ variant: c.description, agent: peer.displayName || String(peer.fingerprint).slice(0, 8) })));
    } catch (e) {
      this.logger.warn(`botsandborgs: could not ask peers what they wear: ${e.message}`);
      return [];
    }
  }

  /** What the owner has said about looks and avatars, from the user profile (USER.md), or ''. Never throws. */
  async ownerTaste() {
    try {
      const { getUserProfile } = await import('../../services/skills/userProfile.js');
      const text = String(await getUserProfile().text() || '');
      return text.split('\n').filter(l => /avatar|model|look|anime|character|style|appearance|wear|outfit|skin/i.test(l)).join('\n').slice(0, 1200);
    } catch { return ''; }
  }

  /** The picture of the Bots & Borgs model this agent wears, for a sync: { variant, title, buffer } or null. */
  async wornModelPicture() {
    let id = this.agent?.agentModel?.activeVRMModel;
    if (id === undefined) {
      id = (await (await import('../../models/Agent.js')).Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { activeVRMModel: 1 }).lean().catch(() => null))?.activeVRMModel;
    }
    if (!id || !String(id).startsWith('store-')) return null;
    const vrmId = (v) => `store-${String(v).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    const item = (await this.libraryItems()).find(i => vrmId(i.variant) === id);
    const file = item && modelPicture(item);
    if (!file) return null;
    return { variant: item.variant, title: item.title, buffer: await this.pictureBytes(item, file) };
  }

  /** A model's picture as avatar bytes: a portrait as is, a preview sheet cut to its front view. */
  async pictureBytes(item, file) {
    const bytes = await this.readOwned({ item, file });
    return file.kind === 'preview' ? portraitFromPreview(bytes).catch(() => bytes) : bytes;
  }

  /**
   * After a reply to the owner: send a sticker or emoji if one fits. Never held up by, and never fails, the reply.
   * Returns the mood sent, or null.
   */
  async autoSticker({ userText, replyText, chatId, threadId } = {}) {
    const now = Date.now();
    if (now - (this._stickerSentAt || 0) < AUTO_STICKER_EVERY_MS || now - (this._stickerAskedAt || 0) < AUTO_STICKER_ASK_EVERY_MS) return null;
    if (!stickerCouldFit(replyText)) return null;
    const s = await this.settings();
    if (!s.autoUse) return null;
    const choices = moodChoices(await this.libraryItems());
    const pm = this.agent?.providerManager;
    const tg = this.agent?.interfaces?.get?.('telegram')?.bot?.telegram;
    if (!choices.length || !pm?.generateAux || !tg?.sendSticker || !chatId) return null;
    this._stickerAskedAt = now;
    const choice = await chooseSticker({
      generate: (prompt) => this.askStickerModel(pm, prompt),
      choices, userText, replyText, agentName: process.env.AGENT_NAME || 'The assistant'
    });
    if (!choice) { this.logger.info('botsandborgs: no sticker suits this reply'); return null; }
    const pick = choice.picks[Math.floor(Math.random() * choice.picks.length)];
    const webp = await toStickerWebp(await this.readOwned(pick));
    await tg.sendSticker(chatId, { source: webp, filename: 'sticker.webp' }, threadId ? { message_thread_id: threadId } : {});
    this._stickerSentAt = Date.now();
    this.logger.info(`botsandborgs: sent a ${pick.file.kind} unasked (${choice.mood}, ${pick.item.variant})`);
    return choice.mood;
  }

  /**
   * Which sticker fits takes judgement: replayed on 12 exchanges, gpt-5.6-luna got all 12 and gpt-4.1-nano, the fast
   * model, sent "lol" for "the cake made me sick". On OpenRouter it gets the better model. A failure means no sticker:
   * this is decoration, and a worse model guessing is worse than nothing.
   */
  async askStickerModel(pm, prompt) {
    const provider = await pm.getCurrentProvider?.().catch?.(() => null);
    if (pm.providerNameOf?.(provider) === 'openrouter') {
      const model = process.env.BOTSANDBORGS_STICKER_MODEL || 'openai/gpt-5.6-luna';
      return pm.generateResponse(prompt, { model, maxTokens: 200, temperature: 0 });
    }
    return pm.generateAux(prompt, { maxTokens: 10, temperature: 0, auxTask: 'store-sticker' });
  }

  /** The wallpaper behind the dashboard today: { path, mime }, or null when none is owned or it is switched off. */
  async backdrop() {
    if (!(await this.settings()).autoUse) return null;
    const pick = wallpaperFor(await this.libraryItems(), { format: 'desktop' });
    if (!pick) return null;
    return { path: path.join(this.libraryDir(), safeName(pick.item.variant), pick.file.name), mime: pick.file.mime };
  }

  /** Put what was bought to use, as the purchase said. */
  async use({ order, downloads, use, to, usd, hash, label, variant }) {
    const paid = `Bought ${variant} for $${usd.toFixed(2)} (${label || `paid on BNB Chain, tx ${hash}`}).`;
    let item;
    try {
      item = await this.ingest({ order, downloads, variant });
    } catch (e) {
      this.logger.warn(`botsandborgs: download for ${order.id} unreadable: ${e.message}`);
      return { success: false, error: `Bought ${variant} (order ${order.id}, tx ${hash}), but I couldn't open the download: ${e.message}` };
    }
    const usable = item.files.filter(f => !['document', 'preview'].includes(f.kind));
    if (!usable.length) return { success: false, error: `Bought ${variant} (order ${order.id}, tx ${hash}), but I couldn't find anything usable in the download.` };
    const model = item.files.find(f => f.kind === 'vrm');
    const pictures = usable.filter(f => f.kind !== 'vrm');
    const counts = () => {
      const c = {};
      for (const f of usable) c[f.kind] = (c[f.kind] || 0) + 1;
      return Object.entries(c).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    };
    let done;
    if (use === 'avatar') {
      const pic = pictures[0];
      if (!pic) return { success: false, error: `${paid} It holds no picture, so my avatar didn't change.` };
      // Everywhere the agent shows a face, not only its own file (owner, 2026-10-28: DELTA's new avatar stayed local).
      const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
      const applied = await applyAgentAvatar(this.agent, await this.readOwned({ item, file: pic }), { source: `Bots & Borgs, ${variant}`, variant });
      done = `It is my avatar now. ${describeAvatarServices(applied.services)}`.trim();
    } else if (use === 'send') {
      const who = String(to || '').trim();
      const pic = pictures[0];
      if (!pic) return { success: false, error: `${paid} It is a 3D model, and its licence doesn't let me pass the file on, so it's installed here instead.` };
      const sent = await this.sendFile({ item, file: pic }, who);
      if (!sent.success) return { success: false, error: `Bought ${variant} (order ${order.id}), but ${sent.error}` };
      done = /^(me|owner|myself)$/i.test(who) ? 'I sent it to you on Telegram.' : `I texted it to ${who}.`;
      if (pictures.length > 1) done += ` The other ${pictures.length - 1} are in my library.`;
    } else if (use === 'wear' && model) {
      const r = await this.useModel({ item: variant, wear: true });
      if (!r.success) return { success: false, error: `${paid} ${r.error}` };
      done = r.result;
    } else if (model) {
      done = `${model.gallery?.name || 'It'} is in my model gallery, and every animation in the designer plays on it.${pictures.length ? ` ${counts()} in my library.` : ''}`;
    } else {
      done = `${counts()} in my library, ready to use.`;
      // A phone wallpaper can't be set from here, so the owner gets one to set.
      const phone = (await this.settings()).autoUse ? wallpaperFor([item], { format: 'phone' }) : null;
      if (phone) {
        const sent = await this.sendFile(phone, 'me');
        done += sent.success ? ' I sent you one for your phone.' : ` I couldn't send you one for your phone: ${sent.error}`;
      }
    }
    const all = await this.ledger();
    const mine = all.find(p => p.order === order.id);
    if (mine) { mine.used = true; mine.usedAt = new Date().toISOString(); await PluginSettings.setCached(this.name, 'ledger', { purchases: all }); }
    return { success: true, result: `${paid} ${done}` };
  }
}
