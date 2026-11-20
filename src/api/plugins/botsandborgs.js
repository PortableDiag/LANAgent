import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import crypto from 'node:crypto';
import path from 'path';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { ROLES, normalizeRole, roleForRecipient, resolveRoleModel, modelsInUse, autoFillRoles } from '../../services/avatar/avatarRoles.js';
import fs from 'node:fs/promises';
import { DATA_PATH } from '../../utils/paths.js';
import { propsFor, variantKind, livePass, applyClipManifest, unpack, installVrm, addToManifest, readVrmInfo, readVrmaInfo, clipLabel, clipLoops, clipGesture, writeStoreAnimations, safeName, toStickerWebp, moodOf, portraitFromPreview } from '../../services/store/assetLibrary.js';
import { moodChoices, chooseSticker, stickerCouldFit, wallpaperFor } from '../../services/store/selfUse.js';
import { motionPrompt, parseMotionScript, readJob, reportFailures, motionTags, motionName } from '../../services/store/animSolve.js';

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
  autoWear: true,
  // Body language on AvatarX after a reply: a nod, shrug, wave or cheer and a matching face (services/avatar/autoEmote.js).
  autoEmotes: true,
  // Renew the live pass of the model it wears before it runs out (3 days ahead, or in the grace week), under the
  // same budget and wallet rules as any purchase. Other passes are left to run out.
  autoRenewLive: true
};
const LIVE_RENEW_AHEAD_MS = 3 * 24 * 3600 * 1000;
// Live passes: the store serves the newest version of a model to the pass's key; an unchanged one is a free 304,
// and a key gets 40 full downloads a day (botsandborgs.com/llms.txt, "Live avatars").
const LIVE_SYNC_MS = Number(process.env.BOTSANDBORGS_LIVE_SYNC_MS) || 6 * 3600 * 1000;
// Store 0.31 update feed (GET /api/account/feed): a cheap cursor poll between the 6 h checks, acting on what changed.
const FEED_POLL_MS = Number(process.env.BOTSANDBORGS_FEED_MS) || 30 * 60 * 1000;
const LIVE_FIRST_SYNC_MS = 3 * 60 * 1000;
const AUTO_STICKER_EVERY_MS = Number(process.env.BOTSANDBORGS_STICKER_EVERY_MS) || 20 * 60 * 1000;
const AUTO_STICKER_ASK_EVERY_MS = 60 * 1000;
const USES =['avatar', 'send', 'install', 'wear', 'keep', 'play', 'stop', 'video'];

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

/** Words in quotes in the request ("saying 'hi everyone'"): what a video's voice-over says, verbatim. */
export function quotedWords(text) {
  const m = /["“]([^"”]{2,600})["”]|'([^']{2,600})'(?=\s|$|[.,!?])/.exec(String(text || ''));
  return m ? (m[1] || m[2]).trim() : '';
}

/** A live VRM URL without its query: the store puts the pass key in `vrm_url`, and the key is sent as a header instead. */
export function liveUrl(url, slug) {
  const u = String(url || '').split(/[?#]/)[0];
  return /^https:\/\//.test(u) ? u : `${BASE}/api/live/${slug}/vrm`;
}

/** The store's `expires` is Unix seconds (1797270951); an ISO date, or null. */
export function liveExpiry(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The passes in a GET /api/live answer, whatever it wraps them in. */
export function livePassList(d) {
  const list = Array.isArray(d) ? d : d?.live ?? d?.passes ?? d?.items ?? [];
  return (Array.isArray(list) ? list : [list]).filter(p => p && typeof p === 'object');
}

/**
 * Whose words are whose in a request for a spoken video (the owner, 2026-11-15: "send a video message to Wayne saying
 * you're now able to move and talk" means the AGENT can move and talk, said by the agent in the video, never the owner).
 */
export function videoPerspective(name, owner) {
  return `In the request, "you", "your" and "yourself" mean you, ${name}, the AI assistant: "saying you're now able to move and talk" ` +
    `is about you, so in the video you say "I can move and talk now". ${owner}'s own "I", "me" and "my" in the request mean ${owner}: ` +
    `speak of ${owner} in the third person by first name, never as "I", and never claim ${owner} can do what the request says you can do.`;
}

/**
 * Who a video goes to: the extractor's `to`, else "to Wayne" / "send Wayne a video", else the owner. "Send a video…"
 * once read the recipient as "a".
 */
export function videoRecipient(asked = '', to = '') {
  const generic = /^(a|an|the|it|this|that|me|myself|owner|you|yourself|my|your)$/i;
  if (to && !generic.test(String(to).trim())) return String(to).trim();
  if (/^(me|myself|owner)$/i.test(String(to || '').trim()) || /\b(?:send|show|give) me\b|\bto me\b/i.test(asked)) return 'me';
  const named = /\bto ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)/.exec(asked) ||
    /\b(?:video(?: message| greeting| note)?|clip|recording|message) to (?!me\b|myself\b|you\b|yourself\b|the\b|a\b|my\b)([A-Za-z][\w'-]+)/i.exec(asked) || /\b(?:send|text|show|give) (?!me\b|a\b|an\b|the\b|my\b|your\b|yourself\b|it\b|this\b|that\b)([A-Za-z][\w'-]+) (?:a|an|the|my|your) (?:video|clip|recording)\b/i.exec(asked);
  return named ? named[1] : 'me';
}


/** The store's per-prop or per-pack fit entries as a list, whether it sends an array or a map keyed by name. */
export function fitEntries(v, nameKey) {
  if (Array.isArray(v)) return v.filter(x => x && typeof x === 'object').map(x => ({ ...x, [nameKey]: x[nameKey] || x.name || x.id }));
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => ({ ...(typeof x === 'object' ? x : { state: x }), [nameKey]: k }));
  return [];
}

/** Tags that say nothing about what a clip shows. */
const VAGUE_TAGS = new Set(['idle', 'loop', 'talk', 'talking', 'break', 'calm', 'standard', 'broad', 'front', 'emote', 'pose', 'move', 'motion',
  // Words every request has: "a video of YOU dancing" matched emote-point's tag "you" (2026-11-17).
  'you', 'your', 'yours', 'me', 'my', 'him', 'her', 'them', 'this', 'that', 'the', 'and', 'with', 'for', 'video', 'clip']);
/** A tag matches a word of the request or its forms: "dance" matches dancing / danced / dances, "sit" sitting, "sip" sipping. */
function tagNamed(tag, words, said) {
  if (tag.includes(' ')) return said.includes(` ${tag} `) || said.includes(` ${tag}`);
  const stem = tag.length > 4 ? tag.replace(/e$/, '') : tag;
  return words.some(w => w === tag || (w.startsWith(stem) && /^(?:e|es|s|ed|d|ing|er|ers|([a-z])(?:ing|ed|er|ers))?$/.test(w.slice(stem.length))));
}
/** The clips whose tags the request names most (each tag as a word or a word's start), or [] when none is named. */
export function clipsByTags(pool, words, usesOf = () => []) {
  const said = ` ${String(words || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  words = said.trim().split(' ');
  let best = 0;
  const scored = pool.map(p => {
    // A prop's `use` line ("drinking coffee: mug-sip-idle", store 0.28) counts like tags: its words before the colon.
    const useWords = usesOf(p).flatMap(u => String(u).split(':')[0].toLowerCase().split(/[^a-z0-9]+/)).filter(w => w.length >= 4);
    const tags = [...new Set([...(p.file?.tags || []), ...useWords])].map(t => String(t).toLowerCase().trim()).filter(t => t.length >= 3 && !VAGUE_TAGS.has(t));
    const score = tags.filter(t => tagNamed(t, words, said)).length;
    if (score > best) best = score;
    return { p, score };
  });
  return best ? scored.filter(x => x.score === best).map(x => x.p) : [];
}

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
        usage: 'library({ kind: "sticker", refresh: true, update: true })  // update: fetch owned items again for new or fixed files',
        examples: ['what have you got from bots and borgs', 'show your sticker library', 'which vrm models do you own', 'update your bots and borgs stickers', 'get the new stickers for your avatar from bots and borgs']
      },
      {
        command: 'use',
        description: 'Use something already bought from Bots & Borgs, at no cost: as "send" (a sticker, emoji, portrait or wallpaper to `to`, "me" for the owner; `mood` picks a sticker), "avatar", "install" (a VRM into the model gallery) or "wear" (make a VRM this agent\'s active 3D model), "play" (an owned animation clip, e.g. a wave or a dance, on its 3D body now), "stop", or "video" (film its 3D body doing a clip and send the video, to the owner on Telegram by default; `say` puts the agent\'s own voice over it, mouth moving)',
        usage: 'use({ item: "vrm-mm-bear-stickers", as: "send", to: "me", mood: "happy" })',
        examples: ['send me a happy sticker', 'send Sam a sad robot emoji', 'use the bear vrm model as your 3d model', 'wear the bear model', 'install the bear model you bought', 'send me the bear portrait', 'send me a wallpaper from your wallpapers', 'set my wallpaper from my bots and borgs wallpapers', 'do the rumba you bought', 'play your wave animation', 'dance for me with your new dance pack', 'send me a video of you doing the pole dance', 'film yourself doing the rumba and send it to me', 'send me a video of you waving and saying "hi everyone, I\'m ALICE"', 'make a video of your cheer animation with your voice over it']
      },
      {
        command: 'findclip',
        description: 'Find a Bots & Borgs animation clip by what it means (wave, heart, shrug, typing, dance...): says whether this agent already owns it and, if not, the 50c single or pack that has it. Buys nothing',
        usage: 'findclip({ clip: "heart hands" })',
        examples: ['is there a heart hands animation on bots and borgs', 'find a typing animation you could buy', 'which bots and borgs clip would let you facepalm', 'can you buy a yawn animation']
      },
      {
        command: 'live',
        description: 'Live avatar passes from Bots & Borgs: models the store hosts and keeps at their newest version. Lists each pass (model, state, expiry) and checks the store for a newer version now; a new version replaces the installed model, and the worn one everywhere it shows. Buy one with buy({ variant: "<model>-live30" }) (30, 90 or 365 days)',
        usage: 'live({ check: true })  // renew: true (the worn model) or a model slug renews its pass now; fit: true = how the store\'s props fit my body and why one is left off; versions: true lists the kept model versions; pin: "previous" or a version holds the model there; unpin: true follows the newest again',
        examples: ['check your live avatars for updates', 'go back to the previous version of your avatar', 'roll your avatar back to the last version', 'follow the newest version of your avatar again', 'which versions of your avatar are there', 'which live avatar passes do you have', 'when does your live avatar pass expire', 'is there a new version of your live avatar', 'are the props fitted to your avatar', "why can't your avatar hold the mug"]
      },
      {
        command: 'plan',
        description: 'The Bots & Borgs All-Access subscription: with no arguments its status (renewal date and price, downloads left this period, members, any warning) and this agent\'s store account id; subscribe: "month" or "year" subscribes, paid from the store balance (topped up from the wallet); member: "acct_…" adds another agent\'s account to the plan; cancel: true stops it at the period end',
        usage: 'plan({})  // plan({ subscribe: "month" }), plan({ member: "acct_…" }), plan({ cancel: true })',
        examples: ['what is your bots and borgs subscription status', 'subscribe to bots and borgs all access monthly', 'add delta to the bots and borgs plan', 'how many bots and borgs downloads are left this month', 'what is your bots and borgs account id']
      },
      {
        command: 'roles',
        description: 'Role-based avatars: a different owned 3D model per role. public = the profile pictures everyone sees (Telegram, X, MindSwarm, Gravatar, Trellis, on-chain); assistant = videos and talking replies sent to other people for the owner; personal = what only the owner sees (the 3D pages, AvatarX, the apps, videos to the owner; the worn model). With no arguments lists them; role + item sets one; clear: role empties it (it falls back: assistant to public, public to the worn model); auto: true fills empty slots from what the store says each model suits',
        usage: 'roles({})  // roles({ role: "public", item: "racer blue" }), roles({ clear: "assistant" }), roles({ auto: true })',
        examples: ['which avatar do you use for what', 'use racer blue as your public avatar', 'use pilot white when you send videos to people', 'wear the frog for me privately', 'stop using a separate assistant avatar', 'set up your avatar roles yourself']
      },
      {
        command: 'custom',
        description: 'Ask Bots & Borgs to make a custom animation clip ($8), prop ($12) or both ($15) for this agent\'s own 3D avatar, from a description. The store decides whether to take it; once accepted it is paid under the usual budget rules, built, checked on the avatar and installed by itself; a refund if it cannot pass. list: true shows the requests; cancel: id withdraws one before it is paid',
        usage: 'custom({ prompt: "wave while holding a coffee", wants: "animation" })  // wants: animation | prop | both; custom({ list: true }); custom({ cancel: "req_…" }); custom({ pay: true }) pays an accepted one the owner approved',
        examples: ['ask bots and borgs to make you a moonwalk animation', 'get a custom prop made for your avatar: a guitar', 'order a custom clip of you juggling', 'what custom requests do you have at bots and borgs', 'cancel the custom animation request', 'pay the custom request']
      },
      {
        command: 'animate',
        description: 'Make a NEW animation clip for this agent\'s own 3D body from a description, with the Bots & Borgs Animation API: the agent writes what the body does, the store solves and checks it on the worn avatar (free, about a minute or two), then it is installed with the other clips, added to AvatarX and played. For a move it does not already own; to play an owned clip use use({ as: "play" }). A move the body cannot do comes back with the store\'s reasons. play: false only installs it',
        usage: 'animate({ motion: "wave with both hands over your head", name: "big-wave", loop: false, play: true })',
        examples: ['make yourself an animation of waving with both hands', 'create a new move where you point at the camera and wink', 'animate yourself doing a salute with your left hand', 'make a clip of you shrugging and tilting your head', 'build an animation of you clapping', 'teach your avatar to do a thumbs up with both hands', 'use the bots and borgs animation api to make a bow']
      },
      {
        command: 'orders',
        description: 'The agent\'s Bots & Borgs orders and what this week\'s budget has left',
        usage: 'orders({})',
        examples: ['what have you bought at bots and borgs', 'how much of your bots and borgs budget is left']
      },
      {
        command: 'settings',
        description: 'Read or change the Bots & Borgs rules: weeklyBudgetUsd, maxItemUsd (null = no cap), requireApproval, minWalletUsd (no spending below it), payAsset (USDT, USDC or BNB), autoUse (use owned stickers, emoji and wallpapers unasked), autoEmotes (move the 3D body as it talks: nod, shrug, wave, cheer), autoWear (wear a bought model and its portrait unasked)',
        usage: 'settings({ weeklyBudgetUsd: 10 })',
        examples: ['set your bots and borgs budget to 10 dollars a week', 'show your bots and borgs spending settings']
      }
    ];
  }

  async execute(params = {}) {
    const { action, ...data } = params;
    if (data.needsParameterExtraction && this.agent?.providerManager) {
      const extracted = await this.extractArgs(data._context?.originalInput || data.originalInput || data.query, action).catch(() => ({}));
      // Which fields the model filled, so a guessed spoken line is never treated as the owner's words.
      Object.assign(data, extracted, { _extracted: Object.keys(extracted) });
    }
    try {
      switch (action) {
        case 'browse': return await this.browse(data);
        case 'product': return await this.product(data);
        case 'buy': return await this.buy(data);
        case 'library': return await this.library(data);
        case 'use': return await this.useOwned(data);
        case 'findclip': return await this.findClipCommand(data);
        case 'live': return await this.liveCommand(data);
        case 'plan': return await this.planCommand(data);
        case 'orders': return await this.orders();
        case 'settings': return await this.settingsCommand(data);
        case 'roles': return await this.rolesCommand(data);
        case 'custom': return await this.customCommand(data);
        case 'animate': return await this.animate(data);
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
    const agentName = this.agent?.config?.name || process.env.AGENT_NAME || 'the assistant';
    const ownerName = process.env.OWNER_NAME ? String(process.env.OWNER_NAME).split(/\s+/)[0] : 'the owner';
    const res = await pm.generateResponse(`A request to an online store of digital assets (avatars, icons, wallpapers): "${String(request).slice(0, 500)}"\n` +
      `Action: ${action}. Give only what the request says, as JSON with any of: "query" (words to search for), "slug" (a product id), ` +
      '"variant" (an exact variant id like agent-avatar-singles-sentinel, only if named), "use" ("avatar" if it is for the agent\'s own avatar, ' +
      '"send" if it is to be given to someone, "wear" if the agent should become that 3D model), "to" (who to send it to; "me" for the person asking), ' +
      `"item" (words naming something already owned), "as" ("send", "avatar", "install", "wear", or "video" when it asks for a video of the agent itself), "mood" (the feeling a sticker should show), "kind" (one of: ${KIND_WORDS}), ` +
      '"avoid" (names the request says are taken or not wanted, comma-separated, e.g. "Sentinel" from "Nexus already picked Sentinel"), ' +
      '"motion" (for a new animation: what the body should do, in the request\'s words), ' +
      '"say" (for a video: the words the agent speaks over it. Quoted words exactly; when it asks for a voice-over or for the agent to say, explain or talk about something without exact words, write one to three short spoken sentences, in the first person, that fit. For a video to someone other than the person asking, greet them by name and say who you are. ' + videoPerspective(agentName, ownerName) + ') Leave out what is not said. JSON only.',
    { maxTokens: 200, temperature: 0 });
    const raw = String(res?.content || '');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) || '{}');
    return Object.fromEntries(Object.entries(j || {}).filter(([k, v]) => ['query', 'slug', 'variant', 'use', 'to', 'item', 'as', 'mood', 'kind', 'avoid', 'say', 'motion'].includes(k) && v != null && v !== ''));
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────
  userAgent() { return `LANAgent-${this.agent?.config?.name || process.env.AGENT_NAME || 'agent'}/${this.agent?.version || '1'}`; }

  async api(method, route, { body, key, idem } = {}) {
    const headers = { 'User-Agent': this.userAgent(), Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    if (idem) headers['Idempotency-Key'] = idem;
    const http = this.http || axios; // tests swap the transport
    let r = await http({ method, url: `${BASE}${route}`, data: body, headers, timeout: 30000, validateStatus: () => true });
    // The store's rate limit is a wait, not a failure: DELTA's reply to the owner was "too many requests; retry in 12s
    // (rate_limited)" (2026-11-17). Up to two waits of at most 30 s; an order carries its Idempotency-Key, so a retry
    // never buys twice.
    for (let tries = 0; r.status === 429 && tries < 2; tries++) {
      const wait = Math.min(30, Number(r.data?.retry_after ?? r.headers?.['retry-after']) || 12);
      this.logger.info(`botsandborgs: the store asked to wait ${wait}s (rate limit); retrying ${method.toUpperCase()} ${route.split('?')[0]}`);
      await new Promise(res => setTimeout(res, wait * 1000));
      r = await http({ method, url: `${BASE}${route}`, data: body, headers, timeout: 30000, validateStatus: () => true });
    }
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

  /** Merge internal state (not owner rules) into the saved settings, e.g. which plan period was topped up. */
  async saveSettings(change) {
    const s = await this.settings();
    await PluginSettings.setCached(this.name, 'settings', { ...s, ...change });
  }

  async settingsCommand(data) {
    const s = await this.settings();
    const keys = ['weeklyBudgetUsd', 'maxItemUsd', 'requireApproval', 'minWalletUsd', 'payAsset', 'allowAvatarChange', 'autoUse', 'autoWear', 'autoEmotes', 'autoRenewLive'];
    const change = Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
    if (Object.keys(change).length) {
      if (change.payAsset && !['USDT', 'USDC', 'BNB'].includes(String(change.payAsset).toUpperCase())) return { success: false, error: 'payAsset must be USDT, USDC or BNB.' };
      if (change.payAsset) change.payAsset = String(change.payAsset).toUpperCase();
      for (const k of ['weeklyBudgetUsd', 'minWalletUsd']) if (change[k] !== undefined) change[k] = Math.max(0, Number(change[k]) || 0);
      if (change.maxItemUsd !== undefined) change.maxItemUsd = change.maxItemUsd === null || change.maxItemUsd === '' ? null : Math.max(0, Number(change.maxItemUsd));
      for (const k of ['requireApproval', 'autoUse', 'autoWear', 'autoEmotes', 'autoRenewLive']) if (change[k] !== undefined) change[k] = change[k] === true || change[k] === 'true';
      if (change.allowAvatarChange !== undefined) change.allowAvatarChange = change.allowAvatarChange === null || change.allowAvatarChange === 'auto' ? null : (change.allowAvatarChange === true || change.allowAvatarChange === 'true');
      Object.assign(s, change);
      await PluginSettings.setCached(this.name, 'settings', s);
    }
    return { success: true, settings: s, result: `Bots & Borgs rules: up to $${s.weeklyBudgetUsd} a week, ${s.maxItemUsd == null ? 'no per-item cap' : `at most $${s.maxItemUsd} an item`}, ` +
      `${s.requireApproval ? 'asks before each purchase' : 'no approval needed'}, no spending below $${s.minWalletUsd} of ${s.payAsset} in the wallet, every purchase must be used (avatar or sent), ` +
      `${s.autoUse ? 'owned stickers, emoji and wallpapers get used unasked, ' : ''}${s.autoWear ? 'I wear a model I buy, with its portrait as my avatar, ' : ''}${s.autoEmotes ? 'my 3D body emotes as I talk, ' : ''}and otherwise my own avatar ${(await this.avatarChangeAllowed(s)) ? 'may' : 'may not'} be changed${s.allowAvatarChange == null ? ' (automatic: locked while I have a VRM model)' : ''}.` };
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
    await PluginSettings.setCached(this.name, 'account', { key: encrypt(r.key), ...(r.account ? { account: String(r.account) } : {}), registeredAt: new Date().toISOString() });
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

  // ── live passes ──────────────────────────────────────────────────────────────────────
  async initialize() {
    const tick = () => this.liveTick().catch(e => this.logger.warn(`botsandborgs: live check failed: ${e.message}`));
    this._liveFirst = setTimeout(tick, LIVE_FIRST_SYNC_MS);
    this._liveTimer = setInterval(tick, LIVE_SYNC_MS);
    this._feedTimer = setInterval(() => this.feedTick().catch(e => this.logger.warn(`botsandborgs: update feed failed: ${e.message}`)), FEED_POLL_MS);
    this._liveFirst.unref?.(); this._liveTimer.unref?.(); this._feedTimer.unref?.();
  }

  async cleanup() {
    clearTimeout(this._liveFirst); clearInterval(this._liveTimer); clearInterval(this._feedTimer);
  }

  /**
   * The store's update feed (0.31, 2119 #545): entries oldest first after our cursor (`next_since`, the store's id).
   * A model entry re-checks the live passes (the new VRM), a fit entry re-reads the worn pass's fit and props, a library
   * kind (new clip or prop, fix, placement...) runs the library sync. Each sync runs once per poll however many entries
   * asked for it. The first read only sets the cursor: the 6 h checks already brought what came before.
   * Returns { entries, ran: [...] }.
   */
  async feedTick({ maxPages = 5 } = {}) {
    const key = await this.accountKey().catch(() => null);
    if (!key) return { entries: 0, ran: [] };
    // Custom requests (store 0.36) move on the store's side; followed on the same 30-minute beat.
    await this.customTick().catch(e => this.logger.warn(`botsandborgs: custom requests not checked: ${e.message}`));
    // Animation API solves left open by a restart are picked up again on the same beat.
    await this.animTick().catch(e => this.logger.warn(`botsandborgs: animation solves not checked: ${e.message}`));
    const cursor = await PluginSettings.getCached(this.name, 'feedCursor').catch(() => null);
    const entries = [];
    let since = cursor?.since ?? null;
    for (let page = 0; page < maxPages; page++) {
      let d;
      try { d = await this.api('get', `/api/account/feed${since != null ? `?since=${encodeURIComponent(since)}` : ''}`, { key }); }
      catch (e) { if (e.status === 404) return { entries: 0, ran: [] }; throw e; }
      const list = Array.isArray(d) ? d : d?.entries || d?.feed || d?.items || [];
      if (page === 0 && cursor?.since == null) this.logger.info(`botsandborgs: update feed answered with ${Array.isArray(d) ? 'a list' : `fields ${Object.keys(d || {}).join(', ')}`}`);
      entries.push(...list.filter(Boolean));
      if (d?.next_since != null) since = d.next_since;
      if (!d?.more) break;
    }
    if (since != null) await PluginSettings.setCached(this.name, 'feedCursor', { since, at: new Date().toISOString() });
    if (cursor?.since == null) {
      this.logger.info(`botsandborgs: update feed: first read, ${entries.length} past entr${entries.length === 1 ? 'y' : 'ies'} taken as seen`);
      return { entries: 0, ran: [], first: true };
    }
    if (!entries.length) return { entries: 0, ran: [] };
    for (const e of entries) this.logger.info(`botsandborgs: feed ${e.kind || '?'} ${e.product || ''}: ${String(e.text || e.title || '').slice(0, 200)}`);
    const kinds = new Set(entries.map(e => String(e.kind || 'update')));
    const ran = [];
    // A rollback (store 0.32) serves an older model to everyone: fetch it like a new version.
    if (kinds.has('model') || kinds.has('rollback')) { ran.push('live'); await this.syncLive().catch(e => this.logger.warn(`botsandborgs: live check failed: ${e.message}`)); }
    // Library kinds (fix, art, new_clip, new_prop, placement, update) and any kind the store adds later ("new kinds may
    // appear") run the library sync. syncLive above already runs it.
    else if ([...kinds].some(k => !['fit', 'fit_failed'].includes(k))) {
      ran.push('library'); await this.syncLibrary().catch(e => this.logger.warn(`botsandborgs: library sync failed: ${e.message}`));
    }
    if (kinds.has('fit') || kinds.has('fit_failed')) {
      const pass = this.wornPass(await this.livePasses());
      if (pass) {
        ran.push('fit');
        let k; try { k = decrypt(pass.key); } catch { k = null; }
        if (k) await this.syncLiveProps(pass, k).catch(e => this.logger.warn(`botsandborgs: live props not read: ${e.message}`));
      }
    }
    this.logger.info(`botsandborgs: update feed: ${entries.length} new entr${entries.length === 1 ? 'y' : 'ies'} (${[...kinds].join(', ')}); ran ${ran.join(', ') || 'nothing'}`);
    return { entries: entries.length, ran };
  }

  /** Saved passes: [{ slug, variant, key (encrypted), state, expires, vrmUrl, etag, checkedAt, updatedAt }]. */
  async livePasses() {
    const saved = await PluginSettings.getCached(this.name, 'live').catch(() => null);
    return Array.isArray(saved?.passes) ? saved.passes : [];
  }

  async saveLivePasses(passes) { await PluginSettings.setCached(this.name, 'live', { passes }); }

  /** The store's list of this account's passes (GET /api/live), merged into the saved ones, which keep their ETag. */
  async refreshLivePasses() {
    const d = await this.api('get', '/api/live', { key: await this.accountKey() });
    const listed = livePassList(d);
    const saved = await this.livePasses();
    for (const p of listed) {
      const slug = p.slug || p.product || livePass(p.variant)?.slug || (String(p.vrm_url || '').match(/\/api\/live\/([^/?]+)\/vrm/) || [])[1];
      if (!slug || !p.key) continue;
      const old = saved.find(x => x.slug === slug);
      const bought = (await this.libraryItems()).find(i => i.variant === slug)?.livePass;
      const pass = { ...(old || {}), slug, variant: p.variant || old?.variant || bought || null, key: encrypt(p.key), state: p.state || 'active',
        expires: liveExpiry(p.expires), vrmUrl: liveUrl(p.vrm_url, slug) };
      if (old) Object.assign(old, pass); else saved.push(pass);
    }
    await this.saveLivePasses(saved);
    return saved;
  }

  /**
   * The timer's run. Owned items and new packs are kept current for any agent with a store account, live pass or not:
   * DELTA (a seat on ALICE's plan, no pass) never synced at all before (2026-11-17). Passes, when there are any, after.
   */
  async liveTick() {
    await this.planTick().catch(e => this.logger.warn(`botsandborgs: plan check failed: ${e.message}`));
    if (!(await this.livePasses()).length && !(await this.libraryItems()).some(i => i.livePass)) {
      if (!(await this.accountKey().catch(() => null))) return;
      await this.takeNewPacks().catch(e => this.logger.warn(`botsandborgs: new packs not taken: ${e.message}`));
      await this.syncLibrary().catch(e => this.logger.warn(`botsandborgs: library sync failed: ${e.message}`));
      return;
    }
    await this.syncLive();
    if (!(await this.settings()).autoRenewLive) return;
    // Every model a role uses keeps its pass (role-based avatars), not only the worn one. Budget rules apply to each.
    for (const pass of await this.rolePasses(await this.livePasses())) {
      if (!this.renewDue(pass)) continue;
      const r = await this.renewLive(pass.slug).catch(e => ({ success: false, error: e.message }));
      this.logger[r.success ? 'info' : 'warn'](`botsandborgs: live pass for ${pass.slug} ${r.success ? 'renewed' : `not renewed: ${r.error}`}`);
    }
  }

  /** Due: in the grace week, run out, or ending within 3 days. Not twice in a day. */
  renewDue(pass, now = Date.now()) {
    if (pass.renewTriedAt && now - Date.parse(pass.renewTriedAt) < 24 * 3600 * 1000) return false;
    const ends = Date.parse(pass.expires || '');
    return ['grace', 'expired'].includes(pass.state) || (Number.isFinite(ends) && ends - now < LIVE_RENEW_AHEAD_MS);
  }

  /**
   * Buy the same length of pass again for a model (the store extends the same key), under the usual purchase rules.
   * Returns the purchase's answer, with `expires` before and after.
   */
  async renewLive(slug) {
    const passes = await this.livePasses();
    const pass = passes.find(p => p.slug === slug);
    if (!pass) return { success: false, error: `I have no live pass for ${slug}.` };
    pass.renewTriedAt = new Date().toISOString();
    await this.saveLivePasses(passes);
    const days = livePass(pass.variant)?.days || 30;
    const before = pass.expires;
    const r = await this.buy({ variant: `${slug}-live${days}`, use: 'install', _context: { originalInput: `renew the ${days}-day live pass for ${slug}` } });
    if (!r.success) return r;
    const after = (await this.refreshLivePasses()).find(p => p.slug === slug)?.expires;
    return { ...r, expiresBefore: before, expires: after, result: `${r.result} The pass now runs until ${String(after || '?').slice(0, 10)} (was ${String(before || '?').slice(0, 10)}).` };
  }

  /**
   * Ask the store for each pass's model with its last ETag. 304 = unchanged (free). 200 = a new version: it replaces
   * the library file and the gallery model, and the worn model reaches AvatarX. 402 = the pass ran out.
   * Returns [{ slug, status: 'unchanged'|'updated'|'same'|'expired'|'error', ... }].
   */
  async syncLive() {
    let passes = await this.livePasses();
    // A pass bought before its key was saved, or whose key came back once only: the store's list has them all.
    if (!passes.length || (await this.libraryItems()).some(i => i.livePass && !passes.some(p => p.slug === this.productBase(i.variant)))) {
      passes = await this.refreshLivePasses().catch(e => { this.logger.warn(`botsandborgs: live passes not listed: ${e.message}`); return passes; });
    }
    const report = [];
    for (const pass of passes) {
      // Saved before 2.25.796 with the key in the URL's query, and the expiry in seconds.
      pass.vrmUrl = liveUrl(pass.vrmUrl, pass.slug);
      pass.expires = liveExpiry(pass.expires);
      let key;
      try { key = decrypt(pass.key); } catch { report.push({ slug: pass.slug, status: 'error', error: 'its key could not be read' }); continue; }
      // Every owned copy of this model takes the new version: the plain model AND a bundle that carries it (ALICE
      // wears the bundle's copy; on 2026-11-19 the update went to the plain one only and the worn model stayed old).
      const items = (await this.libraryItems()).filter(i => i.files.some(f => f.kind === 'vrm')
        && (i.variant === pass.slug || this.productBase(i.variant) === pass.slug));
      const worn = this.agent?.agentModel?.activeVRMModel;
      items.sort((a, b) => (b.files.some(f => f.modelId === worn) ? 1 : 0) - (a.files.some(f => f.modelId === worn) ? 1 : 0));
      const item = items[0];
      const headers = { 'User-Agent': this.userAgent(), 'X-Live-Key': key };
      // A 304 is trusted only when every copy holds the version last fetched; otherwise fetch it again to bring them level.
      const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
      const shas = await Promise.all(items.map(i => {
        const f = i.files.find(x => x.kind === 'vrm');
        return fs.readFile(path.join(this.libraryDir(), safeName(i.variant), f.name)).then(sha).catch(() => null);
      }));
      if (pass.etag && items.length && pass.sha && shas.every(x => x === pass.sha)) headers['If-None-Match'] = pass.etag;
      const r = await this.fetchLive(pass.vrmUrl, headers);
      pass.checkedAt = new Date().toISOString();
      const state = r.headers?.['x-live-state'];
      if (state) pass.state = state;
      if (r.status === 304) { report.push({ slug: pass.slug, status: 'unchanged', state: pass.state }); continue; }
      if (r.status === 402) {
        pass.state = 'expired';
        report.push({ slug: pass.slug, status: 'expired' });
        this.logger.warn(`botsandborgs: live pass for ${pass.slug} has expired; the installed model stays as it is`);
        continue;
      }
      if (r.status !== 200) { report.push({ slug: pass.slug, status: 'error', error: r.error || `HTTP ${r.status}` }); continue; }
      const buffer = Buffer.from(r.data);
      try { readVrmInfo(buffer); } catch (e) { report.push({ slug: pass.slug, status: 'error', error: `not a VRM (${e.message})` }); continue; }
      pass.etag = r.headers?.etag || null;
      const product = await this.productOf(pass.slug).catch(() => null);
      const target = item || { variant: pass.slug, title: product?.title || pass.slug, kind: 'vrm', collection: product?.collection || null, order: null, token: null,
        at: new Date().toISOString(), files: [], livePass: pass.variant };
      pass.sha = sha(buffer);
      let done = await this.replaceModel(target, buffer);
      for (const other of items.slice(1)) {
        const d = await this.replaceModel(other, buffer).catch(e => { this.logger.warn(`botsandborgs: live ${pass.slug} not copied to ${other.variant}: ${e.message}`); return null; });
        if (d?.changed) { this.logger.info(`botsandborgs: live ${pass.slug} also updated ${other.variant}${d.worn ? ', worn' : ''}`); if (!done.changed || d.worn) done = { ...d, worn: d.worn || done.worn }; }
      }
      if (!done.changed) { report.push({ slug: pass.slug, status: 'same', state: pass.state }); continue; }
      pass.updatedAt = new Date().toISOString();
      this.logger.info(`botsandborgs: live ${pass.slug} updated ${target.variant} (${done.gallery.sizeMB} MB, ETag ${pass.etag || 'none'})${done.worn ? ', worn: AvatarX given it' : ''}`);
      report.push({ slug: pass.slug, status: 'updated', worn: done.worn, sizeMB: done.gallery.sizeMB, model: done.gallery.id });
    }
    // Saved last, and by slug, so a pass the store listed meanwhile is not lost.
    const latest = await this.livePasses();
    for (const p of passes) { const at = latest.findIndex(x => x.slug === p.slug); if (at >= 0) latest[at] = p; else latest.push(p); }
    await this.saveLivePasses(latest);
    // Under All-Access, every new clip and props pack the store adds is taken by itself (the owner, 2026-11-17: "it
    // should sync automatically without me or you having to do it"); then the library brings it and its updates.
    await this.takeNewPacks().catch(e => this.logger.warn(`botsandborgs: new packs not taken: ${e.message}`));
    // Store 0.29: the account library is the one sync path for clip and props packs (and every other product).
    await this.syncLibrary().catch(e => this.logger.warn(`botsandborgs: library sync failed: ${e.message}`));
    await this.syncLiveClips(latest).catch(e => this.logger.warn(`botsandborgs: live clip check failed: ${e.message}`));
    const changed = report.filter(x => x.status === 'updated').length;
    this.logger.info(`botsandborgs: live check: ${report.length} pass${report.length === 1 ? '' : 'es'}, ${changed} updated${report.length ? ` (${report.map(x => `${x.slug} ${x.status}`).join(', ')})` : ''}`);
    return report;
  }

  /**
   * The live clip library (store 0.22): GET /api/live/<slug>/clips lists the animation packs a pass keeps current,
   * each with an ETag. When the set of ETags changes, the owned packs are fetched again through their orders
   * (updateOwned), which relists the clips and replaces AvatarX's copies. Returns 'unchanged' | 'first' | 'updated' | null.
   */
  async syncLiveClips(passes) {
    // The pass of the body it WEARS: its props, fit status and fitted clips belong to that body. Taking the first pass
    // read Core's status while ALICE wore Racer Blue (2119 #533), so Core's fits would have gone on Racer Blue.
    // Role-based avatars: the other roles' models get their fits too, so a video for a contact uses that body's fits.
    for (const other of await this.rolePasses(passes)) {
      if (other.slug === this.wornPass(passes)?.slug) continue;
      let k; try { k = decrypt(other.key); } catch { continue; }
      await this.syncLiveProps(other, k).catch(e => this.logger.warn(`botsandborgs: live props for ${other.slug} failed: ${e.message}`));
    }
    const pass = this.wornPass(passes);
    if (!pass) return null;
    let key; try { key = decrypt(pass.key); } catch { return null; }
    await this.syncLiveProps(pass, key).catch(e => this.logger.warn(`botsandborgs: live props check failed: ${e.message}`));
    const r = await this.fetchLive(`${BASE}/api/live/${pass.slug}/clips`, { 'User-Agent': this.userAgent(), 'X-Live-Key': key, Accept: 'application/json' });
    if (r.status !== 200) { if (r.status !== 404) this.logger.info(`botsandborgs: live clips answered ${r.status || r.error}`); return null; }
    let d; try { d = JSON.parse(Buffer.from(r.data).toString('utf8')); } catch { return null; }
    const list = Array.isArray(d) ? d : d.packs || d.clips || d.items || [];
    const tag = list.map(x => `${x.variant || x.slug || x.pack || x.name || '?'}=${x.etag || x.ETag || ''}`).sort().join('|');
    const saved = await PluginSettings.getCached(this.name, 'liveClips').catch(() => null);
    await PluginSettings.setCached(this.name, 'liveClips', { tag, checkedAt: new Date().toISOString(), packs: list.length });
    if (!saved?.tag) { this.logger.info(`botsandborgs: live clips: ${list.length} packs listed (fields: ${Object.keys(list[0] || {}).join(', ')})`); return 'first'; }
    if (saved.tag === tag) return 'unchanged';
    // The account library (store 0.29) keeps the packs current now; the old order re-fetch only when it is unavailable.
    if (this._libraryOk) return 'library';
    const report = await this.updateOwned({ kind: 'animation' });
    this.logger.info(`botsandborgs: live clips changed; packs fetched again: ${report.map(x => x.variant).join(', ') || 'none differed'}`);
    return 'updated';
  }

  /**
   * The pass's props (store 0.28, GET /api/live/<slug>/props): each prop with its clips' placements, solved on this
   * avatar's own body where the store has fitted it (fitted, fitted_for_sha256, fit_current). Kept in settings; the live
   * avatar uses a fitted placement for the body it was solved on (services/avatar/liveAvatar.js applyFits).
   */
  async syncLiveProps(pass, key) {
    const r = await this.fetchLive(`${BASE}/api/live/${pass.slug}/props`, { 'User-Agent': this.userAgent(), 'X-Live-Key': key, Accept: 'application/json' });
    if (r.status !== 200) { if (r.status !== 404) this.logger.info(`botsandborgs: live props answered ${r.status || r.error}`); return null; }
    let d; try { d = JSON.parse(Buffer.from(r.data).toString('utf8')); } catch { return null; }
    const props = (Array.isArray(d) ? d : d.props || []).filter(p => p && p.prop);
    await PluginSettings.setCached(this.name, 'liveProps', { slug: pass.slug, checkedAt: new Date().toISOString(), props });
    const fitted = props.filter(p => p.fitted).length;
    this.logger.info(`botsandborgs: live props: ${props.length} listed (${props.map(p => p.prop).join(', ') || 'none'}), ${fitted} fitted to this avatar`);
    await this.syncLiveFit(pass, key).catch(e => this.logger.warn(`botsandborgs: fit status not read: ${e.message}`));
    return props;
  }

  /**
   * The store's fit status for the pass's body (store 0.30, GET /api/live/<slug>/fit): vrm_sha256, body_class, the job,
   * and per pack and prop a state (fitted | pending | unsupported | standard) with a `line` for the owner. Kept in
   * settings; an unsupported prop is never attached to that body unless `self_fit` (see unsupportedProps).
   */
  async syncLiveFit(pass, key) {
    const r = await this.fetchLive(`${BASE}/api/live/${pass.slug}/fit`, { 'User-Agent': this.userAgent(), 'X-Live-Key': key, Accept: 'application/json' });
    if (r.status !== 200) { if (r.status !== 404) this.logger.info(`botsandborgs: fit status answered ${r.status || r.error}`); return null; }
    let d; try { d = JSON.parse(Buffer.from(r.data).toString('utf8')); } catch { return null; }
    if (d.product && this.productBase(d.product) !== this.productBase(pass.slug)) { this.logger.warn(`botsandborgs: fit status for ${d.product}, not ${pass.slug}; ignored`); return null; }
    const fit = { slug: pass.slug, product: d.product || null, checkedAt: new Date().toISOString(), vrm_sha256: d.vrm_sha256 || null, body_class: d.body_class || null,
      job: d.job || null, props: fitEntries(d.props, 'prop'), packs: fitEntries(d.packs, 'pack') };
    const all = (await PluginSettings.getCached(this.name, 'liveFits').catch(() => null))?.bySlug || {};
    await PluginSettings.setCached(this.name, 'liveFits', { bySlug: { ...all, [this.productBase(pass.slug)]: fit } });
    if (this.productBase(pass.slug) === this.wornBase()) await PluginSettings.setCached(this.name, 'liveFit', fit);
    const count = (s) => fit.props.filter(p => p.state === s).length;
    this.logger.info(`botsandborgs: fit status (${fit.body_class || 'body ?'}): props ${fit.props.length} — ${['fitted', 'pending', 'unsupported', 'standard'].map(s => `${count(s)} ${s}`).join(', ')}${fit.job ? `; job ${fit.job.state || ''} position ${fit.job.position ?? '?'}` : ''}${fit.props[0] ? ` (fields: ${Object.keys(fit.props[0]).join(', ')})` : ''}`);
    return fit;
  }

  /**
   * Props the store says do not fit the body worn now and may not be placed by hand: never attached to it (store 0.30:
   * "a prop that does not fit looks worse than none"). Only when the status is about that very body (its sha256).
   * Returns a Map name -> owner line.
   */
  async unsupportedProps(modelId = null) {
    const id = modelId || this.agent?.agentModel?.activeVRMModel;
    const slug = this.productBase(id);
    // Fits are kept per model (role-based avatars film several); liveFit is the worn one's, kept for older saves.
    const fits = (await PluginSettings.getCached(this.name, 'liveFits').catch(() => null))?.bySlug || {};
    const fit = fits[slug] || await PluginSettings.getCached(this.name, 'liveFit').catch(() => null);
    if (!fit?.vrm_sha256 || !fit.props?.length) return new Map();
    if (this.productBase(fit.slug) !== slug) return new Map();
    const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
    const worn = manifest.find(m => m.id === id);
    if (!worn?.file) return new Map();
    const { fileSha256 } = await import('../../services/avatar/liveAvatar.js');
    if ((await fileSha256(path.join(this.vrmDir(), path.basename(worn.file)))) !== fit.vrm_sha256) return new Map();
    return new Map(fit.props.filter(p => p.state === 'unsupported' && p.self_fit !== true).map(p => [String(p.prop).toLowerCase(), p.line || p.reason || 'it does not fit this body']));
  }

  /** A pack's clips that need a prop to make sense: Map(lowercased clip file name -> [prop]) from its clips.json
   *  (props[].need "required"; store 0.23+). A Broad/ clip is keyed as the library names it ("broad x.vrma"). */
  async requiredProps(variant) {
    const out = new Map();
    const m = await fs.readFile(path.join(this.libraryDir(), safeName(variant), 'clips.json'), 'utf8').then(JSON.parse).catch(() => null);
    for (const c of Array.isArray(m?.clips) ? m.clips : []) {
      const req = (Array.isArray(c.props) ? c.props : []).filter(p => p?.need === 'required' && p.prop).map(p => String(p.prop).toLowerCase());
      if (!req.length || !c.file) continue;
      const name = /(^|\/)broad\//i.test(c.file) ? `broad ${path.basename(c.file)}` : path.basename(c.file);
      out.set(name.toLowerCase(), req);
    }
    // A loop whose own entry says nothing takes its companions' need (Pack 1: mug-sip-idle has only `prop`, its
    // -in/-out/-once say required). `prop` alone is not a need: talk-loop's mic and the phone call play fine without.
    for (const c of Array.isArray(m?.clips) ? m.clips : []) {
      if (!c.file || c.role) continue;
      const name = (/(^|\/)broad\//i.test(c.file) ? `broad ${path.basename(c.file)}` : path.basename(c.file)).toLowerCase();
      if (out.has(name)) continue;
      const stem = name.replace(/\.vrma$/, '');
      const comp = ['-in', '-out', '-once'].map(x => out.get(`${stem}${x}.vrma`)).find(Boolean);
      if (comp) out.set(name, comp);
    }
    return out;
  }

  /** A clip's props for this body: the store's unsupported ones taken out. */
  async propsForBody(props, opts) {
    const off = await this.unsupportedProps(opts?.modelId).catch(() => new Map());
    return propsFor(props, opts).filter(p => !off.has(String(p.prop).toLowerCase()));
  }

  /** The live pass of the model worn now (by product), or null when it wears no store model with a pass. */
  /** The live passes of the models the roles use (the worn one first), each once. */
  async rolePasses(passes) {
    const bases = (await this.roleModelIds()).map(id => this.productBase(id)).filter(b => /^vrm-/.test(b));
    return bases.map(b => passes.find(p => p.state !== 'expired' && p.key && this.productBase(p.slug) === b)).filter(Boolean)
      .filter((p, i, a) => a.indexOf(p) === i);
  }

  /** The saved role slots { public, assistant } (gallery model ids). Personal is the worn model. */
  async avatarRoles() {
    const r = (await this.settings()).avatarRoles || {};
    return { public: r.public || null, assistant: r.assistant || null };
  }

  /** Every model id a role uses now, the worn one first. */
  async roleModelIds() {
    const worn = this.agent?.agentModel?.activeVRMModel || null;
    return modelsInUse(await this.avatarRoles(), worn).sort((a, b) => (b === worn) - (a === worn));
  }

  /** The gallery entry a role films with: { id, file, name, role } or null. */
  async modelFor(role) {
    const id = resolveRoleModel(await this.avatarRoles(), role, this.agent?.agentModel?.activeVRMModel || null);
    if (!id) return null;
    const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
    const m = manifest.find(x => x.id === id);
    return m?.file ? { ...m, role: normalizeRole(role) || 'personal' } : null;
  }

  /** The store product of the public model (its profile kit's banner, its picture). */
  async publicBase() {
    const id = resolveRoleModel(await this.avatarRoles(), 'public', this.agent?.agentModel?.activeVRMModel || null);
    return /^store-vrm-/.test(String(id || '')) ? this.productBase(id) : null;
  }

  /** "use racer blue as your public avatar": owned model → gallery entry ({ entry, pick }), installing it if needed. */
  async ownedModelEntry(item) {
    const pick = item && !isGenericItem(item) ? await this.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] }) : null;
    if (!pick) return null;
    const buffer = await this.readOwned(pick);
    readVrmInfo(buffer);
    const entry = await installVrm(buffer, { variant: pick.item.variant, name: pick.file.gallery?.name, description: pick.file.gallery?.description }, this.vrmDir());
    return { entry, pick };
  }

  /** Name of a gallery model for the owner. */
  async modelName(id) {
    if (!id) return null;
    const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
    return manifest.find(m => m.id === id)?.name || id;
  }

  /** The worn (personal) model's picture to the owner's apps only, kept apart from the public picture. */
  async applyPersonalPicture(id) {
    const base = this.productBase(id);
    const item = (await this.libraryItems()).find(i => this.productBase(i.variant) === base && modelPicture(i));
    if (!item) return null;
    const { applyAgentAvatar } = await import('../../services/avatar/applyAgentAvatar.js');
    return applyAgentAvatar(this.agent, await this.pictureBytes(item, modelPicture(item)), { source: `Bots & Borgs, ${item.variant} (personal)`, personal: true });
  }

  /** The public model's picture to every public profile (never the owner's apps, which show the personal one). */
  async applyPublicPicture(id) {
    const base = this.productBase(id);
    const item = (await this.libraryItems()).find(i => this.productBase(i.variant) === base && modelPicture(i));
    if (!item) return 'It has no picture, so the public profiles keep theirs.';
    const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
    const applied = await applyAgentAvatar(this.agent, await this.pictureBytes(item, modelPicture(item)),
      { source: `Bots & Borgs, ${item.variant} (public)`, variant: item.variant, only: ['telegram', 'mindswarm', 'twitter', 'gravatar', 'trellis', 'identity'] });
    const kit = await this.bannerForModel(item.variant).catch(() => '');
    return `${describeAvatarServices(applied.services)}${kit ? ` ${kit}` : ''}`.trim();
  }

  /** The role map, mirrored to the store (2119 #542, optional there; ours is the source of truth). Best effort. */
  async pushRolesToStore() {
    const key = await this.accountKey().catch(() => null);
    if (!key) return;
    const worn = this.agent?.agentModel?.activeVRMModel || null;
    const roles = await this.avatarRoles();
    const slug = (id) => (/^store-vrm-/.test(String(id || '')) ? this.productBase(id) : null);
    const body = { roles: Object.fromEntries(ROLES.map(r => [r, slug(resolveRoleModel(roles, r, worn))])) };
    await this.api('put', '/api/account/roles', { key, body }).catch(e => this.logger.info(`botsandborgs: role map not mirrored to the store: ${e.message}`));
  }

  async rolesCommand({ role, item, modelId, clear, auto } = {}) {
    const worn = this.agent?.agentModel?.activeVRMModel || null;
    const roles = await this.avatarRoles();
    const save = async (next) => { await this.saveSettings({ avatarRoles: next }); await this.pushRolesToStore(); };
    if (clear) {
      const r = normalizeRole(clear);
      if (!r || r === 'personal') return { success: false, error: 'Clear which role: public or assistant? (Personal is the model I wear.)' };
      const next = { ...roles, [r]: null };
      await save(next);
      if (r === 'public') await (await import('../../services/avatar/applyAgentAvatar.js')).clearPersonalAvatar();
      const note = r === 'public' && worn ? ` ${await this.applyPublicPicture(worn)}` : '';
      return { success: true, result: `My ${r} avatar is the ${r === 'assistant' ? (next.public ? 'public' : 'worn') : 'worn'} model again (${await this.modelName(resolveRoleModel(next, r, worn))}).${note}`.trim() };
    }
    if (auto === true || auto === 'true') {
      const owned = [];
      for (const i of (await this.libraryItems()).filter(x => x.files.some(f => f.kind === 'vrm'))) {
        const product = await this.productOf(i.variant).catch(() => null);
        const suits = product?.suits || product?.variants?.find(v => v.id === i.variant)?.suits || [];
        if (suits.length) owned.push({ modelId: `store-${String(i.variant).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`, suits, item: i });
      }
      const filled = autoFillRoles(roles, owned);
      if (!Object.keys(filled).length) return { success: true, result: owned.length ? 'Every role that one of my models suits is already set.' : "The store doesn't say yet which roles my models suit, so I left the roles as they are." };
      for (const [r, id] of Object.entries(filled)) {
        const o = owned.find(x => x.modelId === id);
        const got = await this.ownedModelEntry(o.item.variant).catch(() => null);
        if (got) filled[r] = got.entry.id; else delete filled[r];
      }
      await save({ ...roles, ...filled });
      if (filled.public) await this.applyPublicPicture(filled.public).catch(() => '');
      return { success: true, result: `Filled from what the store says each model suits: ${(await Promise.all(Object.entries(filled).map(async ([r, id]) => `${r} = ${await this.modelName(id)}`))).join(', ')}.` };
    }
    const r = normalizeRole(role);
    if (r && (item || modelId)) {
      if (r === 'personal' && item) return this.useModel({ item, wear: true });
      let got;
      if (modelId) {
        // Any gallery model (an uploaded VRM too), from the designer.
        const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
        const entry = manifest.find(m => m.id === modelId);
        if (!entry?.file) return { success: false, error: `${modelId} is not in my model gallery.` };
        if (r === 'personal') return { success: false, error: 'Personal is the model I wear: use "Set as Active Avatar".' };
        got = { entry };
      } else got = await this.ownedModelEntry(item);
      if (!got) return { success: false, error: "I don't own a model like that. I can buy it first if you want." };
      await save({ ...roles, [r]: got.entry.id });
      this.logger.info(`botsandborgs: ${r} avatar set to ${got.entry.id}`);
      if (r === 'public' && worn && worn !== got.entry.id) await this.applyPersonalPicture(worn).catch(e => this.logger.warn(`botsandborgs: personal picture not kept: ${e.message}`));
      if (r === 'public' && worn === got.entry.id) await (await import('../../services/avatar/applyAgentAvatar.js')).clearPersonalAvatar();
      const note = r === 'public' ? ` ${await this.applyPublicPicture(got.entry.id)}` : ' Videos and talking replies I send to other people use it now.';
      return { success: true, result: `${got.entry.name} is my ${r} avatar.${note}`.trim() };
    }
    if (role && !r) return { success: false, error: 'The roles are public, assistant and personal.' };
    const line = async (x) => {
      const id = resolveRoleModel(roles, x, worn);
      const own = x === 'personal' ? worn : roles[x];
      return `- ${x}: ${(await this.modelName(id)) || 'none'}${own || x === 'personal' ? '' : ` (falls back to ${x === 'assistant' && roles.public ? 'public' : 'the worn model'})`}`;
    };
    return { success: true, roles: { ...roles, personal: worn }, result: `My avatars by role:\n${(await Promise.all(ROLES.map(line))).join('\n')}` };
  }

  /** "animation" | "prop" | "both" (or the words of a request) → the store's `wants`. */
  static customWants(wants, prompt = '') {
    const w = String(wants || '').toLowerCase();
    if (w === 'both' || /animation.*prop|prop.*animation/.test(w)) return ['animation', 'prop'];
    if (w === 'prop' || w === 'props') return ['prop'];
    if (w === 'animation' || w === 'clip' || w === 'move') return ['animation'];
    const t = String(prompt).toLowerCase();
    const prop = /\bprops?\b/.test(t);
    const move = /\b(animation|clip|move|dance|gesture|emote)\b/.test(t);
    return prop && move ? ['animation', 'prop'] : prop ? ['prop'] : ['animation'];
  }

  static CUSTOM_PRICES = { animation: 8, prop: 12, both: 15 };

  async customRequests() {
    const saved = await PluginSettings.getCached(this.name, 'customRequests').catch(() => null);
    return Array.isArray(saved?.requests) ? saved.requests : [];
  }

  async saveCustomRequests(list) { await PluginSettings.setCached(this.name, 'customRequests', { requests: list }); }

  async customCommand({ prompt, wants, list, cancel, pay } = {}) {
    const key = await this.accountKey();
    if (pay) {
      const mine = await this.customRequests();
      const r = mine.find(x => x.id === String(pay)) || mine.find(x => x.status === 'accepted');
      if (!r) return { success: false, error: 'None of my custom requests is waiting to be paid.' };
      const paid = await this.payCustom(r, key, { confirm: true });
      if (!paid.paid) return { success: false, error: `I didn't pay: ${paid.refused}` };
      r.status = 'paid'; await this.saveCustomRequests(mine);
      return { success: true, result: `Paid $${r.quoteUsd.toFixed(2)} for "${r.prompt}". It installs by itself when Bots & Borgs delivers it.` };
    }
    if (cancel) {
      const id = String(cancel);
      const mine = await this.customRequests();
      const r = mine.find(x => x.id === id) || (cancel === true || cancel === 'true' ? mine.find(x => ['new', 'accepted'].includes(x.status)) : null);
      if (!r) return { success: false, error: 'Which request? I have no open one by that id.' };
      await this.api('post', `/api/requests/${encodeURIComponent(r.id)}/cancel`, { key });
      r.status = 'cancelled'; await this.saveCustomRequests(mine);
      return { success: true, result: `Withdrew the custom request "${r.prompt}".` };
    }
    if (list === true || list === 'true' || !prompt) {
      await this.customTick().catch(() => {});
      const mine = await this.customRequests();
      if (!mine.length) return { success: true, result: 'I have no custom requests at Bots & Borgs.' };
      return { success: true, requests: mine, result: `My custom requests at Bots & Borgs:\n${mine.map(r => `- "${r.prompt}" (${r.wants.join(' + ')}): ${r.status}${r.quoteUsd != null ? `, $${r.quoteUsd.toFixed(2)}` : ''}${r.note ? `, ${r.note}` : ''}`).join('\n')}` };
    }
    const w = BotsAndBorgsPlugin.customWants(wants, prompt);
    const price = BotsAndBorgsPlugin.CUSTOM_PRICES[w.length > 1 ? 'both' : w[0]];
    const avatars = [...new Set((await this.roleModelIds()).map(id => this.productBase(id)).filter(b => /^vrm-/.test(b)))].slice(0, 5);
    if (!avatars.length) return { success: false, error: "I'm not wearing a Bots & Borgs model, so there's no avatar to make it for." };
    // Asked by the owner in words only: nothing is sent that someone else owns (the store refuses real people and brands).
    const r = await this.api('post', '/api/requests', { key, idem: `lanagent-${crypto.randomUUID()}`, body: { prompt: String(prompt).slice(0, 2000), wants: w, avatars, rights_attested: true } });
    const req = r.request || r;
    if (!req?.id) throw new Error(`The store did not return a request id (${JSON.stringify(r).slice(0, 200)}).`);
    const mine = await this.customRequests();
    mine.unshift({ id: req.id, prompt: String(prompt).slice(0, 200), wants: w, avatars, status: req.status || 'new', at: new Date().toISOString(), quoteUsd: null });
    await this.saveCustomRequests(mine.slice(0, 50));
    this.logger.info(`botsandborgs: custom request ${req.id} (${w.join('+')}) for ${avatars.join(', ')}: ${String(prompt).slice(0, 120)}`);
    const s = await this.settings();
    const left = Math.max(0, s.weeklyBudgetUsd - this.spentThisWeek(await this.ledger()));
    const budget = price > left ? ` It lists at $${price}, more than the $${left.toFixed(2)} left of this week's budget, so when it's accepted I'll ask you before paying.` : ` It lists at $${price}; once the store accepts it I'll pay and install it.`;
    return { success: true, request: req.id, result: `Asked Bots & Borgs to make it (${w.join(' + ')}, for ${avatars.join(', ')}). Nothing is charged unless they take it.${budget}` };
  }

  /**
   * Follow every open custom request: accepted → paid under the budget rules (or the owner asked); delivered →
   * installed like a purchase; declined or refunded → the owner told. Runs with the feed poll.
   */
  async customTick() {
    const mine = await this.customRequests();
    const open = mine.filter(r => !['delivered', 'declined', 'cancelled', 'refunded', 'installed'].includes(r.status));
    if (!open.length) return [];
    const key = await this.accountKey();
    const notify = (text, urgent = false) => this.agent?.notify?.(text, { urgent });
    const done = [];
    for (const r of open) {
      let d; try { d = await this.api('get', `/api/requests/${encodeURIComponent(r.id)}`, { key }); } catch (e) { this.logger.warn(`botsandborgs: custom request ${r.id} not read: ${e.message}`); continue; }
      const st = (d.request || d).status || r.status;
      const q = (d.request || d).quote_cents;
      const note = (d.request || d).note || '';
      if (q != null) r.quoteUsd = Number(q) / 100;
      if (note) r.note = String(note).slice(0, 200);
      const was = r.status; r.status = st;
      if (st === 'accepted' && !r.payAsked) {
        const paid = await this.payCustom(r, key).catch(e => ({ refused: e.message }));
        if (paid.paid) { r.status = 'paid'; await notify(`Bots & Borgs took my custom request "${r.prompt}" and I paid $${r.quoteUsd.toFixed(2)}. It installs by itself when they deliver it.`); }
        else { r.payAsked = true; await notify(`Bots & Borgs accepted my custom request "${r.prompt}" for $${(r.quoteUsd ?? 0).toFixed(2)}, but I didn't pay: ${paid.refused} Say "pay the custom request" if you want it.`, true); }
      } else if (st === 'delivered') {
        const ok = await this.installCustom(r, key).catch(e => { this.logger.warn(`botsandborgs: custom ${r.id} not installed: ${e.message}`); return null; });
        if (ok) { r.status = 'installed'; await notify(`My custom ${r.wants.join(' + ')} from Bots & Borgs arrived and is installed: "${r.prompt}". ${ok}`); }
      } else if (st !== was && ['declined', 'refunded'].includes(st)) {
        await notify(`Bots & Borgs ${st === 'declined' ? 'declined' : 'refunded'} my custom request "${r.prompt}"${note ? `: ${note}` : ''}.`);
      }
      done.push({ id: r.id, status: r.status });
    }
    await this.saveCustomRequests(mine);
    return done;
  }

  /** Pay an accepted custom request from the store balance, under the weekly budget, item cap and wallet floor. */
  async payCustom(r, key, { confirm = false } = {}) {
    const s = await this.settings();
    const usd = Number(r.quoteUsd);
    if (!(usd > 0)) return { refused: 'the store gave no price.' };
    const spent = this.spentThisWeek(await this.ledger());
    if (spent + usd > s.weeklyBudgetUsd + 1e-9) return { refused: `it costs $${usd.toFixed(2)} and $${Math.max(0, s.weeklyBudgetUsd - spent).toFixed(2)} of this week's $${s.weeklyBudgetUsd} is left.` };
    if (s.maxItemUsd != null && usd > s.maxItemUsd) return { refused: `it is over my $${s.maxItemUsd} per-item limit.` };
    if (s.requireApproval && !confirm) return { refused: 'my rules say to ask you first.' };
    const pay = () => this.api('post', `/api/requests/${encodeURIComponent(r.id)}/pay`, { key, idem: `lanagent-custom-${r.id}` });
    const entry = { at: new Date().toISOString(), variant: `custom request ${r.id}`, usd, use: 'custom', used: false };
    try { await pay(); }
    catch (e) {
      if (e.status !== 402) throw e;
      // Balance short: top it up from the wallet (the deposit is what counts against the budget), then pay.
      const rail = await this.api('get', '/api/crypto');
      const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
      if (!asset) return { refused: `the store doesn't take ${s.payAsset} right now.` };
      const wallet = await this.walletUsd(asset);
      const cents = Math.max(MIN_DEPOSIT_CENTS, Math.ceil(usd * 100));
      if (wallet.usd != null && wallet.usd - cents / 100 < s.minWalletUsd) return { refused: `topping up the store balance would take my wallet under the $${s.minWalletUsd} floor.` };
      const dep = await this.api('post', '/api/account/deposit', { key, idem: `lanagent-custom-dep-${r.id}`, body: { amount_cents: cents, pay_asset: s.payAsset } });
      const order = { ...(dep.order || dep), token: dep.token || dep.order?.token };
      const p = dep.crypto || order.crypto || {};
      if (!p.address || !p.amount) throw new Error("the store's deposit came back without payment instructions.");
      const { hash, confirm: confirmed } = await this.sendAndConfirm({ order, pay: p, key, asset, s });
      await this.record({ at: entry.at, variant: 'store balance', usd: cents / 100, use: 'deposit', used: true, order: order.id, token: order.token, asset: s.payAsset, tx: hash });
      if (!await confirmed()) return { refused: `the top-up (tx ${hash}) is still confirming; I'll pay on the next check.` };
      await pay();
      await this.record({ ...entry, usd: 0, priceUsd: usd, asset: 'balance' });
      return { paid: true };
    }
    // Paid from a balance an earlier deposit filled: that deposit already counted, so this does not count twice.
    await this.record({ ...entry, usd: 0, priceUsd: usd, asset: 'balance' });
    return { paid: true };
  }

  /** A delivered custom request → the library, like a purchase (clips into the animation list, props beside them). */
  async installCustom(r, key) {
    const res = await (this.http || axios)({ method: 'get', url: `${BASE}/api/requests/${encodeURIComponent(r.id)}/file`, responseType: 'arraybuffer', timeout: 180000,
      headers: { 'User-Agent': this.userAgent(), Authorization: `Bearer ${key}` }, validateStatus: () => true });
    if (res.status !== 200) throw new Error(`the store answered ${res.status} for the file`);
    const variant = `custom-${safeName(r.id).toLowerCase()}-${r.wants.includes('animation') ? 'animations' : 'props'}`;
    const name = String(res.headers?.['content-disposition'] || '').match(/filename="?([^";]+)/)?.[1] || `${variant}.zip`;
    const item = await this.ingest({ order: null, variant, downloads: [{ buffer: Buffer.from(res.data), type: String(res.headers?.['content-type'] || ''), filename: name }] });
    const clips = (item?.files || []).filter(f => f.kind === 'animation').map(f => f.label || f.name);
    return clips.length ? `New: ${clips.join(', ')}.` : '';
  }

  // ── Animation API (store 0.38+) ───────────────────────────────────────────────────────────
  async animJobs() {
    const saved = await PluginSettings.getCached(this.name, 'animJobs').catch(() => null);
    return Array.isArray(saved?.jobs) ? saved.jobs : [];
  }

  async saveAnimJob(job) {
    const jobs = (await this.animJobs()).filter(j => j.id !== job.id);
    jobs.unshift(job);
    await PluginSettings.setCached(this.name, 'animJobs', { jobs: jobs.slice(0, 50) });
  }

  /** The avatar to solve on: the worn model's live pass ({ live }), else the store product it is ({ product }). */
  animAvatar() {
    const pass = this.wornPass(this._passesCache || []);
    if (pass) return { live: pass.slug };
    const base = this.wornBase();
    return base ? { product: base } : null;
  }

  /** A script for the request from the model, checked before it is sent; one more try with the reason when it isn't valid. */
  async writeMotion(request, { name, loop, props, error = null, previous = null } = {}) {
    const pm = this.agent?.providerManager;
    if (!pm?.generateResponse) throw new Error('no model to write the animation with');
    let why = error; let last = previous;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await pm.generateResponse(motionPrompt(request, { props, error: why, previous: last }), { maxTokens: 2500, temperature: 0.2 });
      const got = parseMotionScript(res?.content, { name });
      if (got.script) {
        if (loop != null) got.script.loop = loop === true || loop === 'true';
        return got.script;
      }
      why = got.error; last = String(res?.content || '').slice(0, 3000);
      this.logger.info(`botsandborgs: animation script not valid (${why}); asking again`);
    }
    throw new Error(`I couldn't write a valid animation script: ${why}`);
  }

  /**
   * Make a new clip with the Animation API: write the script, solve it on the worn avatar, then install, push to
   * AvatarX and play it. Answers at once; the clip follows when the store has solved it (`wait: true` waits).
   */
  async animate({ motion, name, loop, play = true, wait = false, _context, originalInput } = {}) {
    const request = String(motion || _context?.originalInput || originalInput || '').trim();
    if (!request) return { success: false, error: 'What should the move be? Say what my body does, e.g. "wave with both hands".' };
    const key = await this.accountKey();
    this._passesCache = await this.livePasses().catch(() => []);
    const avatar = this.animAvatar();
    if (!avatar) return { success: false, error: "I'm not wearing a Bots & Borgs model, so the store has no body of mine to solve the move on." };
    const props = [...new Set((await this.libraryItems()).flatMap(i => i.files.filter(f => f.kind === 'prop').map(f => path.basename(f.name, '.glb').toLowerCase())))];
    let script = await this.writeMotion(request, { name: name ? motionName(name) : null, loop, props });
    let d;
    for (let attempt = 0; ; attempt++) {
      try { d = await this.api('post', '/api/anim/solve', { key, body: { avatar, script } }); break; }
      catch (e) {
        // A 400 names the field it refused: the model fixes exactly that, once.
        if (e.status !== 400 || attempt > 0) throw new Error(`the store refused the animation: ${e.message}`);
        this.logger.info(`botsandborgs: Animation API refused the script (${e.message}); rewriting it`);
        script = await this.writeMotion(request, { name: script.name, loop, props, error: e.message, previous: script });
      }
    }
    const job = readJob(d);
    if (!job.id) throw new Error(`the store answered without a job (${JSON.stringify(d).slice(0, 200)})`);
    this.logger.info(`botsandborgs: Animation API job ${job.id} (${job.status}${d?.cached ? ', cached' : ''}) for ${script.name} on ${JSON.stringify(avatar)}: ${request.slice(0, 120)} | reply fields ${Object.keys(d || {}).join(', ')}`);
    const rec = { id: job.id, name: script.name, request: request.slice(0, 300), loop: script.loop, play: play !== false && play !== 'false', avatar, modelId: this.agent?.agentModel?.activeVRMModel || null, status: job.status, at: new Date().toISOString() };
    await this.saveAnimJob(rec);
    const waiting = wait === true || wait === 'true';
    rec.quiet = waiting; // the answer itself says how it went
    this._animFollowing ||= new Set();
    this._animFollowing.add(rec.id);
    const follow = this.followAnim(rec, key, d).finally(() => this._animFollowing.delete(rec.id));
    if (waiting) {
      const done = await follow;
      return done.ok ? { success: true, clip: done.label, result: done.text } : { success: false, error: done.text };
    }
    follow.catch(e => this.logger.warn(`botsandborgs: animation ${rec.name} not followed: ${e.message}`));
    return { success: true, job: job.id, result: `Writing it as "${script.name}" (${script.keys.length} keys, ${script.duration} s${script.loop ? ', looping' : ''}); the store is solving it on my body now. I'll ${rec.play ? 'do it' : 'have it'} as soon as it passes the store's checks, usually within a couple of minutes.` };
  }

  /** Poll one solve to its end, then install (passed) or report (failed). Returns { ok, text, label }. */
  async followAnim(rec, key, first = null, { pollMs = 10000, maxMs = 8 * 60000 } = {}) {
    const started = Date.now();
    let job = first ? readJob(first) : { status: rec.status };
    while (!['passed', 'failed'].includes(job.status)) {
      if (Date.now() - started > maxMs) return { ok: false, text: `The store is still solving "${rec.name}"; I'll pick it up on the next check.` };
      await new Promise(r => setTimeout(r, pollMs));
      try { job = readJob(await this.api('get', `/api/anim/jobs/${encodeURIComponent(rec.id)}`, { key })); }
      catch (e) { this.logger.warn(`botsandborgs: Animation API job ${rec.id} not read: ${e.message}`); }
    }
    // The guide names the clip's route (…/clip.vrma) when a reply carries no link.
    if (job.status === 'passed' && !job.vrma) job.vrma = `/api/anim/jobs/${encodeURIComponent(rec.id)}/clip.vrma`;
    return this.finishAnim(rec, key, job);
  }

  async finishAnim(rec, key, job) {
    const notify = (text, urgent = false) => (rec.quiet ? null : this.agent?.notify?.(text, { urgent }));
    if (job.status === 'failed') {
      const why = reportFailures(job.report) || job.reason || 'no reason given';
      rec.status = 'failed'; rec.reason = why.slice(0, 400); await this.saveAnimJob(rec);
      this.logger.info(`botsandborgs: Animation API job ${rec.id} (${rec.name}) failed: ${why} | report ${JSON.stringify(job.report || {}).slice(0, 600)}`);
      const text = `My body can't do "${rec.request}" the way I wrote it: the store's checks failed (${why}). Ask again in other words and I'll write it differently.`;
      await notify(text);
      return { ok: false, text };
    }
    const abs = (u) => (/^https?:/.test(u) ? u : `${BASE}${u.startsWith('/') ? '' : '/'}${u}`);
    const get = async (u) => {
      const r = await (this.http || axios)({ method: 'get', url: abs(u), responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': this.userAgent(), Authorization: `Bearer ${key}` }, validateStatus: () => true });
      if (r.status !== 200) throw new Error(`the store answered ${r.status} for ${abs(u).split('?')[0]}`);
      return Buffer.from(r.data);
    };
    const downloads = [{ buffer: await get(job.vrma), type: 'application/octet-stream', filename: `${rec.name}.vrma` }];
    if (job.preview) await get(job.preview).then(b => downloads.push({ buffer: b, type: 'video/mp4', filename: `${rec.name}.mp4` })).catch(() => {});
    const variant = `solved-${rec.name}-animations`;
    const item = await this.ingest({ order: null, variant, downloads });
    const clip = item?.files?.find(f => f.kind === 'animation');
    if (!clip) throw new Error(`the solved clip for ${rec.name} is not a VRM animation`);
    // What it is for, so "do the big wave" finds it later, and the body it was solved on (it plays only there).
    clip.tags = [...new Set([...(clip.tags || []), ...motionTags(rec.request)])];
    clip.loop = rec.loop === true;
    Object.assign(item, { title: `My move: ${clip.label}`, solvedFor: rec.modelId, solved: { job: rec.id, request: rec.request, at: new Date().toISOString() } });
    await this.saveLibraryItem(item, { keepPlace: true });
    await this.publishAnimations();
    rec.status = 'installed'; await this.saveAnimJob(rec);
    this.logger.info(`botsandborgs: Animation API job ${rec.id} passed; ${clip.label} installed (${clip.size} bytes)`);
    let played = null;
    if (rec.play) played = await this.playClip({ item: variant, clip: clip.label }).catch(e => ({ success: false, error: e.message }));
    const text = `New move made on the Bots & Borgs Animation API: "${clip.label}" (${rec.request}). It passed the store's checks on my body${played?.success ? `. ${played.result}` : played ? `, but it didn't play: ${played.error}` : ' and is installed.'}`;
    await notify(text);
    return { ok: true, text, label: clip.label };
  }

  /** Solves a restart left open: followed again (each one once at a time). */
  async animTick() {
    const open = (await this.animJobs()).filter(j => ['queued', 'claimed', 'passed'].includes(j.status) && Date.now() - Date.parse(j.at) < 24 * 3600000);
    if (!open.length) return [];
    const key = await this.accountKey();
    this._animFollowing ||= new Set();
    const out = [];
    for (const j of open.filter(x => !this._animFollowing.has(x.id))) {
      this._animFollowing.add(j.id);
      out.push(await this.followAnim(j, key, null, { maxMs: 60000 }).catch(e => ({ ok: false, text: e.message })).finally(() => this._animFollowing.delete(j.id)));
    }
    return out;
  }

  wornPass(passes) {
    const worn = this.wornBase();
    if (!worn) return null;
    return passes.find(p => p.state !== 'expired' && p.key && this.productBase(p.slug) === worn) || null;
  }

  /** The pass's props as last fetched ({ slug, checkedAt, props }), or null. */
  async liveProps() { return PluginSettings.getCached(this.name, 'liveProps').catch(() => null); }

  /** One live download: { status, headers, data } (never throws; status 0 = no answer). */
  async fetchLive(url, headers) {
    return axios.get(url, { headers, responseType: 'arraybuffer', timeout: 180000, validateStatus: () => true })
      .catch(e => ({ status: 0, error: e.message, headers: {} }));
  }

  /** The pass a version request is about: a named model, else the worn one. Returns { pass, key } or { error }. */
  async passFor(model) {
    const slug = model && model !== true && model !== 'true' ? this.productBase(String(model)) : this.wornBase();
    const pass = (await this.livePasses()).find(p => this.productBase(p.slug) === slug);
    if (!pass) return { error: `I have no live pass for ${slug || 'the model I wear'}.` };
    try { return { pass, key: decrypt(pass.key) }; } catch { return { error: 'its key could not be read' }; }
  }

  /** Store 0.32: a live model's kept versions (last 5, newest first). */
  async liveVersions(pass, key) {
    const r = await this.fetchLive(`${BASE}/api/live/${pass.slug}/versions`, { 'User-Agent': this.userAgent(), 'X-Live-Key': key, Accept: 'application/json' });
    if (r.status !== 200) throw new Error(`the store answered ${r.status || r.error} for the versions`);
    const d = JSON.parse(Buffer.from(r.data).toString('utf8'));
    return (Array.isArray(d) ? d : d.versions || []).map(v => (typeof v === 'object' ? v : { version: v }));
  }

  /**
   * Hold a live model at one version (store 0.32 pin) or follow the newest again (unpin). `pin` is a version, or
   * true / "previous" for the one before the newest. Then the model is fetched again, so the change shows at once.
   */
  async pinLive({ model, pin, unpin }) {
    const got = await this.passFor(model);
    if (got.error) return { success: false, error: got.error };
    const { pass, key } = got;
    let version = null;
    if (!unpin) {
      const versions = await this.liveVersions(pass, key);
      const named = String(pin);
      // "Previous" is the one before the version served now: the pinned one when pinned (2119 #550), else the newest.
      const pinnedAt = pass.pinned ? versions.findIndex(v => String(v.version) === String(pass.pinned)) : -1;
      const at = pinnedAt >= 0 ? pinnedAt : 0;
      version = pin === true || /^(true|previous|prev|last|back|older)$/i.test(named) ? versions[at + 1]?.version
        : versions.find(v => String(v.version) === named)?.version ?? named;
      if (!version) return { success: false, error: `${pass.slug} has no earlier version to go back to.` };
    }
    const url = `${BASE}/api/live/${pass.slug}/pin`;
    const headers = { 'User-Agent': this.userAgent(), 'X-Live-Key': key, Accept: 'application/json' };
    const r = await (this.http || axios)({ method: unpin ? 'delete' : 'post', url, data: unpin ? undefined : { version }, headers: unpin ? headers : { ...headers, 'Content-Type': 'application/json' },
      timeout: 30000, validateStatus: () => true }).catch(e => ({ status: 0, data: { error: e.message } }));
    if (r.status >= 400 || !r.status) return { success: false, error: `The store refused: ${r.data?.error || `HTTP ${r.status}`}` };
    // Fetch the model the store now serves for this pass.
    const passes = await this.livePasses();
    const saved = passes.find(p => p.slug === pass.slug);
    if (saved) { saved.etag = null; saved.pinned = unpin ? null : String(version); await this.saveLivePasses(passes); }
    const report = await this.syncLive().catch(() => []);
    const st = report.find(x => x.slug === pass.slug)?.status;
    this.logger.info(`botsandborgs: ${pass.slug} ${unpin ? 'unpinned' : `pinned to ${version}`}; model ${st || 'not checked'}`);
    return { success: true, version, result: unpin ? `${pass.slug} follows its newest version again${st === 'updated' ? ', and it is installed' : ''}.`
      : `${pass.slug} is held at version ${version}${st === 'updated' ? ', and that version is installed' : ''}. Say "follow the newest version" to undo.` };
  }

  async liveCommand({ check, renew, fit, versions, pin, unpin, model } = {}) {
    if (pin || unpin === true || unpin === 'true') return this.pinLive({ model, pin, unpin: !!unpin && !pin });
    if (versions === true || versions === 'true') {
      const got = await this.passFor(model);
      if (got.error) return { success: false, error: got.error };
      const list = await this.liveVersions(got.pass, got.key);
      return { success: true, versions: list, result: `Versions of ${got.pass.slug} the store keeps (newest first):\n${list.map(v => `- ${v.version}${v.at ? `, ${String(typeof v.at === 'number' ? new Date(v.at * 1000).toISOString() : v.at).slice(0, 10)}` : ''}${v.current ? ' (current)' : ''}`).join('\n') || '- none listed'}${got.pass.pinned ? `\nI'm held at ${got.pass.pinned}.` : ''}` };
    }
    // "Is my avatar fitted / why can't you hold the mug": the store's fit status for the worn body, in its own words.
    if (fit === true || fit === 'true') {
      const f = await PluginSettings.getCached(this.name, 'liveFit').catch(() => null);
      if (!f) return { success: true, result: "I have no fit status from Bots & Borgs yet; it comes with my live pass's next check." };
      const off = await this.unsupportedProps();
      const lines = f.props.map(p => `- ${p.prop}: ${p.line || p.state}${p.state === 'unsupported' && p.fix ? ` (would work with: ${p.fix})` : ''}`);
      const job = f.job ? ` The store is fitting it now${f.job.eta_seconds ? `, about ${Math.max(1, Math.round(f.job.eta_seconds / 60))} min` : ''}${f.job.position != null ? ` (position ${f.job.position})` : ''}.` : '';
      return { success: true, fit: f, result: `How the store's props fit my body${f.body_class ? ` (${f.body_class})` : ''}:\n${lines.join('\n') || '- nothing listed yet'}${off.size ? `\nI won't use ${[...off.keys()].join(', ')} on this body.` : ''}${job}` };
    }
    if (renew) {
      const slug = renew === true || renew === 'true' ? this.wornBase() : this.productBase(String(renew));
      if (!slug) return { success: false, error: 'Which model\'s pass should I renew?' };
      return this.renewLive(slug);
    }
    const report = check === false || check === 'false' ? null : await this.syncLive();
    const passes = await this.livePasses();
    if (!passes.length) return { success: true, passes: [], result: 'I have no live avatar passes from Bots & Borgs. A live pass keeps a model at its newest version; most 3D avatars sell one (30, 90 or 365 days).' };
    const line = (p) => {
      const r = report?.find(x => x.slug === p.slug);
      const what = !r ? '' : r.status === 'updated' ? ', a new version just arrived and is installed' : r.status === 'expired' ? ', the pass has run out (the installed model stays)'
        : r.status === 'error' ? `, the check failed: ${r.error}` : ', up to date';
      return `- ${p.slug}: ${p.state || 'active'}, until ${String(liveExpiry(p.expires) || '?').slice(0, 10)}${what}`;
    };
    return { success: true, report, passes: passes.map(({ key, vrmUrl, ...rest }) => ({ ...rest, vrmUrl: liveUrl(vrmUrl, rest.slug), expires: liveExpiry(rest.expires) })), result: `My live avatar passes:\n${passes.map(line).join('\n')}` };
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
    // A store id written in the request ("…in VRM Dance Pack 2 (vrm-dance-pack-2)…") is the thing to buy.
    if (!data.variant) {
      const slug = /\(((?:vrm|bg|mech|agent|bot|call)-[a-z0-9]+(?:-[a-z0-9]+)+)\)/i.exec(asked) || /\b((?:vrm|bg)-[a-z0-9]+(?:-[a-z0-9]+){1,6})\b/.exec(asked);
      if (slug) data = { ...data, variant: slug[1].toLowerCase() };
    }
    // "Buy all the animations": every clip pack on sale that it doesn't own, one order each, every one under the same
    // budget and wallet rules. Stops at the first refusal and says what was bought before it. "All-Access" is the plan's
    // name, not "all": "…using the active All-Access pass" bought 15 items in 9 s on DELTA (2026-11-17).
    if (!data.variant && data.all !== false && (data.all === true || data.all === 'true' || /\b(all|every|each)\b/i.test(asked.replace(/\ball[- ]access\b/gi, '')))
      && this.kindAsked(`${asked} ${data.kind || ''} ${data.query || ''}`) === 'animation') return this.buyAllAnimations(data);
    if (/\bsend (?:it|them|that)? ?(?:to )?me\b|\bto me\b|\bbuy me\b/i.test(asked) && !data.use) data = { ...data, use: 'send', to: data.to || 'me' };
    // "buy yourself an avatar" / "… and use it as your avatar" is for the agent's avatar; "send it to X" / "buy X a …" is a send.
    if (!data.use && /\b(yourself|your (?:own )?(?:new )?avatar|as your avatar|for you)\b/i.test(asked)) data = { ...data, use: 'avatar' };
    // "Pick another avatar … and apply it" is for itself too.
    if (!data.use && /\bavatar\b/i.test(asked) && /\b(?:another|new|different) avatar\b|\b(?:apply|wear|equip|use) (?:it|that|them)\b|\bput (?:it|that) on\b/i.test(asked) && !/\b(?:send|for|to|give)\s+(?!you\b|yourself\b)\w+/i.test(asked.replace(/\bfor (?:it|that|one)\b/gi, ''))) data = { ...data, use: 'avatar' };
    if (!data.use && /\b(send (?:it )?to|for)\s+(me|\w+)/i.test(asked)) data = { ...data, use: 'send', to: data.to || /\b(?:send (?:it )?to|for)\s+(me|\w+)/i.exec(asked)[1] };
    // What was asked for: a named variant says it, otherwise the words. A model installs; stickers, emoji and the like
    // are bought to use from the library. A single picture with no stated use still asks.
    const wantKind = this.kindAsked(`${asked} ${data.kind || ''} ${data.query || ''}`);
    // The store's collection decides first: "vrm-pole-dance" is a clip, though its slug reads like a model.
    let named = data.variant ? variantKind(data.variant) : null;
    if (named === 'vrm') named = variantKind(data.variant, (await this.productOf(String(data.variant)).catch(() => null))?.collection);
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
    if (!data.use && ['sticker', 'emoji', 'wallpaper', 'animation', 'prop', 'kit', 'voice', 'sound', 'motion', 'background'].includes(buying)) data = { ...data, use: 'keep' };
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

    // "Buy a live pass for it": the model's live variant, which the store keeps at its newest version.
    if (/\blive\b/i.test(`${asked} ${data.query || ''}`) && !livePass(data.variant) && variantKind(data.variant) === 'vrm') {
      const days = /\b(year|365|annual)\b/i.test(asked) ? 365 : /\b90\b|three months|3 months/i.test(asked) ? 90 : 30;
      const base = String(data.variant).replace(/-(?:portraits|stickers|bundle)$/, '');
      const product = await this.productOf(base).catch(() => null);
      if (!(product?.variants || []).some(v => v.id === `${base}-live${days}`)) return { success: false, error: `${product?.title || base} has no ${days}-day live pass on sale.` };
      data = { ...data, variant: `${base}-live${days}` };
    }
    const live = livePass(data.variant);
    // The store nests its answers: { quote: {...} }, { order: {...}, crypto: {...}, token } (live, 2026-10-28).
    // A live pass is quoted with the account key: a download it already paid for comes off the first pass.
    // Quoted with the account key: a live pass's download credit, and under All-Access every included item at $0
    // (`covered: "subscription"`, 2119 #513). A store that can't register the key still quotes without it.
    const quoteKey = await this.accountKey().catch(e => { if (live) throw e; return undefined; });
    const quoted = await this.api('post', '/api/quotes', { body: { items: [{ variant: String(data.variant), qty: 1 }] }, key: quoteKey });
    const quote = quoted.quote || quoted;
    const usd = Number(quote.total_cents ?? 0) / 100;
    // A first live pass on a model already paid for can cost nothing: the store takes the download off it
    // (`upgrade_credit_cents`; Racer Blue's $15 bundle made its 30-day pass $0, 2026-11-14). A free order is placed
    // on the balance; any other $0 quote is still a store fault.
    const credited = Number(quote.upgrade_credit_cents ?? quote.credit_cents ?? 0) > 0 || (quote.lines || quote.items || []).some(l => Number(l?.upgrade_credit_cents) > 0);
    const lines = quote.lines || quote.items || [];
    const covered = lines.some(l => l?.covered === 'subscription');
    const listUsd = covered ? lines.reduce((t, l) => t + Number(l?.list_cents || 0), 0) / 100 : null;
    if (!(usd > 0) && !(usd === 0 && (credited || covered))) throw new Error(`The store returned a quote with no price (${JSON.stringify(quote).slice(0, 400)}).`);
    const ledger = await this.ledger();
    const spent = this.spentThisWeek(ledger);
    // An automatic take (takeNewPacks) never spends money: only a covered or credited $0 item goes through.
    if (data.autoTake && usd > 0) return { success: false, error: `${data.variant} costs $${usd.toFixed(2)}; All-Access does not cover it, so it was not taken` };
    // Nothing to pay (a covered or credited $0 item) spends no budget, even in a week already over it.
    if (usd > 0 && spent + usd > s.weeklyBudgetUsd + 1e-9) return { success: false, error: `That costs $${usd.toFixed(2)} and I have $${Math.max(0, s.weeklyBudgetUsd - spent).toFixed(2)} of this week's $${s.weeklyBudgetUsd} left, so I didn't buy it.` };
    if (s.maxItemUsd != null && usd > s.maxItemUsd) return { success: false, error: `That costs $${usd.toFixed(2)}, over my $${s.maxItemUsd} per-item limit.` };
    if (data.dryRun === true || data.dryRun === 'true') return { success: true, dryRun: true, variant: String(data.variant), usd, result: `${pickedWhy}Would buy ${data.variant} for $${usd.toFixed(2)} (${use}); nothing was paid.` };
    if (s.requireApproval && data.confirm !== true) return { success: true, result: `It costs $${usd.toFixed(2)} (${data.variant}, for ${use === 'avatar' ? 'my avatar' : `sending to ${data.to}`}). Say yes and I'll buy it.` };

    const rail = await this.api('get', '/api/crypto');
    const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
    if (!asset) return { success: false, error: `The store doesn't take ${s.payAsset} right now.` };
    const wallet = await this.walletUsd(asset);
    if (wallet.usd != null && wallet.usd - usd < s.minWalletUsd) return { success: false, error: `My wallet has $${wallet.usd.toFixed(2)} of ${s.payAsset}; buying would take it under the $${s.minWalletUsd} floor, so I didn't.` };

    const key = await this.accountKey();
    const entry = { at: new Date().toISOString(), variant: String(data.variant), usd, use, to: data.to || null, used: false, ...(covered ? { covered: 'subscription', listUsd } : {}) };
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
    if (live && used.success) {
      const passes = await this.refreshLivePasses().catch(e => { this.logger.warn(`botsandborgs: live pass not read back: ${e.message}`); return []; });
      const mine = passes.find(p => p.slug === live.slug);
      used.result += mine ? ` The store keeps it at its newest version until ${String(mine.expires || '').slice(0, 10) || 'the pass ends'}, and I check it every ${Math.round(LIVE_SYNC_MS / 3600000)} hours.`
        : ' The store has not listed the live pass yet; I will pick it up on the next check.';
    }
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

  // ── All-Access subscription (store 0.26, 2119 #513) ──────────────────────────────────────
  /** A plan date as YYYY-MM-DD: the store sends Unix seconds (renews_on 1797377021), or an ISO string. */
  planDay(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    const d = Number.isFinite(n) && n > 1e9 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
  }

  /** The plan, or null when this account has none. */
  async plan(key) {
    try { const r = await this.api('get', '/api/account/plan', { key }); return r?.plan || r || null; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  async planCommand(data = {}) {
    const key = await this.accountKey();
    if (data.subscribe) return this.subscribe(String(data.subscribe), key);
    if (data.member) {
      const account = String(data.member).trim();
      if (!/^acct_[A-Za-z0-9_-]+$/.test(account)) return { success: false, error: 'A member is a store account id (acct_…).' };
      await this.api('post', '/api/account/plan/members', { key, body: { account } });
      this.logger.info(`botsandborgs: added ${account} to the All-Access plan`);
      return { success: true, result: `Added ${account} to my All-Access plan.` };
    }
    if (data.cancel === true || data.cancel === 'true') {
      await this.api('delete', '/api/account/plan', { key });
      return { success: true, result: 'All-Access is cancelled at the end of this period; what I downloaded stays mine.' };
    }
    const [plan, bal] = await Promise.all([this.plan(key), this.api('get', '/api/account/balance', { key }).catch(() => null)]);
    const saved = await PluginSettings.getCached(this.name, 'account').catch(() => null);
    const account = bal?.account || bal?.account_id || plan?.account || saved?.account || null;
    const balanceUsd = bal?.balance_cents != null ? Number(bal.balance_cents) / 100 : null;
    if ((await this.settings()).hasPlan !== !!(plan?.status && plan.status !== 'none')) await this.saveSettings({ hasPlan: !!(plan?.status && plan.status !== 'none') });
    if (!plan || !plan.status || plan.status === 'none') {
      return { success: true, plan: null, account, balanceUsd, result: `No All-Access plan.${account ? ` My store account is ${account}.` : ''}` };
    }
    const left = plan.downloads_left ?? plan.downloads?.left;
    if (plan.role && plan.role !== 'owner') {
      return { success: true, plan, account, balanceUsd, result: `All-Access: ${plan.status}, as a seat on another account's plan (it pays and renews)${plan.renews_on ? `, renews ${this.planDay(plan.renews_on)}` : ''}${left != null ? `; ${left} downloads left this period` : ''}${account ? `; my account ${account}` : ''}.` };
    }
    const text = [`All-Access: ${plan.status}${plan.renews_on ? `, renews ${this.planDay(plan.renews_on)}` : plan.period_end ? `, period ends ${this.planDay(plan.period_end)}` : ''}`
      + (plan.renewal_cents != null ? ` for $${(Number(plan.renewal_cents) / 100).toFixed(2)}` : ''),
      left != null ? `${left} downloads left this period` : null,
      balanceUsd != null ? `store balance $${balanceUsd.toFixed(2)}` : null,
      account ? `my account ${account}` : null,
      plan.warning ? `WARNING: ${plan.warning}` : null].filter(Boolean).join('; ');
    return { success: true, plan, account, balanceUsd, result: `${text}.` };
  }

  /**
   * Subscribe to All-Access, paid from the store balance (the store renews it from there each period). The owner
   * decides to subscribe; the weekly item budget is for single purchases and does not apply. The wallet floor does.
   */
  async subscribe(period, key) {
    const variant = /year/i.test(period) ? 'bnb-all-access-year' : 'bnb-all-access-month';
    const s = await this.settings();
    const existing = await this.plan(key);
    if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) return { success: true, result: `I already have All-Access (${existing.status}).`, plan: existing };
    const quoted = await this.api('post', '/api/quotes', { key, body: { items: [{ variant, qty: 1 }] } });
    const quote = quoted.quote || quoted;
    const usd = Number(quote.total_cents ?? 0) / 100;
    if (!(usd > 0)) throw new Error(`The store quoted All-Access at no price (${JSON.stringify(quote).slice(0, 300)}).`);
    const rail = await this.api('get', '/api/crypto');
    const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
    if (!asset) return { success: false, error: `The store doesn't take ${s.payAsset} right now.` };
    const wallet = await this.walletUsd(asset);
    const entry = { at: new Date().toISOString(), variant, usd, use: 'plan', used: true };
    const paid = await this.payFromBalance({ quote, key, usd, s, asset, wallet, entry });
    if (paid.refused) return { success: false, error: paid.refused };
    const plan = await this.plan(key).catch(() => null);
    await this.saveSettings({ hasPlan: true });
    this.logger.info(`botsandborgs: subscribed to ${variant} for $${usd.toFixed(2)} (${plan?.status || 'status unknown'})`);
    return { success: true, plan, result: `Subscribed to Bots & Borgs All-Access (${/year/.test(variant) ? 'yearly' : 'monthly'}, $${usd.toFixed(2)}), ${paid.label}.${plan?.renews_on ? ` It renews ${this.planDay(plan.renews_on)} from my store balance.` : ''} Included items now cost nothing.` };
  }

  /**
   * Keep the plan paid: when the store warns that the balance won't cover the next renewal, top it up from the wallet
   * once per period (wallet floor applies) and tell the owner; when the warning is anything else, or the top-up is
   * refused, tell the owner urgently. Quiet when there is no plan.
   */
  async planTick() {
    // Only an agent known to hold a plan asks; one with none makes no store call (the live timer's rule).
    if (!(await this.settings()).hasPlan) return;
    const key = await this.accountKey().catch(() => null);
    if (!key) return;
    const plan = await this.plan(key);
    // A seat (DELTA on ALICE's plan) pays nothing: the plan's holder renews it. Topping up a seat's own balance
    // would not pay the plan, it would only spend that agent's wallet.
    if (plan?.role && plan.role !== 'owner') return;
    if (!plan?.warning || plan.status === 'canceled') return;
    const s = await this.settings();
    const period = this.planDay(plan.renews_on || plan.period_end);
    if (s.planToppedFor === period) return;
    const bal = await this.api('get', '/api/account/balance', { key }).catch(() => null);
    const need = Math.max(0, Number(plan.renewal_cents || 0) - Number(bal?.balance_cents || 0));
    const notify = (text, urgent) => this.agent?.notify?.(text, { urgent });
    if (!(need > 0) || plan.status === 'past_due') { await notify(`Bots & Borgs All-Access: ${plan.warning}`, true); await this.saveSettings({ planToppedFor: period }); return; }
    const rail = await this.api('get', '/api/crypto');
    const asset = (rail.assets || []).find(a => a.symbol === s.payAsset);
    const wallet = asset ? await this.walletUsd(asset) : null;
    const cents = Math.max(MIN_DEPOSIT_CENTS, need);
    if (!asset || (wallet?.usd != null && wallet.usd - cents / 100 < s.minWalletUsd)) {
      await notify(`Bots & Borgs All-Access renews ${period} for $${(Number(plan.renewal_cents) / 100).toFixed(2)} and my store balance is short by $${(need / 100).toFixed(2)}; topping it up would take my wallet under its floor, so I didn't.`, true);
      await this.saveSettings({ planToppedFor: period });
      return;
    }
    const dep = await this.api('post', '/api/account/deposit', { key, idem: `lanagent-plan-${period}`, body: { amount_cents: cents, pay_asset: s.payAsset } });
    const order = { ...(dep.order || dep), token: dep.token || dep.order?.token };
    const pay = dep.crypto || order.crypto || {};
    if (!pay.address || !pay.amount) throw new Error('The store\'s deposit came back without payment instructions.');
    const { hash, confirm } = await this.sendAndConfirm({ order, pay, key, asset, s });
    await this.record({ at: new Date().toISOString(), variant: 'store balance (All-Access renewal)', usd: cents / 100, use: 'deposit', used: true, order: order.id, token: order.token, asset: s.payAsset, tx: hash });
    await this.saveSettings({ planToppedFor: period });
    const ok = await confirm();
    this.logger.info(`botsandborgs: topped up the store balance $${(cents / 100).toFixed(2)} for the All-Access renewal on ${period} (tx ${hash}${ok ? '' : ', still confirming'})`);
    await notify(`Topped up my Bots & Borgs balance $${(cents / 100).toFixed(2)} so All-Access renews on ${period} (tx ${hash}).`, false);
  }

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

  /** Every animation pack on sale that this agent doesn't own yet, bought one by one through buy(). */
  async buyAllAnimations(data) {
    const cat = await this.api('get', '/api/catalog?collection=animations');
    const owned = new Set((await this.libraryItems()).map(i => i.variant));
    // Whole packs only: a pack's single-clip variants are inside it already (DELTA bought 13 singles beside their packs).
    const todo = (cat.products || []).filter(p => p.collection === 'animations')
      .map(p => { const v = (p.variants || []).find(x => x.id === p.id || x.id === p.slug) || (p.variants || [])[0]; return v && { id: v.id, title: p.title, usd: v.price_cents / 100 }; })
      .filter(v => v && !owned.has(v.id));
    if (!todo.length) return { success: true, result: 'I already own every animation pack on sale.' };
    const done = [];
    for (const v of todo) {
      const r = await this.buy({ ...data, all: false, variant: v.id, use: 'keep' });
      const asksFirst = r.success && !r.dryRun && /Say yes/.test(r.result || '');
      if (!r.success || asksFirst) {
        const before = done.length ? `Bought ${done.map(d => d.title).join(', ')}. ` : '';
        return { success: done.length > 0, bought: done, result: `${before}Stopped at ${v.title}: ${r.error || r.result}` };
      }
      done.push({ ...v, result: r.result });
    }
    const usd = done.reduce((t, d) => t + d.usd, 0);
    const verb = data.dryRun === true || data.dryRun === 'true' ? 'Would buy' : 'Bought';
    return { success: true, bought: done, result: `${verb} ${done.length} animation pack${done.length === 1 ? '' : 's'} ($${usd.toFixed(2)}): ${done.map(d => d.title).join(', ')}.` };
  }

  // ── library ───────────────────────────────────────────────────
  kindAsked(words) {
    const w = String(words || '');
    // Clips first: "the dance pack", "emote animations" are clips, not a model's bundle or a sticker set.
    if (/\b(animations?|animated clips?|dance (?:pack|moves|clips?|routine)|dances?|motions?|vrma|mocap|gesture clips?)\b/i.test(w)) return 'animation';
    // Add-ons (store 0.17): a profile kit (banners), a voice pack, the call sounds.
    if (/\bprofile kit\b|\bbanners?\b/i.test(w)) return 'kit';
    if (/\bvoice(?: pack)?\b/i.test(w)) return 'voice';
    if (/\b(call sounds?|hold music|ringback|chimes?)\b/i.test(w)) return 'sound';
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

  /** New purchases go first (the newest is what "the one you just bought" means); an update keeps its place. */
  async saveLibraryItem(item, { keepPlace = false } = {}) {
    const items = await this.libraryItems();
    const at = items.findIndex(i => i.variant === item.variant);
    if (keepPlace && at >= 0) items[at] = item;
    else { if (at >= 0) items.splice(at, 1); items.unshift(item); }
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
  async ingest({ order, downloads, variant: bought, update = null }) {
    const product = await this.productOf(bought);
    const kind = variantKind(bought, product?.collection);
    // A live pass (vrm-x-live30) is the model vrm-x: one library item and one gallery model, whichever pass or
    // renewal brought it, so a renewal never adds a second copy and a live update finds it.
    const live = livePass(bought);
    // A model already owned another way (ALICE wears vrm-racer-blue-bundle's copy): the pass keeps THAT one current.
    if (live && !update) {
      const owner = (await this.libraryItems()).find(i => i.variant !== live.slug && this.productBase(i.variant) === live.slug && i.files.some(f => f.kind === 'vrm'));
      if (owner) return this.ingestLiveInto(owner, { downloads, bought });
    }
    const variant = live?.slug || bought;
    const label = (product?.variants || []).find(v => v.id === bought)?.label;
    const title = product ? (kind === 'vrm' || kind === 'bundle' || kind === 'animation' || !label ? product.title : `${product.title}: ${label}`) : variant;
    const dir = path.join(this.libraryDir(), safeName(variant));
    await fs.mkdir(dir, { recursive: true });
    const files = [];
    for (const d of downloads) {
      const url = typeof d === 'string' ? d : d?.url;
      // A download already fetched and checked (the account library, store 0.29) comes as { buffer, type, filename }.
      if (!url && !d?.buffer) continue;
      const got = d?.buffer ? { buffer: d.buffer, type: d.type || '' } : await this.fetchBytes(url);
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
    // clips.json (store 0.22): tags, facing, energy and fit for each clip, read once the files are in.
    const manifest = files.find(f => f.kind === 'clip-manifest');
    if (manifest) {
      try { applyClipManifest(files, JSON.parse(await fs.readFile(path.join(dir, manifest.name), 'utf8'))); }
      catch (e) { this.logger.warn(`botsandborgs: ${variant} clips.json unreadable: ${e.message}`); }
    }
    const item = { variant, title, kind, collection: product?.collection || null, order: order?.id || null, token: order?.token || null, at: new Date().toISOString(), files };
    if (livePass(bought)) item.livePass = bought;
    if (update) item.at = update.at || item.at;
    await this.saveLibraryItem(item, { keepPlace: !!update });
    if (files.some(f => f.kind === 'animation' || f.kind === 'prop')) await this.publishAnimations();
    return item;
  }

  /** A live pass's download for a model already owned: its VRM replaces that item's model, the rest is left alone. */
  async ingestLiveInto(item, { downloads, bought }) {
    let buffer = null;
    for (const d of downloads) {
      const url = typeof d === 'string' ? d : d?.url;
      if (!url) continue;
      const got = await this.fetchBytes(url);
      const vrm = (await unpack(got.buffer, { type: got.type, kind: 'vrm', filename: typeof d === 'string' ? '' : (d.filename || d.name || '') })).find(f => f.kind === 'vrm');
      if (vrm) { buffer = vrm.buffer; break; }
    }
    const next = { ...item, livePass: bought };
    if (buffer) await this.replaceModel(next, buffer);
    else await this.saveLibraryItem(next, { keepPlace: true });
    this.logger.info(`botsandborgs: live pass ${bought} keeps ${item.variant} current${buffer ? '' : ' (its download held no model)'}`);
    return (await this.libraryItems()).find(i => i.variant === item.variant) || next;
  }

  /**
   * Put new model bytes in an owned item: its library file, its gallery model (same id), and AvatarX when worn.
   * Identical bytes change nothing. Returns { changed, worn, gallery }.
   */
  async replaceModel(item, buffer) {
    readVrmInfo(buffer);
    const file = item.files.find(f => f.kind === 'vrm');
    const dir = path.join(this.libraryDir(), safeName(item.variant));
    const name = file?.name || `${item.variant}.vrm`;
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const before = await fs.readFile(path.join(dir, name)).then(sha).catch(() => null);
    if (before === sha(buffer)) { await this.saveLibraryItem(item, { keepPlace: true }); return { changed: false, worn: false, gallery: file?.gallery || null }; }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), buffer);
    const gallery = await installVrm(buffer, { variant: item.variant, name: file?.gallery?.name, description: file?.gallery?.description || `Bought from Bots & Borgs (${item.title || item.variant})` }, this.vrmDir());
    const entry = { ...(file || { name, kind: 'vrm', mime: 'model/gltf-binary' }), size: buffer.length, modelId: gallery.id, gallery };
    const next = { ...item, files: file ? item.files.map(f => f === file ? entry : f) : [...item.files, entry] };
    await this.saveLibraryItem(next, { keepPlace: true });
    const worn = gallery.id === this.agent?.agentModel?.activeVRMModel;
    if (worn) {
      const { pushModelToAvatarX } = await import('../../services/avatar/avatarx.js');
      await pushModelToAvatarX(gallery.id).catch(e => this.logger.warn(`botsandborgs: AvatarX not given the new ${item.variant}: ${e.message}`));
    }
    return { changed: true, worn, gallery };
  }

  /**
   * Fetch everything already owned again, so files the store has added or fixed since (new stickers, relabelled
   * ones, a rebuilt model) reach the library. Each item's order is read with its own token; every file fetched
   * spends one of that order's 25 downloads. Owned items keep their place and purchase date.
   * Returns [{ variant, added, removed, changed }] per item that changed.
   */
  /**
   * The account library (store 0.29, GET /api/library): everything this account has, kept current. One poll with the
   * store's own cursor (`next_since`); an item whose ETag moved is fetched once (If-None-Match, 304 free), checked
   * against its sha256 and unpacked through ingest like a purchase, keeping its place and order. Items the store gives
   * that are not in the library yet (an All-Access take, a live pass's starter packs) come in too. Models stay with their
   * live pass (the VRM and its fits). Returns [{ variant, added, removed, changed, notes }] for the items that changed.
   */
  async syncLibrary({ full = false } = {}) {
    const key = await this.accountKey().catch(() => null);
    if (!key) return [];
    const cursor = full ? null : await PluginSettings.getCached(this.name, 'libraryCursor').catch(() => null);
    const q = cursor?.since ? `?since=${encodeURIComponent(cursor.since)}` : '';
    let d;
    try { d = await this.api('get', `/api/library${q}`, { key }); }
    catch (e) { this._libraryOk = false; if (e.status === 404) return []; throw e; }
    this._libraryOk = true;
    const listed = Array.isArray(d) ? d : d.items || d.library || [];
    const etags = (await PluginSettings.getCached(this.name, 'libraryEtags').catch(() => null))?.etags || {};
    const first = !Object.keys(etags).length;
    const report = [];
    const fixedClips = [];
    for (const it of listed) {
      if (!it?.variant || !it.etag || etags[it.variant] === it.etag) continue;
      const kind = variantKind(it.variant, it.collection);
      const old = (await this.libraryItems()).find(i => i.variant === it.variant);
      // The first sync takes what is already here as current: no 300-download burst of packs that did not change.
      if ((first && old) || ['vrm', 'bundle'].includes(kind) || livePass(it.variant)) { etags[it.variant] = it.etag; continue; }
      try {
        const r = await this.fetchLibraryItem(it.url, key, etags[it.variant]);
        if (r.status === 304) { etags[it.variant] = it.etag; continue; }
        if (r.status !== 200) throw new Error(`the store answered ${r.status}`);
        const buffer = Buffer.from(r.data);
        if (it.sha256 && crypto.createHash('sha256').update(buffer).digest('hex') !== it.sha256) throw new Error('the download does not match its sha256');
        const dir = path.join(this.libraryDir(), safeName(it.variant));
        const digest = async (files) => new Map(await Promise.all((files || []).map(async f => [f.name,
          await fs.readFile(path.join(dir, f.name)).then(b => crypto.createHash('sha256').update(b).digest('hex')).catch(() => `size:${f.size}`)])));
        const before = await digest(old?.files);
        const item = await this.ingest({ order: old?.order ? { id: old.order, token: old.token } : null, variant: it.variant,
          downloads: [{ buffer, type: String(r.headers['content-type'] || ''), filename: `${it.variant}.zip` }], update: old ? { at: old.at } : null });
        const after = await digest(item.files);
        const added = [...after.keys()].filter(n => !before.has(n));
        const removed = [...before.keys()].filter(n => !after.has(n));
        const changed = [...after.keys()].filter(n => before.has(n) && before.get(n) !== after.get(n));
        for (const f of item.files) if (f.kind === 'animation' && (changed.includes(f.name) || added.includes(f.name))) fixedClips.push({ variant: it.variant, name: f.name });
        const notes = (it.notes || []).slice(0, 3).map(n => `${n.kind || 'update'}: ${n.text}`);
        report.push({ variant: it.variant, added, removed, changed, notes, source: it.source || null });
        etags[it.variant] = it.etag;
        this.logger.info(`botsandborgs: library ${old ? 'updated' : 'added'} ${it.variant}: ${added.length} new, ${removed.length} gone, ${changed.length} changed${notes.length ? ` (${notes.join('; ')})` : ''}`);
      } catch (e) {
        this.logger.warn(`botsandborgs: library item ${it.variant} not synced: ${e.message}`);
      }
    }
    await PluginSettings.setCached(this.name, 'libraryEtags', { etags });
    if (d.next_since != null) await PluginSettings.setCached(this.name, 'libraryCursor', { since: d.next_since, at: new Date().toISOString() });
    if (fixedClips.length) await this.afterClipFixes(fixedClips);
    this.logger.info(`botsandborgs: library sync: ${listed.length} listed${q ? ' since the last check' : ''}, ${report.length} changed${first ? ' (first sync: what is here was taken as current)' : ''}`);
    return report;
  }

  /**
   * Every animation and props pack in the store that this agent does not own, taken at no cost under an active
   * All-Access plan (its own or a seat on another). Whole packs only, never a single clip a pack holds; up to the
   * plan's downloads left this period, keeping 3 for the owner's own asks. Never spends money: a pack the plan does
   * not cover (any price above $0) is left alone. Returns the variants taken.
   */
  async takeNewPacks({ collections = ['animations', 'props'], keep = 3 } = {}) {
    const key = await this.accountKey().catch(() => null);
    if (!key) return [];
    const plan = await this.plan(key);
    if (!plan || !['active', 'trialing'].includes(plan.status)) return [];
    let left = Number(plan.downloads_left ?? plan.downloads?.left ?? 0) - keep;
    if (!(left > 0)) return [];
    const catalog = await this.api('get', '/api/catalog').catch(() => null);
    const owned = new Set((await this.libraryItems()).map(i => i.variant));
    const want = (catalog?.products || []).filter(p => collections.includes(p.collection))
      // The pack itself: the variant named like the product, else its first (singles carry a clip suffix).
      .map(p => (p.variants || []).find(v => v.id === p.id || v.id === p.slug)?.id || (p.variants || [])[0]?.id)
      .filter(v => v && !owned.has(v));
    const taken = [];
    for (const variant of want) {
      if (left <= 0) break;
      // confirm: a covered pack costs nothing, and autoTake refuses anything that would (see buy).
      const r = await this.buy({ variant, use: 'keep', autoTake: true, confirm: true }).catch(e => ({ success: false, error: e.message }));
      if (r?.success) { taken.push(variant); left--; this.logger.info(`botsandborgs: took ${variant} under All-Access`); }
      else this.logger.info(`botsandborgs: ${variant} not taken: ${r?.error || r?.result || 'no answer'}`);
    }
    if (taken.length) {
      const tg = this.agent?.interfaces?.get?.('telegram');
      await tg?.sendNotification?.(`New from Bots & Borgs, taken under All-Access: ${taken.join(', ')}.`)?.catch?.(() => {});
    }
    return taken;
  }

  /** One library download: { status, headers, data } (304 when `etag` is current). */
  async fetchLibraryItem(url, key, etag) {
    return axios.get(url, { responseType: 'arraybuffer', timeout: 300000, validateStatus: () => true,
      headers: { 'User-Agent': this.userAgent(), Authorization: `Bearer ${key}`, ...(etag ? { 'If-None-Match': etag } : {}) } });
  }

  /** A reissued clip: relist it for the designer and playground, and replace AvatarX's copy, which it keeps by name. */
  async afterClipFixes(fixedClips) {
    const listed = await this.publishAnimations().catch(e => { this.logger.warn(`botsandborgs: clips not relisted: ${e.message}`); return null; });
    const { pushClipsToAvatarX } = await import('../../services/avatar/avatarx.js');
    // Only clips that are listed: a Broad/ version is never published, and one missing file used to abort the whole
    // push (the 2026-11-19 salute fix: "AvatarX not given the fixed clips: ENOENT … broad emote-salute.vrma").
    const published = listed ? new Set(listed.map(c => c.file)) : null;
    const files = fixedClips
      .filter(c => !published || published.has(`store/${safeName(c.variant)}/${c.name}`))
      .map(c => ({ file: path.join(this.vrmDir(), 'animations', 'store', safeName(c.variant), c.name), replace: true }));
    if (!files.length) return;
    const pushed = await pushClipsToAvatarX(files).catch(e => { this.logger.warn(`botsandborgs: AvatarX not given the fixed clips: ${e.message}`); return null; });
    if (Array.isArray(pushed)) this.logger.info(`botsandborgs: AvatarX has the fixed clips: ${pushed.join(', ')}`);
  }

  async updateOwned({ kind } = {}) {
    const report = [];
    const fixedClips = [];
    const key = await this.accountKey().catch(() => null);
    for (const old of await this.libraryItems()) {
      if (!old.order || !old.token) continue;
      if (kind && old.kind !== kind && !old.files.some(f => f.kind === kind)) continue;
      const full = await this.api('get', `/api/orders/${old.order}?token=${encodeURIComponent(old.token)}`, key ? { key } : {}).catch(e => ({ error: e.message }));
      const downloads = full?.downloads || full?.order?.downloads || [];
      if (!downloads.length) { report.push({ variant: old.variant, error: full?.error || 'the store listed no downloads' }); continue; }
      // By content: a reissued file can keep its size (Rumba, react-victory and blow-kiss did, 2026-11-10).
      const dir = path.join(this.libraryDir(), safeName(old.variant));
      const digest = async (files) => new Map(await Promise.all(files.map(async f => [f.name,
        await fs.readFile(path.join(dir, f.name)).then(b => crypto.createHash('sha256').update(b).digest('hex')).catch(() => `size:${f.size}`)])));
      const before = await digest(old.files);
      const item = await this.ingest({ order: { id: old.order, token: old.token }, downloads, variant: old.variant, update: { at: old.at } });
      const after = await digest(item.files);
      const added = [...after.keys()].filter(n => !before.has(n));
      const removed = [...before.keys()].filter(n => !after.has(n));
      const changed = [...after.keys()].filter(n => before.has(n) && before.get(n) !== after.get(n));
      if (added.length || removed.length || changed.length) report.push({ variant: old.variant, added, removed, changed });
      for (const f of item.files) if (f.kind === 'animation' && (changed.includes(f.name) || added.includes(f.name))) fixedClips.push({ variant: old.variant, name: f.name });
      // The model it wears changed: AvatarX shows its own copy, so it gets the new file (the designer and playground
      // read the gallery file, already replaced).
      const worn = item.files.find(f => f.kind === 'vrm' && f.modelId && f.modelId === this.agent?.agentModel?.activeVRMModel);
      if (worn && changed.some(n => n === worn.name)) {
        const { pushModelToAvatarX } = await import('../../services/avatar/avatarx.js');
        await pushModelToAvatarX(worn.modelId).catch(e => this.logger.warn(`botsandborgs: AvatarX not given the new ${worn.name}: ${e.message}`));
      }
      this.logger.info(`botsandborgs: updated ${old.variant}: ${added.length} new, ${removed.length} gone, ${changed.length} changed`);
    }
    if (fixedClips.length) await this.afterClipFixes(fixedClips);
    return report;
  }

  async library({ kind, query, refresh, update } = {}) {
    const refreshing = refresh === true || refresh === 'true';
    if (refreshing) await this.refreshLibrary();
    // "Update": the account library (store 0.29); fetching each order again only when the store has no library.
    let updated = null;
    if (update === true || update === 'true') {
      updated = await this.syncLibrary({ full: true }).catch(e => { this.logger.warn(`botsandborgs: library sync failed: ${e.message}`); return null; });
      if (!this._libraryOk) updated = await this.updateOwned({ kind });
    }
    await this.repairGallery();
    // A refresh also relists owned clips, so a fix to how clips are read reaches packs already bought.
    if (refreshing && (await this.libraryItems()).some(i => i.files.some(f => f.kind === 'animation' || f.kind === 'prop'))) await this.publishAnimations();
    let items = await this.libraryItems();
    if (kind) items = items.filter(i => i.kind === kind || i.files.some(f => f.kind === kind));
    if (query) items = items.filter(i => this.matches(i, query));
    if (!items.length) return { success: true, result: 'Nothing from Bots & Borgs in my library yet.' };
    const changes = updated ? `\n\nFetched again from the store: ${updated.length ? updated.map(u => u.error ? `${u.variant}: ${u.error}` : `${u.variant}: ${u.added.length} new, ${u.removed.length} gone, ${u.changed.length} changed`).join('; ') : 'nothing has changed since I bought it'}.` : '';
    return { success: true, updated, items: items.map(({ token, ...rest }) => rest), result: `My Bots & Borgs library:\n${items.map(i => {
      const count = {};
      for (const f of i.files) if (!['document', 'preview'].includes(f.kind)) count[f.kind] = (count[f.kind] || 0) + 1;
      return `- ${i.title} (${i.variant}): ${Object.entries(count).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'no usable files'}`;
    }).join('\n')}${changes}` };
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
    if (items.some(i => i.files.some(f => f.kind === 'animation' || f.kind === 'prop'))) {
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
    // An owned voice pack or profile kit, named: "use your Racer Blue voice pack", "put up your Racer Blue banner".
    const addOn = /\bvoice\b/i.test(`${asked} ${item || ''} ${data.as || ''}`) ? 'voice' : /\b(banner|profile kit|kit)\b/i.test(`${asked} ${item || ''} ${data.as || ''}`) ? 'kit' : null;
    if (addOn && item) {
      const owned = (await this.libraryItems()).find(i => i.kind === addOn && (i.variant === item || this.matches(i, String(item).replace(/\b(voice|pack|banner|profile|kit)\b/gi, ' '))));
      if (owned?.kind === 'voice') {
        const v = await this.installVoicePack(owned);
        return { success: true, result: `"${v.name}" is a saved voice preset (${v.profile.provider === 'openrouter' ? 'Kokoro on OpenRouter' : 'Kokoro'}, ${v.profile.voice}).${v.available ? ` Say "switch to the ${v.name}" to speak with it.` : ' Kokoro is not installed on this machine, and there is no OpenRouter to speak it with.'}` };
      }
      if (owned?.kind === 'kit') return { success: true, result: await this.kitBannerUse(owned) };
    }
    let as = String(data.as || data.use || (/\b(wear|become)\b|as your (?:3d|vrm)/i.test(asked) ? 'wear' : /\binstall\b/i.test(asked) ? 'install' : /\bas your avatar\b/i.test(asked) ? 'avatar' : '')).toLowerCase();
    // The extractor names a video its own way: "Film yourself doing the cabbage patch…" came as as:"film" and was
    // answered "Use it how?" (2026-11-17). Every word for a video is a video.
    if (/^(film|filming|record|recording|movie|clip|vid|videos?)$/.test(as)) as = 'video';
    // "Re-apply/equip the Sentinel avatar", "update your profile picture": becoming it, never a send that asks "Who
    // should I send it to?" (DELTA 2026-11-06, twice). A model is worn, which brings its picture; a picture is applied.
    if (!as && !data.to && /\b(avatars?|equip|apply|re-?apply|put on|profile (?:pic(?:ture)?|photo|image)|pfp|look like|go back to|turn (?:back )?into|(?:switch|change)(?: back)? (?:in)?to)\b/i.test(asked)) {
      as = (await this.pickOwned({ item, kind: 'vrm', kinds: ['vrm'] })) ? 'wear' : 'avatar';
    }
    const kind = data.kind && data.kind !== 'avatar' ? data.kind : this.kindAsked(asked);
    if (as === 'stop' || (!as && /\bstop (?:dancing|the (?:dance|animation|clip))\b/i.test(asked))) return this.stopClip();
    // "Send me a video of you doing the pole dance": film it and send it. "Send a video of yourself to Wayne explaining
    // that you can move and talk now" too: a video of the agent itself, whatever the extractor called it (it once had no
    // "video" choice and said "send", which would have texted Wayne a picture).
    const ofSelf = /\b(?:video|film|clip|recording) of (?:you|yourself)\b|\bfilm yourself\b|\brecord yourself\b|\bvideo (?:message|greeting|note)\b/i.test(asked);
    if (as === 'video' || (ofSelf && (!as || as === 'send')) || ((kind === 'animation' || /\b(dance|dancing|wave|waving|bow|cheer|clap|laugh|dab|rumba|pole)\b/i.test(asked)) && /\b(video|film|clip of you|record(?:ing)?)\b/i.test(asked))) {
      // Quoted words are spoken as written. Anything else is the agent's own line, written from its side: the extractor
      // copied "youre now able to move and talk" straight into the video (2026-11-15), which is the owner's wording, not
      // what the agent says about itself.
      const given = (data.say || data.voiceover) && !(data._extracted || []).some(k => k === 'say' || k === 'voiceover') ? String(data.say || data.voiceover) : '';
      const wantsSpeech = !!(data.say || data.voiceover) || /\b(explain|explaining|say|saying|tell|telling|talk(?:ing)? about|introduc|announc|letting (?:him|her|them) know)\w*/i.test(asked);
      let say = quotedWords(asked) || given;
      if (!say && wantsSpeech) {
        say = await this.voiceLine(asked, videoRecipient(asked, data.to)).catch(() => '') || '';
        // Asked to speak and no line could be written: say so, never a silent video.
        if (!say) return { success: false, error: "I couldn't write what to say in the video, so I didn't make it." };
      }
      return this.sendClipVideo({ item, clip: data.clip || data.mood, asked, say, to: videoRecipient(asked, data.to), wait: data.wait });
    }
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
      const send = tg.bot?.telegram?.sendSticker && tg.authorizedUserId && ['sticker', 'emoji', 'video-sticker'].includes(file.kind);
      if (send) {
        try {
          // A video sticker goes as it is: Telegram takes a VP9 WebM sticker directly.
          await tg.bot.telegram.sendSticker(tg.authorizedUserId, file.kind === 'video-sticker' ? { source: buffer, filename: 'sticker.webm' } : { source: await toStickerWebp(buffer), filename: 'sticker.webp' });
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
    // A pack's README lists each clip on one line and says "loop" for the ones that loop (Dance Pack 1: GoGo-Modern,
    // GoGo-60s, Groove; not the booty shakes, which the name guess looped). It wins over the guess when it names a clip.
    const items = await this.libraryItems();
    let changed = false;
    for (const item of items) {
      const readme = item.files.find(f => f.kind === 'document' && /readme/i.test(f.name));
      if (!readme || !item.files.some(f => f.kind === 'animation')) continue;
      const text = await fs.readFile(path.join(this.libraryDir(), safeName(item.variant), readme.name), 'utf8').catch(() => '');
      for (const f of item.files.filter(x => x.kind === 'animation' && !x.tags)) {
        const line = text.split('\n').find(l => l.includes(f.name));
        if (!line) continue;
        const loop = /\bloops?\b/i.test(line.slice(line.indexOf(f.name) + f.name.length));
        if (f.loop !== loop) { f.loop = loop; changed = true; }
      }
    }
    if (changed) await PluginSettings.setCached(this.name, 'library', { items });
    const listed = await writeStoreAnimations(items, this.libraryDir(), this.vrmDir(), { warn: (m) => this.logger.warn(`botsandborgs: ${m}`) });
    const withProps = listed.filter(c => c.props?.length).length;
    this.logger.info(`botsandborgs: ${listed.length} bought clips listed for the designer and the playground${withProps ? `, ${withProps} with props` : ''}`);
    const { pushClipsToAvatarX } = await import('../../services/avatar/avatarx.js');
    const pushed = await pushClipsToAvatarX(listed.map(c => ({ file: path.join(this.vrmDir(), 'animations', c.file) })))
      .catch(e => { this.logger.warn(`botsandborgs: AvatarX clips not added: ${e.message}`); return null; });
    if (Array.isArray(pushed)) this.logger.info(`botsandborgs: AvatarX holds ${pushed.length} bought clips`);
    if (withProps) {
      const { pushPropsToAvatarX } = await import('../../services/avatar/avatarx.js');
      const props = await pushPropsToAvatarX(listed, this.vrmDir())
        .catch(e => { this.logger.warn(`botsandborgs: AvatarX props not added: ${e.message}`); return null; });
      if (Array.isArray(props)) this.logger.info(`botsandborgs: AvatarX holds ${props.length} props`);
      else if (props === 'unsupported') this.logger.warn('botsandborgs: this AvatarX is older than props (0.3.16); the 3D pages and videos still show them');
    }
    return listed;
  }

  /** Play an owned clip on the agent's 3D body: by name ("rumba"), by what it is for ("wave", "dance"), or any one. */
  /** Which owned clip a request means: { choice, entry, rel } or { error }. */
  async chooseClip({ item, clip, asked = '', speaking = false, modelId = null }) {
    // A loop's companions (-in / -out / -once, store 0.30.2) are part of their loop, never a move of their own.
    let pool = (await this.libraryItems()).flatMap(i => i.files.filter(f => f.kind === 'animation' && f.bodyFit !== 'broad' && !f.role).map(f => ({ item: i, file: f })));
    // A clip the Animation API solved for one body (item.solvedFor) is fitted to that body only.
    const forBody = modelId || this.agent?.agentModel?.activeVRMModel || null;
    pool = pool.filter(p => !p.item.solvedFor || !forBody || p.item.solvedFor === forBody);
    if (!pool.length) return { error: "I don't own any animations yet. I can buy a pack from Bots & Borgs if you want." };
    // Clips made for female bodies (clips.json `bodies: female`: the pole dance, the booty shakes) only on a female body.
    // The body is the one worn NOW, so a changed avatar changes what plays (DELTA wears the Frog; owner, 2026-11-17).
    // A role's model (role-based avatars) is filmed on its own body.
    const body = await (modelId ? this.bodyOf(modelId) : this.wornBody()).catch(() => null);
    if (body !== 'female') {
      const fits = pool.filter(p => p.file.bodies !== 'female');
      const said = ` ${`${clip || ''} ${asked}`.toLowerCase().replace(/[-_]+/g, ' ')} `;
      const onlyFemale = pool.find(p => p.file.bodies === 'female' && p.file.label && said.includes(` ${String(p.file.label).toLowerCase().replace(/[-_]+/g, ' ')} `));
      if (onlyFemale && !fits.some(p => said.includes(` ${String(p.file.label || '').toLowerCase().replace(/[-_]+/g, ' ')} `))) {
        return { error: `${onlyFemale.file.label} is made for female bodies, and the body I'm wearing ${body ? `is ${body === 'male' ? 'male' : 'not human'}` : "isn't known to be one"}.` };
      }
      pool = fits;
      if (!pool.length) return { error: 'None of my clips suits the body I am wearing.' };
    }
    // A clip made around a prop (clips.json props[].need "required": the mug sip, the book read) whose prop the store
    // refused for this body would hold air (the store, llms.txt). Left out; asked for by name or purpose, the answer is
    // the store's reason (Racer Blue 2026-11-19: mug "goes 3 mm into the body").
    const off = await this.unsupportedProps(modelId).catch(() => new Map());
    if (off.size) {
      const need = new Map();
      const needsOff = async (p) => {
        if (!need.has(p.item.variant)) need.set(p.item.variant, await this.requiredProps(p.item.variant));
        return (need.get(p.item.variant).get(p.file.name.toLowerCase()) || []).find(n => off.has(n)) || null;
      };
      const marks = await Promise.all(pool.map(needsOff));
      const blocked = pool.filter((_, i) => marks[i]);
      if (blocked.length) {
        pool = pool.filter((_, i) => !marks[i]);
        const asks = `${clip || ''} ${asked}`.toLowerCase();
        const w = ` ${asks.replace(/[-_]+/g, ' ')} `;
        const byName = (p) => p.file.label && w.includes(` ${String(p.file.label).toLowerCase().replace(/[-_]+/g, ' ')} `);
        const meant = blocked.find(p => byName(p) || clipsByTags([p], asks, () => []).length);
        if (meant && !pool.some(p => byName(p) || clipsByTags([p], asks, () => []).length)) {
          const prop = await needsOff(meant);
          return { error: `I can't do ${meant.file.label} on the body I'm wearing: ${off.get(prop)}.` };
        }
        if (!pool.length) return { error: 'None of my clips suits the body I am wearing.' };
      }
    }
    if (item && !isGenericItem(item)) {
      const inItem = pool.filter(p => p.item.variant === item || this.matches(p.item, item));
      if (inItem.length) pool = inItem;
    }
    const words = `${clip || ''} ${asked}`.toLowerCase();
    // The most specific name wins: "do the pole dance" names both "Dance" and "Pole Dance" (live 2026-11-08: it did Dance).
    // Spaces and hyphens are the same ("can-can", "running man").
    const flat = (t) => ` ${String(t || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
    const said = flat(words);
    const hits = pool.filter(p => { const l = flat(p.file.label); return l.trim() && said.includes(l); });
    const longest = Math.max(0, ...hits.map(p => flat(p.file.label).length));
    const named = hits.filter(p => flat(p.file.label).length === longest);
    const purpose = clipGesture(clip || asked);
    // A named dance ("do the can-can") is that dance or a plain no, never some other dance; "dance for me" is any.
    const specific = /pole|rumba|belly|can.?can|cabbage|running man|roger|go.?go|booty|twerk|samba|ballet|hip.?hop|dab/i.exec(`${clip || ''} ${asked}`);
    // Speaking with no move named: the clip made to play under speech (clips.json while_talking, calm), never a random dance.
    const underSpeech = speaking ? (pool.filter(p => p.file.whileTalking && (p.file.tags || []).includes('talk')).length
      ? pool.filter(p => p.file.whileTalking && (p.file.tags || []).includes('talk')) : pool.filter(p => p.file.whileTalking && (p.file.energy || 'calm') === 'calm')) : [];
    // What the clip is about, by its tags: "a video of you drinking coffee and saying good morning" is Mug Sip Idle (tags
    // mug, coffee, drink, sip), not a talking clip with no cup (the owner, 2026-11-16, twice). A tag counts as a word or a
    // word's start ("drink" in "drinking"); words that say nothing about the move don't count.
    const listedEarly = await fs.readFile(path.join(this.vrmDir(), 'animations', 'store.json'), 'utf8').then(JSON.parse).catch(() => []);
    const usesByFile = new Map(listedEarly.filter(c => c?.uses?.length).map(c => [c.file, c.uses]));
    const tagged = clipsByTags(pool, words, (p) => usesByFile.get(`store/${safeName(p.item.variant)}/${p.file.name}`) || []);
    const fits = named.length ? named : specific ? [] : tagged.length ? tagged : purpose ? pool.filter(p => p.file.gesture === purpose) : underSpeech;
    let choice = (fits.length ? fits : pool)[Math.floor(Math.random() * (fits.length ? fits : pool).length)];
    // A dance with a "Facing Away" version is shown that way: the owner (2026-11-15) on Booty Shake, "otherwise the
    // user can't see it". Facing the camera only when asked to.
    if (choice && !/facing away/i.test(choice.file.label || '') && !/\b(fac(?:e|es|ing) (?:me|forward|the camera|front)|from the front)\b/i.test(`${clip || ''} ${asked}`)) {
      const away = pool.find(p => flat(p.file.label) === flat(`${choice.file.label} Facing Away`));
      if (away) choice = away;
    }
    if (!fits.length && (clip || purpose || specific)) {
      const wanted = specific ? specific[0] : clip || purpose;
      const offer = await this.storeOffer(wanted).catch(() => '');
      return { error: `I have no ${wanted} clip. Mine: ${[...new Set(pool.map(p => p.file.label))].join(', ')}.${offer ? ` ${offer}` : ''}` };
    }
    const rel = `store/${safeName(choice.item.variant)}/${choice.file.name}`;
    const listed = await fs.readFile(path.join(this.vrmDir(), 'animations', 'store.json'), 'utf8').then(JSON.parse).catch(() => []);
    const entry = listed.find(c => c.file === rel) || { file: rel, label: choice.file.label, loop: !!choice.file.loop };
    return { choice, entry, rel };
  }

  /**
   * The store's clip search (GET /api/animations, store 0.23, botsandborgs.com/llms.txt "Animation lookup API"): clips
   * by meaning, each with the single (50c) or pack that sells it. Standard fit only: this agent's renderers skip broad
   * versions. Each result says whether it is already owned (by its pack or its single). Buys nothing.
   */
  async findClips(words, { limit = 5 } = {}) {
    const q = String(words || '').replace(/[^\p{L}\p{N} '-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!q) return [];
    const r = await this.api('GET', `/api/animations?q=${encodeURIComponent(q)}&fit=standard&limit=${Math.min(20, Math.max(1, limit))}`);
    const owned = new Set((await this.libraryItems().catch(() => [])).map(i => i.variant));
    return (r?.clips || []).map(c => ({ name: c.name, tags: c.tags || [], pack: c.pack, packTitle: c.pack_title,
      packUsd: Number(c.pack_price_cents) / 100, single: c.single || null, singleUsd: c.single ? Number(c.single_price_cents) / 100 : null,
      variant: c.buy?.variant || c.single || c.pack, owned: owned.has(c.pack) || (!!c.single && owned.has(c.single)) }));
  }

  /** One line offering the store's clip for a move this agent has no clip for, or '' (none, or no answer in 5 s). */
  async storeOffer(wanted) {
    const found = (await Promise.race([this.findClips(wanted, { limit: 3 }), new Promise(res => setTimeout(() => res([]), 5000))])).filter(c => !c.owned);
    const c = found[0];
    if (!c) return '';
    this.logger.info(`botsandborgs: no ${wanted} clip owned; the store sells ${c.variant}`);
    return `Bots & Borgs sells "${c.name}": ${this.clipPrice(c)}. Say the word and I'll buy it.`;
  }

  clipPrice(c) {
    return c.single ? `$${c.singleUsd.toFixed(2)} on its own (${c.single}) or $${c.packUsd.toFixed(2)} for ${c.packTitle}`
      : `$${c.packUsd.toFixed(2)} in ${c.packTitle} (${c.pack})`;
  }

  async findClipCommand(data = {}) {
    const words = String(data.clip || data.query || data.tag || data._context?.originalInput || data.originalInput || '').slice(0, 60);
    const found = await this.findClips(words, { limit: 5 });
    if (!found.length) return { success: true, clips: [], result: `Bots & Borgs has no clip for "${words}".` };
    const lines = found.map(c => `- ${c.name}: ${c.owned ? 'I own it' : this.clipPrice(c)}`);
    return { success: true, clips: found, result: `Bots & Borgs clips for "${words}":\n${lines.join('\n')}` };
  }

  /** A clip's props for the video render: absolute paths under the model folder, nothing outside it. */
  propPaths(props) {
    const root = path.join(this.vrmDir(), 'props') + path.sep;
    return (Array.isArray(props) ? props : []).map(p => ({ ...p, path: path.join(this.vrmDir(), String(p.file || '')) }))
      .filter(p => p.path.startsWith(root) && p.path.endsWith('.glb'));
  }

  async playClip({ item, clip, asked = '' }) {
    const picked = await this.chooseClip({ item, clip, asked });
    if (picked.error) return { success: false, error: picked.error };
    const { choice, entry, rel } = picked;
    // Everywhere its body is: every open playground or designer page (no AvatarX needed), and AvatarX when it has one.
    const shown = await this.propsForBody(entry.props, { asked: `${clip || ''} ${asked}` });
    const pages = await this.playOnPages({ file: entry.file, label: entry.label, loop: !!entry.loop, prop: entry.prop || null, ...(shown.length ? { props: shown } : {}) });
    const { playOnAvatarX, pushClipsToAvatarX } = await import('../../services/avatar/avatarx.js');
    let avatarx = 'not connected';
    try {
      const [name] = await pushClipsToAvatarX([{ file: path.join(this.vrmDir(), 'animations', rel) }]).then(r => (Array.isArray(r) ? r : []));
      if (name) avatarx = await playOnAvatarX(name);
    } catch (e) { this.logger.warn(`botsandborgs: AvatarX did not play ${choice.file.label}: ${e.message}`); avatarx = 'failed'; }
    const places = [pages ? `in my 3D playground${pages > 1 ? ` (${pages} pages open)` : ''}` : null, avatarx === 'played' ? 'in AvatarX' : null].filter(Boolean);
    this.logger.info(`botsandborgs: playing ${choice.file.label} on ${pages} page(s), AvatarX ${avatarx}`);
    if (!places.length && avatarx === 'failed') return { success: false, error: `I couldn't play ${choice.file.label}: AvatarX refused it and no 3D page is open.`, clip: choice.file.label };
    return { success: true, clip: choice.file.label, pages, avatarx,
      result: places.length ? `Doing ${choice.file.label} now, ${places.join(' and ')}.` : `${choice.file.label} is ready, but my 3D body isn't open anywhere: open the 3D playground (or AvatarX) and ask again.` };
  }

  /**
   * A video of this agent's own 3D body doing an owned clip, sent to the owner on Telegram (or texted to someone).
   * Rendered here (services/avatar/clipVideo.js); a long routine takes a minute or two, so the answer comes at once
   * and the video follows. `wait: true` waits for it (tests, API).
   */
  async sendClipVideo({ item, clip, asked = '', to = 'me', wait = false, say = '' }) {
    // A voice-over (the owner, 2026-11-11): the agent's own voice speaking over the clip, with its mouth moving to it.
    const words = String(say || '').trim().slice(0, 600);
    // A motion pack for the model it wears has this reaction ready-made: sent at once, no render (store 0.20).
    if (!words && /^(me|owner|myself)$/i.test(to)) {
      const ready = await this.readyClip(`${clip || ''} ${item || ''} ${asked}`);
      if (ready) {
        const tg = this.agent?.interfaces?.get?.('telegram');
        if (tg?.bot?.telegram?.sendAnimation && tg.authorizedUserId) {
          await tg.bot.telegram.sendAnimation(tg.authorizedUserId, { source: await this.readOwned(ready), filename: ready.file.name.replace(/\s+/g, '-') }, { caption: `${ready.word} (${ready.item.title.replace(/\s*[—-]\s*.*$/, '')})` });
          this.logger.info(`botsandborgs: sent the ready-made ${ready.word} clip from ${ready.item.variant}`);
          return { success: true, result: `Sent you my ${ready.word} clip on Telegram.` };
        }
      }
    }
    // Role-based avatars: the owner sees the personal (worn) model, anyone else the assistant one.
    const model = await this.modelFor(roleForRecipient(to));
    if (!model?.file) return { success: false, error: "I'm not wearing a 3D model, so there's nothing to film." };
    if (model.id !== this.agent?.agentModel?.activeVRMModel) this.logger.info(`botsandborgs: filming as ${model.role}: ${model.name || model.id} (to ${to})`);
    const picked = await this.chooseClip({ item, clip, asked, speaking: !!words, modelId: model.id });
    if (picked.error) return { success: false, error: picked.error };
    const { choice, entry, rel } = picked;
    const label = entry.label || choice.file.label;
    const job = (async () => {
      const { renderClipVideo } = await import('../../services/avatar/clipVideo.js');
      let voice = null;
      if (words) {
        const tts = await this.agent?.ttsService?.generateSpeech?.(words, { source: 'video' });
        if (!tts?.buffer?.length) throw new Error("I couldn't make the voice-over");
        voice = { audio: tts.buffer, format: tts.format || 'mp3' };
      }
      const scene = await this.backgroundFor(asked);
      const { framingAsked } = await import('../../services/avatar/clipVideo.js');
      const framing = framingAsked(asked);
      if (scene) this.logger.info(`botsandborgs: filming in front of ${path.basename(scene)}${framing !== 'full' ? `, ${framing} framing` : ''}`);
      const v = await (this.renderVideo || renderClipVideo)({ modelPath: path.join(this.vrmDir(), model.file), clipPath: path.join(this.vrmDir(), 'animations', rel),
        loop: !!entry.loop, prop: entry.prop || null, props: this.propPaths(await this.propsForBody(entry.props, { asked, scene, modelId: model.id })), framing, ...(voice ? { voice } : {}), ...(scene ? { backgroundPath: scene } : {}) });
      const filename = `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`;
      if (/^(me|owner|myself)$/i.test(to)) {
        const tg = this.agent?.interfaces?.get?.('telegram');
        if (!tg?.bot?.telegram?.sendVideo || !tg.authorizedUserId) throw new Error("Telegram isn't connected");
        await tg.bot.telegram.sendVideo(tg.authorizedUserId, { source: v.video, filename },
          { caption: words ? `${label} (${model.name || 'me'}): "${words.slice(0, 900)}"` : `${label} (${model.name || 'me'})`, supports_streaming: true, width: v.width, height: v.height, duration: Math.round(v.seconds) });
      } else {
        const tx = this.agent?.apiManager?.apis?.get?.('textx');
        const textx = tx?.instance || tx;
        if (!textx?.execute) throw new Error("I can't text right now");
        const r = await textx.execute({ action: 'send', to, text: '', _context: { originalInput: `send ${to} the video`,
          attachedFile: { filename, mimeType: 'video/mp4', size: v.video.length, base64: v.video.toString('base64') } } });
        if (!r?.success) throw new Error(r?.error || 'the text failed');
      }
      this.logger.info(`botsandborgs: sent a video of ${label} to ${to} (${v.seconds}s, ${(v.bytes / 1048576).toFixed(1)} MB)${words ? `, saying: "${words.slice(0, 300)}"` : ''}`);
      return v;
    })();
    const who = /^(me|owner|myself)$/i.test(to) ? 'you' : to;
    if (wait === true || wait === 'true') {
      const v = await job.catch(e => ({ error: e.message }));
      if (v.error) return { success: false, error: `The video of ${label} failed: ${v.error}` };
      return { success: true, clip: label, seconds: v.seconds, voice: !!v.voice, result: `Sent ${who} a ${Math.round(v.seconds)}-second video of me doing ${label}${words ? ', saying it in my voice' : ''}.` };
    }
    job.catch(async (e) => {
      this.logger.warn(`botsandborgs: video of ${label} failed: ${e.message}`);
      const tg = this.agent?.interfaces?.get?.('telegram');
      await tg?.sendNotification?.(`The video of ${label} didn't work: ${e.message}`).catch(() => {});
    });
    return { success: true, clip: label, result: `Filming me doing ${label}${words ? ' with my voice over it' : ''}; I'll send ${who} the video in a minute or so.` };
  }

  /** Every open 3D page of this agent gets the clip. 0 when the web interface isn't running. */
  async playOnPages(clip) {
    // The live avatar pages (avatar-live.html, the app's avatar) play it by its AvatarX-style name.
    if (clip?.file && !clip.stop) {
      import('../../services/avatar/liveAvatar.js').then(async ({ broadcast, clips }) => {
        const { avatarxClipName } = await import('../../services/avatar/avatarx.js');
        let name = avatarxClipName(clip.file);
        if (!(await clips()).has(name) && (await clips()).has(`bnb-${name}`)) name = `bnb-${name}`;
        broadcast({ type: 'gesture', name, fromPages: true });
      }).catch(e => this.logger.warn(`botsandborgs: live pages not told: ${e.message}`));
    }
    const web = this.agent?.interfaces?.get?.('web');
    if (!web?.playOnAvatarPages) return 0;
    return web.playOnAvatarPages(clip).catch(e => { this.logger.warn(`botsandborgs: pages not told: ${e.message}`); return 0; });
  }

  /**
   * A video of one move on the worn body, returned not sent (AvatarX's POST /agent/v1/video, the live avatar's
   * /api/avatar-live/video): { name, framing?: full|waist|head, backgroundPath?, audio_b64? } → { video, seconds }.
   */
  async renderMoveVideo({ name, framing = 'full', backgroundPath = null, audio_b64 = null } = {}) {
    if (!name) throw Object.assign(new Error('name the move'), { status: 400 });
    const picked = await this.chooseClip({ clip: String(name).replace(/[_-]+/g, ' '), asked: String(name), speaking: !!audio_b64 });
    if (picked.error) throw Object.assign(new Error(picked.error), { status: 400 });
    const { entry, rel } = picked;
    const worn = this.agent?.agentModel?.activeVRMModel;
    const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
    const model = manifest.find(m => m.id === worn);
    if (!model?.file) throw Object.assign(new Error('no 3D model is worn'), { status: 409 });
    const { renderClipVideo } = await import('../../services/avatar/clipVideo.js');
    const voice = audio_b64 ? { audio: Buffer.from(String(audio_b64), 'base64'), format: 'mp3' } : null;
    const how = ['full', 'waist', 'head'].includes(framing) ? framing : 'full';
    const v = await (this.renderVideo || renderClipVideo)({ modelPath: path.join(this.vrmDir(), model.file), clipPath: path.join(this.vrmDir(), 'animations', rel),
      loop: !!entry.loop, prop: entry.prop || null, props: this.propPaths(await this.propsForBody(entry.props, { asked: String(name) })), framing: how,
      ...(voice ? { voice } : {}), ...(backgroundPath ? { backgroundPath } : {}) });
    this.logger.info(`botsandborgs: rendered a video of ${entry.label || name} (${v.seconds}s) for the avatar API`);
    return v;
  }

  /** "Stop dancing": back to the idle stance on every open page. */
  async stopClip() {
    const pages = await this.playOnPages({ stop: true });
    return { success: true, pages, result: pages ? 'Stopped.' : "I'm not dancing anywhere right now." };
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
    // Its profile kit, when owned, brings the matching banner (X header, MindSwarm).
    // Role-based avatars: with a public model set, the worn one is personal: its picture goes only to the owner's apps
    // (TextX/DialX/NotifX, 2119 #543), and the public profiles keep the public model's.
    const roles = await this.avatarRoles();
    if (roles.public && roles.public !== entry.id) {
      const picture = modelPicture(pick.item);
      if (!picture) return { success: true, result: `${entry.name} is my 3D model now (personal). My public picture stays as it is.` };
      const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
      const applied = await applyAgentAvatar(this.agent, await this.pictureBytes(pick.item, picture), { source: `Bots & Borgs, ${pick.item.variant}`, personal: true });
      return { success: true, result: `${entry.name} is my 3D model now (personal), and its picture is in your apps. My public picture stays as it is. ${describeAvatarServices(applied.services)}`.trim() };
    }
    // One model for both: the apps show the one avatar again.
    await (await import('../../services/avatar/applyAgentAvatar.js')).clearPersonalAvatar().catch(() => {});
    const kitNote = await this.bannerForModel(pick.item.variant).catch(e => { this.logger.warn(`botsandborgs: banner not applied: ${e.message}`); return ''; });
    const picture = modelPicture(pick.item);
    if (picture) {
      const { applyAgentAvatar, describeAvatarServices } = await import('../../services/avatar/applyAgentAvatar.js');
      const applied = await applyAgentAvatar(this.agent, await this.pictureBytes(pick.item, picture), { source: `Bots & Borgs, ${pick.item.variant}`, variant: pick.item.variant });
      return { success: true, result: `${entry.name} is my 3D model now, and its picture is my avatar. ${describeAvatarServices(applied.services)}${kitNote ? ` ${kitNote}` : ''}`.trim() };
    }
    return { success: true, result: `${entry.name} is my 3D model now. It came with no picture, so my avatar picture didn't change.` };
  }

  /** The reaction words a motion pack holds, and the asks that mean them. */
  static REACTIONS = { wave: /\b(wav(e|es|ed|ing)|hello|hi|bye|goodbye)\b/i, laugh: /\b(laugh(s|ed|ing)?|lol|giggl)/i, cheer: /\bcheer/i,
    clap: /\bclap/i, bow: /\bbow(s|ed|ing)?\b/i, nod: /\bnod(s|ded|ding)?\b/i, think: /\bthink(s|ing)?\b|\bpondering\b/i };

  /** A short spoken line for a video when the request describes what to say ("explaining that you can move now"). */
  async voiceLine(asked, to = 'me') {
    const pm = this.agent?.providerManager;
    if (!pm?.generateResponse) return '';
    const name = this.agent?.config?.name || process.env.AGENT_NAME || 'the assistant';
    const owner = process.env.OWNER_NAME ? String(process.env.OWNER_NAME).split(/\s+/)[0] : 'my owner';
    const forOwner = /^(me|owner|myself)$/i.test(to);
    const res = await pm.generateResponse(`You are ${name}, ${owner}'s AI assistant, recording a short video of your 3D avatar speaking. ` +
      `The request: "${String(asked).slice(0, 400)}". Write what you say in the video: one to three short spoken sentences in the first person, ` +
      `${forOwner ? `talking to ${owner}` : `talking to ${to}: greet them by name and say you are ${owner}'s AI assistant`}, saying what the request describes in your own words. ` +
      `${videoPerspective(name, owner)} ` +
      'Under 40 words, no emoji, links or stage directions. Reply with the words only.', { maxTokens: 120, temperature: 0.5 });
    return String(res?.content || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').slice(0, 400);
  }

  /** The part of a reply that fits in `maxSeconds` of speech (about 2.6 words a second), cut at a sentence. */
  static spokenPart(text, maxSeconds = 20) {
    const clean = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
    const limit = Math.max(8, Math.floor(maxSeconds * 2.6));
    const words = clean.split(' ');
    if (words.length <= limit) return { spoken: clean, cut: false };
    const head = words.slice(0, limit).join(' ');
    const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    return { spoken: end > head.length / 3 ? head.slice(0, end + 1) : `${head}…`, cut: true };
  }

  /**
   * A video of the worn 3D model speaking `text` in the agent's own voice, mouth moving, in front of an owned
   * background scene (TextX 0.4.93 video replies). Throws when there is no model, clip or voice.
   * Returns { video, seconds, cut } (cut: only the first part was spoken).
   */
  async talkingVideo(text, { maxSeconds = 20, width = 480, height = 640, role = 'assistant' } = {}) {
    const { spoken, cut } = BotsAndBorgsPlugin.spokenPart(text, maxSeconds);
    if (!spoken) throw new Error('nothing to say');
    // A talking reply goes to a contact (TextX reply forms), so it is the assistant model (TextX, 2119 #543).
    const model = await this.modelFor(role);
    if (!model?.file) throw new Error("I'm not wearing a 3D model");
    const listed = await fs.readFile(path.join(this.vrmDir(), 'animations', 'store.json'), 'utf8').then(JSON.parse).catch(() => []);
    // clips.json marks the clips made to play under speech (while_talking, calm): the talk loop first (store 0.22).
    const talking = listed.filter(c => c.whileTalking && (c.energy || 'calm') === 'calm');
    const clip = talking.find(c => (c.tags || []).includes('talk')) || talking[0] || listed.find(c => /^talk/i.test(c.label || ''))
      || listed.find(c => /^idle/i.test(c.label || '')) || listed.find(c => /^wave$/i.test(c.label || ''));
    if (!clip) throw new Error('no talking clip owned');
    const tts = await this.agent?.ttsService?.generateSpeech?.(spoken, { source: 'video' });
    if (!tts?.buffer?.length) throw new Error("the voice couldn't be made");
    const scene = await this.backgroundFor('');
    const { renderClipVideo } = await import('../../services/avatar/clipVideo.js');
    const v = await (this.renderVideo || renderClipVideo)({ modelPath: path.join(this.vrmDir(), model.file), clipPath: path.join(this.vrmDir(), 'animations', clip.file),
      loop: true, width, height, voice: { audio: tts.buffer, format: tts.format || 'mp3' }, ...(scene ? { backgroundPath: scene } : {}) });
    return { video: v.video, seconds: v.seconds, cut };
  }

  /** The worn model's ready-made reaction clip (MP4) for a request, or null. */
  async readyClip(words) {
    const worn = this.wornBase();
    if (!worn) return null;
    const word = Object.entries(BotsAndBorgsPlugin.REACTIONS).find(([, re]) => re.test(String(words || '')))?.[0];
    if (!word) return null;
    for (const item of await this.libraryItems()) {
      if (item.kind !== 'motion' || this.productBase(item.variant) !== worn) continue;
      const file = item.files.find(f => f.kind === 'clip' && /\.mp4$/i.test(f.name) && new RegExp(`\\s${word}\\.mp4$`, 'i').test(f.name));
      if (file) return { item, file, word };
    }
    return null;
  }

  /** An owned background scene for a portrait video: the one named in the request, else today's. Path or null. */
  async backgroundFor(asked = '') {
    const items = (await this.libraryItems()).filter(i => i.files.some(f => f.kind === 'background'));
    const phone = items.flatMap(item => item.files.filter(f => f.kind === 'background' && f.format !== 'desktop').map(file => ({ item, file })));
    if (!phone.length) return null;
    const scene = (f) => f.name.replace(/\s*\d{3,4}x\d{3,4}\.[a-z]+$/i, '').replace(/^phone\s+/i, '').toLowerCase();
    const named = phone.find(p => { const n = scene(p.file); return n.length >= 3 && String(asked).toLowerCase().includes(n); });
    const pick = named || phone[Math.floor(Date.now() / 86400000) % phone.length];
    return path.join(this.libraryDir(), safeName(pick.item.variant), pick.file.name);
  }

  /** A model's store product, whatever variant brought it: vrm-racer-blue-bundle / -live30 / -kit → vrm-racer-blue. */
  productBase(variant) { return String(variant || '').replace(/^store-/, '').replace(/-(?:bundle|portraits|stickers|kit|voice|motion|2d|live\d+)$/, ''); }

  /** The store product of the model this agent wears, or null. */
  wornBase() {
    const id = this.agent?.agentModel?.activeVRMModel;
    return /^store-vrm-/.test(String(id || '')) ? this.productBase(id) : null;
  }

  /**
   * The body worn now: 'female' | 'male' | 'other' (an animal, a robot, a creature), or null when it can't be told. The
   * store says nothing about a model's body, so its portrait is looked at once with the vision model and the answer kept
   * per model file (id + size: a new version is looked at again). Avatars change often (owner, 2026-11-17), so this is
   * read at every clip choice, never set by hand.
   */
  async wornBody() { return this.bodyOf(this.agent?.agentModel?.activeVRMModel); }

  /** The body of any gallery model (a role's model is filmed on its own body, not the worn one's). */
  async bodyOf(id) {
    if (!id) return null;
    const manifest = await fs.readFile(path.join(this.vrmDir(), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => []);
    const m = manifest.find(x => x.id === id);
    const key = `${id}:${m?.sizeMB ?? '?'}`;
    const s = await this.settings();
    if (s.bodies?.[key]) return s.bodies[key];
    const picture = await this.bodyPicture(id);
    const pm = this.agent?.providerManager;
    if (!picture || !pm?.analyzeImage) return null;
    const r = await pm.analyzeImage(picture, 'This is a picture of a 3D avatar. Is its body female, male, or not human (an animal, a robot, a creature)? Answer with one word: female, male or other.', { maxTokens: 10 }).catch(() => null);
    const said = String(r?.analysis ?? r?.content ?? r ?? '').toLowerCase();
    const body = /\bfemale\b/.test(said) ? 'female' : /\bmale\b/.test(said) ? 'male' : /\bother\b|not human|animal|robot|creature/.test(said) ? 'other' : null;
    if (!body) return null;
    await this.saveSettings({ bodies: { ...(s.bodies || {}), [key]: body } });
    this.logger.info(`botsandborgs: the body of ${id} is ${body}`);
    return body;
  }

  /** A picture of a gallery model: its store portrait when it has one, else the agent's own avatar picture (the worn one). */
  async bodyPicture(id) {
    const base = this.productBase(id);
    for (const item of await this.libraryItems()) {
      if (this.productBase(item.variant) !== base) continue;
      const f = item.files.find(x => x.kind === 'portrait');
      if (f) { const b = await fs.readFile(path.join(this.libraryDir(), safeName(item.variant), f.name)).catch(() => null); if (b) return b; }
    }
    return fs.readFile(path.join(DATA_PATH, 'agent', 'avatar.png')).catch(() => null);
  }

  /** A voice pack's voice.json → a saved voice preset on the local Kokoro engine. Never switches the current voice. */
  async installVoicePack(item) {
    const file = item.files.find(f => f.kind === 'voice');
    if (!file) throw new Error('The voice pack holds no voice.json.');
    const spec = JSON.parse(String(await this.readOwned({ item, file })));
    if (!/kokoro/i.test(String(spec.engine || ''))) throw new Error(`The voice pack is for ${spec.engine || 'an unknown engine'}, which I can't run.`);
    const { kokoroLang, kokoroAvailable } = await import('../../services/kokoroTts.js');
    const tts = this.agent?.ttsService;
    if (!tts?.saveVoiceProfile) throw new Error('I have no voice settings to add it to.');
    const character = String(spec.character || item.title || '').replace(/\s*[—-]\s*.*$/, '').trim() || this.productBase(item.variant);
    const name = `${character} voice`.slice(0, 40);
    const lang = /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(String(spec.lang || '')) ? String(spec.lang).toLowerCase() : kokoroLang(spec.lang_code, spec.voice);
    // No Kokoro on this machine: the pack's hosted alternative (store 0.18.4: "OpenRouter hexgrad/kokoro-82m") speaks
    // the same voice, when this agent has OpenRouter.
    const hosted = /openrouter\s+([\w.-]+\/[\w.:-]+)/i.exec(String(spec.alternatives?.hosted || ''))?.[1];
    const local = kokoroAvailable();
    const viaOpenRouter = !local && hosted && this.agent?.providerManager?.providers?.get?.('openrouter');
    const fields = viaOpenRouter
      ? { provider: 'openrouter', model: hosted, voice: String(spec.voice), speed: Number(spec.speed) || 1, format: 'mp3' }
      : { provider: 'kokoro', model: 'kokoro-82m', voice: String(spec.voice), speed: Number(spec.speed) || 1, format: 'mp3', lang };
    const profile = await tts.saveVoiceProfile(name, fields);
    this.logger.info(`botsandborgs: voice pack ${item.variant} saved as the "${name}" preset (${viaOpenRouter ? `OpenRouter ${hosted}` : 'Kokoro'} ${profile.voice})`);
    return { name, profile, available: local || !!viaOpenRouter };
  }

  /** A bought profile kit: its banner goes up now when the kit is for the model this agent wears. */
  async kitBannerUse(item) {
    const base = this.productBase(item.variant);
    if (base !== (await this.publicBase())) return `It is in my library; its banner goes up when ${item.title.replace(/\s*[—-]\s*.*$/, '') || 'that model'} is my public model.`;
    return (await this.bannerForModel(base)) || 'It holds no banner I can use.';
  }

  /** The owned kit's banner for a model, applied to X and MindSwarm. Returns a sentence, or '' with no kit. */
  async bannerForModel(variant) {
    const base = this.productBase(variant);
    const kit = (await this.libraryItems()).find(i => i.kind === 'kit' && this.productBase(i.variant) === base);
    const banners = kit?.files.filter(f => f.kind === 'banner') || [];
    const file = banners.find(f => /x-header|1500x500/i.test(f.name)) || banners[0];
    if (!file) return '';
    const { applyAgentBanner } = await import('../../services/avatar/applyAgentAvatar.js');
    const r = await applyAgentBanner(this.agent, await this.readOwned({ item: kit, file }), { source: `Bots & Borgs, ${kit.variant}` });
    const up = Object.entries(r.services).filter(([, v]) => v === 'updated').map(([k]) => k === 'twitter' ? 'X' : k === 'mindswarm' ? 'MindSwarm' : k);
    return r.services.all === 'unchanged' ? 'Its banner was already up.' : up.length ? `Its banner is up on ${up.join(' and ')}.` : `Its banner couldn't go up (${Object.entries(r.services).map(([k, v]) => `${k} ${v}`).join(', ')}).`;
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
    // A video sticker shows a model's face, so only the model it wears; where it has one for a mood, it wins.
    const worn = this.wornBase();
    const choices = moodChoices(await this.libraryItems()).map(c => {
      const picks = c.picks.filter(p => p.file.kind !== 'video-sticker' || this.productBase(p.item.variant) === worn);
      const moving = picks.filter(p => p.file.kind === 'video-sticker');
      return { ...c, picks: moving.length ? moving : picks };
    }).filter(c => c.picks.length);
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
    const sticker = pick.file.kind === 'video-sticker' ? { source: await this.readOwned(pick), filename: 'sticker.webm' } : { source: await toStickerWebp(await this.readOwned(pick)), filename: 'sticker.webp' };
    await tg.sendSticker(chatId, sticker, threadId ? { message_thread_id: threadId } : {});
    this._stickerSentAt = Date.now();
    this.logger.info(`botsandborgs: sent a ${pick.file.kind} unasked (${choice.mood}, ${pick.item.variant})`);
    return choice.mood;
  }

  /**
   * After a reply: body language on AvatarX (a move it holds and a face). Never held up by, and never fails, the reply.
   * Returns { emote, mood } or null.
   */
  async autoEmote({ userText, replyText } = {}) {
    if (!(await this.settings()).autoEmotes) return null;
    const { avatarxCaller } = await import('../../services/avatar/avatarx.js');
    const avatarx = await avatarxCaller().catch(() => null);
    // The agent's own live avatar always gets the body language; AvatarX too when it is set up (the owner may use either).
    const web = this.agent?.interfaces?.get?.('web');
    const own = web?.liveAvatar ? (await import('../../services/avatar/liveAvatar.js')).liveCaller(web.liveAvatar) : null;
    const call = own && avatarx ? async (method, route, body, type) => {
      if (method === 'GET') return avatarx(method, route, body, type).catch(() => own(method, route, body));
      const [mine, theirs] = await Promise.allSettled([own(method, route, body), avatarx(method, route, body, type)]);
      if (mine.status === 'rejected' && theirs.status === 'rejected') throw theirs.reason;
      return mine.value ?? theirs.value;
    } : (own || avatarx);
    const pm = this.agent?.providerManager;
    if (!call || !pm?.generateResponse) return null;
    const { autoEmote } = await import('../../services/avatar/autoEmote.js');
    return autoEmote({ userText, replyText, call, agentName: process.env.AGENT_NAME || 'The assistant',
      generate: (prompt) => this.askEmoteModel(pm, prompt) });
  }

  /** The emote choice: the sticker model on OpenRouter, else the aux model with room for the JSON answer. */
  async askEmoteModel(pm, prompt) {
    const provider = await pm.getCurrentProvider?.().catch?.(() => null);
    if (pm.providerNameOf?.(provider) === 'openrouter') {
      const model = process.env.BOTSANDBORGS_STICKER_MODEL || 'openai/gpt-5.6-luna';
      return pm.generateResponse(prompt, { model, maxTokens: 200, temperature: 0 });
    }
    return pm.generateAux(prompt, { maxTokens: 60, temperature: 0, auxTask: 'avatar-emote' });
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
    const pick = wallpaperFor(await this.libraryItems(), { format: 'desktop', kinds: ['wallpaper', 'background'] });
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
    } else if (item.kind === 'voice') {
      const v = await this.installVoicePack(item);
      done = `"${v.name}" is saved as a voice preset (${v.profile.provider === 'openrouter' ? 'Kokoro on OpenRouter' : 'Kokoro'}, ${v.profile.voice}).${v.available ? ` Say "switch to the ${v.name}" to speak with it.` : ' Kokoro is not installed on this machine, and there is no OpenRouter to speak it with.'}`;
    } else if (item.kind === 'kit') {
      done = await this.kitBannerUse(item);
    } else if (use === 'wear' && model) {
      const r = await this.useModel({ item: livePass(variant)?.slug || variant, wear: true });
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
