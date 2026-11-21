/**
 * /api/avatar-live: what the live avatar page (public/avatar-live.html) and the agent's own tools call. The page is
 * AvatarX's, so the routes are AvatarX's (/api/state, /api/events, /api/chat, /api/tts, /api/voice/session, uploads),
 * under this prefix and behind the dashboard's own login (a JWT or an API key). Data: services/avatar/liveAvatar.js.
 *
 * Owner-only like the dashboard: anyone who reaches these routes signed in is the owner.
 */
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { authenticateToken, verifyToken } from './auth.js';
import { logger } from '../../utils/logger.js';
import * as L from '../../services/avatar/liveAvatar.js';

const MAX_VRM = 200 * 1048576;
const raw = (limit) => express.raw({ type: () => true, limit });

/** The service behind the routes; also what the agent's own code calls (liveCaller). */
export function createLiveAvatar(agent, { d = L.dirs() } = {}) {
  const store = () => { const e = agent?.apiManager?.apis?.get?.('botsandborgs'); return e?.instance || e || null; };

  async function activeId() {
    if (agent?.agentModel?.activeVRMModel) return agent.agentModel.activeVRMModel;
    try {
      const { Agent } = await import('../../models/Agent.js');
      const a = await Agent.findOne({ name: process.env.AGENT_NAME || 'LANAgent' }).lean();
      return a?.activeVRMModel || null;
    } catch { return null; }
  }

  async function setActive(id) {
    const { Agent } = await import('../../models/Agent.js');
    await Agent.updateOne({ name: process.env.AGENT_NAME || 'LANAgent' }, { $set: { activeVRMModel: id } });
    if (agent?.agentModel) agent.agentModel.activeVRMModel = id;
    logger.info(`Live avatar: showing ${id}`);
    import('../../services/avatar/avatarx.js').then(({ pushModelToAvatarX }) => pushModelToAvatarX(id))
      .catch(e => logger.warn(`AvatarX not told: ${e.message}`));
  }

  /** The store's scenes, named store-<scene>. Nothing when the store plugin is off. */
  async function storeScenes() {
    const s = store();
    if (!s?.libraryItems) return [];
    try {
      const items = await s.libraryItems();
      const out = [];
      for (const item of items) {
        for (const f of item.files || []) {
          if (f.kind !== 'background' && f.kind !== 'wallpaper') continue;
          // One picture per scene: the landscape (desktop) one; a phone shows it cover-fit, cropped to its shape.
          if (f.format && f.format !== 'desktop') continue;
          const file = path.join(s.libraryDir(), String(item.variant || '').replace(/[^a-z0-9._-]/gi, '_'), f.name);
          const scene = f.name.replace(/\s*\d{3,4}x\d{3,4}(?=\.[a-z]+$)/i, '').replace(/^(desktop|phone)[\s_-]+/i, '');
          const name = `store-${L.cleanName(scene)}`.slice(0, 60);
          if (/\.(jpe?g|png)$/i.test(f.name) && fsSync.existsSync(file) && !out.some(x => x.name === name)) out.push({ name, file });
        }
      }
      return out;
    } catch { return []; }
  }

  async function gather() {
    const [settings, active, avatarList, clipMap, propList, bgMap] = await Promise.all([
      L.readSettings(d), activeId(), L.avatars(d), L.clips(d), L.props(d), storeScenes().then(s => L.customBackgrounds(d, s))
    ]);
    // Clips the store fitted to the body showing (its fitted packs, same clip names) play instead of the pack's.
    try {
      const fittedClips = await store()?.fittedClips?.(active);
      for (const [name, file] of fittedClips || []) {
        if (clipMap.has(name)) clipMap.set(name, file);
        else if (clipMap.has(`bnb-${name}`)) clipMap.set(`bnb-${name}`, file);
      }
    } catch {}
    // Props the store fitted to the body showing (store 0.28) take the pack placements' place for it.
    let fitted = propList;
    try {
      const live = await store()?.liveProps?.();
      const body = avatarList.find(a => a.id === active);
      if (live?.props?.some(p => p.fitted) && body) fitted = L.applyFits(propList, live.props, await L.fileSha256(body.file));
      // Store 0.30: a prop that cannot fit this body is not attached to it (unless the store allows a self-fit: the pole).
      const off = await store()?.unsupportedProps?.();
      if (off?.size) fitted = fitted.filter(p => !off.has(p.prop || p.name));
    } catch {}
    return { settings, active, avatarList, clipMap, propList: fitted, bgMap, clipNames: [...clipMap.keys()].sort(), backgroundNames: [...bgMap.keys()] };
  }

  /** The agent's own voice, for the page to show (it is never changed there): its speech voice, and its realtime one. */
  async function agentVoice() {
    let speech = '';
    try { const v = await agent?.ttsService?.getVoiceSettings?.(); speech = [v?.provider, v?.voice].filter(Boolean).join(' '); } catch {}
    let realtime = '';
    try { const { getDialXSettings } = await import('../../services/textx/dialx.js'); realtime = (await getDialXSettings())?.realtimeVoice || ''; } catch {}
    return { speech, realtime };
  }

  const live = {
    d,
    gather,
    async getState() { return L.publicState({ ...(await gather()), agentVoice: await agentVoice(), looks: (await store()?.avatarLooks?.().catch(() => ({}))) || {} }); },
    async patch(p) {
      const g = await gather();
      await L.applyPatch(p || {}, { d, setActive, known: { avatars: g.avatarList, backgrounds: g.backgroundNames, animations: g.clipNames, active: g.active } });
      L.broadcast({ type: 'state' });
      return live.getState();
    },
    async expression(name, seconds = 4) {
      if (!L.MOODS.includes(name)) throw Object.assign(new Error(`an expression is one of ${L.MOODS.join(', ')}`), { status: 400 });
      const s = Math.min(30, Math.max(0.5, Number(seconds) || 4));
      L.broadcast({ type: 'expression', name, seconds: s });
      return { ok: true, name, seconds: s };
    },
    /** Plays a move on every open live page (the name resolved the AvatarX way). Returns the name played. */
    async gesture(name) {
      const g = await gather();
      const move = L.resolveMove(name, g.clipNames);
      if (!move) throw Object.assign(new Error(`no move called ${name}`), { status: 400 });
      L.broadcast({ type: 'gesture', name: move });
      logger.info(`Live avatar: gesture ${move}`);
      return { ok: true, name: move };
    },
    activeId,
    setActive,
    storeScenes,
    store
  };
  return live;
}

function fail(res, e) {
  const status = e.status || (e.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) logger.warn(`Live avatar: ${e.message}`);
  res.status(status).json({ error: e.message });
}

function sendFile(res, file, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  fsSync.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
}

/** One reply from the agent, the way the dashboard's chat asks: { text }. */
async function askAgent(agent, text) {
  const r = await agent.processNaturalLanguage(text, { userId: 'web-user', interface: 'avatar' });
  return String(r?.content ?? r?.text ?? r ?? '').trim();
}

export function avatarLiveRouter(agent, live = createLiveAvatar(agent), { auth = authenticateToken } = {}) {
  const r = express.Router();
  const { d } = live;
  // The store plugin, for the routes below (chat's body language, videos). It lives in createLiveAvatar; the /video
  // route answered "store is not defined" until this was here (2026-11-17).
  const store = () => live.store?.() || null;

  // Public: whether this browser is signed in (the page shows its login otherwise). Never a secret.
  r.get('/status', (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    let logged = false;
    try { logged = !!(token && verifyToken(token)); } catch {}
    res.json({ agent: process.env.AGENT_NAME || 'LANAgent', logged_in: logged, voice: !!process.env.OPENAI_API_KEY, has_password: true, can_setup: false });
  });

  r.use(auth);

  r.get('/state', async (req, res) => { try { res.json(await live.getState()); } catch (e) { fail(res, e); } });
  r.patch('/state', express.json(), async (req, res) => { try { res.json(await live.patch(req.body)); } catch (e) { fail(res, e); } });
  r.post('/gesture', express.json(), async (req, res) => { try { res.json(await live.gesture(req.body?.name)); } catch (e) { fail(res, e); } });
  r.post('/expression', express.json(), async (req, res) => { try { res.json(await live.expression(req.body?.name, req.body?.seconds)); } catch (e) { fail(res, e); } });

  // Live changes, as server-sent events. The page reads them with fetch (a header carries the login).
  r.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    const on = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    L.bus.on('event', on);
    req.on('close', () => { clearInterval(ping); L.bus.off('event', on); });
  });

  // --- bodies ---
  r.get('/avatars/:id/file', async (req, res) => {
    const a = (await L.avatars(d)).find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'no such avatar' });
    sendFile(res, a.file, 'model/gltf-binary');
  });
  r.post('/avatars', raw(MAX_VRM), async (req, res) => {
    try {
      const a = await L.addAvatar(req.body, req.query.name, { d, replace: req.query.replace || null });
      if (req.query.replace && (await live.activeId()) === req.query.replace) {
        import('../../services/avatar/avatarx.js').then(({ pushModelToAvatarX }) => pushModelToAvatarX(req.query.replace)).catch(() => {});
      }
      L.broadcast({ type: 'state' });
      logger.info(`Live avatar: ${req.query.replace ? 'replaced' : 'added'} body ${a.id} (${(a.size / 1048576).toFixed(1)} MB)`);
      res.json({ avatar: a });
    } catch (e) { fail(res, e); }
  });
  r.delete('/avatars/:id', async (req, res) => {
    try {
      if ((await live.activeId()) === req.params.id) return res.status(409).json({ error: 'that body is showing: show another first' });
      const how = await L.removeAvatar(req.params.id, { d });
      if (how === 'missing') return res.status(404).json({ error: 'no such avatar' });
      if (how === 'kept') return res.status(409).json({ error: 'only an uploaded body can be deleted here; the designer manages the rest' });
      L.broadcast({ type: 'state' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --- motions ---
  r.get('/animations/:name/file', async (req, res) => {
    let file = (await L.clips(d)).get(req.params.name);
    // The body showing plays its fitted version (the store solved it on that body), same name.
    try {
      const fitted = await store()?.fittedClips?.(await activeId());
      const own = fitted?.get(req.params.name) || fitted?.get(String(req.params.name).replace(/^bnb-/, ''));
      if (file && own) file = own;
    } catch {}
    if (!file) return res.status(404).json({ error: 'no such clip' });
    sendFile(res, file, 'application/octet-stream');
  });
  r.post('/animations', raw(64 * 1048576), async (req, res) => {
    try {
      const name = await L.addClip(req.body, req.query.name, { d });
      L.broadcast({ type: 'state' });
      logger.info(`Live avatar: added clip ${name}`);
      res.json({ animation: name });
    } catch (e) { fail(res, e); }
  });
  r.delete('/animations/:name', async (req, res) => {
    try {
      if (!(await L.removeClip(req.params.name, { d }))) return res.status(409).json({ error: 'only an uploaded motion can be deleted here' });
      L.broadcast({ type: 'state' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --- props ---
  r.get('/props/:name/file', async (req, res) => {
    const p = (await L.props(d)).find(x => x.name === req.params.name);
    if (!p) return res.status(404).json({ error: 'no such prop' });
    sendFile(res, p.glb, 'model/gltf-binary');
  });
  r.post('/props', raw(32 * 1048576), async (req, res) => {
    try {
      // A JSON attach sent as application/json was already parsed by the app's JSON body parser.
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
      const got = await L.addPropPart(body, req.query.name, { d });
      L.broadcast({ type: 'state' });
      res.json({ ok: true, ...got });
    } catch (e) { fail(res, e); }
  });
  r.delete('/props/:name', async (req, res) => {
    try {
      if (!(await L.removeProp(req.params.name, { d }))) return res.status(404).json({ error: 'no such prop (store props come with their clips)' });
      L.broadcast({ type: 'state' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --- backgrounds ---
  r.get('/backgrounds/:name/file', async (req, res) => {
    const g = await live.gather();
    const file = g.bgMap.get(req.params.name);
    if (!file) return res.status(404).json({ error: 'no such background' });
    sendFile(res, file, /\.png$/i.test(file) ? 'image/png' : 'image/jpeg');
  });
  r.post('/backgrounds', raw(20 * 1048576), async (req, res) => {
    try {
      const name = await L.addBackground(req.body, req.query.name, { d });
      L.broadcast({ type: 'state' });
      res.json({ background: name });
    } catch (e) { fail(res, e); }
  });
  r.delete('/backgrounds/:name', async (req, res) => {
    try {
      if (!(await L.removeBackground(req.params.name, { d }))) return res.status(409).json({ error: 'only an uploaded background can be deleted here' });
      L.broadcast({ type: 'state' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --- the conversation ---
  r.get('/chat', async (req, res) => { res.json({ lines: (await L.chatLines(d)).map(({ role, text }) => ({ role, text })) }); });
  r.delete('/chat', async (req, res) => { await L.newChat(d); res.json({ ok: true }); });

  // A typed message: the agent's reply as an OpenAI-style stream (what the page reads), then body language.
  r.post('/chat', express.json(), async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 8000);
    if (!text) return res.status(400).json({ error: 'say something' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const ping = setInterval(() => res.write(': working\n\n'), 10000);
    try {
      const reply = await askAgent(agent, text);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply || '…' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      await L.addChatLines([{ role: 'user', text }, { role: 'assistant', text: reply }], d);
      store()?.autoEmote?.({ userText: text, replyText: reply })?.catch?.(e => logger.warn(`Live avatar: no emote: ${e.message}`));
    } catch (e) {
      logger.warn(`Live avatar chat failed: ${e.message}`);
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
    } finally {
      clearInterval(ping);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  // Talk's ask_agent tool: one request, one answer.
  r.post('/ask', express.json(), async (req, res) => {
    try {
      const text = String(req.body?.text || req.body?.request || '').trim();
      if (!text) return res.status(400).json({ error: 'ask something' });
      const answer = await askAgent(agent, text);
      await L.addChatLines([{ role: 'user', text }, { role: 'assistant', text: answer }], d);
      res.json({ text: answer });
    } catch (e) { fail(res, e); }
  });

  // A typed reply, spoken one sentence at a time. The body's own voice when it has one, else the agent's.
  r.post('/tts', express.json(), async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim().slice(0, 1200);
      if (!text) return res.status(400).json({ error: 'nothing to say' });
      if (!agent?.ttsService?.generateSpeech) return res.status(503).json({ error: 'speech is not available' });
      // The agent's own set voice, always (the owner, 2026-11-16: an agent sticks to its voice; only realtime may change
      // it, and only on a fallback). The same voice its videos and voice notes use.
      const out = await agent.ttsService.generateSpeech(text, { source: 'voice' });
      const fmt = out?.format || 'mp3';
      res.setHeader('Content-Type', fmt === 'wav' ? 'audio/wav' : fmt === 'opus' ? 'audio/ogg' : 'audio/mpeg');
      res.end(out.buffer);
    } catch (e) { fail(res, e); }
  });

  // Talk: a short-lived OpenAI Realtime secret (the browser connects by WebRTC), in this body's voice.
  r.post('/voice/session', async (req, res) => {
    try {
      const { mintTalkSession } = await import('../../services/voiceTalk.js');
      // The agent's set realtime voice (DialX realtimeVoice), the same as its calls and the app's talk mode.
      const s = await mintTalkSession(agent, { userId: 'web-user', surface: 'avatar' });
      logger.info(`Live avatar: talk session (${s.model}, ${s.voice})`);
      res.json({ value: s.client_secret, model: s.model, voice: s.voice });
    } catch (e) {
      logger.warn(`Live avatar: no talk session: ${e.message}`);
      res.status(e.code === 'unavailable' ? 503 : 502).json({ error: e.message });
    }
  });

  // A video of one move, as an mp4 (AvatarX POST /agent/v1/video): { name, framing?, background?, audio_b64? }.
  r.post('/video', express.json({ limit: '20mb' }), async (req, res) => {
    try {
      const s = store();
      if (!s?.renderMoveVideo) return res.status(503).json({ error: 'videos need the Bots & Borgs plugin' });
      const { background, ...rest } = req.body || {};
      const backgroundPath = background ? (await live.gather()).bgMap.get(background) : null;
      if (background && !backgroundPath && !L.BACKGROUNDS.includes(background)) return res.status(400).json({ error: 'no such background' });
      const v = await s.renderMoveVideo({ ...rest, backgroundPath });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Seconds', String(v.seconds));
      res.end(v.video);
    } catch (e) { fail(res, e); }
  });

  r.post('/client-log', express.json(), (req, res) => {
    logger.warn(`Live avatar page: ${String(req.body?.kind || 'note').slice(0, 40)}: ${String(req.body?.note || '').slice(0, 200)}`);
    res.json({ ok: true });
  });

  return r;
}
