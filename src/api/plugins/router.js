import { BasePlugin } from '../core/basePlugin.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { DEPLOY_PATH, DATA_PATH } from '../../utils/paths.js';

/**
 * The home router's DHCP reservations and a security read-out (Asuswrt-Merlin, owner 2026-11-21: "managing my DHCP
 * server since i have so many entries ... static ips help"). The agent reaches the router over SSH (LAN only, key
 * only) and sends ONLY the commands of its wrapper script (scripts/router/agent-router.sh, installed at
 * /jffs/agent/router.sh). Merlin has one admin account and its Dropbear refused a forced-command key, so the key is a
 * full admin key: the restriction is here. Every value is checked before it is sent, the host key is pinned
 * (StrictHostKeyChecking=yes), the router's copy of the wrapper must match this repository's before any change, only the
 * owner can ask, and each change is logged on the router and told to the owner.
 *
 * Settings (.env): ROUTER_SSH_HOST (default the LAN's default gateway), ROUTER_SSH_USER (admin), ROUTER_SSH_KEY
 * (~/.ssh/router_agent). Off when the key file is missing.
 */
const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const NAME = /^[A-Za-z0-9._-]{0,32}$/;
const WRAPPER = '/jffs/agent/router.sh';
const KEEP_BACKUPS = 14;
const CONFIRM_MS = 5 * 60 * 1000;
const YES = /\b(yes|confirm(ed)?|go ahead|do it|proceed)\b/i;

/** The LAN's default gateway (the router), from the kernel's routing table; null when it can't be read. */
export function defaultGateway(table = null) {
  try {
    const t = table ?? readFileSync('/proc/net/route', 'utf8');
    for (const line of t.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && f[2] && f[2] !== '00000000') return f[2].match(/../g).reverse().map(h => parseInt(h, 16)).join('.');
    }
  } catch { /* not Linux */ }
  return null;
}
const GOVEE_OUI = ['D4:AD:FC', 'A4:C1:38', '60:74:F4'];

export function parseReservations(text) {
  return String(text || '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => MAC.test(p[0] || ''))
    .map(([mac, ip, name]) => ({ mac: mac.toUpperCase(), ip, name: name || '' }));
}

export function parseClients(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'wifi' && MAC.test(p[2] || '')) out.set(p[2].toUpperCase(), { mac: p[2].toUpperCase(), band: p[1], rssi: Number((p[3] || '').split('=')[1]) || null, ...(out.get(p[2].toUpperCase()) || {}) });
    if (p[0] === 'arp' && MAC.test(p[2] || '')) out.set(p[2].toUpperCase(), { ...(out.get(p[2].toUpperCase()) || { mac: p[2].toUpperCase() }), ip: p[3] });
  }
  return [...out.values()];
}

/** The router's settings that matter for security, judged: [{ ok, line }]. */
export function judgeSecurity(kv) {
  const v = (k) => kv[k];
  const out = [];
  const add = (ok, line) => out.push({ ok, line });
  add(true, `Firmware ${v('firmver')}.${v('buildno')}_${v('extendno')}`);
  add(v('wl1_auth_mode_x') === 'sae', `5 GHz Wi-Fi: ${v('wl1_auth_mode_x') === 'sae' ? 'WPA3 only' : v('wl1_auth_mode_x')}`);
  add(['psk2', 'psk2sae', 'sae'].includes(v('wl0_auth_mode_x')), `2.4 GHz Wi-Fi: ${v('wl0_auth_mode_x') === 'psk2sae' ? 'WPA2/WPA3 mixed (fine for older smart bulbs)' : v('wl0_auth_mode_x')}`);
  add(v('wps_enable') === '0', `WPS ${v('wps_enable') === '0' ? 'off' : 'ON (turn it off)'}`);
  add(v('misc_http_x') === '0', `Web admin from the internet: ${v('misc_http_x') === '0' ? 'off' : 'ON'}`);
  add(v('sshd_enable') === '2' && v('sshd_pass') === '0', `SSH: ${v('sshd_enable') === '2' ? 'LAN only' : v('sshd_enable') === '1' ? 'LAN AND WAN' : 'off'}, ${v('sshd_pass') === '0' ? 'keys only' : 'passwords allowed'}`);
  add(v('telnetd_enable') === '0', `Telnet ${v('telnetd_enable') === '0' ? 'off' : 'ON'}`);
  add(v('fw_enable_x') === '1', `Firewall ${v('fw_enable_x') === '1' ? 'on' : 'OFF'}`);
  add(v('upnp_enable') === '0', `UPnP ${v('upnp_enable') === '0' ? 'off' : 'on (devices can open ports by themselves)'}`);
  const pf = Number(v('port_forwards') || 0);
  add(pf === 0, `${pf} port forward${pf === 1 ? '' : 's'} open to the internet${pf ? ' (check each is still needed)' : ''}`);
  return out;
}

export default class RouterPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'router';
    this.version = '1.0.0';
    this.worksWithoutCredentials = true;
    this.description = 'The home router (Asuswrt-Merlin): DHCP reservations (static IPs) listed, added, removed or moved to a replacement device, the devices connected, and a security check of its settings. Owner only';
    this.commands = [
      { command: 'reservations', description: 'List the router\'s DHCP reservations (static IPs), with the names the agent knows for each device', usage: 'reservations({})', examples: ['list my dhcp reservations', 'which devices have static ips', 'what ip is the hall light on'] },
      { command: 'unreserved', description: 'Devices connected to the network now that have no DHCP reservation (new devices)', usage: 'unreserved({})', examples: ['which devices have no static ip', 'is there a new device on the network', 'find the new light bulb on the network'] },
      { command: 'reserve', description: 'Give a device a DHCP reservation (static IP): by MAC, with an IP (or the next free one) and an optional name', usage: 'reserve({ mac: "D4:AD:FC:11:22:33", ip: "192.168.1.131", name: "hall-light" })', examples: ['give the new bulb a static ip', 'reserve 192.168.1.140 for D4:AD:FC:11:22:33'] },
      { command: 'unreserve', description: 'Remove a device\'s DHCP reservation, by MAC, IP or light name', usage: 'unreserve({ device: "192.168.1.131" })', examples: ['remove the static ip for 192.168.1.131', 'delete the dhcp reservation of the old bulb'] },
      { command: 'replace', description: 'A replacement device takes over an old one\'s reservation (same IP and name): the old one by MAC, IP or light name; the new one by MAC, or found by itself (the one new unreserved smart-light on the network)', usage: 'replace({ old: "Hall Light", new: "auto" })', examples: ['the new bulb replaces the hall light', 'swap the light bulb in the router', 'give the new bulb the old bulb\'s ip'] },
      { command: 'security', description: 'Check the router\'s security settings (Wi-Fi encryption, WPS, remote admin, SSH, UPnP, port forwards, firmware)', usage: 'security({})', examples: ['check my router security', 'is my wifi secure', 'audit the router'] },
      { command: 'changes', description: 'The changes the agent made on the router', usage: 'changes({})', examples: ['what did you change on the router'] },
      { command: 'backup', description: 'Back up the router: its settings (as the web UI\'s settings file) and its /jffs files, kept on this machine (the last 14; also taken daily by itself). list: true lists the backups', usage: 'backup({})  // backup({ list: true })', examples: ['back up the router', 'make a router backup', 'list the router backups'] },
      { command: 'restore', description: 'Restore the router\'s settings from a backup (the latest, or a named one), then it restarts. Takes a fresh backup first and asks the owner to confirm', usage: 'restore({ backup: "latest" })', examples: ['restore the router settings from the last backup', 'roll the router back to yesterday\'s backup'] },
      { command: 'firmware', description: 'Check the router for a firmware update; update: true installs it with the router\'s own signed upgrade (it restarts by itself), after a fresh backup and the owner\'s confirmation', usage: 'firmware({})  // firmware({ update: true })', examples: ['is there a router firmware update', 'update the router firmware', 'upgrade the router'] },
      { command: 'reboot', description: 'Restart the router (the whole network drops for a few minutes). Asks the owner to confirm', usage: 'reboot({})', examples: ['restart the router', 'reboot the router'] }
    ];
  }

  get host() { return process.env.ROUTER_SSH_HOST || defaultGateway() || ''; }
  get user() { return process.env.ROUTER_SSH_USER || 'admin'; }
  get keyFile() { return process.env.ROUTER_SSH_KEY || path.join(os.homedir(), '.ssh', 'router_agent'); }

  fromOwner(data) {
    const uid = data?._context?.userId;
    return !uid || uid === 'web-user' || String(uid) === String(process.env.TELEGRAM_USER_ID || '');
  }

  /** One wrapper command over SSH. Only `op` from the wrapper's list and checked tokens are ever sent. */
  async run(op, args = [], { input = null, binary = false } = {}) {
    const ops = ['reservations', 'leases', 'clients', 'security', 'changes', 'add', 'remove', 'replace', 'backup-nvram', 'backup-jffs', 'restore', 'fw-check', 'fw-upgrade', 'reboot'];
    if (!ops.includes(op)) throw new Error(`not a router command: ${op}`);
    for (const a of args) if (!/^[A-Za-z0-9.:_-]{1,40}$/.test(String(a))) throw new Error(`refused a router argument: ${a}`);
    await fs.access(this.keyFile).catch(() => { throw new Error('the router key is not set up on this machine'); });
    if (!this.host) throw new Error('no router address: set ROUTER_SSH_HOST');
    return this.ssh(`sh ${WRAPPER} ${[op, ...args].join(' ')}`, input, binary);
  }

  ssh(remote, input = null, binary = false) {
    return new Promise((resolve, reject) => {
      const child = execFile('ssh', ['-i', this.keyFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', `${this.user}@${this.host}`, remote],
        { timeout: 180000, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
          if (err && !stdout?.length) return reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
          resolve(binary ? stdout : String(stdout));
        });
      if (input != null) { child.stdin.end(input); }
    });
  }

  /** The router's copy of the wrapper must be this repository's, byte for byte, before anything is changed. */
  async verifyWrapper() {
    const mine = await fs.readFile(path.join(DEPLOY_PATH, 'scripts', 'router', 'agent-router.sh'));
    const theirs = Buffer.from(await this.ssh(`cat ${WRAPPER}`));
    const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
    if (h(mine) !== h(theirs)) throw new Error('the router script differs from the one I installed, so I changed nothing. Someone or something edited it; say "reinstall the router script" to put mine back');
  }

  /** Names the agent knows per MAC: Govee light names (their id ends in the Wi-Fi MAC) and its network scan. */
  async knownNames() {
    const names = new Map();
    try {
      const govee = this.agent?.apiManager?.apis?.get?.('govee');
      const g = govee?.instance || govee;
      for (const [id, d] of g?.deviceCache || []) {
        const mac = String(id).toUpperCase().split(':').slice(-6).join(':');
        if (MAC.test(mac) && d?.deviceName) names.set(mac, d.deviceName);
      }
    } catch { /* no govee */ }
    try {
      const { default: NetworkDevice } = await import('../../models/NetworkDevice.js');
      for (const d of await NetworkDevice.find({}, { mac: 1, hostname: 1, name: 1, vendor: 1 }).lean()) {
        const mac = String(d.mac || '').toUpperCase();
        if (MAC.test(mac) && !names.has(mac)) names.set(mac, d.name || (d.hostname && !/^\d+\.\d+\.\d+\.\d+$/.test(d.hostname) ? d.hostname : d.vendor) || '');
      }
    } catch { /* no db */ }
    return names;
  }

  /** A device by MAC, IP or a known name, among the reservations: { mac, ip, name } or null. */
  async findReserved(ref, res, names) {
    const r = String(ref || '').trim();
    if (MAC.test(r)) return res.find(x => x.mac === r.toUpperCase()) || null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(r)) return res.find(x => x.ip === r) || null;
    const want = r.toLowerCase();
    return res.find(x => (names.get(x.mac) || x.name || '').toLowerCase() === want)
      || res.find(x => (names.get(x.mac) || x.name || '').toLowerCase().includes(want)) || null;
  }

  async execute(params = {}) {
    const { action, ...data } = params;
    if (!this.fromOwner(params)) return { success: false, error: 'Only my owner can see or change the router.' };
    try {
      switch (action) {
        case 'reservations': return await this.reservations();
        case 'unreserved': return await this.unreserved();
        case 'reserve': return await this.reserve(data);
        case 'unreserve': return await this.unreserve(data);
        case 'replace': return await this.replace(data);
        case 'security': return await this.security();
        case 'changes': return { success: true, result: (await this.run('changes')).trim() || 'I have not changed anything on the router.' };
        case 'backup': return data.list === true || data.list === 'true' ? await this.listBackups() : await this.backup();
        case 'restore': return await this.restore(data, params);
        case 'firmware': return await this.firmware(data, params);
        case 'reboot': return await this.reboot(params);
        default: return { success: false, error: `Unknown action ${action}` };
      }
    } catch (e) {
      this.logger.warn(`router ${action} failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async reservations() {
    const res = parseReservations(await this.run('reservations'));
    const names = await this.knownNames();
    const lines = res.sort((a, b) => a.ip.split('.').pop() - b.ip.split('.').pop()).map(r => `- ${r.ip}  ${r.mac}${names.get(r.mac) || r.name ? `  ${names.get(r.mac) || r.name}` : ''}`);
    return { success: true, reservations: res, result: `${res.length} DHCP reservations:\n${lines.join('\n')}` };
  }

  async unreserved() {
    const [res, clients, names] = await Promise.all([this.run('reservations').then(parseReservations), this.run('clients').then(parseClients), this.knownNames()]);
    const reserved = new Set(res.map(r => r.mac));
    const free = clients.filter(c => !reserved.has(c.mac));
    if (!free.length) return { success: true, devices: [], result: 'Every connected device has a reservation.' };
    return { success: true, devices: free, result: `Connected without a reservation:\n${free.map(c => `- ${c.mac}${c.ip ? ` at ${c.ip}` : ''}${names.get(c.mac) ? ` (${names.get(c.mac)})` : ''}${c.rssi ? `, Wi-Fi ${c.rssi} dBm` : ''}`).join('\n')}` };
  }

  /** The next free address: above the highest reservation in .100–.249, not taken by any connected device. */
  nextFreeIp(res, clients) {
    const taken = new Set([...res.map(r => r.ip), ...clients.map(c => c.ip).filter(Boolean)]);
    const base = this.host.split('.').slice(0, 3).join('.');
    for (let i = 100; i < 250; i++) if (!taken.has(`${base}.${i}`)) return `${base}.${i}`;
    return null;
  }

  async reserve({ mac, ip, name } = {}) {
    if (!MAC.test(String(mac || ''))) return { success: false, error: 'Which device? Give me its MAC (e.g. D4:AD:FC:11:22:33), or say "which devices have no static ip".' };
    if (name && !NAME.test(String(name))) return { success: false, error: 'A reservation name may use letters, digits, dot, dash and underscore only (up to 32).' };
    await this.verifyWrapper();
    const [res, clients] = await Promise.all([this.run('reservations').then(parseReservations), this.run('clients').then(parseClients)]);
    const addr = ip || this.nextFreeIp(res, clients);
    if (!addr) return { success: false, error: 'No free address left between .100 and .249.' };
    const out = (await this.run('add', [String(mac).toUpperCase(), addr, ...(name ? [name] : [])])).trim();
    if (!out.startsWith('OK')) return { success: false, error: `The router refused it: ${out}` };
    return this.done(`Reserved ${addr} for ${String(mac).toUpperCase()}${name ? ` (${name})` : ''}. It gets that address the next time it connects (power-cycle it to do it now).`);
  }

  async unreserve({ device, mac, ip } = {}) {
    const res = parseReservations(await this.run('reservations'));
    const hit = await this.findReserved(device || mac || ip, res, await this.knownNames());
    if (!hit) return { success: false, error: `No reservation matches "${device || mac || ip}".` };
    await this.verifyWrapper();
    const out = (await this.run('remove', [hit.mac])).trim();
    if (!out.startsWith('OK')) return { success: false, error: `The router refused it: ${out}` };
    return this.done(`Removed the reservation ${hit.ip} for ${hit.mac}.`);
  }

  async replace({ old, new: newer } = {}) {
    const [res, clients, names] = await Promise.all([this.run('reservations').then(parseReservations), this.run('clients').then(parseClients), this.knownNames()]);
    const from = await this.findReserved(old, res, names);
    if (!from) return { success: false, error: `No reservation matches "${old}". Say "list my dhcp reservations" to see them.` };
    let to = MAC.test(String(newer || '')) ? String(newer).toUpperCase() : null;
    if (!to) {
      // The new device: connected, no reservation, and a smart-light maker's MAC (like the one it replaces).
      const reserved = new Set(res.map(r => r.mac));
      const oui = from.mac.slice(0, 8);
      const cands = clients.filter(c => !reserved.has(c.mac) && (c.mac.startsWith(oui) || GOVEE_OUI.some(p => c.mac.startsWith(p))));
      if (cands.length !== 1) {
        return { success: false, error: cands.length ? `I see ${cands.length} new smart-light devices: ${cands.map(c => `${c.mac}${c.ip ? ` (${c.ip})` : ''}`).join(', ')}. Which one is the new bulb?` : 'I don\'t see a new smart-light bulb on the network yet. Is it powered on and set up on the Wi-Fi?' };
      }
      to = cands[0].mac;
    }
    await this.verifyWrapper();
    const out = (await this.run('replace', [from.mac, to])).trim();
    if (!out.startsWith('OK')) return { success: false, error: `The router refused it: ${out}` };
    return this.done(`${to} now has ${from.ip}${names.get(from.mac) ? ` (was ${names.get(from.mac)}, ${from.mac})` : ` (was ${from.mac})`}. Power-cycle the new bulb so it picks up its address.`);
  }

  async security() {
    const kv = Object.fromEntries((await this.run('security')).split('\n').map(l => l.split('=')).filter(p => p[0]).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
    const checks = judgeSecurity(kv);
    const bad = checks.filter(c => !c.ok);
    return { success: true, checks, result: `Router security${bad.length ? ` (${bad.length} to look at)` : ' (all good)'}:\n${checks.map(c => `${c.ok ? '✓' : '⚠️'} ${c.line}`).join('\n')}` };
  }

  // ── Backup, restore, firmware, reboot (owner, 2026-11-21: "make sure it can backup, restore, update and restart") ──
  backupRoot() { return this.backupDir || path.join(DATA_PATH, 'router-backups'); }

  async initialize() {
    // A backup a day, by itself, while the key is set up (the router holds every reservation and the Wi-Fi keys).
    const daily = async () => { try { await fs.access(this.keyFile); await this.backup({ quiet: true }); } catch (e) { if (!/key is not set up|ENOENT/.test(e.message)) this.logger.warn(`router: daily backup failed: ${e.message}`); } };
    this.backupTimer = setInterval(daily, 24 * 3600 * 1000);
    this.backupTimer.unref?.();
  }

  async cleanup() { clearInterval(this.backupTimer); }

  /** Settings (nvram save, the web UI's settings file) + /jffs, kept owner-only under data/router-backups/<time>/. */
  async backup({ quiet = false } = {}) {
    const settings = await this.run('backup-nvram', [], { binary: true });
    if (!settings?.length) throw new Error('the router gave an empty settings file');
    const jffs = await this.run('backup-jffs', [], { binary: true }).catch(() => null);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(this.backupRoot(), stamp);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, 'settings.cfg'), settings, { mode: 0o600 });
    if (jffs?.length) await fs.writeFile(path.join(dir, 'jffs.tgz'), jffs, { mode: 0o600 });
    const fw = (await this.run('security').catch(() => '')).match(/buildno=(\S+)[\s\S]*extendno=(\S+)/);
    await fs.writeFile(path.join(dir, 'about.json'), JSON.stringify({ at: new Date().toISOString(), firmware: fw ? `${fw[1]}_${fw[2]}` : null, settingsBytes: settings.length, jffsBytes: jffs?.length || 0 }, null, 2), { mode: 0o600 });
    const all = (await fs.readdir(this.backupRoot()).catch(() => [])).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await fs.rm(path.join(this.backupRoot(), old), { recursive: true, force: true });
    this.logger.info(`router: backup ${stamp} (settings ${settings.length} B, jffs ${jffs?.length || 0} B)`);
    return { success: true, backup: stamp, result: `Router backed up (${stamp}): settings ${Math.round(settings.length / 1024)} KB${jffs?.length ? `, /jffs ${Math.round(jffs.length / 1024)} KB` : ''}. I keep the last ${KEEP_BACKUPS}.` };
  }

  async listBackups() {
    const all = (await fs.readdir(this.backupRoot()).catch(() => [])).sort().reverse();
    if (!all.length) return { success: true, backups: [], result: 'No router backups yet.' };
    const rows = [];
    for (const b of all) { const a = await fs.readFile(path.join(this.backupRoot(), b, 'about.json'), 'utf8').then(JSON.parse).catch(() => ({})); rows.push(`- ${b}${a.firmware ? ` (firmware ${a.firmware})` : ''}`); }
    return { success: true, backups: all, result: `Router backups, newest first:\n${rows.join('\n')}` };
  }

  /**
   * A hard-to-undo action goes ahead only on the owner's yes within 5 minutes of asking: the first call explains and
   * waits; `confirm: true`, or a "yes / go ahead" reply, carries it out.
   */
  confirmed(action, data, params, ask) {
    const said = String(params?._context?.originalInput || params?.originalInput || '');
    const p = this.pending;
    if ((data.confirm === true || data.confirm === 'true' || (p && YES.test(said))) && p?.action === action && Date.now() - p.at < CONFIRM_MS) { this.pending = null; return true; }
    this.pending = { action, at: Date.now(), data };
    return ask;
  }

  async restore(data, params) {
    const all = (await fs.readdir(this.backupRoot()).catch(() => [])).sort();
    const pick = !data.backup || data.backup === 'latest' ? all.at(-1) : all.find(b => b.startsWith(String(data.backup)));
    if (!pick) return { success: false, error: all.length ? `No backup named "${data.backup}". Say "list the router backups".` : 'There are no router backups to restore from.' };
    const ok = this.confirmed('restore', data, params, { success: true, needsConfirmation: true, result: `This restores the router's settings from ${pick} and restarts it: the whole network (me included) drops for a few minutes, and any change since then is undone. I take a fresh backup first. Say "yes, restore the router" to go ahead (within 5 minutes).` });
    if (ok !== true) return ok;
    await this.verifyWrapper();
    await this.backup();
    const out = String(await this.run('restore', [], { input: await fs.readFile(path.join(this.backupRoot(), pick, 'settings.cfg')) })).trim();
    if (!out.startsWith('OK')) return { success: false, error: `The router refused it: ${out}` };
    return this.done(`Restored the settings from ${pick}; the router is restarting now (back in a few minutes).`);
  }

  async firmware(data, params) {
    const out = String(await this.run('fw-check')).trim();
    const kv = Object.fromEntries(out.split(/\s+/).map(x => x.split('=')));
    const available = kv.flag === '1' || kv.flag === '2' ? kv.available : null;
    if (!(data.update === true || data.update === 'true' || this.pending?.action === 'firmware')) {
      return { success: true, firmware: kv, result: available ? `A router firmware update is available: ${available.replace(/_/g, '.')} (you run ${kv.current}). Say "update the router firmware" to install it.` : `The router's firmware is up to date (${kv.current}).` };
    }
    if (!available) return { success: true, result: `There is no firmware update to install (you run ${kv.current}).` };
    const ok = this.confirmed('firmware', data, params, { success: true, needsConfirmation: true, result: `This installs router firmware ${available.replace(/_/g, '.')} with the router's own signed upgrade; it restarts by itself and the whole network (me included) is down for about 5 minutes. I take a backup first. Say "yes, update the router firmware" to go ahead (within 5 minutes).` });
    if (ok !== true) return ok;
    await this.verifyWrapper();
    await this.backup();
    const r = String(await this.run('fw-upgrade')).trim();
    if (!r.startsWith('OK')) return { success: false, error: `The router refused it: ${r}` };
    return this.done(`Installing router firmware ${available.replace(/_/g, '.')}; the router restarts by itself, the network is back in about 5 minutes.`);
  }

  async reboot(params) {
    const ok = this.confirmed('reboot', params, params, { success: true, needsConfirmation: true, result: 'This restarts the router: the whole network (me included) drops for a few minutes. Say "yes, reboot the router" to go ahead (within 5 minutes).' });
    if (ok !== true) return ok;
    await this.verifyWrapper();
    // Told first: once the router goes down, so does the way to tell.
    await this.agent?.notify?.('🛜 Router: restarting now; the network is back in a few minutes.').catch?.(() => {});
    const r = String(await this.run('reboot')).trim();
    if (!r.startsWith('OK')) return { success: false, error: `The router refused it: ${r}` };
    this.logger.info('router: reboot');
    return { success: true, result: 'Restarting the router now; the network is back in a few minutes.' };
  }

  async done(text) {
    this.logger.info(`router: ${text}`);
    await this.agent?.notify?.(`🛜 Router: ${text}`).catch?.(() => {});
    return { success: true, result: text };
  }
}
