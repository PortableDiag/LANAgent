import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { RfDevice } from '../../models/RfDevice.js';
import { PluginSettings } from '../../models/PluginSettings.js';

/**
 * Home-Defense RF Sensor plugin.
 *
 * Continuous WiFi + Bluetooth presence awareness for ALICE, with a PLUGGABLE
 * capture backend (the operator's in-house watchers, or Kismet later). The
 * backend's native records are normalized once into the common RfDevice shape
 * so the API / WebUI / (future) rules engine stay backend-agnostic.
 *
 * Note: WiFi signal is a 0-100 quality value; BT signal is negative dBm —
 * proximity/threshold logic is band-aware (see cmdSuspicious).
 *
 * Design notes (boot-safety): the constructor and initialize() do NO blocking
 * network I/O — the capture backend is only contacted on-demand from command
 * handlers, each with a hard timeout. A down/absent watcher degrades to an
 * "offline" status, never a boot hang.
 */
export default class HomeDefensePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'home-defense';
    this.version = '1.0.0';
    this.description = 'Home-defense RF sensor — continuous WiFi/Bluetooth presence monitoring with a pluggable capture backend (in-house watchers or Kismet).';

    // Config (env-overridable; localhost-bound defaults, no token needed locally).
    this.backendType = process.env.HOMEDEFENSE_BACKEND || 'inhouse';
    this.wifiApiUrl  = (process.env.HOMEDEFENSE_WIFI_URL  || 'http://127.0.0.1:8079/v1').replace(/\/$/, '');
    this.wifiApiToken = process.env.HOMEDEFENSE_WIFI_TOKEN || '';
    this.btApiUrl    = (process.env.HOMEDEFENSE_BT_URL || 'http://127.0.0.1:8077/api/v1').replace(/\/$/, '');
    this.btApiToken  = process.env.HOMEDEFENSE_BT_TOKEN || '';
    this.httpTimeoutMs = parseInt(process.env.HOMEDEFENSE_HTTP_TIMEOUT_MS || '6000', 10);
    this.persistToDb = process.env.HOMEDEFENSE_PERSIST !== 'false';

    // Telegram alerting. The enable/disable state is a PERSISTED SETTING (not env)
    // so it's toggleable from the WebUI or by asking the agent. Defaults below are
    // only used until the persisted config loads.
    this._alertDefaults = { enabled: false, intervalMinutes: 15, newWindowMinutes: 15, alertNew: true, alertSuspicious: true, alertSpoofing: true, spoofBaselineMinutes: 60, alertOnlyIdentifiable: true };
    this._alertCfg = { ...this._alertDefaults };
    this._alertTimer = null;
    this._alertPrimed = false;       // first cycle silently establishes the baseline (no cold-start flood)
    this._alertedIds = new Set();

    // SSIDs broadcast by many unrelated APs (carrier hotspots, captive portals,
    // default router names). "Same SSID, different-vendor BSSID" is meaningless
    // for these — they're shared globally — so the spoofing detector skips them
    // to avoid false positives. Extend via HOME_DEFENSE_GENERIC_SSIDS (csv).
    this._genericSsids = new Set([
      'xfinitywifi', 'xfinity', 'attwifi', 'att-wifi', 'spectrum', 'spectrumwifi',
      'optimumwifi', 'cablewifi', 'eduroam', 'starbucks wifi', 'google starbucks',
      'guest', 'guestwifi', 'guest wifi', 'public wifi', 'free wifi', 'free wi-fi',
      'netgear', 'linksys', 'dlink', 'd-link', 'tp-link', 'tplink', 'tp-link_extender',
      'belkin', 'asus', 'orbi', 'setup', 'default', 'wireless', 'internet',
      ...String(process.env.HOME_DEFENSE_GENERIC_SSIDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    ]);

    this.commands = [
      { command: 'status',   description: 'Capture backend health + device counts', usage: 'status()',
        examples: ['home defense status', 'is the rf sensor up'] },
      { command: 'networks', description: 'List observed WiFi networks', usage: 'networks({ unknown, open, limit, order })',
        examples: ['list wifi networks', 'show nearby wireless networks', 'what wifi networks are around', 'unknown wifi networks', 'scan for wireless networks nearby'] },
      { command: 'bt-devices', description: 'List observed Bluetooth devices (BLE + Classic)', usage: 'bt-devices({ unknown, type, limit })',
        examples: ['list bluetooth devices', 'show nearby bluetooth devices', 'what bluetooth devices are around', 'unknown bt devices', 'scan for bluetooth devices nearby'] },
      { command: 'devices',  description: 'List observed RF devices (WiFi + BT)', usage: 'devices({ type, trust, unknown, limit })',
        examples: ['list rf devices', 'show detected devices'] },
      { command: 'new', description: 'Recently first-seen devices/networks (WiFi + BT)', usage: 'new({ band, hours })',
        examples: ['are there any new bluetooth devices around', 'any new devices nearby', 'new wifi networks', 'what new wireless devices showed up', 'did any new devices appear recently', 'new bluetooth devices today'] },
      { command: 'suspicious', description: 'Suspicious devices/networks — unknown+close, flagged, open, or threat-tagged', usage: 'suspicious({ band })',
        examples: ['are there any new or suspicious bluetooth devices around', 'any suspicious devices nearby', 'anything suspicious on wifi', 'suspicious wireless devices', 'is anything sketchy around', 'any rogue access points or unknown devices close by', 'should i be worried about any devices nearby'] },
      { command: 'spoofing', description: 'Possible WiFi MAC-spoofing / evil-twin: a known SSID broadcast from a NEW, different-vendor BSSID', usage: 'spoofing()',
        examples: ['is anyone spoofing my wifi', 'check for evil twin access points', 'any rogue access points impersonating my network', 'is someone faking my ssid', 'detect wifi mac spoofing', 'are there fake versions of my network'] },
      { command: 'stats',    description: 'Aggregate stats for charts (WiFi + BT)', usage: 'stats()', examples: ['rf sensor stats'] },
      { command: 'activity', description: 'Devices-over-time buckets for charts', usage: 'activity({ range })', examples: ['rf activity chart'] },
      { command: 'export',   description: 'Export observed devices/networks as CSV or JSON', usage: 'export({ format, band })',
        examples: ['export wifi networks to csv', 'export bluetooth devices as json', 'download rf devices', 'export detected devices'] },
      { command: 'alerts-on', description: 'Enable Telegram alerts for new/suspicious devices', usage: 'alerts-on({ intervalMinutes })',
        examples: ['turn on home defense alerts', 'notify me about new or suspicious devices', 'enable bluetooth and wifi alerts', 'alert me when a new device shows up', 'watch for suspicious devices and message me', 'start rf alerts'] },
      { command: 'alerts-off', description: 'Disable Telegram alerts for new/suspicious devices', usage: 'alerts-off()',
        examples: ['turn off home defense alerts', 'stop notifying me about devices', 'disable bluetooth and wifi alerts', 'mute rf alerts', 'stop watching for new devices'] },
      { command: 'alerts-status', description: 'Show whether device alerts are on + settings', usage: 'alerts-status()',
        examples: ['are device alerts on', 'home defense alert settings', 'is rf alerting enabled'] },
      { command: 'device',   description: 'Get one device by id', usage: 'device({ id })', examples: ['show device AA:BB:CC:DD:EE:FF'] },
      { command: 'set-trust', description: 'Annotate a device trust/label (trusted|unknown|flagged)', usage: 'set-trust({ id, trust, label, notes })',
        examples: ['mark device trusted', 'flag this network'] },
      { command: 'scan',     description: 'Trigger an immediate WiFi scan', usage: 'scan()', examples: ['scan wifi now', 'rescan networks'] },
      { command: 'backends', description: 'List available capture backends + active selection', usage: 'backends()', examples: ['list capture backends'] }
    ];
  }

  async initialize() {
    // Load the persisted alert setting (a single DB doc — no network I/O, won't
    // block boot). The already-alerted key set is persisted too: without it,
    // every restart wiped the dedup memory, and the silent prime only
    // re-silenced devices that happened to be alert-worthy at that instant —
    // anything momentarily out of range / below the RSSI threshold missed the
    // baseline and re-alerted when it re-qualified (same MACs after every
    // deploy, observed 2026-07-14).
    try {
      this._alertCfg = await this._loadAlertConfig();
      this._alertedIds = await this._loadAlertedKeys();
      if (this._alertCfg.enabled) this._startAlertLoop();
    } catch (e) {
      logger.warn(`[home-defense] alert config load failed: ${e.message}`);
    }
    logger.info(`[home-defense] initialized (backend=${this.backendType}, wifi=${this.wifiApiUrl}, bt=${this.btApiUrl}, alerts=${this._alertCfg.enabled ? 'on' : 'off'})`);
    return true;
  }

  async cleanup() {
    this._stopAlertLoop();
    return true;
  }

  // ---- Command dispatch (entry point used by /api/plugin + NL + agents) ----
  async execute(params = {}) {
    const action = params.action;
    try {
      switch (action) {
        case 'status':    return await this.cmdStatus();
        case 'networks':  return await this.cmdNetworks(params);
        case 'bt-devices':
        case 'btDevices': return await this.cmdBtDevices(params);
        case 'stats':     return await this.cmdStats();
        case 'activity':  return await this.cmdActivity(params);
        case 'new':
        case 'new-devices': return await this.cmdNew(params);
        case 'suspicious': return await this.cmdSuspicious(params);
        case 'spoofing': return await this.cmdSpoofing(params);
        case 'export':    return await this.cmdExport(params);
        case 'alerts-on':
        case 'enable-alerts':  return await this.cmdAlertsOn(params);
        case 'alerts-off':
        case 'disable-alerts': return await this.cmdAlertsOff();
        case 'alerts-status':  return await this.cmdAlertsStatus();
        case 'devices':   return await this.cmdDevices(params);
        case 'device':    return await this.cmdDevice(params);
        case 'set-trust':
        case 'setTrust':  return await this.cmdSetTrust(params);
        case 'scan':      return await this.cmdScan();
        case 'backends':  return this.cmdBackends();
        default:
          return { success: false, error: `Unknown action '${action}'. Valid: ${this.commands.map(c => c.command).join(', ')}` };
      }
    } catch (err) {
      logger.error(`[home-defense] action '${action}' failed:`, err);
      return { success: false, error: err.message };
    }
  }

  // ----------------------------- HTTP helper -----------------------------
  async _fetchJson(url, { method = 'GET', token = '', body = null } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.httpTimeoutMs);
    try {
      const headers = { 'Accept': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${(json.error || text || '').slice(0, 120)}`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // --------------------------- Normalization ----------------------------
  /** Parse a backend timestamp — ISO string or unix epoch (s or ms). */
  _toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const d = new Date(v);                       // ISO string
    return isNaN(d.getTime()) ? null : d;
  }

  /** Map a WifiWatcher /v1 network record into the common RfDevice shape. */
  _normalizeWifiNetwork(n) {
    const sec = (n.security || '').toString();
    return {
      deviceId: (n.bssid || '').toUpperCase(),
      type: 'wifi_ap',
      name: n.ssid || (n.hidden ? '<hidden>' : ''),
      ssid: n.ssid || '',
      vendor: n.vendor || '',
      band: n.band || '',
      channel: n.channel != null ? Number(n.channel) : null,
      freq: n.freq != null ? Number(n.freq) : null,
      security: sec,
      rssiLast: n.last_signal != null ? Number(n.last_signal) : null,
      rssiPeak: n.max_signal != null ? Number(n.max_signal) : null,
      firstSeen: this._toDate(n.first_seen),
      lastSeen:  this._toDate(n.last_seen),
      packetCount: n.times_seen != null ? Number(n.times_seen) : 0,
      known: !!n.known,
      label: n.label || '',
      notes: n.notes || '',
      hidden: !!n.hidden,
      threat: !!n.threat,
      source: 'inhouse:wifi',
      backendKey: n.bssid || ''
    };
  }

  /** Map a BluetoothWatcher /api/v1 device record into the common RfDevice shape. */
  _normalizeBtDevice(d) {
    const sources = (d.sources || '').toString();
    const isClassic = /classic|br\/edr/i.test(sources);
    const rawType = (d.type || '').toLowerCase();
    // Prefer the BR/EDR vs BLE distinction; fall back to the watcher's type label.
    let type = isClassic ? 'bt_classic' : 'ble';
    if (rawType.includes('phone') || rawType.includes('audio') || rawType.includes('computer')) {
      type = isClassic ? 'bt_classic' : 'ble';
    }
    return {
      deviceId: (d.mac || '').toUpperCase(),
      type,
      name: d.name || '',
      ssid: '',
      vendor: d.vendor && d.vendor !== '(unknown)' && d.vendor !== '(random/local)' ? d.vendor : (d.vendor || ''),
      band: 'bt',
      channel: null,
      freq: null,
      security: d.type || '',                 // device class label (Phone / Audio/Video / BLE-device)
      rssiLast: d.last_rssi != null ? Number(d.last_rssi) : null,
      rssiPeak: d.last_rssi != null ? Number(d.last_rssi) : null,
      firstSeen: this._toDate(d.first_seen),
      lastSeen:  this._toDate(d.last_seen),
      packetCount: d.times_seen != null ? Number(d.times_seen) : 0,
      known: !!d.known,
      label: d.label || '',
      notes: d.notes || '',
      hidden: false,
      threat: !!d.threat,
      source: 'inhouse:bt',
      backendKey: d.mac || ''
    };
  }

  async _persist(records) {
    if (!this.persistToDb || !records.length) return;
    await Promise.allSettled(records.map(r => RfDevice.upsertNormalized(r)));
  }

  // ------------------------------ Commands ------------------------------
  async cmdStatus() {
    const out = { success: true, backend: this.backendType, wifi: { url: this.wifiApiUrl, up: false }, bt: { url: this.btApiUrl || null, up: false, note: this.btApiUrl ? undefined : 'BT backend not configured' } };
    try {
      const h = await this._fetchJson(`${this.wifiApiUrl}/health`, { token: this.wifiApiToken });
      out.wifi.up = true;
      out.wifi.health = h;
    } catch (e) {
      out.wifi.error = e.message;
    }
    if (this.btApiUrl) {
      try { await this._fetchJson(`${this.btApiUrl}/health`, { token: this.btApiToken }); out.bt.up = true; }
      catch (e) { out.bt.error = e.message; }
    }
    if (this.persistToDb) {
      try { out.storedDevices = await RfDevice.estimatedDocumentCount(); } catch { /* db optional */ }
    }
    return out;
  }

  async cmdNetworks(params = {}) {
    const q = new URLSearchParams();
    if (params.unknown) q.set('unknown', '1');
    if (params.open) q.set('open', '1');
    q.set('order', params.order || 'last_seen');
    q.set('limit', String(params.limit || 200));
    const data = await this._fetchJson(`${this.wifiApiUrl}/networks?${q.toString()}`, { token: this.wifiApiToken });
    const list = Array.isArray(data) ? data : (data.networks || data.items || []);
    const normalized = list.map(n => this._normalizeWifiNetwork(n));
    await this._persist(normalized);
    return { success: true, count: normalized.length, networks: normalized };
  }

  async cmdBtDevices(params = {}) {
    if (!this.btApiUrl) return { success: false, error: 'BT backend not configured' };
    const q = new URLSearchParams();
    if (params.unknown) q.set('unknown', '1');
    if (params.type) q.set('type', params.type);
    q.set('order', params.order || 'last_seen');
    q.set('limit', String(params.limit || 300));
    const data = await this._fetchJson(`${this.btApiUrl}/devices?${q.toString()}`, { token: this.btApiToken });
    const list = Array.isArray(data) ? data : (data.devices || data.items || []);
    const normalized = list.map(d => this._normalizeBtDevice(d));
    await this._persist(normalized);
    return { success: true, count: normalized.length, devices: normalized };
  }

  /** Aggregate stats from both backends for charts. Never throws on a down backend. */
  async cmdStats() {
    const out = { success: true, wifi: null, bt: null };
    try { out.wifi = await this._fetchJson(`${this.wifiApiUrl}/stats`, { token: this.wifiApiToken }); } catch (e) { out.wifiError = e.message; }
    if (this.btApiUrl) {
      try { out.bt = await this._fetchJson(`${this.btApiUrl}/stats`, { token: this.btApiToken }); } catch (e) { out.btError = e.message; }
    }
    return out;
  }

  /** Devices-over-time buckets from both backends (for the activity chart). */
  async cmdActivity(params = {}) {
    const range = params.range || '24h';
    const out = { success: true, range, wifi: [], bt: [] };
    try { const w = await this._fetchJson(`${this.wifiApiUrl}/activity?range=${range}`, { token: this.wifiApiToken }); out.wifi = w.buckets || []; } catch (e) { out.wifiError = e.message; }
    if (this.btApiUrl) {
      try { const b = await this._fetchJson(`${this.btApiUrl}/activity?range=${range}`, { token: this.btApiToken }); out.bt = b.buckets || []; } catch (e) { out.btError = e.message; }
    }
    return out;
  }

  async cmdDevices(params = {}) {
    // Devices come from the DB (union of all backends/history); refresh both first.
    try { await this.cmdNetworks({ limit: 500 }); } catch (e) { logger.warn(`[home-defense] wifi refresh failed: ${e.message}`); }
    try { await this.cmdBtDevices({ limit: 500 }); } catch (e) { logger.warn(`[home-defense] bt refresh failed: ${e.message}`); }
    const filter = {};
    if (params.type) filter.type = params.type;
    if (params.trust) filter.trust = params.trust;
    if (params.unknown) filter.known = false;
    const limit = Math.min(parseInt(params.limit || '500', 10), 2000);
    const devices = await RfDevice.find(filter).sort({ lastSeen: -1 }).limit(limit).lean();
    return { success: true, count: devices.length, devices };
  }

  /** Refresh both backends so a DB query reflects what's in range right now. */
  async _refreshAll() {
    await Promise.allSettled([
      this.cmdNetworks({ limit: 500 }).catch(() => {}),
      this.btApiUrl ? this.cmdBtDevices({ limit: 500 }).catch(() => {}) : Promise.resolve()
    ]);
  }

  _bandFilter(band) {
    if (!band) return {};
    const b = String(band).toLowerCase();
    if (/bt|blue/.test(b)) return { type: { $in: ['ble', 'bt_classic'] } };
    if (/wifi|wireless|network/.test(b)) return { type: { $in: ['wifi_ap', 'wifi_client'] } };
    return {};
  }

  /** Devices/networks first seen within the last N hours (default 24). */
  async cmdNew(params = {}) {
    await this._refreshAll();
    const hours = Math.max(parseFloat(params.hours || params.window || 24), 0.1);
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const filter = { firstSeen: { $gte: since }, ...this._bandFilter(params.band) };
    const items = await RfDevice.find(filter).sort({ firstSeen: -1 }).limit(200).lean();
    return {
      success: true, windowHours: hours, since: since.toISOString(), count: items.length,
      summary: items.length ? `${items.length} new device(s) in the last ${hours}h` : `No new devices in the last ${hours}h`,
      devices: items
    };
  }

  /**
   * Suspicious = anything an operator would want flagged:
   *  - operator-flagged (trust=flagged) or backend threat
   *  - open WiFi network (no encryption)
   *  - unknown AND very close (rssi >= -55 — right next to the sensor)
   * Each result carries a `reasons` array so the agent can explain itself.
   */
  async cmdSuspicious(params = {}) {
    await this._refreshAll();
    // Signal scales differ by band: BT is negative dBm (closer→0), WiFi is a
    // 0-100 quality value (higher=stronger). "Very close" must be band-aware.
    const BT_CLOSE_DBM = parseInt(params.btCloseRssi || -60, 10);
    const WIFI_CLOSE_PCT = parseInt(params.wifiClosePct || 70, 10);
    const filter = {
      $or: [
        { trust: 'flagged' },
        { threat: true },
        { type: 'wifi_ap', security: { $in: ['', 'open', 'none', 'Open', 'OPEN', 'None'] } },
        { known: false, type: { $in: ['ble', 'bt_classic'] }, rssiLast: { $gte: BT_CLOSE_DBM } },
        { known: false, type: 'wifi_ap', rssiLast: { $gte: WIFI_CLOSE_PCT } }
      ],
      ...this._bandFilter(params.band)
    };
    const items = await RfDevice.find(filter).sort({ rssiLast: -1 }).limit(200).lean();
    const flagged = items.map(d => {
      const reasons = [];
      const isBt = d.type === 'ble' || d.type === 'bt_classic';
      if (d.trust === 'flagged') reasons.push('operator-flagged');
      if (d.threat) reasons.push('backend threat');
      if (d.type === 'wifi_ap' && /^(open|none|)$/i.test(d.security || '')) reasons.push('open network (no encryption)');
      if (!d.known && isBt && d.rssiLast != null && d.rssiLast >= BT_CLOSE_DBM) reasons.push(`unknown & very close (${d.rssiLast} dBm)`);
      if (!d.known && d.type === 'wifi_ap' && d.rssiLast != null && d.rssiLast >= WIFI_CLOSE_PCT) reasons.push(`unknown & strong signal (${d.rssiLast}%)`);
      return { ...d, reasons };
    });
    return {
      success: true, count: flagged.length,
      summary: flagged.length ? `${flagged.length} suspicious device(s) in range` : 'Nothing suspicious in range',
      devices: flagged
    };
  }

  /** OUI = the vendor-assigned first 3 octets of a MAC/BSSID (AA:BB:CC). */
  _ouiOf(mac) {
    return String(mac || '').toUpperCase().split(':').slice(0, 3).join(':');
  }

  /**
   * A locally-administered MAC has the 2nd-least-significant bit of the first
   * octet set. Real AP hardware uses a globally-unique (OUI-assigned) address;
   * an LAA on an AP impersonating a real-OUI network is a spoof tell (randomized
   * to hide the hardware).
   */
  _isLocallyAdministered(mac) {
    const first = parseInt(String(mac || '').split(':')[0], 16);
    return Number.isFinite(first) && (first & 0x02) !== 0;
  }

  _isGenericSsid(ssid) {
    const s = String(ssid || '').trim().toLowerCase();
    if (!s) return true;
    return this._genericSsids.has(s);
  }

  _isEncryptedSecurity(sec) {
    return /wpa|wep|rsn|psk|eap|802\.1x|sae/i.test(String(sec || ''));
  }
  _isOpenSecurity(sec) {
    return /^(open|none|)$/i.test(String(sec || '').trim());
  }

  /**
   * Detect possible WiFi MAC-spoofing / evil-twin APs: a real, non-generic SSID
   * with an ESTABLISHED baseline that is now ALSO being broadcast from a NEW
   * BSSID whose hardware vendor differs from the baseline.
   *
   * Designed to avoid false positives:
   *  - Generic/public/default SSIDs are skipped (shared by many unrelated APs).
   *  - Requires a baseline BSSID for the SSID (operator-known/trusted, or seen
   *    longer than spoofBaselineMinutes) — without one, nothing is an "impostor".
   *  - A new BSSID is flagged ONLY when its OUI *and* vendor name differ from
   *    every baseline BSSID. Same-vendor extra BSSIDs (mesh nodes, range
   *    extenders, the 2.4/5 GHz radios of one router) are normal and never flag.
   *  - BSSIDs the operator marked trusted/known are never treated as impostors,
   *    so a legitimate multi-vendor setup can be silenced permanently after one
   *    look (set-trust → trusted).
   *  - A locally-administered/randomized impostor MAC, or a security downgrade
   *    (secured baseline → open clone), are reported as extra confidence.
   */
  async cmdSpoofing(params = {}) {
    await this._refreshAll();
    const baselineMs = Math.max(1, parseInt(params.baselineMinutes || this._alertCfg.spoofBaselineMinutes || 60, 10)) * 60000;
    const baselineCutoff = new Date(Date.now() - baselineMs);

    // All WiFi APs with a usable SSID (hidden / empty can't be compared).
    const aps = await RfDevice.find({ type: 'wifi_ap' }).lean();
    const bySsid = new Map();
    for (const ap of aps) {
      if (!ap.ssid || ap.hidden || ap.name === '<hidden>') continue;
      if (this._isGenericSsid(ap.ssid)) continue;
      const key = ap.ssid.trim().toLowerCase();
      if (!bySsid.has(key)) bySsid.set(key, []);
      bySsid.get(key).push(ap);
    }

    const flagged = [];
    for (const [, group] of bySsid) {
      if (group.length < 2) continue; // one BSSID for the SSID → nothing to compare
      // Baseline = the established, legitimate identity for this SSID.
      const baseline = group.filter(ap =>
        ap.known || ap.trust === 'trusted' || (ap.firstSeen && new Date(ap.firstSeen) <= baselineCutoff)
      );
      if (!baseline.length) continue; // no established identity yet — can't judge
      const baseOuis = new Set(baseline.map(ap => this._ouiOf(ap.deviceId)));
      const baseVendors = new Set(baseline.map(ap => String(ap.vendor || '').trim().toLowerCase()).filter(v => v && !/random|local|unknown/.test(v)));
      const baseEncrypted = baseline.some(ap => this._isEncryptedSecurity(ap.security));
      const baseLabel = baseline.find(ap => ap.vendor)?.vendor || baseline[0].deviceId;

      for (const ap of group) {
        if (baseline.includes(ap)) continue;
        if (ap.known || ap.trust === 'trusted') continue; // operator-vouched → not an impostor
        const oui = this._ouiOf(ap.deviceId);
        if (baseOuis.has(oui)) continue;                  // same hardware OUI → mesh/dual-band, not spoofing
        const apVendor = String(ap.vendor || '').trim().toLowerCase();
        const laa = this._isLocallyAdministered(ap.deviceId);
        // Different real vendor, OR a randomized MAC impersonating a real-OUI net.
        const vendorDiffers = apVendor && !/random|local|unknown/.test(apVendor) && !baseVendors.has(apVendor);
        const primaryTell = vendorDiffers || (laa && baseVendors.size > 0);
        if (!primaryTell) continue;                       // unknown vendor & not LAA → too ambiguous to flag

        const reasons = [];
        if (vendorDiffers) reasons.push(`different hardware vendor (${ap.vendor} vs ${baseLabel})`);
        if (laa) reasons.push('randomized/locally-administered MAC');
        if (baseEncrypted && this._isOpenSecurity(ap.security)) reasons.push('open clone of a secured network');
        flagged.push({ ...ap, reasons, spoofedSsid: ap.ssid, baselineBssid: baseline.map(b => b.deviceId), baselineVendor: baseLabel });
      }
    }
    flagged.sort((a, b) => (b.rssiLast ?? -999) - (a.rssiLast ?? -999));
    return {
      success: true, count: flagged.length,
      summary: flagged.length
        ? `${flagged.length} possible spoofing/evil-twin AP(s): a known SSID seen from a new, different-vendor BSSID`
        : 'No WiFi spoofing detected (no known SSID is being broadcast from an unexpected, different-vendor BSSID)',
      devices: flagged
    };
  }

  /** Export observed devices/networks as CSV or JSON. Returns the content string. */
  async cmdExport(params = {}) {
    await this._refreshAll();
    const format = /json/i.test(params.format || 'csv') ? 'json' : 'csv';
    const band = (params.band || 'all').toLowerCase();
    const filter = this._bandFilter(/wifi|wireless|network/.test(band) ? 'wifi' : (/bt|blue/.test(band) ? 'bt' : ''));
    const fields = ['deviceId', 'type', 'name', 'ssid', 'vendor', 'band', 'channel', 'security',
      'hidden', 'rssiLast', 'rssiPeak', 'firstSeen', 'lastSeen', 'packetCount', 'known', 'trust', 'label', 'source'];
    const rows = await RfDevice.find(filter).sort({ lastSeen: -1 }).limit(5000)
      .select(fields.join(' ') + ' -_id').lean();
    const tag = /wifi/.test(band) ? 'wifi' : (/bt|blue/.test(band) ? 'bluetooth' : 'rf');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `homedefense-${tag}-${stamp}.${format}`;

    let content;
    if (format === 'json') {
      content = JSON.stringify(rows, null, 2);
    } else {
      const esc = (v) => {
        if (v == null) return '';
        if (v instanceof Date) v = v.toISOString();
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [fields.join(',')];
      for (const r of rows) lines.push(fields.map(f => esc(r[f])).join(','));
      content = lines.join('\n');
    }
    return { success: true, format, band, filename, count: rows.length,
      contentType: format === 'json' ? 'application/json' : 'text/csv', content };
  }

  // ----------------------------- Alerting -------------------------------
  async _loadAlertConfig() {
    const doc = await PluginSettings.findOne({ pluginName: this.name, settingsKey: 'alertConfig' });
    return { ...this._alertDefaults, ...(doc && doc.settingsValue ? doc.settingsValue : {}) };
  }
  async _saveAlertConfig(cfg) {
    await PluginSettings.findOneAndUpdate(
      { pluginName: this.name, settingsKey: 'alertConfig' },
      { $set: { settingsValue: cfg, updatedAt: new Date() }, $setOnInsert: { pluginName: this.name, settingsKey: 'alertConfig' } },
      { upsert: true }
    );
  }

  // Persisted already-alerted identity keys, so dedup memory survives restarts.
  // Capped by insertion order (Set preserves it) — oldest keys age out first.
  static get ALERTED_KEYS_CAP() { return 5000; }
  async _loadAlertedKeys() {
    try {
      const doc = await PluginSettings.findOne({ pluginName: this.name, settingsKey: 'alertedKeys' });
      const arr = Array.isArray(doc?.settingsValue) ? doc.settingsValue : [];
      return new Set(arr.slice(-HomeDefensePlugin.ALERTED_KEYS_CAP));
    } catch (e) {
      logger.warn(`[home-defense] alerted-keys load failed: ${e.message}`);
      return new Set();
    }
  }
  async _saveAlertedKeys() {
    try {
      const arr = Array.from(this._alertedIds).slice(-HomeDefensePlugin.ALERTED_KEYS_CAP);
      if (arr.length < this._alertedIds.size) this._alertedIds = new Set(arr);
      await PluginSettings.findOneAndUpdate(
        { pluginName: this.name, settingsKey: 'alertedKeys' },
        { $set: { settingsValue: arr, updatedAt: new Date() }, $setOnInsert: { pluginName: this.name, settingsKey: 'alertedKeys' } },
        { upsert: true }
      );
    } catch (e) {
      logger.warn(`[home-defense] alerted-keys save failed: ${e.message}`);
    }
  }

  _startAlertLoop() {
    this._stopAlertLoop();
    // Prime (silent baseline) only on a truly cold start — with persisted
    // dedup memory, a restart should alert on genuinely-unseen devices
    // immediately instead of re-silencing a snapshot of the moment.
    this._alertPrimed = this._alertedIds.size > 0;
    const ms = Math.max(1, this._alertCfg.intervalMinutes || 15) * 60 * 1000;
    // Prime shortly after start, then run on the interval.
    this._alertTimer = setInterval(() => this._runAlertCycle().catch(e => logger.warn(`[home-defense] alert cycle: ${e.message}`)), ms);
    if (this._alertTimer.unref) this._alertTimer.unref();
    setTimeout(() => this._runAlertCycle().catch(e => logger.warn(`[home-defense] alert prime: ${e.message}`)), 4000);
  }
  _stopAlertLoop() {
    if (this._alertTimer) { clearInterval(this._alertTimer); this._alertTimer = null; }
  }

  /**
   * A device is alert-worthy only if it's identifiable — i.e. it has a stable,
   * trackable identity. Anything else is rotating-MAC noise: each address rotation
   * looks like a brand-new device, so it churns endlessly and can't be acted on.
   *
   *  - bt_classic: always a real public MAC → identifiable.
   *  - a real broadcast name (not '<hidden>') → identifiable, on any band.
   *  - nameless BLE: NOT identifiable. The `vendor` here is decoded from BLE
   *    advertising manufacturer-data (Apple/Microsoft/OnePlus/…), NOT from a real
   *    OUI, while the MAC is a rotating private address (resolvable-private rotates
   *    ~15 min, static-random changes on reboot). A mfg-data vendor on a private
   *    MAC is not an identity — every nearby phone/laptop would alert forever.
   *  - WiFi AP: a resolved OUI vendor IS a stable identity (BSSIDs don't churn).
   */
  _isIdentifiable(d) {
    if (d.type === 'bt_classic') return true;
    if (d.name && d.name !== '<hidden>') return true;
    if (d.type === 'ble') return false;
    return !!(d.vendor && !/random|local|unknown|^$/i.test(d.vendor));
  }

  /**
   * Stable de-dupe key for alerts. A device that broadcasts a name but rotates its
   * MAC (some BLE peripherals do) still maps to ONE key, so it alerts once — not
   * once per address rotation. Nameless devices fall back to the MAC.
   */
  _alertKey(d) {
    if (d.name && d.name !== '<hidden>') return `name:${d.type}:${(d.name || '').toLowerCase()}`;
    if (d.ssid) return `ssid:${(d.ssid || '').toLowerCase()}`;
    return d.deviceId;
  }

  /** One alert cycle: refresh, find new/suspicious, dedup, notify. First cycle primes silently. */
  async _runAlertCycle() {
    if (!this._alertCfg.enabled) return;
    await this._refreshAll();
    let candidates = [];
    if (this._alertCfg.alertSuspicious) {
      const s = await this.cmdSuspicious({});
      (s.devices || []).forEach(d => candidates.push({ d, why: (d.reasons || []).join(', ') || 'suspicious', kind: 'suspicious' }));
    }
    if (this._alertCfg.alertNew) {
      const hours = (this._alertCfg.newWindowMinutes || 15) / 60;
      const n = await this.cmdNew({ hours });
      (n.devices || []).filter(d => !d.known).forEach(d => candidates.push({ d, why: 'new device', kind: 'new' }));
    }
    if (this._alertCfg.alertSpoofing) {
      const sp = await this.cmdSpoofing({});
      // Keyed per impostor BSSID (NOT the shared SSID) so each rogue radio alerts once.
      (sp.devices || []).forEach(d => candidates.push({
        d, kind: 'spoof', why: (d.reasons || []).join(', ') || 'possible MAC spoofing',
        key: `spoof:${(d.spoofedSsid || '').toLowerCase()}:${d.deviceId}`
      }));
    }
    // Drop un-actionable rotating-MAC noise (keeps the dashboard full, the alerts quiet).
    // Spoofing hits are always kept — a rogue AP is the whole point of the feature.
    if (this._alertCfg.alertOnlyIdentifiable !== false) {
      candidates = candidates.filter(c => c.kind === 'spoof' || this._isIdentifiable(c.d));
    }
    // First cycle after (re)start: silence the existing baseline, alert only on what appears afterwards.
    if (!this._alertPrimed) {
      candidates.forEach(c => this._alertedIds.add(c.key || this._alertKey(c.d)));
      // Seed the baseline from the whole observed-device DB, not just this
      // instant's candidates — a device momentarily out of range / below the
      // RSSI threshold at prime time would otherwise re-alert on its next
      // appearance. (Spoof keys are per SSID+BSSID pair and intentionally NOT
      // covered by this seed — a rogue AP must never be pre-silenced.)
      try {
        const room = HomeDefensePlugin.ALERTED_KEYS_CAP - this._alertedIds.size;
        if (room > 0) {
          const docs = await RfDevice.find({}, { deviceId: 1, name: 1, ssid: 1, type: 1 })
            .sort({ lastSeen: -1 }).limit(room).lean();
          docs.forEach(d => this._alertedIds.add(this._alertKey(d)));
        }
      } catch (e) {
        logger.warn(`[home-defense] baseline seed from RfDevice failed: ${e.message}`);
      }
      this._alertPrimed = true;
      await this._saveAlertedKeys();
      logger.info(`[home-defense] alerts primed (${this._alertedIds.size} baseline identities silenced, persisted)`);
      return;
    }
    // De-dupe: only alert each identity once (stable key, not the rotating MAC).
    const seen = new Set();
    const fresh = candidates.filter(c => {
      const k = c.key || this._alertKey(c.d);
      if (this._alertedIds.has(k) || seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (!fresh.length) return;
    fresh.forEach(c => this._alertedIds.add(c.key || this._alertKey(c.d)));
    await this._saveAlertedKeys();

    const fmt = (c) => {
      const d = c.d;
      const icon = c.kind === 'spoof' ? '🚨' : (c.kind === 'suspicious' ? '⚠️' : '🆕');
      const isBt = d.type === 'ble' || d.type === 'bt_classic';
      const sig = d.rssiLast != null ? (isBt ? `${d.rssiLast} dBm` : `${d.rssiLast}%`) : '?';
      const vendorLabel = d.vendor && !/random|local|unknown|^$/i.test(d.vendor) ? `${d.vendor} device` : null;
      const label = d.name || d.ssid || vendorLabel || '<unnamed>';
      const kind = isBt ? (d.type === 'bt_classic' ? 'BT-Classic' : 'BLE') : 'WiFi';
      return `${icon} *${label}* (\`${d.deviceId}\`) — ${kind}, ${sig} — ${c.why}`;
    };
    const msg = `🛡️ *Home Defense* — ${fresh.length} new alert(s)\n` + fresh.slice(0, 15).map(fmt).join('\n') +
      (fresh.length > 15 ? `\n…and ${fresh.length - 15} more` : '');
    await this.notify(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    logger.info(`[home-defense] sent ${fresh.length} device alert(s) to Telegram`);
  }

  async cmdAlertsOn(params = {}) {
    const interval = parseInt(params.intervalMinutes || params.interval || this._alertCfg.intervalMinutes || 15, 10);
    this._alertCfg = { ...this._alertCfg, enabled: true, intervalMinutes: Math.max(1, interval) };
    await this._saveAlertConfig(this._alertCfg);
    this._startAlertLoop();
    // Confirmation ping — also proves the Telegram path end-to-end.
    const delivery = await this.notify(`🛡️ *Home Defense* alerts enabled — I'll message you about new, suspicious, and possible MAC-spoofing / evil-twin WiFi & Bluetooth devices (every ${this._alertCfg.intervalMinutes} min). Existing devices are baselined, so you'll only hear about new arrivals.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true });
    return { success: true, enabled: true, intervalMinutes: this._alertCfg.intervalMinutes, telegramDelivered: delivery && delivery.delivered !== false,
      message: `Home-defense alerts ON — I'll message you about new/suspicious devices every ${this._alertCfg.intervalMinutes} min (existing devices are baselined, so you'll only hear about what shows up from now on).` };
  }
  async cmdAlertsOff() {
    this._alertCfg = { ...this._alertCfg, enabled: false };
    await this._saveAlertConfig(this._alertCfg);
    this._stopAlertLoop();
    return { success: true, enabled: false, message: 'Home-defense alerts OFF.' };
  }
  async cmdAlertsStatus() {
    return { success: true, ...this._alertCfg, running: !!this._alertTimer, primed: this._alertPrimed, baselineSilenced: this._alertedIds.size };
  }

  async cmdDevice(params = {}) {
    if (!params.id) return { success: false, error: 'id is required' };
    const dev = await RfDevice.findOne({ deviceId: params.id.toUpperCase() }).lean();
    if (!dev) return { success: false, error: 'device not found' };
    return { success: true, device: dev };
  }

  async cmdSetTrust(params = {}) {
    const id = (params.id || '').toUpperCase();
    if (!id) return { success: false, error: 'id is required' };
    const trust = params.trust;
    if (trust && !['trusted', 'unknown', 'flagged'].includes(trust)) {
      return { success: false, error: "trust must be one of: trusted, unknown, flagged" };
    }
    const update = {};
    if (trust) { update.trust = trust; update.known = trust === 'trusted'; }
    if (params.label != null) update.label = params.label;
    if (params.notes != null) update.notes = params.notes;
    const dev = await RfDevice.findOneAndUpdate({ deviceId: id }, { $set: update }, { new: true }).lean();
    if (!dev) return { success: false, error: 'device not found' };

    // Best-effort write-through to the originating backend's annotation API (keeps
    // the watcher's own known/label in sync); never fail the call if it's offline.
    const body = { known: update.known, label: update.label, notes: update.notes };
    try {
      if (dev.source === 'inhouse:wifi') {
        await this._fetchJson(`${this.wifiApiUrl}/networks/${encodeURIComponent(id)}`, { method: 'PATCH', token: this.wifiApiToken, body });
      } else if (dev.source === 'inhouse:bt' && this.btApiUrl) {
        await this._fetchJson(`${this.btApiUrl}/devices/${encodeURIComponent(id)}`, { method: 'PATCH', token: this.btApiToken, body });
      }
    } catch (e) { logger.warn(`[home-defense] backend annotate failed: ${e.message}`); }
    return { success: true, device: dev };
  }

  async cmdScan() {
    try {
      await this._fetchJson(`${this.wifiApiUrl}/scan`, { method: 'POST', token: this.wifiApiToken, body: { rescan: true } });
    } catch (e) {
      return { success: false, error: `scan trigger failed: ${e.message}` };
    }
    // Give the watcher a moment, then pull fresh results.
    await new Promise(r => setTimeout(r, 1500));
    return await this.cmdNetworks({ limit: 200 });
  }

  cmdBackends() {
    return {
      success: true,
      active: this.backendType,
      backends: [
        { id: 'inhouse', label: 'In-house watchers', wifi: this.wifiApiUrl, bt: this.btApiUrl || 'deferred', status: 'default' },
        { id: 'kismet',  label: 'Kismet', status: 'not-configured', note: 'install via deploy layer when desired' }
      ]
    };
  }

  // ----------------------------- REST routes ----------------------------
  // Mounted at /api/home-defense/* by the /api/:pluginName/* dispatcher.
  getRoutes() {
    return [
      { method: 'GET',  path: '/status',         handler: async () => this.cmdStatus() },
      { method: 'GET',  path: '/networks',       handler: async (d, req) => this.cmdNetworks(req.query || {}) },
      { method: 'GET',  path: '/bt-devices',     handler: async (d, req) => this.cmdBtDevices(req.query || {}) },
      { method: 'GET',  path: '/stats',          handler: async () => this.cmdStats() },
      { method: 'GET',  path: '/activity',       handler: async (d, req) => this.cmdActivity(req.query || {}) },
      { method: 'GET',  path: '/devices',        handler: async (d, req) => this.cmdDevices(req.query || {}) },
      { method: 'GET',  path: '/new',            handler: async (d, req) => this.cmdNew(req.query || {}) },
      { method: 'GET',  path: '/suspicious',     handler: async (d, req) => this.cmdSuspicious(req.query || {}) },
      { method: 'GET',  path: '/spoofing',       handler: async (d, req) => this.cmdSpoofing(req.query || {}) },
      { method: 'GET',  path: '/export',         handler: async (d, req) => this.cmdExport(req.query || {}) },
      { method: 'GET',  path: '/alerts',         handler: async () => this.cmdAlertsStatus() },
      { method: 'POST', path: '/alerts/on',      handler: async (d) => this.cmdAlertsOn(d || {}) },
      { method: 'POST', path: '/alerts/off',     handler: async () => this.cmdAlertsOff() },
      { method: 'GET',  path: '/devices/:id',    handler: async (d, req) => this.cmdDevice({ id: req.params.id }) },
      { method: 'PATCH', path: '/devices/:id',   handler: async (d, req) => this.cmdSetTrust({ id: req.params.id, ...(d || {}) }) },
      { method: 'POST', path: '/scan',           handler: async () => this.cmdScan() },
      { method: 'GET',  path: '/backends',       handler: async () => this.cmdBackends() }
    ];
  }

  // ------------------------------- WebUI --------------------------------
  getUIConfig() {
    return {
      menuItem: { id: 'home-defense', title: 'Home Defense', icon: 'fas fa-shield-halved', order: 77, section: 'main' },
      hasUI: true
    };
  }

  getUIContent() {
    return `
      <style>
        .hd-wrap { padding: 1rem; }
        .hd-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem; flex-wrap:wrap; gap:0.75rem; }
        .hd-actions { display:flex; gap:0.5rem; }
        .hd-status { display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.75rem; }
        .hd-pill { padding:0.4rem 0.7rem; border-radius:8px; background:var(--bg-tertiary); font-size:0.8rem; }
        .hd-pill .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
        .dot-up { background:#22c55e; } .dot-down { background:#ef4444; } .dot-wait { background:#f59e0b; }
        .hd-nav { display:flex; gap:0.25rem; border-bottom:1px solid var(--border,#2a2a2a); margin-bottom:1rem; }
        .hd-nav button { background:none; border:none; padding:0.6rem 1rem; color:var(--text-secondary); cursor:pointer; font-size:0.9rem; border-bottom:2px solid transparent; }
        .hd-nav button.active { color:var(--accent,#3b82f6); border-bottom-color:var(--accent,#3b82f6); font-weight:600; }
        .hd-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:0.75rem; margin-bottom:1rem; }
        .hd-card { background:var(--bg-secondary); border-radius:10px; padding:0.9rem 1rem; }
        .hd-card .v { font-size:1.6rem; font-weight:700; line-height:1.1; }
        .hd-card .k { font-size:0.72rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.03em; margin-top:0.2rem; }
        .hd-charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:1rem; margin-bottom:1.25rem; }
        .hd-chart { background:var(--bg-secondary); border-radius:10px; padding:0.9rem 1rem; }
        .hd-chart h4 { margin:0 0 0.6rem; font-size:0.8rem; color:var(--text-secondary); font-weight:600; text-transform:uppercase; letter-spacing:0.03em; }
        .hd-hbar { display:flex; align-items:center; gap:0.5rem; margin:0.3rem 0; font-size:0.8rem; }
        .hd-hbar .lbl { width:30%; min-width:84px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .hd-hbar .track { flex:1; background:var(--bg-tertiary); border-radius:4px; height:14px; overflow:hidden; }
        .hd-hbar .fill { height:100%; border-radius:4px; }
        .hd-hbar .n { width:34px; text-align:right; font-variant-numeric:tabular-nums; }
        table.hd-tbl { width:100%; border-collapse:collapse; font-size:0.85rem; }
        .hd-tbl th, .hd-tbl td { text-align:left; padding:0.5rem 0.6rem; border-bottom:1px solid var(--border, #2a2a2a); }
        .hd-tbl th { color:var(--text-secondary); font-weight:600; cursor:default; }
        .hd-mac { font-family:monospace; font-size:0.78rem; color:var(--text-secondary); }
        .hd-badge { font-size:0.62rem; padding:0.1rem 0.4rem; border-radius:10px; text-transform:uppercase; }
        .b-unknown { background:#6b728020; color:#9ca3af; } .b-trusted { background:#22c55e20; color:#22c55e; } .b-flagged { background:#ef444420; color:#ef4444; }
        .b-open { background:#f59e0b20; color:#f59e0b; } .b-ble { background:#3b82f620; color:#3b82f6; } .b-classic { background:#a855f720; color:#a855f7; }
        .b-hidden { background:#8b5cf620; color:#8b5cf6; }
        .hd-empty { text-align:center; padding:2.5rem; color:var(--text-secondary); }
        .hd-rssi { font-variant-numeric:tabular-nums; }
        .hd-toolbar { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.6rem; flex-wrap:wrap; }
        .hd-search { flex:0 1 280px; padding:0.4rem 0.6rem; border-radius:8px; border:1px solid var(--border,#2a2a2a); background:var(--bg-tertiary); color:inherit; font-size:0.82rem; }
        .hd-filter { padding:0.4rem 0.6rem; border-radius:8px; border:1px solid var(--border,#2a2a2a); background:var(--bg-tertiary); color:inherit; font-size:0.82rem; }
        .hd-count { font-size:0.75rem; color:var(--text-secondary); }
        .hd-th-sort { cursor:pointer; user-select:none; }
        .hd-th-sort:hover { color:var(--accent,#3b82f6); }
        .hd-bars { display:flex; align-items:flex-end; gap:3px; height:90px; }
        .hd-bars .bar { flex:1; background:var(--accent,#3b82f6); border-radius:2px 2px 0 0; min-height:2px; opacity:0.85; }
        .hd-bars-x { display:flex; gap:3px; margin-top:3px; }
        .hd-bars-x span { flex:1; text-align:center; font-size:0.6rem; color:var(--text-secondary); }
      </style>

      <div class="hd-wrap">
        <div class="hd-head">
          <h2><i class="fas fa-shield-halved"></i> Home Defense — RF Sensor</h2>
          <div class="hd-actions">
            <button class="btn btn-secondary" id="hd-alerts-btn" onclick="hdToggleAlerts()" title="Telegram alerts for new/suspicious devices"><i class="fas fa-bell"></i> Alerts: …</button>
            <button class="btn btn-primary" onclick="hdScan()" id="hd-scan-btn"><i class="fas fa-satellite-dish"></i> Scan WiFi</button>
            <button class="btn btn-secondary" onclick="hdRefresh()"><i class="fas fa-rotate"></i> Refresh</button>
          </div>
        </div>
        <div class="hd-status" id="hd-status"><span class="hd-pill"><span class="dot dot-wait"></span>loading…</span></div>
        <div class="hd-nav">
          <button id="hd-tab-wifi" class="active" onclick="hdTab('wifi')"><i class="fas fa-wifi"></i> WiFi</button>
          <button id="hd-tab-bt" onclick="hdTab('bt')"><i class="fab fa-bluetooth-b"></i> Bluetooth</button>
        </div>
        <div id="hd-body"><div class="hd-empty">Loading…</div></div>
      </div>

      <script>
      (function() {
        const token = localStorage.getItem('lanagent_token');
        let page = 'wifi';
        async function hdApi(action, data) {
          const r = await fetch('/api/plugin', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ plugin: 'home-defense', action }, data || {}))
          });
          return r.json();
        }
        function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
        function ago(d){ if(!d) return '—'; const s=(Date.now()-new Date(d).getTime())/1000; if(s<60) return Math.round(s)+'s'; if(s<3600) return Math.round(s/60)+'m'; if(s<86400) return Math.round(s/3600)+'h'; return Math.round(s/86400)+'d'; }
        function trustBadge(t){ const c={trusted:'b-trusted',flagged:'b-flagged'}[t]||'b-unknown'; return '<span class="hd-badge '+c+'">'+esc(t||'unknown')+'</span>'; }

        // ---- chart helpers (dependency-free) ----
        function hbars(items, color){
          if(!items.length) return '<div class="hd-empty" style="padding:1rem">no data</div>';
          const max = Math.max.apply(null, items.map(function(i){return i.n;})) || 1;
          return items.map(function(i){
            return '<div class="hd-hbar"><span class="lbl" title="'+esc(i.label)+'">'+esc(i.label)+'</span>'+
              '<span class="track"><span class="fill" style="width:'+Math.round(i.n/max*100)+'%;background:'+(color||'#3b82f6')+'"></span></span>'+
              '<span class="n">'+i.n+'</span></div>';
          }).join('');
        }
        function vbars(items, color){
          if(!items.length) return '<div class="hd-empty" style="padding:1rem">no data</div>';
          const max = Math.max.apply(null, items.map(function(i){return i.n;})) || 1;
          const bars = items.map(function(i){ return '<div class="bar" title="'+esc(i.label)+': '+i.n+'" style="height:'+Math.round(i.n/max*100)+'%;background:'+(color||'#3b82f6')+'"></div>'; }).join('');
          const lbls = items.map(function(i,ix){ return '<span>'+((ix%Math.ceil(items.length/8||1)===0)?esc(i.label):'')+'</span>'; }).join('');
          return '<div class="hd-bars">'+bars+'</div><div class="hd-bars-x">'+lbls+'</div>';
        }
        function distFrom(list, keyFn){
          const m = {};
          list.forEach(function(x){ const k = keyFn(x) || '—'; m[k] = (m[k]||0)+1; });
          return Object.keys(m).map(function(k){return {label:k, n:m[k]};}).sort(function(a,b){return b.n-a.n;});
        }
        function rssiHist(list, dbm){
          if (dbm) { // BT: negative dBm
            const bins=[{label:'<-90',n:0},{label:'-90',n:0},{label:'-80',n:0},{label:'-70',n:0},{label:'-60',n:0},{label:'>-50',n:0}];
            list.forEach(function(x){ const r=x.rssiLast; if(r==null) return; if(r<-90)bins[0].n++; else if(r<-80)bins[1].n++; else if(r<-70)bins[2].n++; else if(r<-60)bins[3].n++; else if(r<-50)bins[4].n++; else bins[5].n++; });
            return bins;
          }
          // WiFi: 0-100 quality (higher = stronger)
          const bins=[{label:'0-20',n:0},{label:'20-40',n:0},{label:'40-60',n:0},{label:'60-80',n:0},{label:'80-100',n:0}];
          list.forEach(function(x){ const r=x.rssiLast; if(r==null) return; const i=Math.min(Math.floor(r/20),4); bins[i].n++; });
          return bins;
        }
        function card(v,k){ return '<div class="hd-card"><div class="v">'+v+'</div><div class="k">'+esc(k)+'</div></div>'; }

        async function renderStatus() {
          const s = await hdApi('status');
          const el = document.getElementById('hd-status');
          const wifiDot = s.wifi && s.wifi.up ? 'dot-up' : 'dot-down';
          const btDot = (s.bt && s.bt.up) ? 'dot-up' : 'dot-down';
          el.innerHTML =
            '<span class="hd-pill"><span class="dot '+wifiDot+'"></span>WiFi: '+(s.wifi&&s.wifi.up?'online':'offline')+'</span>' +
            '<span class="hd-pill"><span class="dot '+btDot+'"></span>Bluetooth: '+((s.bt&&s.bt.up)?'online':'offline')+'</span>' +
            '<span class="hd-pill">Stored: '+(s.storedDevices!=null?s.storedDevices:'—')+'</span>' +
            '<span class="hd-pill">Backend: '+esc(s.backend||'?')+'</span>';
        }

        // ---- per-page state (rows cached so sort/filter/search are instant, no refetch) ----
        const ST = {
          wifi: { rows: [], q: '', filter: 'all', sortKey: 'rssiLast', sortDir: -1 },
          bt:   { rows: [], q: '', filter: 'all', sortKey: 'rssiLast', sortDir: -1 }
        };
        function actBtns(id){ return '<button class="btn btn-sm btn-secondary" onclick="hdTrust(\\''+esc(id)+'\\',\\'trusted\\')">Trust</button> '+
          '<button class="btn btn-sm btn-secondary" onclick="hdTrust(\\''+esc(id)+'\\',\\'flagged\\')">Flag</button>'; }
        const WIFI_COLS = [
          { k:'name', label:'SSID', sort:function(n){return (n.name||n.ssid||'').toLowerCase();}, get:function(n){var o=/^(open|none|)$/i.test(n.security||'');return esc(n.name||n.ssid||'<hidden>')+(o?' <span class="hd-badge b-open">open</span>':'')+(n.hidden?' <span class="hd-badge b-hidden" title="broadcasts as hidden (SSID shown here leaked via a client probe)">hidden</span>':'');} },
          { k:'deviceId', label:'BSSID', cls:'hd-mac', sort:function(n){return n.deviceId;}, get:function(n){return esc(n.deviceId);} },
          { k:'vendor', label:'Vendor', sort:function(n){return (n.vendor||'').toLowerCase();}, get:function(n){return esc(n.vendor||'—');} },
          { k:'band', label:'Band/Ch', sort:function(n){return n.channel||0;}, get:function(n){return esc(n.band||'')+(n.channel?(' ch'+n.channel):'');} },
          { k:'security', label:'Security', sort:function(n){return (n.security||'').toLowerCase();}, get:function(n){return esc(n.security||'—');} },
          { k:'rssiLast', label:'Signal', cls:'hd-rssi', sort:function(n){return n.rssiLast==null?-999:n.rssiLast;}, get:function(n){return n.rssiLast!=null?n.rssiLast+'%':'—';} },
          { k:'firstSeen', label:'First seen', sort:function(n){return new Date(n.firstSeen||0).getTime();}, get:function(n){return ago(n.firstSeen);} },
          { k:'lastSeen', label:'Last seen', sort:function(n){return new Date(n.lastSeen||0).getTime();}, get:function(n){return ago(n.lastSeen);} },
          { k:'trust', label:'Trust', sort:function(n){return n.trust||'';}, get:function(n){return trustBadge(n.trust);} },
          { k:'_act', label:'', get:function(n){return actBtns(n.deviceId);} }
        ];
        const BT_COLS = [
          { k:'name', label:'Name', sort:function(d){return (d.name||'').toLowerCase();}, get:function(d){return esc(d.name||'<unnamed>');} },
          { k:'deviceId', label:'MAC', cls:'hd-mac', sort:function(d){return d.deviceId;}, get:function(d){return esc(d.deviceId);} },
          { k:'vendor', label:'Vendor', sort:function(d){return (d.vendor||'').toLowerCase();}, get:function(d){return esc(d.vendor||'—');} },
          { k:'type', label:'Kind', sort:function(d){return d.type;}, get:function(d){return d.type==='bt_classic'?'<span class="hd-badge b-classic">classic</span>':'<span class="hd-badge b-ble">ble</span>';} },
          { k:'security', label:'Class', sort:function(d){return (d.security||'').toLowerCase();}, get:function(d){return esc(d.security||'—');} },
          { k:'rssiLast', label:'Signal', cls:'hd-rssi', sort:function(d){return d.rssiLast==null?-999:d.rssiLast;}, get:function(d){return d.rssiLast!=null?d.rssiLast+' dBm':'—';} },
          { k:'firstSeen', label:'First seen', sort:function(d){return new Date(d.firstSeen||0).getTime();}, get:function(d){return ago(d.firstSeen);} },
          { k:'lastSeen', label:'Last seen', sort:function(d){return new Date(d.lastSeen||0).getTime();}, get:function(d){return ago(d.lastSeen);} },
          { k:'trust', label:'Trust', sort:function(d){return d.trust||'';}, get:function(d){return trustBadge(d.trust);} },
          { k:'_act', label:'', get:function(d){return actBtns(d.deviceId);} }
        ];
        const FILTERS = {
          wifi: [['all','All'],['unknown','Unknown'],['trusted','Trusted'],['flagged','Flagged'],['open','Open only'],['hidden','Hidden only']],
          bt:   [['all','All'],['unknown','Unknown'],['trusted','Trusted'],['flagged','Flagged'],['ble','BLE only'],['classic','Classic only']]
        };
        function filterMatch(kind, f, d){
          switch(f){
            case 'unknown': return !d.known;
            case 'trusted': return d.trust==='trusted';
            case 'flagged': return d.trust==='flagged';
            case 'open': return /^(open|none|)$/i.test(d.security||'');
            case 'hidden': return !!d.hidden;
            case 'ble': return d.type==='ble';
            case 'classic': return d.type==='bt_classic';
            default: return true;
          }
        }
        function toolbar(kind){
          const st=ST[kind];
          const opts=FILTERS[kind].map(function(o){return '<option value="'+o[0]+'"'+(st.filter===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('');
          return '<div class="hd-toolbar">'+
            '<input class="hd-search" id="hd-search" placeholder="Search name / mac / vendor / security…" value="'+esc(st.q)+'" oninput="hdSearch(\\''+kind+'\\',this.value)">'+
            '<select class="hd-filter" onchange="hdFilter(\\''+kind+'\\',this.value)">'+opts+'</select>'+
            '<span class="hd-count" id="hd-count"></span>'+
            '<span style="flex:1"></span>'+
            '<button class="btn btn-sm btn-secondary" onclick="hdExport(\\''+kind+'\\',\\'csv\\')"><i class="fas fa-file-csv"></i> CSV</button>'+
            '<button class="btn btn-sm btn-secondary" onclick="hdExport(\\''+kind+'\\',\\'json\\')"><i class="fas fa-file-code"></i> JSON</button>'+
            '</div><div id="hd-table-wrap"></div>';
        }
        function drawTable(kind){
          const st=ST[kind], cols=kind==='bt'?BT_COLS:WIFI_COLS;
          let rows=st.rows.slice();
          if(st.q){ const q=st.q.toLowerCase(); rows=rows.filter(function(d){ return [d.deviceId,d.name,d.ssid,d.vendor,d.security].some(function(v){return (v||'').toLowerCase().indexOf(q)>=0;}); }); }
          rows=rows.filter(function(d){ return filterMatch(kind, st.filter, d); });
          const col=cols.filter(function(c){return c.k===st.sortKey;})[0];
          if(col && col.sort){ rows.sort(function(a,b){ var va=col.sort(a),vb=col.sort(b); return va<vb?-st.sortDir:(va>vb?st.sortDir:0); }); }
          const thead='<tr>'+cols.map(function(c){ if(!c.sort) return '<th>'+esc(c.label)+'</th>'; var ar=st.sortKey===c.k?(st.sortDir<0?' ▼':' ▲'):''; return '<th class="hd-th-sort" onclick="hdSort(\\''+kind+'\\',\\''+c.k+'\\')">'+esc(c.label)+ar+'</th>'; }).join('')+'</tr>';
          const tbody=rows.length? rows.map(function(d){ return '<tr>'+cols.map(function(c){ return '<td'+(c.cls?' class="'+c.cls+'"':'')+'>'+c.get(d)+'</td>'; }).join('')+'</tr>'; }).join('') : '<tr><td colspan="'+cols.length+'" class="hd-empty">No matches</td></tr>';
          document.getElementById('hd-table-wrap').innerHTML='<table class="hd-tbl"><thead>'+thead+'</thead><tbody>'+tbody+'</tbody></table>';
          const cnt=document.getElementById('hd-count'); if(cnt) cnt.textContent=rows.length+' / '+st.rows.length+' shown';
        }
        window.hdSearch=function(kind,v){ ST[kind].q=v; drawTable(kind); };
        window.hdFilter=function(kind,v){ ST[kind].filter=v; drawTable(kind); };
        window.hdSort=function(kind,k){ const st=ST[kind]; if(st.sortKey===k) st.sortDir*=-1; else { st.sortKey=k; st.sortDir=1; } drawTable(kind); };
        window.hdExport=async function(kind,fmt){ const res=await hdApi('export',{ band:kind, format:fmt }); if(!res||!res.success){ alert('Export failed: '+((res&&res.error)||'unknown')); return; } const blob=new Blob([res.content],{type:res.contentType||'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=res.filename||('homedefense.'+fmt); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href); };

        async function renderWifi() {
          const body = document.getElementById('hd-body');
          const res = await hdApi('networks', { limit: 500 });
          if (!res.success) { body.innerHTML = '<div class="hd-empty">'+esc(res.error||'WiFi backend offline')+'</div>'; return; }
          const nets = res.networks||[];
          ST.wifi.rows = nets;
          const act = await hdApi('activity', { range: '24h' });
          const open = nets.filter(function(n){return /^(open|none|)$/i.test(n.security||'');}).length;
          const unknown = nets.filter(function(n){return !n.known;}).length;
          const secDist = distFrom(nets, function(n){ return (n.security||'open').split(' ')[0]; });
          const bandDist = distFrom(nets, function(n){ return n.band||'?'; });
          body.innerHTML =
            '<div class="hd-cards">'+card(nets.length,'Networks')+card(unknown,'Unknown')+card(open,'Open')+card(bandDist.length,'Bands')+'</div>'+
            '<div class="hd-charts">'+
              '<div class="hd-chart"><h4>Security</h4>'+hbars(secDist,'#3b82f6')+'</div>'+
              '<div class="hd-chart"><h4>Signal quality (%)</h4>'+vbars(rssiHist(nets,false),'#3b82f6')+'</div>'+
              '<div class="hd-chart"><h4>New networks / hour (24h)</h4>'+vbars((act.wifi||[]).map(function(b){return {label:b.label,n:b.n};}),'#3b82f6')+'</div>'+
            '</div>'+ toolbar('wifi');
          drawTable('wifi');
        }

        async function renderBt() {
          const body = document.getElementById('hd-body');
          const res = await hdApi('bt-devices', { limit: 500 });
          if (!res.success) { body.innerHTML = '<div class="hd-empty">'+esc(res.error||'Bluetooth backend offline')+'</div>'; return; }
          const devs = res.devices||[];
          ST.bt.rows = devs;
          const act = await hdApi('activity', { range: '24h' });
          const ble = devs.filter(function(d){return d.type==='ble';}).length;
          const classic = devs.filter(function(d){return d.type==='bt_classic';}).length;
          const named = devs.filter(function(d){return d.name;}).length;
          const typeDist = distFrom(devs, function(d){ return d.security||d.type; });
          const vendorDist = distFrom(devs.filter(function(d){return d.vendor && !/random|unknown/i.test(d.vendor);}), function(d){return d.vendor;}).slice(0,6);
          body.innerHTML =
            '<div class="hd-cards">'+card(devs.length,'Devices')+card(ble,'BLE')+card(classic,'Classic')+card(named,'Named')+'</div>'+
            '<div class="hd-charts">'+
              '<div class="hd-chart"><h4>Device type</h4>'+hbars(typeDist,'#a855f7')+'</div>'+
              '<div class="hd-chart"><h4>Signal strength (dBm)</h4>'+vbars(rssiHist(devs,true),'#a855f7')+'</div>'+
              '<div class="hd-chart"><h4>Top vendors</h4>'+hbars(vendorDist,'#a855f7')+'</div>'+
              '<div class="hd-chart"><h4>New devices / hour (24h)</h4>'+vbars((act.bt||[]).map(function(b){return {label:b.label,n:b.n};}),'#a855f7')+'</div>'+
            '</div>'+ toolbar('bt');
          drawTable('bt');
        }

        function renderPage(){ document.getElementById('hd-body').innerHTML='<div class="hd-empty">Loading…</div>'; return page==='bt'?renderBt():renderWifi(); }
        window.hdTab = function(p){ page=p; document.getElementById('hd-tab-wifi').classList.toggle('active',p==='wifi'); document.getElementById('hd-tab-bt').classList.toggle('active',p==='bt'); renderPage(); };

        let alertsOn=false;
        async function renderAlerts(){
          const s = await hdApi('alerts-status');
          alertsOn = !!(s && s.enabled);
          const b=document.getElementById('hd-alerts-btn');
          b.innerHTML='<i class="fas fa-bell'+(alertsOn?'':'-slash')+'"></i> Alerts: '+(alertsOn?'ON':'OFF');
          b.style.color = alertsOn ? '#22c55e' : '';
        }
        window.hdToggleAlerts = async function(){
          const b=document.getElementById('hd-alerts-btn'); b.disabled=true;
          try { await hdApi(alertsOn?'alerts-off':'alerts-on'); } finally { b.disabled=false; await renderAlerts(); }
        };
        window.hdRefresh = async function(){ await renderStatus(); await renderAlerts(); await renderPage(); };
        window.hdScan = async function(){
          const b=document.getElementById('hd-scan-btn'); b.disabled=true; b.innerHTML='<i class="fas fa-spinner fa-spin"></i> Scanning…';
          try { await hdApi('scan'); } finally { b.disabled=false; b.innerHTML='<i class="fas fa-satellite-dish"></i> Scan WiFi'; await hdRefresh(); }
        };
        window.hdTrust = async function(id, trust){
          await hdApi('set-trust', { id: id, trust: trust });
          ['wifi','bt'].forEach(function(k){ ST[k].rows.forEach(function(d){ if(d.deviceId===id){ d.trust=trust; d.known=(trust==='trusted'); } }); });
          drawTable(page);
        };

        hdRefresh();
      })();
      </script>
    `;
  }
}
