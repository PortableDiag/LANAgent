/**
 * Trellis Notes Plugin
 *
 * Read and write the operator's Trellis notes. Trellis is a spatial note-taking app:
 * a tree of NODES (baskets), each holding a canvas of CARDS (text / checklist / code /
 * table / image / sketch). Cards carry inline `key:: value` properties, and two of
 * those — `status::` and `due::` — feed the app's Agenda and Kanban views
 * automatically. That is what makes this useful to an agent: anything filed here
 * shows up in the operator's own task views without them copying it anywhere.
 *
 * TWO SERVERS, ONE API. Trellis runs in two places and this plugin speaks to both:
 *   - trellis-web (https://trellis-cards.com) — the DEFAULT. Multi-document and
 *     multi-tenant, so every document-scoped route takes `?document=<id>`, and the
 *     query routes live under /api/documents/{id}/ (search, tasks, kanban).
 *     Index: GET /api · reference: GET /api/reference · agent start: GET /api/agent.
 *   - Trellis desktop (http://<host>:7374) — ONE PORT = ONE DOCUMENT, so there is no
 *     document parameter and the query routes are /api/search, /api/tasks,
 *     /api/kanban. Reference: GET /api/docs; identity: GET /api/instance.
 * Everything else — route names and body shapes — is shared ("a script written for
 * one works against the other"), so the difference is confined to _path() below.
 * TRELLIS_MODE=web|desktop forces a mode; otherwise it is detected (a desktop answers
 * GET /api/instance, the web server does not).
 *
 * NAMING — this plugin is `trellis-notes`, not `trellis`, on purpose. LANAgent
 * already uses the name TRELLIS for the free photo/text-to-3D provider in
 * src/services/avatar/avatarService.js. Two plugins answering to "trellis" would
 * collide in the vector intent index and send "make a trellis note" to the 3D
 * pipeline. Keep the command examples in this file about notes/baskets/agenda and
 * away from words like model, mesh, avatar or generate.
 *
 * DELIBERATELY READ-MOSTLY. There is no delete action of any kind — not for cards,
 * not for baskets. Plugin actions are reachable by fuzzy vector-matched intent, and
 * a mis-matched phrase must never be able to destroy the operator's notes. Edits are
 * additive: `appendNote` uses the server's append route, it does not replace.
 *
 * Credentials: TRELLIS_API_KEY (web keys look like tk_…; mint one while signed in,
 *              POST /api/keys — or in Settings → Plugins → trellis-notes).
 * Base URL:    TRELLIS_BASE_URL, default https://trellis-cards.com. For the desktop
 *              app use its LAN address and port and enable Tools → Settings → LAN access.
 * Documents:   one key can reach many documents (web). The convention is TrellisBridge's,
 *              so a config is portable between the two:
 *                TRELLIS_DOCUMENT   the default document (uuid; a name is accepted too)
 *                TRELLIS_DOCUMENTS  comma-separated uuids to FOLLOW (channels); empty
 *                                   means every document the key reaches, re-read from
 *                                   GET /api/agent every 5 minutes
 *              Every action takes an optional `document`; with none it uses the default.
 *              Channel and card references may be written "<document-uuid>:<card>",
 *              since a card id is only unique inside its document.
 */

import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PluginSettings } from '../../models/PluginSettings.js';
import { TrellisChannelListener } from '../../services/trellisChannelListener.js';

const DEFAULT_BASE_URL = 'https://trellis-cards.com';
const MAX_BODY_CHARS = 1200;   // truncate card bodies so results stay context-cheap
const MAX_HITS = 25;
const MAX_MESSAGES = 30;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_KINDS = ['text', 'checklist', 'code'];
const VALID_STATUS = ['todo', 'doing', 'done', 'blocked', 'waiting'];
const MODES = ['auto', 'web', 'desktop'];
const DOCS_TTL_MS = 5 * 60 * 1000;   // re-read the key's documents, as TrellisBridge does
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_CARD_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i;

// The document one action runs against. Carried per call rather than on the instance,
// so two actions in flight against different documents cannot cross.
const docContext = new AsyncLocalStorage();

export default class TrellisNotesPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'trellis-notes';
    this.version = '2.0.0';
    this.description = 'Read and write the operator\'s Trellis notes (trellis-cards.com or the desktop app): baskets, cards, agenda tasks, the Kanban board and agent channels';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'Trellis API Key', envVar: 'TRELLIS_API_KEY', required: true }
    ];

    this.commands = [
      {
        command: 'trellisStatus',
        description: 'Whether Trellis is reachable, which server (web or desktop) and which document this plugin is using',
        usage: 'trellisStatus',
        examples: ['trellis status', 'is trellis reachable', 'which notes document am I connected to', 'check my notes app']
      },
      {
        command: 'listDocuments',
        description: 'List the Trellis documents this key can reach (web) — or the one document a desktop instance serves',
        usage: 'listDocuments',
        examples: ['list my notes documents', 'which trellis documents do I have', 'show my notebooks']
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
        command: 'readCard',
        description: 'Read one card by its id — the full body, properties and checklist items',
        usage: 'readCard({ card: 3143 })',
        examples: ['read card 3143 in my notes', 'open that notes card', 'show me the full note']
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
        command: 'listChannels',
        description: 'List Trellis channel cards (agent conversations), marking the ones waiting on a reply from this agent ("waiting" is relative to the name it signs as)',
        usage: 'listChannels({ waitingOnly: true })  // every followed document; add document to narrow',
        examples: ['any messages waiting in my notes channels', 'list trellis channels', 'is anyone waiting on a reply in trellis']
      },
      {
        command: 'readChannel',
        description: 'Read the messages in one channel card, optionally only those after a sequence number',
        usage: 'readChannel({ card: 2119, since: 40 })  // or card: "<document-uuid>:2119"',
        examples: ['read the trellis channel', 'what did the operator say in the channel', 'show the channel conversation']
      },
      {
        command: 'replyChannel',
        description: 'Post a reply in a channel card, signed as this agent',
        usage: 'replyChannel({ card: 2119, text: "Done — deployed v2.25.352." })  // or card: "<document-uuid>:2119"',
        examples: ['reply in the trellis channel', 'answer the operator in the channel', 'post in the notes channel']
      },
      {
        command: 'listAgents',
        description: 'Which agents act in the Trellis document: the server\'s built-in agents (name, reach, home basket) and the names seen in each project\'s channels',
        usage: 'listAgents',
        examples: ['which agents are in my trellis document', 'list trellis agents', 'who else is working in my notes']
      },
      {
        command: 'getPluginConfig',
        description: 'Return a sanitized snapshot of this plugin\'s current configuration (credentials redacted)',
        usage: 'getPluginConfig',
        examples: ['getPluginConfig', 'show trellis notes plugin config']
      }
    ];

    this.config = {
      baseUrl: process.env.TRELLIS_BASE_URL || DEFAULT_BASE_URL,
      mode: process.env.TRELLIS_MODE || 'auto',
      document: process.env.TRELLIS_DOCUMENT || null,  // web: default document (uuid or name)
      documents: process.env.TRELLIS_DOCUMENTS || null, // web: comma-separated uuids to follow; empty = all
      timeoutMs: 10000,
      defaultBasket: null   // basket id or title used when an action omits `basket`
    };

    this.initialized = false;
    this.reachable = false;
    this.resolvedMode = null;   // 'web' | 'desktop' once known
    this.documentId = null;     // web: the DEFAULT document (null when several and none set)
    this.documentName = null;
    this._docs = null;          // web: { list, at } — the documents this key reaches
    this._agents = new Map();   // document id ('' on desktop) → { builtin, generic, raw, at }
    this.instanceInfo = null;   // desktop GET /api/instance, or web document summary
  }

  async initialize() {
    this.logger.info(`Initializing ${this.name} plugin...`);

    const savedConfig = await PluginSettings.getCached(this.name, 'config');
    if (savedConfig) Object.assign(this.config, savedConfig);
    // The saved copy is a snapshot persisted at a previous boot (below), and it
    // includes baseUrl — without these overrides a stale snapshot masks any later
    // .env change, and .env is the knob the operator actually edits.
    if (process.env.TRELLIS_BASE_URL) this.config.baseUrl = process.env.TRELLIS_BASE_URL;
    if (process.env.TRELLIS_MODE) this.config.mode = process.env.TRELLIS_MODE;
    if (process.env.TRELLIS_DOCUMENT) this.config.document = process.env.TRELLIS_DOCUMENT;
    if (process.env.TRELLIS_DOCUMENTS) this.config.documents = process.env.TRELLIS_DOCUMENTS;

    // Throws "Missing required credentials" when unset, which the API manager
    // turns into a soft-disable with a fix-it-in-Settings message rather than a
    // failed load.
    this.credentials = await this.loadCredentials(this.requiredCredentials);

    // A probe, not a gate. The desktop app is routinely closed and the web server can
    // be briefly unreachable; neither must disable the plugin — the next call simply
    // reports it clearly.
    try {
      await this._ensureTarget();
      this.logger.info(`Trellis reachable at ${this._base()} (${this.resolvedMode}) — document "${this.documentName}"`);
      // A model's name (claude, gpt, agent, …) is refused as a sender in multi-project
      // documents, and as a built-in agent's name. Say so at boot, not at the first reply.
      if (this.resolvedMode === 'desktop' || this.documentId) {
        const info = await this._agentsInfo().catch(() => null);
        if (info?.generic.has(String(this._agentName()).toLowerCase())) {
          this.logger.warn(`Trellis refuses "${this._agentName()}" as an agent name (a model's name); set AGENT_NAME to something specific, or channel replies may be rejected.`);
        }
      }
    } catch (error) {
      this.reachable = false;
      this.logger.warn(`Trellis not ready at ${this._base()} (${error.message}). The plugin stays enabled; calls will report this until it is.`);
    }

    await PluginSettings.setCached(this.name, 'config', this.config);
    this.initialized = true;

    // Answer in Trellis channels unprompted (see services/trellisChannelListener.js for who
    // it answers and what it may do). Opt-in: most installs only want the actions above.
    if (process.env.TRELLIS_LISTEN === 'true' && this.credentials?.apiKey) {
      this.listener = new TrellisChannelListener(this);
      this.listener.start();
    }
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

      return await this._inDocument(data, () => this._dispatch(action, data));
    } catch (error) {
      this.logger.error(`${action} failed:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Run one action against the document it names: `document` (uuid or name), or a
   * `card` written "<document-uuid>:<card>". With neither, the default document.
   */
  async _inDocument(data, fn) {
    if (typeof data.card === 'string') {
      const m = DOC_CARD_RE.exec(data.card.trim());
      if (m) {
        if (data.document && String(data.document) !== m[1]) {
          throw new Error(`card "${data.card}" names document ${m[1]}, but document is ${data.document}.`);
        }
        data.document = m[1];
        data.card = Number(m[2]);
      }
    }
    const want = data.document;
    delete data.document;
    if (want === undefined || want === null || want === '') return fn();

    await this._ensureTarget();
    if (this.resolvedMode === 'desktop') {
      throw new Error('This is a desktop Trellis instance: it serves one document, so there is no document to choose. Run another instance on another port for another document.');
    }
    const doc = await this._resolveDocument(want);
    return docContext.run({ id: doc.id, name: doc.name }, fn);
  }

  async _dispatch(action, data) {
      switch (action) {
        case 'trellisStatus':   return await this.trellisStatus();
        case 'listDocuments':   return await this.listDocuments();
        case 'listBaskets':     return await this.listBaskets(data);
        case 'readBasket':      return await this.readBasket(data);
        case 'readCard':        return await this.readCard(data);
        case 'searchNotes':     return await this.searchNotes(data);
        case 'listTasks':       return await this.listTasks(data);
        case 'getKanban':       return await this.getKanban(data);
        case 'createTask':      return await this.createTask(data);
        case 'createNote':      return await this.createNote(data);
        case 'appendNote':      return await this.appendNote(data);
        case 'createBasket':    return await this.createBasket(data);
        case 'setTaskStatus':   return await this.setTaskStatus(data);
        case 'completeTask':    return await this.setTaskStatus({ ...data, status: 'done' });
        case 'listChannels':    return await this.listChannels(data);
        case 'readChannel':     return await this.readChannel(data);
        case 'replyChannel':    return await this.replyChannel(data);
        case 'listAgents':      return await this.listAgents();
        case 'getPluginConfig': return this.getPluginConfig();
        default:
          throw new Error(`Unknown action: ${action}`);
      }
  }

  // ---------------------------------------------------------------- transport

  /** Base URL without a trailing slash or a pasted-in `/api`. */
  _base() {
    return String(this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/api$/, '');
  }

  /** The name this agent signs channel messages and change-log entries with. */
  _agentName() {
    return process.env.AGENT_NAME || this.agent?.config?.name || 'LANAgent';
  }

  /**
   * One HTTP call, with the failure modes that actually happen turned into messages an
   * operator can act on. `path` is used as given — callers build it with _path().
   */
  async _request(method, path, body = null, timeoutMs = null) {
    const url = `${this._base()}${path}`;
    const web = this.resolvedMode !== 'desktop';
    try {
      const response = await axios.request({
        method,
        url,
        data: body ?? undefined,
        timeout: timeoutMs || this.config.timeoutMs,
        headers: {
          'X-API-Key': this.credentials?.apiKey,
          'X-Agent': this._agentName(),
          'Content-Type': 'application/json'
        },
        validateStatus: () => true
      });

      const serverError = response.data?.error;
      if (response.status === 401) {
        throw new Error(web
          ? `Trellis rejected the API key (401)${serverError ? `: ${serverError}` : ''}. Mint a key at ${this._base()} (POST /api/keys while signed in) and set it in Settings → Plugins → trellis-notes.`
          : 'Trellis rejected the API key (401). Update it in Settings → Plugins → trellis-notes.');
      }
      if (response.status === 403) {
        throw new Error(web
          ? `Trellis refused this call for this key (403)${serverError ? `: ${serverError}` : ''} — a key scoped to a document or basket cannot reach outside it.`
          : 'The Trellis Agent API is disabled — no key is set in the app (Tools → Settings → Agent API).');
      }
      if (response.status >= 400) {
        const err = new Error(serverError || (response.status === 404 ? `Not found: ${path}` : `Trellis returned HTTP ${response.status}`));
        err.status = response.status;
        throw err;
      }
      this.reachable = true;
      return response.data;
    } catch (error) {
      if (['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
        this.reachable = false;
        throw new Error(web
          ? `Trellis is not answering at ${this._base()} (${error.code}).`
          : `Trellis is not answering at ${this._base()} — the app is closed, or it is on another host and LAN access is off (Tools → Settings → LAN access).`);
      }
      throw error;
    }
  }

  /**
   * Work out which server this is and, on the web, which document to use. Cached;
   * a failure leaves nothing cached so the next call tries again.
   */
  async _ensureTarget() {
    if (this.resolvedMode && (this.resolvedMode === 'desktop' || this._docs)) return;

    const mode = MODES.includes(this.config.mode) ? this.config.mode : 'auto';
    let detected = mode === 'auto' ? null : mode;

    if (detected !== 'web') {
      // The desktop's identity route. The web server answers it 404 — that, not a
      // hostname, is what tells the two apart, so a self-hosted web server works too.
      try {
        this.resolvedMode = 'desktop';
        const info = await this._request('get', '/api/instance', null, 5000);
        // `app` is the contract: the desktop says "trellis"; trellis-web (v0.50.0+)
        // answers this route too, with "trellis-web" and no key needed. Older web
        // servers 404 it (handled below).
        if (info?.app === 'trellis-web') {
          if (detected === 'desktop') throw new Error('TRELLIS_MODE=desktop, but this server says it is trellis-web.');
        } else if (info?.app === 'trellis' || info?.document) {
          this.instanceInfo = info;
          this.documentName = info.document || null;
          return;
        }
      } catch (error) {
        if (detected === 'desktop') { this.resolvedMode = null; throw error; }
        // Key on the status, not the wording: the web server answers this route
        // "no such API route", and a message-text match would miss it.
        if (error.status !== 404) {
          // Unreachable / refused: do not guess a mode from a network failure.
          this.resolvedMode = null;
          throw error;
        }
      }
      detected = 'web';
    }

    this.resolvedMode = 'web';
    try {
      const doc = await this._pickDocument();
      this.documentId = doc ? doc.id : null;
      this.documentName = doc ? doc.name : null;
    } catch (error) {
      this.resolvedMode = null;
      this._docs = null;
      throw error;
    }
  }

  /**
   * Web: the documents THIS KEY can reach, normalised to [{id, name, access, baskets}].
   * GET /api/agent answers for the key's scope; GET /api/documents answers for the
   * account, and a basket-scoped key 404s on documents that list shows (seen live
   * 2026-09-25: a key scoped to one basket in "WebNotes" was also offered "Doodly").
   */
  async _listWebDocuments({ fresh = false } = {}) {
    if (!fresh && this._docs && Date.now() - this._docs.at < DOCS_TTL_MS) return this._docs.list;
    const list = await this._fetchWebDocuments();
    this._docs = { list, at: Date.now() };
    return list;
  }

  async _fetchWebDocuments() {
    try {
      const agent = await this._request('get', '/api/agent');
      if (Array.isArray(agent?.documents)) {
        return agent.documents.map(d => ({
          id: d.id, name: d.name, access: d.access || null,
          baskets: Array.isArray(d.baskets) ? d.baskets : null
        }));
      }
    } catch (error) {
      if (error.status !== 404) throw error;   // an older server without /api/agent
    }
    const data = await this._request('get', '/api/documents');
    const list = Array.isArray(data) ? data : (data?.documents || []);
    return list.map(d => ({ id: d.id, name: d.name, access: d.access || null, baskets: null }));
  }

  async _pickDocument() {
    const docs = await this._listWebDocuments();
    if (!docs.length) throw new Error('This Trellis key reaches no documents.');
    const want = this.config.document ? String(this.config.document).trim() : '';
    if (want) {
      const byId = docs.find(d => d.id === want);
      if (byId) return byId;
      const byName = docs.filter(d => String(d.name || '').toLowerCase() === want.toLowerCase());
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) throw new Error(`TRELLIS_DOCUMENT "${want}" matches ${byName.length} documents — use the id: ${byName.map(d => d.id).join(', ')}.`);
      throw new Error(`No Trellis document "${want}". This key reaches: ${docs.map(d => `${d.name} (${d.id})`).join(', ')}.`);
    }
    if (docs.length === 1) return docs[0];
    // Several and no default: every call must name its document. Not an error here —
    // listDocuments and listChannels work without one.
    return null;
  }

  /** A document the key reaches, by uuid or (unambiguous) name. */
  async _resolveDocument(ref) {
    const want = String(ref).trim();
    let docs = await this._listWebDocuments();
    let hit = docs.find(d => d.id === want);
    if (!hit && UUID_RE.test(want)) {
      docs = await this._listWebDocuments({ fresh: true });   // a document shared in the last 5 min
      hit = docs.find(d => d.id === want);
    }
    if (hit) return hit;
    const byName = docs.filter(d => String(d.name || '').toLowerCase() === want.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`"${want}" matches ${byName.length} documents — use the uuid: ${byName.map(d => d.id).join(', ')}.`);
    throw new Error(`This key does not reach a document "${want}". It reaches: ${docs.map(d => `${d.name} (${d.id})`).join(', ')}.`);
  }

  /** The documents to follow for channels: TRELLIS_DOCUMENTS, else every one the key reaches. */
  async _followedDocuments() {
    const docs = await this._listWebDocuments();
    const wanted = String(this.config.documents || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!wanted.length) return docs;
    return docs.filter(d => wanted.includes(d.id) || wanted.some(w => w.toLowerCase() === String(d.name).toLowerCase()));
  }

  /** Run fn with `doc` as the current document (used by the channel listener). */
  _runInDocument(doc, fn) {
    return docContext.run({ id: doc.id, name: doc.name }, fn);
  }

  /** The document the current call runs against (web). */
  _currentDoc() {
    const ctx = docContext.getStore();
    if (ctx?.id) return ctx;
    if (this.documentId) return { id: this.documentId, name: this.documentName };
    const names = (this._docs?.list || []).map(d => `${d.name} (${d.id})`).join(', ');
    throw new Error(`This key reaches several Trellis documents and no default is set — pass document, or set TRELLIS_DOCUMENT. Documents: ${names}.`);
  }

  /**
   * Address a route for the current server. `route` is the desktop spelling, and
   * since web v0.51.0 it is the web spelling too — /api/tasks, /api/kanban and
   * /api/search included — with the document as ?document=<id>. One path shape;
   * the desktop simply gets no document parameter.
   */
  _path(route, query = {}) {
    const p = route;
    const q = { ...query };
    if (this.resolvedMode === 'web') q.document = this._currentDoc().id;
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return qs ? `${p}?${qs}` : p;
  }

  /** _ensureTarget + _request on a routed path. */
  async _call(method, route, { query = {}, body = null, timeoutMs = null } = {}) {
    await this._ensureTarget();
    return this._request(method, this._path(route, query), body, timeoutMs);
  }

  // ---------------------------------------------------------------- resolvers

  /** The basket tree flattened: [{id, title, cards, depth, parent, path}]. Both servers answer /api/tree nested. */
  async _flatTree() {
    const { roots } = await this._call('get', '/api/tree');
    const out = [];
    const seen = new Set();   // server data: guard the walk
    const walk = (node, depth, parent, path) => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);
      const here = { id: node.id, title: node.title, cards: node.cards, depth, parent, path: path ? `${path} › ${node.title}` : node.title };
      out.push(here);
      for (const c of node.children || []) walk(c, depth + 1, node.id, here.path);
    };
    for (const r of roots || []) walk(r, 0, null, '');
    return out;
  }

  /** Accept a node id or a node title (case-insensitive); never guess between two matches. */
  async _resolveNode(ref, { allowDefault = false, nodes = null } = {}) {
    let target = ref;
    if ((target === undefined || target === null || target === '') && allowDefault) {
      target = this.config.defaultBasket;
    }
    if (target === undefined || target === null || target === '') {
      throw new Error('No basket given, and no defaultBasket is configured for this plugin.');
    }

    const list = nodes || await this._flatTree();

    if (typeof target === 'number' || /^\d+$/.test(String(target))) {
      const id = Number(target);
      const hit = list.find(n => n.id === id);
      if (!hit) throw new Error(`No basket with id ${id}.`);
      return hit;
    }

    const wanted = String(target).trim().toLowerCase();
    const exact = list.filter(n => String(n.title).toLowerCase() === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`"${target}" matches ${exact.length} baskets (${exact.map(n => `${n.path} = ${n.id}`).join('; ')}). Use the id — basket titles repeat across projects.`);
    }

    const partial = list.filter(n => String(n.title).toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${target}" is ambiguous: ${partial.slice(0, 8).map(n => `${n.title} (${n.id})`).join(', ')}.`);
    }
    throw new Error(`No basket matching "${target}".`);
  }

  /** Ids of a basket and every basket under it. */
  _subtreeIds(nodes, rootId) {
    const ids = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (n.parent !== null && ids.has(n.parent) && !ids.has(n.id)) { ids.add(n.id); grew = true; }
      }
    }
    return ids;
  }

  /** Accept a card id (anywhere) or a card title within one basket. */
  async _resolveCard(nodeId, ref) {
    if (ref === undefined || ref === null || ref === '') {
      throw new Error('No card given.');
    }
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const data = await this._call('get', `/api/cards/${Number(ref)}`);
      return data.card || data;
    }
    if (nodeId === null || nodeId === undefined) {
      throw new Error(`Give the basket, or the card id — "${ref}" is a title and titles repeat across baskets.`);
    }
    const data = await this._call('get', `/api/nodes/${nodeId}/cards`);
    const cards = Array.isArray(data) ? data : (data.cards || []);

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

  /** Resolve {basket?, card}: a numeric card needs no basket. */
  async _resolveCardRef({ basket, card }) {
    const numeric = typeof card === 'number' || /^\d+$/.test(String(card ?? ''));
    const node = numeric && (basket === undefined || basket === null || basket === '')
      ? null
      : await this._resolveNode(basket, { allowDefault: true });
    const target = await this._resolveCard(node ? node.id : null, card);
    return { node, target };
  }

  _trim(text) {
    if (!text) return '';
    const s = String(text);
    return s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}\n… [${s.length - MAX_BODY_CHARS} more chars]` : s;
  }

  _summarizeCard(card, { full = false } = {}) {
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
      out.body = full ? String(card.body || '') : this._trim(card.body);
    }
    const props = card.properties || [];
    if (Array.isArray(props) && props.length) {
      out.properties = props.reduce((acc, p) => { acc[p.key] = p.value; return acc; }, {});
    }
    return out;
  }

  // ------------------------------------------------------------------ actions

  async trellisStatus() {
    await this._ensureTarget();
    if (this.resolvedMode === 'desktop') {
      const info = await this._request('get', '/api/instance', null, 5000);
      this.instanceInfo = info;
      return {
        success: true,
        reachable: true,
        server: 'desktop',
        baseUrl: this._base(),
        document: info.document,
        nodes: info.nodes,
        lanAccess: info.lan,
        unsavedChanges: info.unsaved_changes,
        channelsWaiting: info.channels_waiting ?? null,
        version: info.version,
        note: 'A desktop Trellis instance serves one document — this port is that document.'
      };
    }
    const me = await this._request('get', '/api/me', null, 5000).catch(() => null);
    const docs = await this._listWebDocuments();
    let current = null;
    try { current = this._currentDoc(); } catch { /* several documents and no default */ }
    if (!current) {
      return {
        success: true,
        reachable: true,
        server: 'web',
        baseUrl: this._base(),
        account: me ? (me.email || me.name || me.id || null) : null,
        document: null,
        documents: docs.map(d => ({ id: d.id, name: d.name })),
        note: 'This key reaches several documents and no default is set: pass document on each call, or set TRELLIS_DOCUMENT.'
      };
    }
    const doc = await this._request('get', `/api/documents/${encodeURIComponent(current.id)}`, null, 8000);
    this.instanceInfo = { document: doc.name, nodes: (doc.nodes || []).length };
    return {
      success: true,
      reachable: true,
      server: 'web',
      baseUrl: this._base(),
      account: me ? (me.email || me.name || me.id || null) : null,
      document: doc.name,
      documentId: current.id,
      isDefault: current.id === this.documentId,
      documentsReachable: docs.length,
      access: doc.access || null,
      partial: !!doc.partial,
      nodes: (doc.nodes || []).length,
      channels: doc.channels ?? null,
      channelsWaiting: doc.channels_waiting ?? null
    };
  }

  async listDocuments() {
    await this._ensureTarget();
    if (this.resolvedMode === 'desktop') {
      return {
        success: true,
        server: 'desktop',
        documents: [{ id: null, name: this.documentName, current: true }],
        note: 'The desktop app serves one document per port; run another instance on another port for another document.'
      };
    }
    const docs = await this._listWebDocuments({ fresh: true });
    const followed = new Set((await this._followedDocuments()).map(d => d.id));
    return {
      success: true,
      server: 'web',
      count: docs.length,
      default: this.documentId,
      documents: docs.map(d => ({ ...d, default: d.id === this.documentId, followed: followed.has(d.id) })),
      hint: docs.length > 1
        ? 'Pass document (uuid or name) on any action, or "<uuid>:<card>" as a card; TRELLIS_DOCUMENT sets the default, TRELLIS_DOCUMENTS which ones are followed.'
        : undefined
    };
  }

  async listBaskets({ project = null } = {}) {
    let list = await this._flatTree();
    if (project) {
      const wanted = String(project).toLowerCase();
      list = list.filter(n => n.path.toLowerCase().includes(wanted));
      if (!list.length) throw new Error(`No baskets under a project matching "${project}".`);
    }
    return {
      success: true,
      document: this.documentName,
      count: list.length,
      baskets: list.map(({ parent, ...rest }) => rest),
      hint: 'Use path, not title, to tell projects apart — basket names like "Open Items" repeat.'
    };
  }

  async readBasket({ basket, includeBodies = true } = {}) {
    const node = await this._resolveNode(basket, { allowDefault: true });
    const data = await this._call('get', `/api/nodes/${node.id}`);
    const cards = (data.cards || []).map(c => includeBodies
      ? this._summarizeCard(c)
      : { id: c.id, kind: c.kind, title: c.title || '(untitled)' });

    return {
      success: true,
      basket: { id: node.id, title: node.title, path: node.path },
      groups: (data.groups || []).map(g => ({ title: g.title, cards: g.cards })),
      count: cards.length,
      cards
    };
  }

  async readCard({ card } = {}) {
    if (!(typeof card === 'number' || /^\d+$/.test(String(card ?? '')))) {
      throw new Error('readCard needs a card id (a number). Use readBasket or searchNotes to find one.');
    }
    const data = await this._call('get', `/api/cards/${Number(card)}`);
    const c = data.card || data;
    return {
      success: true,
      basket: data.node ?? null,
      basketPath: data.node_path ?? null,
      card: this._summarizeCard(c, { full: true })
    };
  }

  async searchNotes({ query, limit = MAX_HITS } = {}) {
    if (!query || !String(query).trim()) throw new Error('searchNotes needs a query.');
    const data = await this._call('get', '/api/search', { query: { q: String(query).trim() } });
    const all = data.hits || [];
    const hits = all.slice(0, Math.min(Number(limit) || MAX_HITS, MAX_HITS));
    return {
      success: true,
      query,
      count: all.length,
      returned: hits.length,
      hits: hits.map(h => ({ basket: h.node_title, basketId: h.node, card: h.card, snippet: this._trim(h.snippet) }))
    };
  }

  /**
   * Agenda bucket from a day number (days since the epoch, as the web sends `due_days`),
   * against today's LOCAL calendar day — the same rule the desktop applies.
   */
  _bucketFor(dueDays) {
    if (!Number.isFinite(dueDays)) return 'later';
    const now = new Date();
    const today = Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
    if (dueDays < today) return 'overdue';
    if (dueDays === today) return 'today';
    if (dueDays <= today + 7) return 'week';
    return 'later';
  }

  /**
   * Restrict agenda/kanban rows to one project's subtree. Done here for both servers:
   * the desktop takes ?project= but the web routes do not document it, and the web
   * server refuses parameters it does not take.
   */
  async _projectFilter(project) {
    if (!project) return null;
    const nodes = await this._flatTree();
    const node = await this._resolveNode(project, { nodes });
    return this._subtreeIds(nodes, node.id);
  }

  async listTasks({ project = null, includeDone = false } = {}) {
    const within = await this._projectFilter(project);
    const data = await this._call('get', '/api/tasks', { query: includeDone ? { all: 'true' } : {} });
    let tasks = data.tasks || [];
    if (!includeDone) tasks = tasks.filter(t => !t.done);
    if (within) tasks = tasks.filter(t => within.has(t.node));

    // The desktop sends `bucket` and `project_title`; the web sends `due_days` (days
    // since the epoch) and `root_title`. Derive what is missing so both read alike.
    tasks = tasks.map(t => ({ ...t, bucket: t.bucket ?? this._bucketFor(t.due_days), project_title: t.project_title ?? t.root_title }));

    const buckets = {};
    for (const t of tasks) (buckets[t.bucket] ||= []).push(t);

    return {
      success: true,
      count: tasks.length,
      byBucket: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      tasks: tasks.map(t => ({
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
    const within = await this._projectFilter(project);
    const data = await this._call('get', '/api/kanban');
    // Desktop: columns is [{status, count, cards}]. Web: {<status>: [cards]}.
    const columns = Array.isArray(data.columns)
      ? data.columns
      : Object.entries(data.columns || {}).map(([status, cards]) => ({ status, count: cards.length, cards }));
    return {
      success: true,
      columns: columns.map(col => {
        const cards = (col.cards || []).filter(c => !within || within.has(c.node));
        return {
          status: col.status,
          count: within ? cards.length : (col.count ?? cards.length),
          cards: cards.map(c => ({ card: c.card, title: c.title, due: c.due, path: c.node_path }))
        };
      })
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

    const created = await this._call('post', `/api/nodes/${node.id}/cards`, { body: payload });
    return {
      success: true,
      created: { card: created.id, basket: node.id, basketTitle: node.title, kind, title: payload.title }
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

    const created = await this._call('post', `/api/nodes/${node.id}/cards`, {
      body: {
        kind: 'text',
        title: String(title).trim(),
        body: lines.join('\n'),
        color: color || 'amber',
        fit: true
      }
    });

    return {
      success: true,
      created: { card: created.id, basket: node.id, basketTitle: node.title, title: String(title).trim(), status, due: due || null },
      note: due ? 'Filed with a due date — it is now in the operator\'s Agenda and Kanban.' : 'Filed without a due date, so it appears on the Kanban but not the Agenda.'
    };
  }

  async appendNote({ basket, card, text } = {}) {
    if (!text || !String(text).trim()) throw new Error('appendNote needs text.');
    const { node, target } = await this._resolveCardRef({ basket, card });

    if (target.kind && target.kind !== 'text' && target.kind !== 'code') {
      throw new Error(`Card "${target.title}" is a ${target.kind} card; appendNote only works on text and code cards.`);
    }

    // The server's append route: never resends the body, so it cannot race the
    // operator editing the same card in the window.
    await this._call('post', `/api/cards/${target.id}/append`, { body: { text: String(text).trim() } });

    return {
      success: true,
      appended: { card: target.id, title: target.title, basket: node?.id ?? null, basketTitle: node?.title ?? null, addedChars: String(text).trim().length }
    };
  }

  async createBasket({ title, parent = null, color = null } = {}) {
    if (!title || !String(title).trim()) throw new Error('createBasket needs a title.');
    const payload = { title: String(title).trim() };
    if (parent) payload.parent = (await this._resolveNode(parent)).id;

    const created = await this._call('post', '/api/nodes', { body: payload });
    if (color) await this._call('patch', `/api/nodes/${created.id}`, { body: { color } });

    return { success: true, created: { basket: created.id, title: payload.title, parent: payload.parent || null } };
  }

  async setTaskStatus({ basket, card, status } = {}) {
    if (!VALID_STATUS.includes(status)) throw new Error(`status must be one of: ${VALID_STATUS.join(', ')}.`);
    const { node, target } = await this._resolveCardRef({ basket, card });

    // Checklist cards have no body, so the property endpoint writes nowhere and
    // the card silently never reaches the board. Say so instead of reporting a
    // success that did nothing.
    if (target.kind === 'checklist') {
      throw new Error(`"${target.title}" is a checklist card. Trellis stores properties in a card body, which checklists do not have — put [status:: ${status}] in the card title instead, or convert it to a text card.`);
    }

    await this._call('post', `/api/cards/${target.id}/property`, { body: { key: 'status', value: status } });
    return { success: true, updated: { card: target.id, title: target.title, status, basketTitle: node?.title ?? null } };
  }

  /**
   * GET /api/agents for the current document, cached 5 minutes. On the web it names the
   * server's BUILT-IN agents (reach basket / document / account since v0.51.0); both servers
   * name the generic model names refused as an agent name. `fresh` re-reads, used when a
   * channel shows a sender we have never seen.
   */
  async _agentsInfo({ fresh = false } = {}) {
    const key = this.resolvedMode === 'web' ? this._currentDoc().id : '';
    const cached = this._agents.get(key);
    if (!fresh && cached && Date.now() - cached.at < DOCS_TTL_MS) return cached;
    let raw = {};
    try {
      raw = await this._call('get', '/api/agents');
    } catch (error) {
      if (error.status !== 404) throw error;   // a server without the route: nothing known
    }
    // On the web a person's message carries their display name or email local part
    // ("portablediag"), not "operator"; the key's owner, from /api/me, is the operator.
    const humans = new Set(['operator']);
    if (this.resolvedMode === 'web') {
      const me = await this._request('get', '/api/me', null, 5000).catch(() => null);
      for (const v of [me?.display_name, me?.email, me?.email ? String(me.email).split('@')[0] : null]) {
        if (v) humans.add(String(v).toLowerCase());
      }
    }
    const info = {
      raw,
      humans,
      builtin: new Set((raw.agents || []).map(a => String(a.name).toLowerCase())),
      generic: new Set((raw.generic || []).map(g => String(g).toLowerCase())),
      at: Date.now()
    };
    this._agents.set(key, info);
    return info;
  }

  /**
   * Who a channel message is from, in the server's own vocabulary: `person`, `builtin`
   * (one of the server's built-in agents) or `agent` (posted with an X-Agent, like this
   * plugin). Web v0.52.0 records `kind` on each message when it is numbered — that wins.
   * Without it (older messages, the desktop) it is inferred: the desktop's "operator" and
   * the key owner's web name are a person, a name GET /api/agents lists is builtin,
   * anything else an agent. `kindSource` says which, so a guess is never read as a fact.
   */
  _senderKind(message, info) {
    if (['person', 'builtin', 'agent'].includes(message?.kind)) return { kind: message.kind, kindSource: 'server' };
    const f = String(message?.from ?? message?.agent ?? message?.author ?? '').toLowerCase();
    if (!f || f === 'operator' || info?.humans?.has(f)) return { kind: 'person', kindSource: 'inferred' };
    if (info?.builtin?.has(f)) return { kind: 'builtin', kindSource: 'inferred' };
    return { kind: 'agent', kindSource: 'inferred' };
  }

  async listAgents() {
    await this._ensureTarget();
    const info = await this._agentsInfo({ fresh: true });
    const raw = info.raw || {};
    const me = this._agentName();
    return {
      success: true,
      document: this.resolvedMode === 'web' ? this._currentDoc().name : this.documentName,
      builtIn: (raw.agents || []).map(a => ({
        name: a.name,
        reach: a.reach || 'basket',
        home: a.document_name || null,
        homeBasket: a.node ?? null,
        channel: a.card ?? null,
        homeIsHere: a.here ?? null,
        active: a.active ?? null,
        lastError: a.last_error ?? null
      })),
      seenInChannels: (raw.projects || []).flatMap(pr => (pr.names || []).map(n => ({ name: n.name, messages: n.messages ?? null, lastAt: n.last_at ?? null }))),
      signingAs: me,
      signingNameRefused: info.generic.has(String(me).toLowerCase())
    };
  }

  /**
   * Channel cards. On the web with no `document` given, every FOLLOWED document is listed
   * (TRELLIS_DOCUMENTS, else all the key reaches) and each row carries its document and a
   * `ref` — "<document-uuid>:<card>" outside the default document — so a reply cannot
   * land in the wrong one. That is TrellisBridge's convention.
   */
  async listChannels({ project = null, waitingOnly = false } = {}) {
    await this._ensureTarget();
    const explicit = docContext.getStore();
    const isWaiting = c => !!(c.waiting ?? c.operator_waiting ?? false);

    const listOne = async (doc) => {
      const query = {};
      if (project) query.project = (await this._resolveNode(project)).id;
      const data = await this._call('get', '/api/channels', { query });
      const rows = Array.isArray(data) ? data : (data.channels || []);
      return rows.map(c => {
        const card = c.card ?? c.cid ?? c.id;
        const inDefault = !doc || doc.id === this.documentId;
        return {
          card,
          ref: inDefault ? String(card) : `${doc.id}:${card}`,
          document: doc ? doc.name : this.documentName,
          documentId: doc ? doc.id : null,
          title: c.title || null,
          path: c.node_path || null,
          waiting: isWaiting(c),
          lastSeq: c.last_seq ?? c.seq ?? null,
          lastFrom: c.last_from ?? null,
          lastKind: c.last_kind ?? null,
          group: c.group ?? null,
          claimedBy: c.claimed_by ?? null
        };
      });
    };

    let channels = [];
    const errors = [];
    if (this.resolvedMode === 'desktop') {
      channels = await listOne(null);
    } else if (explicit) {
      channels = await listOne(explicit);
    } else {
      for (const doc of await this._followedDocuments()) {
        try {
          channels.push(...await docContext.run({ id: doc.id, name: doc.name }, () => listOne(doc)));
        } catch (error) {
          // One document failing (a basket filter it lacks, a revoked share) must not
          // hide the others' waiting messages.
          errors.push(`${doc.name}: ${error.message}`);
        }
      }
    }

    if (waitingOnly) channels = channels.filter(c => c.waiting);
    return {
      success: true,
      count: channels.length,
      waiting: channels.filter(c => c.waiting).length,
      channels,
      ...(errors.length ? { errors } : {})
    };
  }

  async readChannel({ card, since = null, limit = MAX_MESSAGES } = {}) {
    if (!(typeof card === 'number' || /^\d+$/.test(String(card ?? '')))) {
      throw new Error('readChannel needs the channel card id (listChannels shows them).');
    }
    const query = since !== null && since !== undefined && since !== '' ? { since: Number(since) } : {};
    const data = await this._call('get', `/api/cards/${Number(card)}/channel`, { query });
    const messages = Array.isArray(data) ? data : (data.messages || []);
    const tail = messages.slice(-Math.min(Number(limit) || MAX_MESSAGES, 100));
    let agents = null;
    try {
      agents = await this._agentsInfo();
      const senders = tail.filter(m => !m.kind).map(m => String(m.from ?? '').toLowerCase()).filter(f => f && !agents.humans?.has(f));
      // A sender we have never seen may be a built-in agent created since the cache.
      if (senders.some(f => !agents.builtin.has(f)) && Date.now() - agents.at > 30000) agents = await this._agentsInfo({ fresh: true });
    } catch { /* labelling is best-effort; the messages still come back */ }
    return {
      success: true,
      card: Number(card),
      count: messages.length,
      returned: tail.length,
      // Group channels (web v0.56 / desktop v0.203): each message's addressees, as the
      // server computes them, plus the channel's lead.
      group: data.group ?? null,
      lead: data.lead ?? null,
      messages: tail.map(m => ({
        seq: m.seq ?? null,
        from: m.from ?? m.agent ?? m.author ?? null,
        ...(Array.isArray(m.to) ? { to: m.to } : {}),
        ...this._senderKind(m, agents),
        at: m.at ?? m.time ?? m.ts ?? null,
        text: this._trim(m.text ?? m.body ?? '')
      }))
    };
  }

  async replyChannel({ card, text } = {}) {
    if (!(typeof card === 'number' || /^\d+$/.test(String(card ?? '')))) {
      throw new Error('replyChannel needs the channel card id.');
    }
    if (!text || !String(text).trim()) throw new Error('replyChannel needs text.');
    const data = await this._call('post', `/api/cards/${Number(card)}/say`, { body: { text: String(text).trim() } });
    const doc = this.resolvedMode === 'web' ? this._currentDoc() : null;
    return { success: true, card: Number(card), document: doc?.name ?? null, seq: data?.seq ?? null, as: this._agentName() };
  }

  getPluginConfig() {
    return {
      success: true,
      config: {
        baseUrl: this._base(),
        mode: this.config.mode,
        document: this.config.document,
        documents: this.config.documents,
        timeoutMs: this.config.timeoutMs,
        defaultBasket: this.config.defaultBasket,
        apiKey: this.credentials?.apiKey ? '[configured]' : '[not set]'
      },
      state: {
        initialized: this.initialized,
        reachable: this.reachable,
        server: this.resolvedMode,
        documentId: this.documentId,
        document: this.documentName
      }
    };
  }

  async getAICapabilities() {
    return {
      enabled: this.initialized,
      reachable: this.reachable,
      server: this.resolvedMode,
      document: this.documentName,
      examples: [
        'what is on my agenda',
        'search my notes for the vpn flap',
        'file a task in my notes to rotate the gateway key by 2026-08-11',
        'append today\'s ops result to the message board card',
        'is anyone waiting on a reply in my trellis channels'
      ]
    };
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => { acc[cmd.command] = cmd.description; return acc; }, {});
  }

  async cleanup() {
    this.logger.info(`Cleaning up ${this.name} plugin...`);
    if (this.listener) { this.listener.stop(); this.listener = null; }
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
              ? '<div><b>Server</b>' + esc(r.server) + '</div>' +
                '<div><b>Document</b>' + esc(r.document) + '</div>' +
                '<div><b>Baskets</b>' + esc(r.nodes) + '</div>' +
                '<div><b>Waiting</b>' + esc(r.channelsWaiting == null ? '—' : r.channelsWaiting) + '</div>' +
                '<div><b>Endpoint</b>' + esc(r.baseUrl) + '</div>'
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
