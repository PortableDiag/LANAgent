// The router plugin (2026-11-21): DHCP reservations on Asuswrt-Merlin through the agent's wrapper script only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import RouterPlugin, { parseReservations, parseClients, judgeSecurity } from '../../src/api/plugins/router.js';

const RES = 'D4:AD:FC:00:00:01 192.168.1.131 \nAA:BB:CC:00:00:01 192.168.1.60 nas\n';
const CLIENTS = 'wifi eth5 D4:AD:FC:99:88:77 rssi=-55\narp eth0 D4:AD:FC:99:88:77 192.168.1.177\nwifi eth5 D4:AD:FC:00:00:01 rssi=-60\narp eth0 11:22:33:44:55:66 192.168.1.200\n';

function plugin({ wrapperMatches = true, res = RES, clients = CLIENTS } = {}) {
  const p = new RouterPlugin({ notify: async () => {} });
  p.logger = { info() {}, warn() {} };
  const sent = [];
  p.ssh = async (remote) => { sent.push(remote); if (remote.startsWith('cat ')) return wrapperMatches ? 'SAME' : 'EDITED';
    if (/ reservations$/.test(remote)) return res; if (/ clients$/.test(remote)) return clients;
    if (/ replace /.test(remote)) return 'OK replaced'; if (/ add /.test(remote)) return 'OK added'; if (/ remove /.test(remote)) return 'OK removed'; return ''; };
  p.verifyWrapper = async function () { const t = await this.ssh('cat /jffs/agent/router.sh'); if (t !== 'SAME') throw new Error('the router script differs from the one I installed, so I changed nothing'); };
  p.knownNames = async () => new Map([['D4:AD:FC:00:00:01', 'Hall Light']]);
  p.fs = null;
  return { p, sent };
}
// The key file check: pretend it exists.
import fs from 'node:fs/promises';
fs.access = async () => {};
process.env.ROUTER_SSH_HOST = '192.168.1.1';

test('parsing the wrapper\'s answers', () => {
  assert.deepEqual(parseReservations(RES), [{ mac: 'D4:AD:FC:00:00:01', ip: '192.168.1.131', name: '' }, { mac: 'AA:BB:CC:00:00:01', ip: '192.168.1.60', name: 'nas' }]);
  const c = parseClients(CLIENTS);
  assert.equal(c.find(x => x.mac === 'D4:AD:FC:99:88:77').ip, '192.168.1.177');
  assert.equal(c.find(x => x.mac === 'D4:AD:FC:99:88:77').rssi, -55);
});

test('security: risky settings are flagged', () => {
  const j = judgeSecurity({ firmver: '3.0.0.4', buildno: '388.9', extendno: '2', wl0_auth_mode_x: 'psk2sae', wl1_auth_mode_x: 'sae', wps_enable: '0', misc_http_x: '0', sshd_enable: '2', sshd_pass: '0', telnetd_enable: '0', fw_enable_x: '1', upnp_enable: '1', port_forwards: '8' });
  assert.deepEqual(j.filter(x => !x.ok).map(x => x.line), ['UPnP on (devices can open ports by themselves)', '8 port forwards open to the internet (check each is still needed)']);
});

test('the new bulb takes over the old one\'s reservation, found by itself; only the wrapper\'s commands go out', async () => {
  const { p, sent } = plugin();
  const r = await p.execute({ action: 'replace', old: 'Hall Light', new: 'auto' });
  assert.equal(r.success, true, r.error);
  assert.match(r.result, /D4:AD:FC:99:88:77 now has 192\.168\.1\.131 \(was Hall Light/);
  assert.ok(sent.includes('sh /jffs/agent/router.sh replace D4:AD:FC:00:00:01 D4:AD:FC:99:88:77'));
  assert.ok(sent.every(s => s.startsWith('sh /jffs/agent/router.sh ') || s === 'cat /jffs/agent/router.sh'));
});

test('two new bulbs: asks which; an edited wrapper: changes nothing', async () => {
  let t = plugin({ clients: CLIENTS + 'wifi eth5 D4:AD:FC:11:11:11 rssi=-50\n' });
  assert.match((await t.p.execute({ action: 'replace', old: '192.168.1.131' })).error, /2 new smart-light devices/);
  t = plugin({ wrapperMatches: false });
  const r = await t.p.execute({ action: 'replace', old: 'Hall Light', new: 'D4:AD:FC:99:88:77' });
  assert.match(r.error, /differs from the one I installed/);
  assert.equal(t.sent.some(s => / replace /.test(s)), false);
});

test('reserve picks the next free address; bad input and strangers are refused', async () => {
  const { p, sent } = plugin();
  const r = await p.execute({ action: 'reserve', mac: 'd4:ad:fc:99:88:77' });
  assert.match(r.result, /Reserved 192\.168\.1\.100 for D4:AD:FC:99:88:77/);
  assert.ok(sent.includes('sh /jffs/agent/router.sh add D4:AD:FC:99:88:77 192.168.1.100'));
  assert.match((await p.execute({ action: 'reserve', mac: 'x; reboot' })).error, /Which device/);
  await assert.rejects(p.run('add', ['AA:BB:CC:00:00:02', '192.168.1.5; reboot']), /refused a router argument/);
  await assert.rejects(p.run('nvram'), /not a router command/);
  assert.match((await p.execute({ action: 'reservations', _context: { userId: 'stranger-42' } })).error, /Only my owner/);
});

test('the router address defaults to the default gateway', async () => {
  const { defaultGateway } = await import('../../src/api/plugins/router.js');
  assert.equal(defaultGateway('Iface\tDestination\tGateway\neno1\t00000000\t0101A8C0\t0003\n'), '192.168.1.1');
  assert.equal(defaultGateway('Iface\tDestination\tGateway\n'), null);
});

test('backup keeps settings and /jffs owner-only; reboot and restore wait for a confirming yes', async () => {
  const os = await import('node:os'); const path = await import('node:path'); const fsx = await import('node:fs');
  const { p, sent } = plugin();
  p.backupDir = fsx.mkdtempSync(path.join(os.tmpdir(), 'router-bk-'));
  const base = p.ssh;
  p.ssh = async (remote, input, binary) => { if (/ backup-nvram$/.test(remote)) return Buffer.from('CFGDATA'); if (/ backup-jffs$/.test(remote)) return Buffer.from('TGZ'); if (/ reboot$/.test(remote)) return 'OK rebooting'; if (/ restore$/.test(remote)) { sent.push(`restore:${input}`); return 'OK restored, rebooting'; } return base(remote, input, binary); };
  const b = await p.execute({ action: 'backup' });
  assert.equal(b.success, true, b.error);
  const dir = path.join(p.backupDir, b.backup);
  assert.equal(fsx.readFileSync(path.join(dir, 'settings.cfg'), 'utf8'), 'CFGDATA');
  assert.equal(fsx.statSync(path.join(dir, 'settings.cfg')).mode & 0o777, 0o600);
  // Reboot: asked first, done only on the yes.
  let r = await p.execute({ action: 'reboot', _context: { originalInput: 'reboot the router' } });
  assert.equal(r.needsConfirmation, true);
  assert.equal(sent.some(s => / reboot$/.test(s)), false);
  r = await p.execute({ action: 'reboot', _context: { originalInput: 'yes, reboot the router' } });
  assert.match(r.result, /Restarting the router now/);
  // Restore: asked, then a fresh backup and the file sent.
  r = await p.execute({ action: 'restore', _context: { originalInput: 'restore the router from the last backup' } });
  assert.equal(r.needsConfirmation, true);
  r = await p.execute({ action: 'restore', _context: { originalInput: 'yes, restore the router' } });
  assert.match(r.result, /Restored the settings/);
  assert.ok(sent.includes('restore:CFGDATA'));
  assert.equal(fsx.readdirSync(p.backupDir).length >= 1, true);
});
