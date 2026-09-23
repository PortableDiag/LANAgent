/**
 * Trellis Notes Plugin
 *
 * Read and write the operator's Trellis document over its localhost/LAN Agent API.
 * Trellis is a spatial note-taking app: a tree of NODES (baskets), each holding a
 * canvas of CARDS (text / checklist / code / table / image / sketch). Cards carry
 * inline `key:: value` properties, and two of those — `status::` and `due::` — feed
 * the app's Agenda and Kanban views automatically. That is what makes this useful to
 * an agent: anything filed here shows up in the operator's own task views without
 * them copying it anywhere.
 *
 * NAMING — this plugin is `trellis-notes`, not `trellis`, on purpose. LANAgent
 * already uses the name TRELLIS for the free photo/text-to-3D provider in
 * src/services/avatar/avatarService.js. Two plugins answering to "trellis" would
 * collide in the vector intent index and send "make a trellis note" to the 3D
 * pipeline. Keep the command examples in this file about notes/baskets/agenda and
 * away from words like model, mesh, avatar or generate.
 *
 * ONE PORT = ONE DOCUMENT. A Trellis instance serves exactly one document, so the
 * port IS the address of the document. An operator may run more than one, on
 * different ports with different keys. `trellisStatus`
 * reports which document this plugin is pointed at; check it before writing.
 *
 * DELIBERATELY READ-MOSTLY. There is no delete action of any kind — not for cards,
 * not for baskets. Plugin actions are reachable by fuzzy vector-matched intent, and
 * a mis-matched phrase must never be able to destroy the operator's notes. Trellis
 * deletes are irreversible over the API (no undo endpoint). Edits are additive:
 * `appendNote` appends, it does not replace.
 *
 * PERSISTENCE. Trellis autosaves ~2 s after the last change, on its own thread, and
 * snapshots to version history. There is no save endpoint and nothing to call here.
 *
 * Credentials: TRELLIS_API_KEY (or set it in Settings → Plugins → trellis-notes).
 * Base URL:    TRELLIS_BASE_URL, default http://127.0.0.1:7374. When the agent runs
 *              on a different host than the app, point this at the LAN address and
 *              enable Tools → Settings → LAN access in Trellis.
 */

import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { PluginSettings } from '../../models/PluginSettings.js';

const MAX_BODY_CHARS = 1200;   // truncate card bodies so results stay context-cheap
const MAX_HITS = 25;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_KINDS = ['text', 'checklist', 'code'];
const VALID_STATUS = ['todo', 'doing', 'done', 'blocked', 'waiting'];

export default class TrellisNotesPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'trellis-notes';
    this.version = '1.0.0';
    this.description = 'Read and write the operator\'s Trellis notes: baskets, cards, agenda tasks and the Kanban board';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'Trellis API Key', envVar: 'TRELLIS_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'trellisStatus',
        description: 'Which Trellis document is reachable, its node count and whether it has unsaved changes',
        usage: 'trellisStatus',
        examples: ['trellis status', 'is trellis reachable', 'which notes document am I connected to', 'check my notes app']
      },
      {
        command: 'listBaskets',
        description: 'List the basket tree — every node with its id, title and card count',
        usage: 'listBaskets({ project: "LANAgent" })',
        examples: ['list my baskets', 'show the notes tree', 'what projects are in my notes', 'list trellis notebooks']
      },
      {
        command: 'readBasket',
        description: 'Read the cards in one basket, by basket id or title',
        usage: 'readBasket({ basket: "LANAgent Open Items" })',
        examples: ['read the open items basket', 'show me the cards in Ops Checks', 'what is in my reference basket']
      },
      {
        command: 'searchNotes',
        description: 'Full-text search every card in the document',
        usage: 'searchNotes({ query: "vpn flap" })',
        examples: ['search my notes for the vpn flap', 'find notes about the gateway', 'do I have a note on this']
      },
      {
        command: 'listTasks',
        description: 'The agenda: cards carrying a due:: date, bucketed overdue / today / week / later',
        usage: 'listTasks({ project: "LANAgent", includeDone: false })',
        examples: ['what is on my agenda', 'list my open tasks', 'what is due today', 'anything overdue in my notes']
      },
      {
        command: 'getKanban',
        description: 'The Kanban board: cards grouped by their status:: value',
        usage: 'getKanban({ project: "LANAgent" })',
        examples: ['show my kanban board', 'what am I working on', 'what is in progress']
      },
      {
        command: 'createTask',
        description: 'File a task card with status:: and due:: so it lands in the Agenda and Kanban automatically',
        usage: 'createTask({ basket: "LANAgent Open Items", title: "Rotate the API key", body: "why it matters", due: "2026-08-11" })',
        examples: ['add a task to my notes', 'file this as a task in trellis', 'remind me in my notes to rotate the key']
      },
      {
        command: 'createNote',
        description: 'Create a text, checklist or code card in a basket',
        usage: 'createNote({ basket: "Reference", title: "Log one-liners", body: "...", kind: "text" })',
        examples: ['make a note in trellis', 'save this to my notes', 'write this down in my notes app', 'add a checklist to my notes']
      },
      {
        command: 'appendNote',
        description: 'Append text to the end of an existing card — additive, never replaces what is there',
        usage: 'appendNote({ basket: "LANAgent", card: "Message board", text: "..." })',
        examples: ['append to my notes card', 'add a line to the message board', 'log this on the existing note']
      },
      {
        command: 'createBasket',
        description: 'Create a new basket, optionally nested under a parent basket',
        usage: 'createBasket({ title: "Deploy Log", parent: "LANAgent" })',
        examples: ['create a new basket in trellis', 'add a notes section for this project']
      },
      {
        command: 'setTaskStatus',
        description: 'Set a card\'s status:: value, which moves it on the Kanban board',
        usage: 'setTaskStatus({ basket: "LANAgent Open Items", card: "Rotate the API key", status: "doing" })',
        examples: ['move that task to doing', 'set the task status in my notes', 'mark it in progress']
      },
      {
        command: 'completeTask',
        description: 'Mark a task card done (status:: done)',
        usage: 'completeTask({ basket: "LANAgent Open Items", card: "Rotate the API key" })',
        examples: ['mark that task done in my notes', 'complete the task in trellis', 'tick that item off']
      },
      {
        command: 'getPluginConfig',
        description: 'Return a sanitized snapshot of this plugin\'s current configuration (credentials redacted)',
        usage: 'getPluginConfig',
        examples: ['getPluginConfig', 'show trellis notes plugin config']
      }
    ];

    this.config = {
      baseUrl: process.env.TRELLIS_BASE_URL || 'http://127.0.0.1:7374',
      timeoutMs: 10000,
      defaultBasket: null   // basket id or title used when an action omits `basket`
    };

    this.initialized = false;
    this.reachable = false;
    this.instanceInfo = null;
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    const savedConfig = await PluginSettings.getCached(this.name, 'config');
    if (savedConfig) Object.assign(this.config, savedConfig);
    // The saved copy is a snapshot persisted at a previous boot (line below), and it
    // includes baseUrl — without this override a stale snapshot masks any later
    // TRELLIS_BASE_URL change in .env, which is the one knob the operator actually edits
    // when the Trellis host moves.
    if (process.env.TRELLIS_BASE_URL) this.config.baseUrl = process.env.TRELLIS_BASE_URL;

    // Throws "Missing required credentials" when unset, which the API manager
    // turns into a soft-disable with a fix-it-in-Settings message rather than a
    // failed load.
    this.credentials = await this.loadCredentials(this.requiredCredentials);

    // A probe, not a gate. Trellis is a desktop app: it is routinely closed, and
    // that must not disable the plugin — the next call simply reports it clearly.
    try {
      const info = await this._request('get', '/api/instance', null, 4000);
      this.instanceInfo = info;
      this.reachable = true;
      this.logger.info(`Trellis reachable at ${this.config.baseUrl} — document "${info.document}", ${info.nodes} nodes, LAN ${info.lan ? 'on' : 'off'}`);
    } catch (error) {
      this.reachable = false;
      this.logger.warn(`Trellis not reachable at ${this.config.baseUrl} (${error.message}). The plugin stays enabled; calls will report this until the app is running.`);
    }

    await PluginSettings.setCached(this.name, 'config', this.config);
    this.initialized = true;
    this.logger.info(`${this.name} plugin initialized successfully`);
  }

  async execute(params) {
    const { action, ...data } = params;

    try {
      // Inside the try on purpose: an unknown or missing action is a caller
      // error like any other, and every path out of execute() should return the
      // same { success:false, error } shape rather than throwing past it.
      this.validateParams(params, {
        action: { required: true, type: 'string', enum: this.commands.map(c => c.command) }
      });

      switch (action) {
        case 'trellisStatus':   return await this.trellisStatus();
        case 'listBaskets':     return await this.listBaskets(data);
        case 'readBasket':      return await this.readBasket(data);
        case 'searchNotes':     return await this.searchNotes(data);
        case 'listTasks':       return await this.listTasks(data);
        case 'getKanban':       return await this.getKanban(data);
        case 'createTask':      return await this.createTask(data);
        case 'createNote':      return await this.createNote(data);
        case 'appendNote':      return await this.appendNote(data);
        case 'createBasket':    return await this.createBasket(data);
        case 'setTaskStatus':   return await this.setTaskStatus(data);
        case 'completeTask':    return await this.setTaskStatus({ ...data, status: 'done' });
        case 'getPluginConfig': return this.getPluginConfig();
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  // ---------------------------------------------------------------- transport

  /**
   * One HTTP call against the Trellis Agent API, with the failure modes that
   * actually happen turned into messages an operator can act on.
   */
  async _request(method, path, body = null, timeoutMs = null) {
    const url = `${String(this.config.baseUrl).replace(/\/+$/, '')}${path}`;
    try {
      const response = await axios({
        method,
        url,
        data: body ?? undefined,
        timeout: timeoutMs || this.config.timeoutMs,
        headers: {
          'X-API-Key': this.credentials?.apiKey,
          'Content-Type': 'application/json'
        },
        validateStatus: () => true
      });

      if (response.status === 401) {
        throw new Error('Trellis rejected the API key (401). Update it in Settings → Plugins → trellis-notes.');
      }
      if (response.status === 403) {
        throw new Error('The Trellis Agent API is disabled — no key is set in the app (Tools → Settings → Agent API).');
      }
      if (response.status === 404) {
        throw new Error(response.data?.error || `Not found: ${path}`);
      }
      if (response.status >= 400) {
        throw new Error(response.data?.error || `Trellis returned HTTP ${response.status}`);
      }
      this.reachable = true;
      return response.data;
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        this.reachable = false;
        throw new Error(`Trellis is not answering at ${this.config.baseUrl} — the app is closed, or it is on another host and LAN access is off (Tools → Settings → LAN access).`);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- resolvers

  /** Accept a node id or a node title (case-insensitive); never guess between two matches. */
  async _resolveNode(ref, { allowDefault = false } = {}) {
    let target = ref;
    if ((target === undefined || target === null || target === '') && allowDefault) {
      target = this.config.defaultBasket;
    }
    if (target === undefined || target === null || target === '') {
      throw new Error('No basket given, and no defaultBasket is configured for this plugin.');
    }

    const { nodes } = await this._request('get', '/api/nodes');

    if (typeof target === 'number' || /^\d+$/.test(String(target))) {
      const id = Number(target);
      const hit = nodes.find(n => n.id === id);
      if (!hit) throw new Error(`No basket with id ${id}.`);
      return hit;
    }

    const wanted = String(target).trim().toLowerCase();
    const exact = nodes.filter(n => n.title.toLowerCase() === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`"${target}" matches ${exact.length} baskets (ids ${exact.map(n => n.id).join(', ')}). Use the id — basket titles repeat across projects.`);
    }

    const partial = nodes.filter(n => n.title.toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${target}" is ambiguous: ${partial.slice(0, 8).map(n => `${n.title} (${n.id})`).join(', ')}.`);
    }
    throw new Error(`No basket matching "${target}".`);
  }

  /** Accept a card id or a card title within one basket. */
  async _resolveCard(nodeId, ref) {
    if (ref === undefined || ref === null || ref === '') {
      throw new Error('No card given.');
    }
    const { cards } = await this._request('get', `/api/nodes/${nodeId}/cards`);

    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const id = Number(ref);
      const hit = cards.find(c => c.id === id);
      if (!hit) throw new Error(`No card with id ${id} in basket ${nodeId}.`);
      return hit;
    }

    const wanted = String(ref).trim().toLowerCase();
    const exact = cards.filter(c => (c.title || '').toLowerCase() === wanted);
    if (exact.length === 1) return exact[0];

    const partial = cards.filter(c => (c.title || '').toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${ref}" matches ${partial.length} cards in that basket: ${partial.slice(0, 6).map(c => `${c.title} (${c.id})`).join(', ')}.`);
    }
    throw new Error(`No card matching "${ref}" in basket ${nodeId}.`);
  }

  _trim(text) {
    if (!text) return '';
    const s = String(text);
    return s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}\n… [${s.length - MAX_BODY_CHARS} more chars]` : s;
  }

  _summarizeCard(card) {
    const out = {
      id: card.id,
      kind: card.kind,
      title: card.title || '(untitled)'
    };
    if (card.kind === 'checklist') {
      const items = card.items || [];
      out.items = items.map(i => `${i.done ? '[x]' : '[ ]'} ${i.text}`);
      out.progress = `${items.filter(i => i.done).length}/${items.length}`;
    } else if (card.kind === 'table') {
      out.rows = (card.rows || []).length;
    } else {
      out.body = this._trim(card.body);
    }
    const props = card.properties || [];
    if (props.length) {
      out.properties = props.reduce((acc, p) => { acc[p.key] = p.value; return acc; }, {});
    }
    return out;
  }

  // ------------------------------------------------------------------ actions

  async trellisStatus() {
    const info = await this._request('get', '/api/instance', null, 5000);
    this.instanceInfo = info;
    return {
      success: true,
      reachable: true,
      baseUrl: this.config.baseUrl,
      document: info.document,
      path: info.path,
      port: info.port,
      nodes: info.nodes,
      lanAccess: info.lan,
      unsavedChanges: info.unsaved_changes,
      version: info.version,
      note: 'One Trellis instance serves one document — this port is that document.'
    };
  }

  async listBaskets({ project = null } = {}) {
    const { roots } = await this._request('get', '/api/tree');

    const flatten = (node, depth, path) => {
      const here = { id: node.id, title: node.title, cards: node.cards, depth, path: path ? `${path} › ${node.title}` : node.title };
      return [here, ...(node.children || []).flatMap(c => flatten(c, depth + 1, here.path))];
    };

    let list = roots.flatMap(r => flatten(r, 0, ''));
    if (project) {
      const wanted = String(project).toLowerCase();
      list = list.filter(n => n.path.toLowerCase().includes(wanted));
      if (!list.length) throw new Error(`No baskets under a project matching "${project}".`);
    }

    return {
      success: true,
      count: list.length,
      baskets: list,
      hint: 'Use path, not title, to tell projects apart — basket names like "Open Items" repeat.'
    };
  }

  async readBasket({ basket, includeBodies = true } = {}) {
    const node = await this._resolveNode(basket, { allowDefault: true });
    const data = await this._request('get', `/api/nodes/${node.id}`);
    const cards = (data.cards || []).map(c => includeBodies
      ? this._summarizeCard(c)
      : { id: c.id, kind: c.kind, title: c.title || '(untitled)' });

    return {
      success: true,
      basket: { id: node.id, title: node.title },
      groups: (data.groups || []).map(g => ({ title: g.title, cards: g.cards })),
      count: cards.length,
      cards
    };
  }

  async searchNotes({ query, limit = MAX_HITS } = {}) {
    if (!query || !String(query).trim()) throw new Error('searchNotes needs a query.');
    const data = await this._request('get', `/api/search?q=${encodeURIComponent(String(query).trim())}`);
    const hits = (data.hits || []).slice(0, Math.min(Number(limit) || MAX_HITS, MAX_HITS));
    return {
      success: true,
      query,
      count: data.hits?.length || 0,
      returned: hits.length,
      hits: hits.map(h => ({ basket: h.node_title, basketId: h.node, card: h.card, snippet: this._trim(h.snippet) }))
    };
  }

  async listTasks({ project = null, includeDone = false } = {}) {
    let path = `/api/tasks${includeDone ? '?all=true' : ''}`;
    if (project) {
      const node = await this._resolveNode(project);
      path = `/api/tasks?project=${node.id}${includeDone ? '&all=true' : ''}`;
    }
    const data = await this._request('get', path);

    const buckets = {};
    for (const t of data.tasks || []) (buckets[t.bucket] ||= []).push(t);

    return {
      success: true,
      count: data.count,
      byBucket: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      tasks: (data.tasks || []).map(t => ({
        card: t.card,
        title: t.title,
        due: t.due,
        bucket: t.bucket,
        done: t.done,
        project: t.project_title,
        path: t.node_path
      }))
    };
  }

  async getKanban({ project = null } = {}) {
    let path = '/api/kanban';
    if (project) {
      const node = await this._resolveNode(project);
      path = `/api/kanban?project=${node.id}`;
    }
    const data = await this._request('get', path);
    return {
      success: true,
      columns: (data.columns || []).map(col => ({
        status: col.status,
        count: col.count,
        cards: col.cards.map(c => ({ card: c.card, title: c.title, due: c.due, path: c.node_path }))
      }))
    };
  }

  async createNote({ basket, title, body = '', kind = 'text', items = null, lang = null, color = null, tags = null } = {}) {
    if (!title || !String(title).trim()) throw new Error('createNote needs a title.');
    if (!VALID_KINDS.includes(kind)) throw new Error(`kind must be one of: ${VALID_KINDS.join(', ')}.`);

    const node = await this._resolveNode(basket, { allowDefault: true });
    const payload = { kind, title: String(title).trim(), fit: true };

    if (kind === 'checklist') {
      const list = Array.isArray(items) ? items : String(body || '').split('\n').filter(Boolean);
      if (!list.length) throw new Error('A checklist note needs items (array of strings, or newline-separated body text).');
      payload.items = list.map(i => (typeof i === 'string' ? { done: false, text: i } : { done: !!i.done, text: String(i.text) }));
    } else {
      let text = String(body || '');
      if (Array.isArray(tags) && tags.length) {
        text = `${tags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ')}\n\n${text}`;
      }
      payload.body = text;
      if (kind === 'code' && lang) payload.lang = lang;
    }
    if (color) payload.color = color;

    const created = await this._request('post', `/api/nodes/${node.id}/cards`, payload);
    return {
      success: true,
      created: { card: created.id, basket: node.id, basketTitle: node.title, kind, title: payload.title },
      note: 'Trellis autosaves ~2 s after the last change — nothing to save.'
    };
  }

  async createTask({ basket, title, body = '', due = null, status = 'todo', tags = null, color = null } = {}) {
    if (!title || !String(title).trim()) throw new Error('createTask needs a title.');
    if (due && !DUE_RE.test(String(due))) throw new Error('due must be YYYY-MM-DD.');
    if (!VALID_STATUS.includes(status)) throw new Error(`status must be one of: ${VALID_STATUS.join(', ')}.`);

    const node = await this._resolveNode(basket, { allowDefault: true });

    // Properties go on their own lines at the top: that is the form the Agenda and
    // Kanban parsers read, and it keeps them visible in the rendered card.
    const lines = [`status:: ${status}`];
    if (due) lines.push(`due:: ${due}`);
    if (Array.isArray(tags) && tags.length) lines.push(tags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' '));
    lines.push('', String(body || ''));

    const created = await this._request('post', `/api/nodes/${node.id}/cards`, {
      kind: 'text',
      title: String(title).trim(),
      body: lines.join('\n'),
      color: color || 'amber',
      fit: true
    });

    return {
      success: true,
      created: { card: created.id, basket: node.id, basketTitle: node.title, title: String(title).trim(), status, due: due || null },
      note: due ? 'Filed with a due date — it is now in the operator\'s Agenda and Kanban.' : 'Filed without a due date, so it appears on the Kanban but not the Agenda.'
    };
  }

  async appendNote({ basket, card, text } = {}) {
    if (!text || !String(text).trim()) throw new Error('appendNote needs text.');
    const node = await this._resolveNode(basket, { allowDefault: true });
    const target = await this._resolveCard(node.id, card);

    if (target.kind !== 'text' && target.kind !== 'code') {
      throw new Error(`Card "${target.title}" is a ${target.kind} card; appendNote only works on text and code cards.`);
    }

    // Read-modify-write: additive by construction, so a race with the operator
    // editing in the window costs an ordering, never their words.
    const body = `${(target.body || '').replace(/\s+$/, '')}\n\n${String(text).trim()}`;
    await this._request('patch', `/api/nodes/${node.id}/cards/${target.id}`, { body, fit: true });

    return {
      success: true,
      appended: { card: target.id, title: target.title, basket: node.id, basketTitle: node.title, addedChars: String(text).trim().length }
    };
  }

  async createBasket({ title, parent = null, color = null } = {}) {
    if (!title || !String(title).trim()) throw new Error('createBasket needs a title.');
    const payload = { title: String(title).trim() };
    if (parent) payload.parent = (await this._resolveNode(parent)).id;

    const created = await this._request('post', '/api/nodes', payload);
    if (color) await this._request('patch', `/api/nodes/${created.id}`, { color });

    return { success: true, created: { basket: created.id, title: payload.title, parent: payload.parent || null } };
  }

  async setTaskStatus({ basket, card, status } = {}) {
    if (!VALID_STATUS.includes(status)) throw new Error(`status must be one of: ${VALID_STATUS.join(', ')}.`);
    const node = await this._resolveNode(basket, { allowDefault: true });
    const target = await this._resolveCard(node.id, card);

    // Checklist cards have no body, so the property endpoint writes nowhere and
    // the card silently never reaches the board. Say so instead of reporting a
    // success that did nothing.
    if (target.kind === 'checklist') {
      throw new Error(`"${target.title}" is a checklist card. Trellis stores properties in a card body, which checklists do not have — put [status:: ${status}] in the card title instead, or convert it to a text card.`);
    }

    await this._request('post', `/api/nodes/${node.id}/cards/${target.id}/property`, { key: 'status', value: status });
    return { success: true, updated: { card: target.id, title: target.title, status, basketTitle: node.title } };
  }

  getPluginConfig() {
    return {
      success: true,
      config: {
        baseUrl: this.config.baseUrl,
        timeoutMs: this.config.timeoutMs,
        defaultBasket: this.config.defaultBasket,
        apiKey: this.credentials?.apiKey ? '[configured]' : '[not set]'
      },
      state: {
        initialized: this.initialized,
        reachable: this.reachable,
        document: this.instanceInfo?.document || null
      }
    };
  }

  async getAICapabilities() {
    return {
      enabled: this.initialized,
      reachable: this.reachable,
      document: this.instanceInfo?.document || null,
      examples: [
        'what is on my agenda',
        'search my notes for the vpn flap',
        'file a task in my notes to rotate the gateway key by 2026-08-11',
        'append today\'s ops result to the message board card'
      ]
    };
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => { acc[cmd.command] = cmd.description; return acc; }, {});
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    this.initialized = false;
    this.reachable = false;
  }

  // ----------------------------------------------------------------- web UI

  getUIConfig() {
    return {
      menuItem: {
        id: 'trellis-notes',
        title: 'Notes',
        icon: 'fas fa-sticky-note',
        order: 62,
        section: 'main'
      },
      hasUI: true
    };
  }

  getUIContent() {
    return `
      <style>
        .trellis-card { background: var(--card-bg); border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
        .trellis-status { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: .9rem; }
        .trellis-status b { display: block; opacity: .6; font-weight: 500; font-size: .75rem; text-transform: uppercase; }
        .trellis-task { display: flex; justify-content: space-between; gap: 1rem; padding: .45rem 0; border-bottom: 1px solid rgba(128,128,128,.18); }
        .trellis-task:last-child { border-bottom: none; }
        .trellis-due { opacity: .7; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .trellis-bucket-overdue { color: #ef4444; }
        .trellis-bucket-today { color: #f59e0b; }
        .trellis-form input, .trellis-form textarea { width: 100%; margin-bottom: .5rem; padding: .5rem; border-radius: 6px; }
        .trellis-muted { opacity: .65; font-size: .85rem; }
      </style>

      <div class="plugin-header"><h2>Notes (Trellis)</h2></div>

      <div class="plugin-content">
        <div class="trellis-card">
          <div class="trellis-status" id="trellis-status">Checking…</div>
        </div>

        <div class="trellis-card">
          <h3>Agenda</h3>
          <div id="trellis-tasks" class="trellis-muted">Loading…</div>
        </div>

        <div class="trellis-card trellis-form">
          <h3>Quick task</h3>
          <input id="trellis-basket" placeholder="Basket (id or title)">
          <input id="trellis-title" placeholder="Task title">
          <textarea id="trellis-body" rows="3" placeholder="Detail (optional)"></textarea>
          <input id="trellis-due" placeholder="Due YYYY-MM-DD (optional)">
          <button class="btn" id="trellis-file">File task</button>
          <div id="trellis-result" class="trellis-muted"></div>
        </div>
      </div>

      <script>
        (function() {
          const token = localStorage.getItem('lanagent_token');
          const call = async (action, data = {}) => {
            const r = await fetch('/api/plugin', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ plugin: 'trellis-notes', action, ...data })
            });
            return r.json();
          };
          const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

          async function refresh() {
            const st = await call('trellisStatus');
            const el = document.getElementById('trellis-status');
            const r = st.result || st;
            el.innerHTML = r && r.success
              ? '<div><b>Document</b>' + esc(r.document) + '</div>' +
                '<div><b>Baskets</b>' + esc(r.nodes) + '</div>' +
                '<div><b>Endpoint</b>' + esc(r.baseUrl) + '</div>' +
                '<div><b>Unsaved</b>' + (r.unsavedChanges ? 'yes' : 'no') + '</div>'
              : '<span class="trellis-bucket-overdue">' + esc((r && r.error) || 'Trellis not reachable') + '</span>';

            const t = await call('listTasks');
            const tr = t.result || t;
            const box = document.getElementById('trellis-tasks');
            if (!tr || !tr.success) { box.textContent = (tr && tr.error) || 'No agenda available'; return; }
            if (!tr.tasks.length) { box.textContent = 'Nothing due.'; return; }
            box.innerHTML = tr.tasks.map(x =>
              '<div class="trellis-task"><span>' + esc(x.title) +
              ' <span class="trellis-muted">' + esc(x.path) + '</span></span>' +
              '<span class="trellis-due trellis-bucket-' + esc(x.bucket) + '">' + esc(x.due) + '</span></div>').join('');
          }

          document.getElementById('trellis-file').addEventListener('click', async () => {
            const out = document.getElementById('trellis-result');
            out.textContent = 'Filing…';
            const res = await call('createTask', {
              basket: document.getElementById('trellis-basket').value || undefined,
              title: document.getElementById('trellis-title').value,
              body: document.getElementById('trellis-body').value,
              due: document.getElementById('trellis-due').value || undefined
            });
            const r = res.result || res;
            out.textContent = r && r.success ? 'Filed into ' + r.created.basketTitle : 'Failed: ' + ((r && r.error) || 'unknown');
            if (r && r.success) refresh();
          });

          refresh();
        })();
      </script>
    `;
  }
}
