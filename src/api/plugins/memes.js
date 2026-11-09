/**
 * Memes: pick a picture, put text where it goes, get the image back.
 *
 * Two stashes (owner, 2026-11-09):
 * - popular templates (Drake, Distracted Boyfriend, ...): for the agent's own owner only, never to a paid caller;
 * - public-domain / CC0 pictures (Openverse): sold through the API gateway, licence attached.
 * A caller's own picture (url or base64) works for both.
 *
 * The agent sends the result as a photo (result.file); a paid caller gets it as base64 with the licence.
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { TEMP_PATH } from '../../utils/paths.js';
import { safeJsonParse } from '../../utils/jsonUtils.js';
import { renderMeme, defaultBoxes, namedBox } from '../../services/memes/render.js';
import { popularTemplates, freeTemplates, freeById, findPopular, boxesFor, templateImage, keptFree, ROLES } from '../../services/memes/templates.js';

const MAX_INPUT = 10 * 1024 * 1024;

/** Unasked memes (owner, 2026-11-09): on by default, at most one an hour; both set under Settings → Memes. */
export const DEFAULTS = { autoMemes: true, autoMemeEveryMinutes: 60 };
const ASK_EVERY_MS = 60 * 1000; // never ask the model more than once a minute

/** Replies a meme would only cheapen: code, long reports, lists. */
export function memeCouldFit(replyText) {
  const r = String(replyText || '').trim();
  return !!r && r.length <= 800 && !r.includes('```') && (r.match(/\n\s*[-*\d]/g) || []).length < 3;
}

/** The texts and where they go, from any of: texts[], top/bottom, boxes[{text, position | x,y,w,h}]. */
export function placements(params, template) {
  if (Array.isArray(params.boxes) && params.boxes.length) {
    return params.boxes.map(b => ({
      text: b.text,
      box: ['x', 'y', 'w', 'h'].every(k => typeof b[k] === 'number') ? { x: b.x, y: b.y, w: b.w, h: b.h } : namedBox(b.position || 'top'),
      align: b.align, color: b.color
    }));
  }
  let texts = Array.isArray(params.texts) ? params.texts : typeof params.texts === 'string' ? params.texts.split('|') : null;
  if (!texts) texts = [params.top ?? params.text, params.bottom].filter(t => t != null);
  texts = texts.map(t => String(t).trim());
  if (!texts.length) return [];
  if (texts.length === 1 && params.position) return [{ text: texts[0], box: namedBox(params.position) }];
  const boxes = boxesFor(template, texts.length) || defaultBoxes(texts.length);
  return texts.map((text, i) => ({ text, box: boxes[i], align: boxes[i].align, style: boxes[i].style, valign: boxes[i].valign }));
}

export default class MemesPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'memes';
    this.version = '1.0.0';
    this.description = 'Make memes: pick a template or picture, place the text, get the image';
    this.category = 'media';
    this.commands = [
      {
        command: 'make',
        description: 'Make a meme: a template (name or id) or your own picture (url/base64), and the text for each box (texts[], or top/bottom, or boxes[{text, position|x,y,w,h}])',
        usage: 'make({ template: "drake", texts: ["top text", "bottom text"] })',
        examples: ['make a drake meme: tests passing / tests actually testing something', 'send me a meme about mondays',
          'make a meme with distracted boyfriend: me, new side project, my unfinished projects', 'meme this: when the deploy works first try'],
        offerAsService: true
      },
      {
        command: 'settings',
        description: 'Read or change the meme settings: autoMemes (send a fitting meme unasked after a reply to the owner), autoMemeEveryMinutes',
        usage: 'settings({ autoMemes: true, autoMemeEveryMinutes: 60 })',
        examples: ['stop sending me memes', 'send memes less often'],
        offerAsService: false
      },
      {
        command: 'templates',
        description: 'List meme templates. Paid callers see the public-domain/CC0 pictures; pass query to search them',
        usage: 'templates({ query: "cat", limit: 10 })',
        examples: ['what meme templates do you have', 'list meme templates'],
        offerAsService: true
      },
      {
        command: 'find',
        description: 'Find public-domain / CC0 pictures to use as a meme, with their licences',
        usage: 'find({ query: "surprised cat", limit: 10 })',
        examples: ['find a public domain picture of a cat for a meme'],
        offerAsService: true
      }
    ];
  }

  async execute(params = {}) {
    const { action, ...data } = params;
    const external = params._caller === 'external';
    try {
      // Plain words reach make() either flagged for extraction or with only the original sentence ("send me a meme
      // about mondays" came with neither a template nor texts, 2026-11-09): either way, read them from the sentence.
      // A request in plain words is read from the sentence by the meme's own extractor, which knows each template's
      // box order: the agent's generic extraction kept the listing order ("me" on the woman in red) or gave texts with
      // no template ("a meme about mondays" -> texts ["mondays"]), 2026-11-09. Explicit API fields are left alone.
      const said = params.originalInput || params.input || params._context?.originalInput || '';
      const own = data.url || data.base64 || data.imageBase64;
      if (said && !own && !external && this.agent?.providerManager && (params.needsParameterExtraction || params.fromAI || action === 'make')) {
        const x = await this.extractParameters(said, action);
        if (action === 'make' && x?.template && Array.isArray(x.texts) && x.texts.length) {
          delete data.top; delete data.bottom; delete data.boxes;
          Object.assign(data, { template: x.template, texts: x.texts });
        } else if (x && typeof x === 'object') {
          for (const [k, v] of Object.entries(x)) if (data[k] == null) data[k] = v;
        }
      }
      switch (action) {
        case 'make': return await this.make(data, external);
        case 'templates': return await this.templates(data, external);
        case 'find': return await this.find(data, external);
        case 'settings':
          if (external) return { success: false, error: 'Unknown action: settings' };
          return await this.settingsCommand(data);
        default: return { success: false, error: `Unknown action: ${action}. Available: make, templates, find` };
      }
    } catch (error) {
      this.logger.error(`memes ${action} failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async extractParameters(input, action) {
    if (action !== 'make') return { query: input };
    const roles = Object.entries(ROLES).map(([id, r]) => `${id}: ${r.map((x, i) => `${i + 1}) ${x}`).join('; ')}`).join('\n');
    const names = (await popularTemplates().catch(() => [])).slice(0, 60).map(t => t.name).join(', ');
    const prompt = `Turn this meme request into JSON: "${input}"
Return {"template": "<a template's plain name, no id or prefix>", "texts": ["box 1", "box 2", ...]}.
- Pick the template the user named; if they named none, pick the well-known template that suits the topic best from: ${names}.
- Texts go in the template's BOX ORDER, not the order the user listed them. Box order for these templates (by imgflip id):
${roles}
  Example: "distracted boyfriend: me, a new side project, my unfinished projects" -> ["a new side project", "me", "my unfinished projects"].
- Use the user's words when given (split on "/", "|" or commas); otherwise write short, funny texts, one per box.
- Other templates: top text then bottom text.`;
    const r = await this.agent.providerManager.generateResponse(prompt, { temperature: 0.6, maxTokens: 300 });
    return safeJsonParse(r?.content, {}) || {};
  }

  async picture(data) {
    if (data.url) {
      const r = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_INPUT, headers: { 'User-Agent': 'LANAgent/1.0 (memes)' } });
      return Buffer.from(r.data);
    }
    const b64 = data.base64 || data.imageBase64 || data.image;
    if (b64) {
      const buf = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (buf.length > MAX_INPUT) throw new Error('The picture is over 10 MB');
      return buf;
    }
    return null;
  }

  /** The template a request names: an id, a popular name (own use only), or a free picture of that subject. */
  async resolveTemplate(name, external) {
    let n = String(name || '').trim();
    if (!n) return null;
    // A model sometimes writes a name with an id prefix ("free:drake", 2026-11-09): a prefix on something that is
    // not an id is just the name.
    const isId = /^pop:\d+$/.test(n) || /^free:(wm-\d+|[0-9a-f-]{36})$/i.test(n);
    if (!isId && /^(pop|free):/i.test(n)) n = n.replace(/^(pop|free):/i, '').trim();
    if (n.startsWith('pop:')) {
      if (external) throw new Error('Popular templates are not offered through the API; use a free: template (see templates) or your own picture');
      return (await popularTemplates()).find(t => t.id === n) || null;
    }
    if (n.startsWith('free:')) {
      const free = await freeById(n);
      if (!free) throw new Error('That picture is not public domain or CC0, or no longer exists');
      return free;
    }
    const pop = await findPopular(n).catch(() => null);
    if (pop && external) throw new Error(`'${pop.name}' is a popular template, not offered through the API; use a free: template (templates or find) or your own picture`);
    if (pop) return pop;
    const free = await freeTemplates(n, { limit: 5 });
    return free[0] || null;
  }

  async make(data, external) {
    const own = await this.picture(data);
    const template = own ? { id: 'own', name: 'your picture', source: 'own', sellable: true } : await this.resolveTemplate(data.template || data.templateId || data.name || data.query, external);
    if (!template) return { success: false, error: `No template or picture matches '${data.template || data.query || ''}'. Try templates, or send a picture.` };
    const texts = placements(data, template);
    if (!texts.length) return { success: false, error: 'Give the text: texts: ["top", "bottom"], or top/bottom, or boxes[{text, position}]' };
    const image = own || await templateImage(template);
    const out = await renderMeme(image, texts, { format: data.format, uppercase: data.uppercase !== false });
    const info = { template: template.id, name: template.name, source: template.source, license: template.license || null, width: out.width, height: out.height, format: out.format };
    this.logger.info(`Meme made: ${template.id} (${template.name}), ${texts.length} text(s), ${(out.buffer.length / 1024).toFixed(0)} KB${external ? ', paid call' : ''}`);

    if (external) {
      return { success: true, data: { ...info, image: `data:image/${out.format};base64,${out.buffer.toString('base64')}`, size: out.buffer.length } };
    }
    const dir = path.join(TEMP_PATH, 'memes');
    await fs.mkdir(dir, { recursive: true });
    const filename = `meme-${Date.now()}.${out.format === 'png' ? 'png' : 'jpg'}`;
    const file = path.join(dir, filename);
    await fs.writeFile(file, out.buffer);
    return { success: true, ...info, file: { path: file, filename }, message: `Here's your ${template.name} meme.` };
  }

  async settings() {
    const saved = await PluginSettings.getCached(this.name, 'settings').catch(() => null);
    return { ...DEFAULTS, ...(saved || {}) };
  }

  async settingsCommand(data = {}) {
    const s = await this.settings();
    let changed = false;
    if (data.autoMemes !== undefined) { s.autoMemes = data.autoMemes === true || data.autoMemes === 'true'; changed = true; }
    if (data.autoMemeEveryMinutes !== undefined) {
      s.autoMemeEveryMinutes = Math.max(10, Math.min(24 * 60, Math.round(Number(data.autoMemeEveryMinutes) || DEFAULTS.autoMemeEveryMinutes)));
      changed = true;
    }
    if (changed) await PluginSettings.setCached(this.name, 'settings', s);
    return { success: true, settings: s,
      message: s.autoMemes ? `Unasked memes are on, at most one every ${s.autoMemeEveryMinutes} minutes.` : 'Unasked memes are off.' };
  }

  /**
   * After a reply in the owner's private chat: a meme, if one would land. Light moments only, like the stickers;
   * never held up by, and never fails, the reply. Returns the template name sent, or null.
   */
  async autoMeme({ userText, replyText, chatId, threadId, stickerSentAt = 0 } = {}) {
    const now = Date.now();
    const s = await this.settings();
    if (!s.autoMemes || !chatId || !memeCouldFit(replyText)) return null;
    if (now - (this._memeSentAt || 0) < s.autoMemeEveryMinutes * 60000) return null;
    if (now - (this._memeAskedAt || 0) < ASK_EVERY_MS) return null;
    if (now - stickerSentAt < 20 * 60000) return null; // a sticker just went: no meme on top of it
    const pm = this.agent?.providerManager;
    const tg = this.agent?.interfaces?.get?.('telegram')?.bot?.telegram;
    if (!pm || !tg?.sendPhoto) return null;
    this._memeAskedAt = now;
    const names = (await popularTemplates().catch(() => [])).slice(0, 60).map(t => t.name).join(', ');
    const roles = Object.entries(ROLES).map(([id, r]) => `${id}: ${r.join(' | ')}`).join('\n');
    const agentName = process.env.AGENT_NAME || 'The assistant';
    const prompt = `${agentName} is chatting with its owner and has just replied. Decide whether a meme should follow, the way a funny friend sometimes adds one.
Send one only for: a joke or banter, a relatable everyday frustration (Mondays, bugs, waiting), good news worth celebrating, playful chat.
Never for: death, grief, illness, pain, money worries, anything upsetting, plain facts, data, instructions, errors, or a task just done. When unsure, no meme.

Owner: ${String(userText || '').slice(0, 500)}
${agentName}: ${String(replyText).slice(0, 600)}

Templates: ${names}
Box order of these (by imgflip id):
${roles}

Answer JSON only: {"meme": false} or {"meme": true, "template": "<template name>", "texts": ["box 1", "box 2"]}. Texts short, about this exchange, never mean to the owner.`;
    let r;
    try {
      r = await Promise.race([this.askModel(pm, prompt), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000))]);
    } catch (e) { this.logger.info(`memes: no unasked meme (${e.message})`); return null; }
    const pick = safeJsonParse(r?.content ?? r, null);
    if (!pick?.meme || !pick.template || !Array.isArray(pick.texts) || !pick.texts.length) { this.logger.info('memes: no meme suits this reply'); return null; }
    const made = await this.make({ template: pick.template, texts: pick.texts }, false);
    if (!made.success) { this.logger.info(`memes: unasked meme not made: ${made.error}`); return null; }
    await tg.sendPhoto(chatId, { source: await fs.readFile(made.file.path) }, threadId ? { message_thread_id: threadId } : {});
    this._memeSentAt = Date.now();
    this.logger.info(`memes: sent a meme unasked (${made.name})`);
    return made.name;
  }

  /** The same model choice as the unasked stickers: gpt-5.6-luna on OpenRouter, else the aux model. */
  async askModel(pm, prompt) {
    const provider = await pm.getCurrentProvider?.().catch?.(() => null);
    if (pm.providerNameOf?.(provider) === 'openrouter') {
      return pm.generateResponse(prompt, { model: process.env.MEMES_MODEL || process.env.BOTSANDBORGS_STICKER_MODEL || 'openai/gpt-5.6-luna', maxTokens: 250, temperature: 0.4 });
    }
    return pm.generateAux ? pm.generateAux(prompt, { maxTokens: 250, temperature: 0.4, auxTask: 'memes' }) : pm.generateResponse(prompt, { maxTokens: 250, temperature: 0.4 });
  }

  async templates(data, external) {
    const limit = Math.min(Number(data.limit) || 25, 100);
    const free = data.query ? await freeTemplates(data.query, { limit }) : await keptFree();
    const strip = (t) => ({ id: t.id, name: t.name, boxes: t.boxCount, source: t.source, license: t.license || undefined, width: t.width, height: t.height });
    if (external || data.source === 'free') return { success: true, data: { count: free.length, templates: free.slice(0, limit).map(strip) } };
    const q = String(data.query || '').toLowerCase();
    const popular = (await popularTemplates()).filter(t => !q || t.name.toLowerCase().includes(q)).slice(0, limit);
    return { success: true, data: { popular: popular.map(strip), free: free.slice(0, limit).map(strip),
      note: 'Popular templates are for your own use; only free (public-domain/CC0) templates and your own pictures are offered through the API.' } };
  }

  async find(data, external) {
    if (!data.query) return { success: false, error: 'What should the picture show? Pass query.' };
    if (!external) {
      // For the owner, a meme about a topic means a well-known template ("a meme about mondays" took a random free
      // picture of digital rain, 2026-11-09): list them, and the free pictures after.
      const popular = (await popularTemplates().catch(() => [])).slice(0, 40).map(t => ({ id: t.id, name: t.name, boxes: t.boxCount }));
      const free = await freeTemplates(data.query, { limit: 5 }).catch(() => []);
      return { success: true, data: { query: data.query, popular, free: free.map(t => ({ id: t.id, name: t.name, license: t.license })),
        note: 'For the owner, pick the popular template that suits the topic and pass its name to make with texts in its box order.' } };
    }
    const list = await freeTemplates(data.query, { limit: Number(data.limit) || 10 });
    return { success: true, data: { query: data.query, count: list.length, templates: list.map(t => ({ id: t.id, name: t.name, url: t.url, license: t.license })) } };
  }
}
