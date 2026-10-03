import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { assertPublicUrl } from '../../utils/publicUrl.js';
import { BROWSER_UA } from '../../services/webtools/fetchPublic.js';
import { DATA_PATH, TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH } from '../../utils/paths.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Generic HTTP client: any method, headers, and a JSON, form, raw or multipart body.
 *
 * Every other web tool the agent has is a GET (scraper, fetchPublic), so an API that is
 * POST-only was out of reach: on 2026-10-01 the agent could not sign up at reapption.net
 * (challenge → register → task, all POSTs) and told the channel it had no web tool at all.
 *
 * Secrets: a response field that is a credential (api_key, *_secret, password, access_token…)
 * is stored encrypted under "<host>.<field>" and replaced in the result by a placeholder,
 * `{{secret:<host>.<field>}}`. Later requests put that placeholder in a header, URL or body
 * and it is filled in at send time — only for that same host (or a subdomain), so a key can
 * never be carried to another site. The model and the channel see the placeholder, never the key.
 *
 * Addresses: public only (each redirect hop is checked), so a link cannot walk the agent onto
 * its own LAN. HTTP_TOOL_ALLOW_PRIVATE=true lifts that for the operator's own requests.
 */

const SECRET_FIELD = /^(api[_-]?key|apikey|secret|[a-z]+[_-]secret|secret[_-][a-z]+|password|passwd|pass[_-]?phrase|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret|signing[_-]?key)$/i;
const PLACEHOLDER = /\{\{\s*secret:([a-z0-9._-]+)\s*\}\}/gi;
const MAX_BODY_CHARS = 8000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SHOWN_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'www-authenticate'];

export default class HttpPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'http';
    this.version = '1.0.0';
    this.description = 'Make any HTTP request (GET, POST, PUT, PATCH, DELETE) to a web API with headers and a JSON, form or file-upload body; keys the API returns are saved and reused as {{secret:...}} placeholders';
    this.commands = [
      {
        command: 'request',
        description: 'Send an HTTP request to an API and return status, headers and body. Use for any POST/PUT/PATCH/DELETE, API signups and registrations, authenticated calls and file uploads. Credentials in the response are saved and shown as {{secret:<host>.<field>}}; put that placeholder in a later header or body to use it.',
        usage: 'request({ url: "https://api.example.com/x", method: "POST", headers: { "X-Api-Key": "{{secret:api.example.com.api_key}}" }, json: { ... } | form: { ... } | body: "raw" | multipart: { fields: { ... }, files: [{ field: "file", path: "/abs/path" }] } })',
        examples: [
          'send a POST request to this API',
          'call the API endpoint with a JSON body',
          'register an account through the API',
          'sign up for the service using its agent API',
          'post this JSON to the url',
          'make an HTTP PUT request',
          'send a DELETE request to the endpoint',
          'upload this file to the API',
          'make an authenticated API call with my saved key',
          'curl this endpoint with a POST'
        ]
      },
      {
        command: 'listSecrets',
        description: 'List the names of saved API credentials (never their values)',
        usage: 'listSecrets()',
        examples: ['what API keys have you saved', 'list saved http secrets']
      },
      {
        command: 'saveSecret',
        description: 'Save a credential for a host so it can be used as {{secret:<host>.<name>}}',
        usage: 'saveSecret({ host: "api.example.com", name: "api_key", value: "..." })',
        examples: ['save this API key for that site']
      },
      {
        command: 'forgetSecret',
        description: 'Delete a saved API credential by name',
        usage: 'forgetSecret({ name: "api.example.com.api_key" })',
        examples: ['forget the saved API key for that site']
      }
    ];
    this.secrets = null;
  }

  async initialize() {
    this.initialized = true;
  }

  async execute(params = {}) {
    const { action } = params;
    switch (action) {
      case 'request': return this.request(params);
      case 'listSecrets': return this.listSecrets();
      case 'saveSecret': return this.saveSecret(params);
      case 'forgetSecret': return this.forgetSecret(params);
      default: return { success: false, error: `Unknown action: ${action}. Use request, listSecrets, saveSecret or forgetSecret.` };
    }
  }

  // ---- secrets ------------------------------------------------------------------------------

  async _loadSecrets() {
    if (this.secrets) return this.secrets;
    const stored = await PluginSettings.getCached(this.name, 'secrets').catch(() => null);
    this.secrets = stored && typeof stored === 'object' ? { ...stored } : {};
    return this.secrets;
  }

  async _storeSecret(name, value) {
    const secrets = await this._loadSecrets();
    secrets[name] = { value: encrypt(String(value)), savedAt: new Date().toISOString() };
    await PluginSettings.setCached(this.name, 'secrets', secrets);
  }

  async listSecrets() {
    const secrets = await this._loadSecrets();
    const names = Object.keys(secrets).sort();
    return {
      success: true,
      secrets: names.map(n => ({ name: n, placeholder: `{{secret:${n}}}`, savedAt: secrets[n].savedAt })),
      result: names.length ? names.map(n => `{{secret:${n}}}`).join('\n') : 'No saved secrets.'
    };
  }

  async saveSecret({ host, name, value, _peer }) {
    if (_peer) return { success: false, error: 'Only the operator can save a credential by hand.' };
    if (!host || !name || !value) return { success: false, error: 'host, name and value are required' };
    const key = `${String(host).toLowerCase()}.${fieldName(name)}`;
    await this._storeSecret(key, value);
    return { success: true, result: `Saved as {{secret:${key}}}` };
  }

  async forgetSecret({ name }) {
    const secrets = await this._loadSecrets();
    const key = String(name || '').replace(/^\{\{\s*secret:|\s*\}\}$/g, '').toLowerCase();
    if (!secrets[key]) return { success: false, error: `No saved secret named ${key}` };
    delete secrets[key];
    await PluginSettings.setCached(this.name, 'secrets', secrets);
    return { success: true, result: `Forgot ${key}` };
  }

  /** Replace {{secret:name}} in a string. A secret is only sent to its own host or a subdomain. */
  async _fill(value, host, used) {
    if (typeof value !== 'string' || !value.includes('{{')) return value;
    const secrets = await this._loadSecrets();
    return value.replace(PLACEHOLDER, (whole, rawName) => {
      const name = rawName.toLowerCase();
      const entry = secrets[name];
      if (!entry) throw new Error(`No saved secret named ${name} (listSecrets shows what is saved)`);
      const owner = name.slice(0, name.lastIndexOf('.'));
      if (!(host === owner || host.endsWith(`.${owner}`))) {
        throw new Error(`Secret ${name} belongs to ${owner} and is not sent to ${host}`);
      }
      used.add(name);
      return decrypt(entry.value);
    });
  }

  async _fillDeep(value, host, used) {
    if (typeof value === 'string') return this._fill(value, host, used);
    if (Array.isArray(value)) return Promise.all(value.map(v => this._fillDeep(v, host, used)));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await this._fillDeep(v, host, used);
      return out;
    }
    return value;
  }

  /** Swap credential fields in a parsed response for placeholders, saving the values. */
  async _redact(value, host, saved, depth = 0) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map(v => this._redact(v, host, saved, depth + 1)));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 6) {
        const name = `${host}.${fieldName(k)}`;
        await this._storeSecret(name, v);
        saved.push(name);
        out[k] = `{{secret:${name}}}`;
      } else {
        out[k] = await this._redact(v, host, saved, depth + 1);
      }
    }
    return out;
  }

  // ---- request ------------------------------------------------------------------------------

  async _checkUploadPath(p, peer) {
    const abs = path.resolve(String(p || ''));
    const base = path.basename(abs).toLowerCase();
    if (base.startsWith('.env') || /\/\.ssh\//.test(abs) || /\.(pem|key)$/.test(base) || base === 'ecosystem.config.cjs') {
      throw new Error(`${abs} is not uploaded: it holds credentials`);
    }
    if (peer) {
      const roots = [DATA_PATH, TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, '/tmp'];
      if (!roots.some(r => abs === r || abs.startsWith(r + path.sep))) {
        throw new Error(`Another agent's request can upload only files under ${roots.join(', ')}`);
      }
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new Error(`No file at ${abs}`);
    if (st.size > MAX_UPLOAD_BYTES) throw new Error(`${abs} is ${st.size} bytes; the upload limit is ${MAX_UPLOAD_BYTES}`);
    return abs;
  }

  async request(params) {
    const peer = params._peer || null;
    const method = String(params.method || (params.json || params.form || params.body || params.multipart ? 'POST' : 'GET')).toUpperCase();
    if (!METHODS.includes(method)) return { success: false, error: `method must be one of ${METHODS.join(', ')}` };
    if (!params.url) return { success: false, error: 'url is required' };

    let url;
    try {
      const u = new URL(String(params.url));
      if (params.query && typeof params.query === 'object') {
        for (const [k, v] of Object.entries(params.query)) u.searchParams.set(k, String(v));
      }
      url = u;
    } catch {
      return { success: false, error: `Not a valid URL: ${params.url}` };
    }
    const allowPrivate = !peer && String(process.env.HTTP_TOOL_ALLOW_PRIVATE || '').toLowerCase() === 'true';
    const host = url.hostname.toLowerCase();
    const used = new Set();

    try {
      const target = await this._fill(url.toString(), host, used);
      if (!allowPrivate) await assertPublicUrl(target);

      const headers = { 'User-Agent': `LANAgent/${process.env.AGENT_NAME || 'agent'} (+https://lanagent.net)`, Accept: 'application/json, text/plain, */*' };
      for (const [k, v] of Object.entries(params.headers || {})) headers[k] = await this._fill(String(v), host, used);
      if (params.browserUA) headers['User-Agent'] = BROWSER_UA;

      let body;
      if (params.multipart) {
        const form = new FormData();
        const fields = await this._fillDeep(params.multipart.fields || {}, host, used);
        for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        for (const f of params.multipart.files || []) {
          const abs = await this._checkUploadPath(f.path, peer);
          const bytes = await fs.readFile(abs);
          form.append(f.field || 'file', new Blob([bytes], { type: f.contentType || guessType(abs) }), f.filename || path.basename(abs));
        }
        body = form;
      } else if (params.json !== undefined) {
        body = JSON.stringify(await this._fillDeep(params.json, host, used));
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      } else if (params.form) {
        body = new URLSearchParams(await this._fillDeep(params.form, host, used)).toString();
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
      } else if (params.body !== undefined) {
        if (typeof params.body === 'object') {
          body = JSON.stringify(await this._fillDeep(params.body, host, used));
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        } else {
          body = await this._fill(String(params.body), host, used);
        }
      }
      if (method === 'GET' || method === 'HEAD') body = undefined;

      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 30000, 1000), 120000);
      const res = await this._send(target, { method, headers, body, timeoutMs, allowPrivate });

      const contentType = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RESPONSE_BYTES) throw new Error(`Response is ${buf.length} bytes; limit ${MAX_RESPONSE_BYTES}`);
      const saved = [];
      let data = null;
      let text = null;
      if (/json/i.test(contentType) || /^\s*[[{]/.test(buf.subarray(0, 64).toString())) {
        try { data = await this._redact(JSON.parse(buf.toString('utf8')), new URL(res.url || target).hostname.toLowerCase(), saved); } catch { /* not JSON after all */ }
      }
      if (data === null) {
        text = /^(text\/|application\/(xml|xhtml|javascript|x-www-form-urlencoded))/i.test(contentType) || !contentType
          ? buf.toString('utf8')
          : `<${buf.length} bytes of ${contentType}>`;
      }
      const shownHeaders = {};
      for (const h of SHOWN_HEADERS) if (res.headers.get(h)) shownHeaders[h] = res.headers.get(h);

      const bodyText = data !== null ? JSON.stringify(data, null, 2) : String(text);
      const clipped = bodyText.length > MAX_BODY_CHARS ? `${bodyText.slice(0, MAX_BODY_CHARS)}\n…(${bodyText.length - MAX_BODY_CHARS} more chars)` : bodyText;
      this.logger.info(`[http] ${method} ${host}${url.pathname} → ${res.status}${saved.length ? ` (saved ${saved.join(', ')})` : ''}`);
      return {
        success: res.status < 400,
        status: res.status,
        headers: shownHeaders,
        ...(data !== null ? { data } : { text: clipped }),
        ...(saved.length ? { savedSecrets: saved.map(n => `{{secret:${n}}}`) } : {}),
        ...(res.status >= 400 ? { error: `HTTP ${res.status}` } : {}),
        result: `${method} ${target.replace(/\{\{[^}]+\}\}/g, '…')} → HTTP ${res.status}` +
          (saved.length ? `\nSaved credentials (use these placeholders, never the values): ${saved.map(n => `{{secret:${n}}}`).join(', ')}` : '') +
          `\n${clipped}`
      };
    } catch (err) {
      // An error message can quote a filled-in URL; never echo a secret back.
      let message = err.message || String(err);
      for (const name of used) {
        const v = decrypt((this.secrets || {})[name]?.value || '');
        if (v) message = message.split(v).join(`{{secret:${name}}}`);
      }
      return { success: false, error: message };
    }
  }

  /** fetch with redirects followed by hand, each hop checked for a public address. */
  async _send(target, { method, headers, body, timeoutMs, allowPrivate }) {
    let current = target;
    let m = method;
    let b = body;
    const deadline = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetch(current, { method: m, headers, body: b, redirect: 'manual', signal: deadline });
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const loc = res.headers.get('location');
      if (!loc) return res;
      const next = new URL(loc, current);
      if (next.host !== new URL(current).host) {
        // Never carry credentials to another host.
        for (const k of Object.keys(headers)) if (/^(authorization|cookie|x-.*key.*|x-.*token.*)$/i.test(k)) delete headers[k];
      }
      current = next.toString();
      if (!allowPrivate) await assertPublicUrl(current);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m !== 'GET' && m !== 'HEAD')) {
        m = 'GET'; b = undefined; delete headers['Content-Type'];
      }
    }
    throw new Error('Too many redirects');
  }
}

/** A secret's own name never contains a dot: the part before the last dot is its host. */
function fieldName(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function guessType(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip'
  }[ext] || 'application/octet-stream';
}
