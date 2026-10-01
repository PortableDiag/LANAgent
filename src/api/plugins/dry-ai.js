import fs from 'fs/promises';
import path from 'path';
import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';

/**
 * Dry (dry.ai) — the user's shared object database: spaces hold types, objects of those types,
 * and pages (live views written from a plain-language prompt).
 *
 * v2 (2026-09-29). dry.ai is a new site: v1 moved to dry-og.com and its /api/custom-gpt REST
 * API is gone (every route 404s). v2's whole API is one MCP server, POST https://dry.ai/api/mcp
 * (Streamable HTTP, stateless), authenticated with a personal access token (`dry_pat_…`).
 * Every API route is a tool named by its operation id (list_spaces, create_object, chat …), so
 * the `tool` action reaches a new route with no change here.
 *
 * The agent signs itself in (autoAuth): Dry emails a magic link to the agent's own mailbox,
 * the link gives a session, and the session mints a token that does not expire. The sender is
 * noreply@unitarylabs.com, as it was for v1's codes.
 */

// The web origin (sign-in, tokens, REST) and the MCP endpoint: dry.ai/api/mcp is Dry's main
// MCP server (GET /api/config → mcpUrl). The older drydotai-v2-mcp-server…workers.dev server
// is no longer the main one. Override here if Dry moves either.
const BASE = (process.env.DRY_BASE_URL || 'https://dry.ai').replace(/\/+$/, '');
const MCP_URL = process.env.DRY_MCP_URL || `${BASE}/api/mcp`;
const PAGE_TYPE = '00000000-0000-7000-8000-000000000004';
const UA = 'LANAgent-dry/2';
const MAIL_FROM = 'unitarylabs.com';
const LINK_RE = /https:\/\/dry\.ai\/api\/auth\/magic-link\/verify\?[^"'<>\s]+/;

export default class DryAIPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'dry-ai';
    this.version = '2.0.0';
    this.description = 'Dry (dry.ai): save, track, search and build pages over the user\'s own object database';
    this.commands = [
      { command: 'ask', description: 'Ask Dry in plain language — save, track, log or remember something, or ask what was saved; Dry runs it in a space (the default one unless named)',
        usage: 'ask({ request: "track my workouts: 5 km run this morning", space: "Memories" })',
        examples: ['hey dry, remember that the wifi password changed', 'save this to dry', 'track my workouts in dry', 'log 5 km this morning in dry',
          'what did I save in dry about sleep', 'how many books have I logged in dry', 'add this to my dry space', 'keep track of my expenses in dry'] },
      { command: 'confirm', description: 'Carry out the deletes Dry proposed in the last ask (only when the user explicitly confirms)',
        usage: 'confirm()', examples: ['yes delete it in dry', 'confirm the dry deletion'] },
      { command: 'listSpaces', description: 'List the Dry spaces the agent can see, with links',
        usage: 'listSpaces()', examples: ['list my dry spaces', 'what spaces do I have in dry', 'show dry spaces'] },
      { command: 'createSpace', description: 'Create a new Dry space (the owner is invited as admin)',
        usage: 'createSpace({ name: "Horse Tracker" })', examples: ['create a dry space called recipes', 'make a new dry space for my trips'] },
      { command: 'listTypes', description: 'List the record types in a Dry space and their fields',
        usage: 'listTypes({ space: "Memories" })', examples: ['what types are in my dry space', 'show the fields in dry'] },
      { command: 'listObjects', description: 'List records in a Dry space, optionally of one type',
        usage: 'listObjects({ space: "Memories", type: "Memory", limit: 20 })', examples: ['list the records in my dry space', 'show my dry memories', 'list my dry pages'] },
      { command: 'searchObjects', description: 'Search records in a Dry space',
        usage: 'searchObjects({ space: "Memories", query: "sleep" })', examples: ['search dry for sleep', 'find the article about sleep in dry'] },
      { command: 'createPage', description: 'Build a live Dry page from a plain-language prompt',
        usage: 'createPage({ space: "Expenses", title: "This month", prompt: "expenses by category, biggest first" })',
        examples: ['make a dry page showing this month\'s expenses by category', 'build a dry page for my workouts'] },
      { command: 'editPage', description: 'Change a Dry page by describing the change',
        usage: 'editPage({ space: "Expenses", page: "This month", instruction: "put the total at the top" })',
        examples: ['change the dry page to show the total at the top', 'edit my dry page to colour anything over 100 red'] },
      { command: 'uploadFile', description: 'Upload a local file into a Dry space as a File object',
        usage: 'uploadFile({ space: "Memories", path: "/path/to/photo.jpg" })', examples: ['upload this photo to dry', 'attach the file to my dry space'] },
      { command: 'exportSpace', description: 'Export a whole Dry space; answers with a download link',
        usage: 'exportSpace({ space: "Horse Tracker" })', examples: ['export my dry space', 'back up my dry space'] },
      { command: 'addMember', description: 'Add or invite a person to a Dry space by email, with roles (admin or space_owner)',
        usage: 'addMember({ space: "Recipes", email: "person@example.com", roles: ["admin"] })', examples: ['share my dry space with someone', 'invite them to the dry space'] },
      { command: 'tool', description: 'Call any Dry API tool by name with arguments (every Dry route is a tool: list_changes, get_object, update_object …)',
        usage: 'tool({ name: "list_changes", args: { spaceId: "…" } })', examples: ['call the dry list_changes tool'] },
      { command: 'listTools', description: 'List the tools the Dry API offers',
        usage: 'listTools()', examples: ['what can the dry api do'] },
      { command: 'status', description: 'Whether the agent is signed in to Dry, as whom, and its default space',
        usage: 'status()', examples: ['are you connected to dry', 'dry status', 'is dry working'] },
      { command: 'autoAuth', description: 'Sign the agent in to Dry by itself: a magic link to its own mailbox, then a personal access token',
        usage: 'autoAuth()', examples: ['log in to dry', 'connect to dry', 'set up dry', 'sign up for dry'] },
      { command: 'setToken', description: 'Use a Dry personal access token (dry_pat_…) the user created under Agents & tokens',
        usage: 'setToken({ token: "dry_pat_…" })', examples: ['use this dry token'] },
      { command: 'clearToken', description: 'Forget the stored Dry token', usage: 'clearToken()', examples: ['disconnect from dry'] },
      { command: 'setOwnerEmail', description: 'The owner\'s email, invited as admin to every space the agent creates',
        usage: 'setOwnerEmail({ email: "owner@example.com" })', examples: ['set my dry owner email'] },
      { command: 'setDefaultSpace', description: 'The space ask() uses when none is named',
        usage: 'setDefaultSpace({ space: "Memories" })', examples: ['use my memories space in dry by default'] }
    ];
    this.token = null;
    this.email = null;
    this.ownerEmail = null;
    this.defaultSpace = null;
    this.pendingProposals = null;   // {spaceId, actions} from the last ask
    this.rpcId = 0;
  }

  async initialize() {
    try {
      const saved = await PluginSettings.getCached(this.name, 'v2');
      if (saved) Object.assign(this, { token: saved.token || null, email: saved.email || null, ownerEmail: saved.ownerEmail || null, defaultSpace: saved.defaultSpace || null });
    } catch (e) {
      this.logger.debug(`Dry settings not loaded: ${e.message}`);
    }
    if (process.env.DRY_TOKEN) this.token = process.env.DRY_TOKEN;
    if (!this.ownerEmail && process.env.EMAIL_OF_MASTER) this.ownerEmail = process.env.EMAIL_OF_MASTER;
    this.logger.info(`Dry plugin initialized (${this.token ? `signed in${this.email ? ` as ${this.email}` : ''}` : 'not signed in — autoAuth or setToken'})`);
  }

  async execute(params) {
    const { action, ...data } = params;
    try {
      this.validateParams(params, { action: { required: true, type: 'string', enum: this.commands.map(c => c.command) } });
      switch (action) {
        case 'autoAuth': return await this.autoAuth(data);
        case 'setToken': return await this.setToken(data);
        case 'clearToken': await this._save({ token: null, email: null }); return { success: true, result: 'Dry token forgotten.' };
        case 'setOwnerEmail': return await this._setting('ownerEmail', data.email, v => /@/.test(v), 'an email address');
        case 'setDefaultSpace': return await this._setting('defaultSpace', (await this._space(data.space)).id, Boolean, 'a space');
        case 'status': return await this.status();
      }
      this._needToken();
      switch (action) {
        case 'ask': return await this.ask(data);
        case 'confirm': return await this.confirm();
        case 'listSpaces': return await this.listSpaces();
        case 'createSpace': return await this.createSpace(data);
        case 'listTypes': return await this.listTypes(data);
        case 'listObjects': return await this.listObjects(data);
        case 'searchObjects': return await this.searchObjects(data);
        case 'createPage': return await this.createPage(data);
        case 'editPage': return await this.editPage(data);
        case 'uploadFile': return await this.uploadFile(data);
        case 'exportSpace': return await this.exportSpace(data);
        case 'addMember': return await this.addMember(data);
        case 'tool': return { success: true, result: await this._tool(String(data.name || ''), data.args || data.arguments || {}) };
        case 'listTools': return { success: true, tools: (await this._rpc('tools/list')).tools.map(t => ({ name: t.name, description: (t.description || '').split('\n')[0] })) };
      }
      throw new Error(`Unknown action ${action}`);
    } catch (error) {
      this.logger.error(`dry-ai ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ─── natural language ─────────────────────────────────────────────

  async ask({ request, query, message, space } = {}) {
    const text = String(request || query || message || '').trim();
    if (!text) throw new Error('ask needs the request in plain language.');
    const sp = await this._space(space);
    const out = await this._tool('chat', { spaceId: sp.id, messages: [{ role: 'user', content: text }] });
    const proposals = Array.isArray(out?.proposals) ? out.proposals : [];
    this.pendingProposals = proposals.length ? { spaceId: sp.id, actions: proposals } : null;
    return {
      success: true,
      space: { id: sp.id, name: sp.name, url: sp.url },
      result: `${out?.reply || 'Done.'}${proposals.length ? `\n\nDry proposes ${proposals.length} change(s) that need confirmation (say "confirm" to carry them out).` : ''}`,
      ran: (out?.executed || []).map(e => e.tool),
      proposals
    };
  }

  async confirm() {
    if (!this.pendingProposals) throw new Error('Nothing is waiting for confirmation.');
    const { spaceId, actions } = this.pendingProposals;
    this.pendingProposals = null;
    const out = await this._tool('chat_confirm', { spaceId, actions });
    return { success: true, result: out?.reply || `Carried out ${actions.length} change(s).`, detail: out };
  }

  // ─── spaces, types, records, pages ────────────────────────────────

  async listSpaces() {
    const spaces = this._items(await this._tool('list_spaces', {}));
    return { success: true, spaces: spaces.map(s => ({ id: s.id, name: s.name, role: s.role, url: s.url })),
      result: spaces.map(s => `- **${s.name}** (${s.role}) ${s.url}`).join('\n') || 'No spaces.' };
  }

  async createSpace({ name, public: isPublic = false } = {}) {
    if (!name) throw new Error('createSpace needs a name.');
    const sp = this._one(await this._tool('create_space', { name: String(name), public: !!isPublic }));
    let invited = null;
    if (this.ownerEmail && this.ownerEmail !== this.email) {
      invited = await this._tool('add_member', { spaceId: sp.id, email: this.ownerEmail, roles: ['admin'] })
        .then(() => this.ownerEmail).catch(e => { this.logger.warn(`Dry: could not invite ${this.ownerEmail}: ${e.message}`); return null; });
    }
    return { success: true, space: { id: sp.id, name: sp.name, url: sp.url }, invited,
      result: `Created space **${sp.name}**: ${sp.url}${invited ? ` (invited ${invited} as admin)` : ''}` };
  }

  async listTypes({ space } = {}) {
    const sp = await this._space(space);
    const types = this._items(await this._tool('list_types', { spaceId: sp.id }));
    return { success: true, space: sp.name, types: types.map(t => ({ id: t.id, name: t.name, fields: (t.fields || []).map(f => f.label || f.name || f.id) })) };
  }

  async listObjects({ space, type, limit = 25 } = {}) {
    const sp = await this._space(space);
    const typeId = type ? (await this._type(sp.id, type)).id : undefined;
    const items = this._items(await this._tool('list_objects', { spaceId: sp.id, ...(typeId ? { typeId } : {}), limit: Math.min(Number(limit) || 25, 100) }));
    return { success: true, space: sp.name, count: items.length, objects: items.map(o => this._brief(o)) };
  }

  async searchObjects({ space, query, search } = {}) {
    const q = String(query || search || '').trim();
    if (!q) throw new Error('searchObjects needs a query.');
    const sp = await this._space(space);
    const items = this._items(await this._tool('search_objects', { spaceId: sp.id, search: q, limit: 25 }));
    return { success: true, space: sp.name, count: items.length, objects: items.map(o => this._brief(o)) };
  }

  async createPage({ space, title, prompt } = {}) {
    if (!title || !prompt) throw new Error('createPage needs a title and a prompt.');
    const sp = await this._space(space);
    const page = this._one(await this._tool('create_object', { spaceId: sp.id, typeId: PAGE_TYPE, values: { Title: String(title), Prompt: String(prompt) } }));
    return { success: true, page: this._brief(page), result: `Page **${title}** is being generated (a few seconds): ${page.url}` };
  }

  async editPage({ space, page, instruction } = {}) {
    if (!page || !instruction) throw new Error('editPage needs the page (id or title) and the instruction.');
    const sp = await this._space(space);
    const pageId = /^[0-9a-f-]{36}$/i.test(String(page)) ? String(page)
      : (this._items(await this._tool('search_objects', { spaceId: sp.id, typeId: PAGE_TYPE, search: String(page), limit: 5 }))[0]?.id);
    if (!pageId) throw new Error(`No page "${page}" in ${sp.name}.`);
    const out = this._one(await this._tool('edit_page', { spaceId: sp.id, pageId, instruction: String(instruction) }));
    return { success: true, page: this._brief(out), result: `Page updated: ${out?.url || ''}` };
  }

  async uploadFile({ space, path: filePath, name, mime } = {}) {
    if (!filePath) throw new Error('uploadFile needs the path of a local file.');
    const data = await fs.readFile(filePath);
    if (data.length > 25 * 1024 * 1024) throw new Error('That file is over 25 MB.');
    const sp = await this._space(space);
    const file = this._one(await this._tool('upload_file', { spaceId: sp.id, name: name || path.basename(filePath), data: data.toString('base64'), ...(mime ? { mime } : {}) }));
    return { success: true, file: this._brief(file), result: `Uploaded ${name || path.basename(filePath)} to ${sp.name}: ${file?.url || file?.id}` };
  }

  async exportSpace({ space } = {}) {
    const sp = await this._space(space);
    const out = await this._tool('export_space', { spaceId: sp.id });
    return { success: true, space: sp.name, url: out?.url || null, result: `Export of ${sp.name}: ${out?.url || '(no link returned)'} — opens while signed in to Dry.` };
  }

  async addMember({ space, email, roles = ['admin'] } = {}) {
    if (!email) throw new Error('addMember needs an email.');
    const sp = await this._space(space);
    await this._tool('add_member', { spaceId: sp.id, email: String(email), roles: Array.isArray(roles) ? roles : [String(roles)] });
    return { success: true, result: `${email} added to ${sp.name} as ${[].concat(roles).join(', ')}.` };
  }

  // ─── sign-in ───────────────────────────────────────────────────────

  async status() {
    if (!this.token) return { success: true, signedIn: false, result: 'Not signed in to Dry. Run autoAuth, or setToken with a dry_pat_ token.' };
    const me = await this._rest('GET', '/api/me');
    const sp = this.defaultSpace ? await this._space(this.defaultSpace).catch(() => null) : null;
    return { success: true, signedIn: true, email: me.email, owner: this.ownerEmail, defaultSpace: sp ? { name: sp.name, url: sp.url } : null,
      result: `Signed in to Dry as ${me.email}${sp ? `; default space ${sp.name}` : ''}.` };
  }

  async setToken({ token } = {}) {
    const t = String(token || '').trim();
    if (!t.startsWith('dry_pat_')) throw new Error('A Dry personal access token starts with dry_pat_.');
    const me = await this._rest('GET', '/api/me', null, t);
    await this._save({ token: t, email: me.email });
    return { success: true, result: `Dry token saved; signed in as ${me.email}.` };
  }

  /** Magic link to the agent's own mailbox → session → personal access token. */
  async autoAuth({ email } = {}) {
    if (this.token) {
      const me = await this._rest('GET', '/api/me').catch(() => null);
      if (me?.email) return { success: true, alreadySignedIn: true, result: `Already signed in to Dry as ${me.email}.` };
    }
    const address = email || process.env.EMAIL_USER;
    if (!address || !address.includes('@')) throw new Error('No agent mailbox: set EMAIL_USER or pass email.');
    const mail = this.agent?.apiManager?.getPlugin?.('email');
    if (!mail) throw new Error('The email plugin is needed to read the sign-in link.');

    const since = Date.now();
    const body = { email: address, callbackURL: `${BASE}/` };
    let res = await this._authPost('/api/auth/sign-in/magic-link', body);
    if (res.status === 404 && /NO_ACCOUNT/.test(res.text)) res = await this._authPost('/api/auth/sign-in/magic-link', body, { 'x-dry-intent': 'sign-up' });
    if (res.status >= 400) throw new Error(`Dry refused the sign-in request (${res.status}): ${res.text.slice(0, 200)}`);

    let link = null;
    for (let i = 0; i < 12 && !link; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const found = await mail.execute({ action: 'searchEmails', from: MAIL_FROM, since: new Date(since - 86400000).toISOString().slice(0, 10), limit: 5, includeBody: true }).catch(() => null);
      for (const m of found?.emails || []) {
        if (m.date && new Date(m.date).getTime() < since - 60000) continue;
        const hit = `${m.html || ''} ${m.text || ''}`.match(LINK_RE);
        if (hit) { link = hit[0].replace(/&amp;/g, '&'); break; }
      }
    }
    if (!link) throw new Error(`No Dry sign-in email reached ${address} within two minutes.`);

    const verify = await fetch(link, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const cookie = (verify.headers.getSetCookie?.() || [verify.headers.get('set-cookie') || ''])
      .map(c => c.split(';')[0]).filter(c => /session_token=/.test(c)).join('; ');
    if (!cookie) throw new Error(`The sign-in link did not start a session (HTTP ${verify.status}).`);

    const minted = await fetch(`${BASE}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE, 'User-Agent': UA },
      body: JSON.stringify({ name: `LANAgent ${process.env.AGENT_NAME || ''} (dry-ai plugin)`.replace(/\s+/g, ' ').trim() })
    }).then(r => r.json());
    if (!String(minted?.token || '').startsWith('dry_pat_')) throw new Error(`Dry did not mint a token: ${JSON.stringify(minted).slice(0, 200)}`);
    await this._save({ token: minted.token, email: address });
    this.logger.info(`Dry: signed in as ${address} (token ${minted.prefix}…)`);
    return { success: true, result: `Signed in to Dry as ${address}; token ${minted.prefix}… saved (no expiry, revocable under Agents & tokens).` };
  }

  // ─── transport ─────────────────────────────────────────────────────

  _needToken() {
    if (!this.token) throw new Error('Not signed in to Dry — run autoAuth (the agent signs itself in) or setToken.');
  }

  async _rpc(method, params = {}) {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
      signal: AbortSignal.timeout(180000)
    });
    let text = await res.text();
    if ((res.headers.get('content-type') || '').includes('event-stream')) {
      text = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop() || '{}';
    }
    let msg;
    try { msg = JSON.parse(text); } catch { throw new Error(`Dry answered HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (res.status === 401 || msg?.code === 'unauthenticated') throw new Error('Dry rejected the token (revoked or expired) — run autoAuth again.');
    if (msg.error) throw new Error(`Dry: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  /** Call one Dry tool; answers its structured result (or the parsed text). */
  async _tool(name, args) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('A Dry tool name is lowercase with underscores (see listTools).');
    const r = await this._rpc('tools/call', { name, arguments: args || {} });
    const text = (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (r?.isError) throw new Error(`Dry ${name}: ${text.slice(0, 300)}`);
    if (r?.structuredContent !== undefined) return r.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  }

  async _rest(method, route, body = null, token = this.token) {
    const res = await fetch(`${BASE}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await res.json().catch(() => ({}));
    if (res.status >= 400) throw new Error(`Dry ${route}: ${data?.error || res.status}`);
    return data;
  }

  async _authPost(route, body, extra = {}) {
    const res = await fetch(`${BASE}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': UA, ...extra }, body: JSON.stringify(body)
    });
    return { status: res.status, text: await res.text() };
  }

  _items(out) { return Array.isArray(out) ? out : (out?.items || []); }
  _one(out) { return Array.isArray(out) ? out[0] : (out?.items?.[0] || out); }
  /** Values are keyed by field id, so the title is the first text value (else the slug). */
  _brief(o) {
    if (!o) return null;
    const v = o.values || {};
    const text = v.Title || v.Name || Object.values(v).find(x => typeof x === 'string' && x.trim() && !/^[0-9a-f-]{36}$/i.test(x));
    return { id: o.id, title: o.title || o.name || (text ? String(text).slice(0, 120) : null) || o.slug || null, type: o.typeName || o.typeId, url: o.url };
  }

  /** A space by id, name or slug; the default space, else the agent's first (its Memories). */
  async _space(ref) {
    const spaces = this._items(await this._tool('list_spaces', {}));
    const want = String(ref || this.defaultSpace || '').trim().toLowerCase();
    const hit = want
      ? spaces.find(s => s.id === want || String(s.slug).toLowerCase() === want || String(s.name).toLowerCase() === want)
      : (spaces.find(s => /^memories/i.test(s.name)) || spaces[0]);
    if (!hit) throw new Error(want ? `No Dry space "${ref}". Spaces: ${spaces.map(s => s.name).join(', ') || 'none'}.` : 'No Dry spaces yet.');
    return hit;
  }

  async _type(spaceId, ref) {
    const types = this._items(await this._tool('list_types', { spaceId }));
    const want = String(ref).toLowerCase();
    const hit = types.find(t => t.id === ref || String(t.name).toLowerCase() === want);
    if (!hit) throw new Error(`No type "${ref}". Types: ${types.map(t => t.name).join(', ')}.`);
    return hit;
  }

  async _save(patch) {
    Object.assign(this, patch);
    await PluginSettings.setCached(this.name, 'v2', { token: this.token, email: this.email, ownerEmail: this.ownerEmail, defaultSpace: this.defaultSpace, savedAt: new Date().toISOString() });
  }

  async _setting(key, value, ok, what) {
    if (!ok(value)) throw new Error(`Needs ${what}.`);
    await this._save({ [key]: value });
    return { success: true, result: `Dry ${key} set.` };
  }

  async cleanup() {
    this.pendingProposals = null;
  }
}
