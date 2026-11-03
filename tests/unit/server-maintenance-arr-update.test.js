/**
 * *arr app updates go through the app's own updater, backup first.
 *
 * goliath carries a stale `sonarr 3.0.10` dpkg record while v4/v5 runs from
 * /opt/Sonarr, so the agent reported 3.0.10 and tried apt. The 4.0.20 → 5.0.0
 * major update was never auto-installed and had to be done by hand (2026-10-14).
 */
import test from 'node:test';
import assert from 'node:assert';
import { ServerMaintenanceAgent } from '../../src/services/subagents/ServerMaintenanceAgent.js';

const SONARR = { name: 'sonarr', unit: 'sonarr', checkMethod: 'systemd', port: 8989 };

/** Agent whose SSH transport fakes a host running sonarr's API. */
function makeAgent({ version = '4.0.20.3012', updates, backupStatus = 'completed', updateTakes = true } = {}) {
  const calls = [];
  let current = version;
  const respond = (command) => {
    calls.push(command);
    if (command.startsWith('dpkg -l')) return '3.0.10\n';
    if (command.startsWith('systemctl is-active')) return 'active\n';
    const m = command.match(/-X (\w+) .*\/api\/v3\/(\S+) 2>/);
    if (!m) return '';
    const [, method, path] = m;
    if (path === 'system/status') return JSON.stringify({ version: current, branch: 'develop' });
    if (path === 'update') return JSON.stringify(updates ?? [{ version: '5.0.0.2608', installable: true, installed: false }, { version: current, installed: true }]);
    if (path === 'system/backup') return JSON.stringify([{ name: 'old.zip', time: '2026-09-09T00:00:00Z' }, { name: 'sonarr_backup_new.zip', time: '2026-10-14T18:11:52Z' }]);
    if (method === 'POST' && path === 'command') {
      if (command.includes('ApplicationUpdate')) {
        if (updateTakes) current = '5.0.0.2608';
        return JSON.stringify({ id: 2, status: 'started' });
      }
      return JSON.stringify({ id: 1, status: 'queued' });
    }
    if (path === 'command/1') return JSON.stringify({ id: 1, status: backupStatus });
    return '';
  };
  const mainAgent = { apiManager: { executeAPI: async (_p, _a, { command }) => ({ success: true, data: { stdout: respond(command) } }) } };
  const agentDoc = { name: 't', config: { domainConfig: {} }, state: { domainState: {} }, save: async () => {} };
  const a = new ServerMaintenanceAgent(mainAgent, agentDoc);
  a.sshConnectionId = 'root@host:22';
  return { agent: a, calls };
}

test('version comes from the API, not a stale dpkg record', async () => {
  const { agent } = makeAgent();
  assert.equal(await agent.getAppVersion(SONARR), '4.0.20.3012');
});

test('backs up, then installs the major update, and reports the new version', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, calls } = makeAgent();
  const p = agent.updateArrApp(SONARR, 'goliath');
  for (let i = 0; i < 10; i++) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(5000); }
  const r = await p;
  assert.equal(r.success, true, r.message);
  assert.match(r.message, /4\.0\.20\.3012 → 5\.0\.0\.2608/);
  assert.match(r.message, /sonarr_backup_new\.zip/);
  const backupAt = calls.findIndex(c => c.includes('"name":"Backup"'));
  const updateAt = calls.findIndex(c => c.includes('ApplicationUpdate'));
  assert.ok(backupAt >= 0 && updateAt > backupAt, 'backup must run before the update');
  assert.ok(calls[updateAt].includes('"installMajorUpdate":true'));
});

test('a failed backup blocks the update', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, calls } = makeAgent({ backupStatus: 'failed' });
  const p = agent.updateArrApp(SONARR, 'goliath');
  for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(5000); }
  const r = await p;
  assert.equal(r.success, false);
  assert.match(r.message, /update NOT attempted/);
  assert.ok(!calls.some(c => c.includes('ApplicationUpdate')));
});

test('nothing installable: no backup, no update', async () => {
  const { agent, calls } = makeAgent({ updates: [{ version: '4.0.20.3012', installed: true, installable: false }] });
  const r = await agent.updateArrApp(SONARR, 'goliath');
  assert.equal(r.success, true);
  assert.match(r.message, /already up to date \(4\.0\.20\.3012/);
  assert.ok(!calls.some(c => c.includes('"name":"Backup"')));
});

test('an API that never answers falls through to the legacy path (null)', async () => {
  const mainAgent = { apiManager: { executeAPI: async () => ({ success: true, data: { stdout: '' } }) } };
  const a = new ServerMaintenanceAgent(mainAgent, { name: 't', config: { domainConfig: {} }, state: { domainState: {} }, save: async () => {} });
  a.sshConnectionId = 'root@host:22';
  assert.equal(await a.updateArrApp(SONARR, 'goliath'), null);
});

test('a failed backup says why, and the Backups folder is repaired before it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, calls } = makeAgent({ backupStatus: 'failed' });
  const realExec = agent.mainAgent.apiManager.executeAPI;
  agent.mainAgent.apiManager.executeAPI = async (p, a, args) => {
    if (/\/command\/1 2>/.test(args.command)) {
      return { success: true, data: { stdout: JSON.stringify({ id: 1, status: 'failed', exception: 'System.UnauthorizedAccessException: Backup folder /var/lib/sonarr/Backups/manual is not writable\n   at ...' }) } };
    }
    return realExec(p, a, args);
  };
  const p = agent.updateArrApp(SONARR, 'goliath');
  for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(5000); }
  const r = await p;
  assert.equal(r.success, false);
  assert.match(r.message, /Reason: System\.UnauthorizedAccessException: Backup folder \/var\/lib\/sonarr\/Backups\/manual is not writable$/);
  const healAt = calls.findIndex(c => c.includes('chown -R') && c.includes('/var/lib/sonarr'));
  const backupAt = calls.findIndex(c => c.includes('"name":"Backup"'));
  assert.ok(healAt >= 0 && healAt < backupAt, 'ownership repair must run before the backup');
});

/** Agent with two *arr apps (sonarr outdated, radarr current) and a Telegram spy. */
function makeAutoAgent(opts = {}) {
  const { agent, calls } = makeAgent(opts);
  const sent = [];
  // updateState goes through the Mongoose model; merge the way its $set does
  agent.updateState = async (u) => { Object.assign(agent.agentDoc.state.domainState, u); };
  agent.mainAgent.interfaces = new Map([['telegram', { sendNotification: async (m, o) => { sent.push({ m, o }); return true; } }]]);
  const RADARR = { name: 'radarr', unit: 'radarr', checkMethod: 'systemd', port: 7878 };
  const config = { arrAutoUpdate: { enabled: true, windowStartHour: 3, windowEndHour: 7 }, monitoredServices: { apps: [RADARR, SONARR] } };
  // radarr answers on /api/v3 too; make it current
  const exec = agent.mainAgent.apiManager.executeAPI;
  agent.mainAgent.apiManager.executeAPI = async (p, a, args) => {
    if (args.command.includes('localhost:7878')) {
      if (args.command.includes('/system/status')) return { success: true, data: { stdout: JSON.stringify({ version: '7.0.1', branch: 'develop' }) } };
      if (args.command.includes('/update 2>')) return { success: true, data: { stdout: JSON.stringify([{ version: '7.0.1', installed: true }]) } };
    }
    return exec(p, a, args);
  };
  return { agent, calls, sent, config };
}

async function drive(t, p, n = 10) {
  for (let i = 0; i < n; i++) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(5000); }
  return p;
}

test('auto-update: does nothing outside the night window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 14, 0).getTime() });
  const { agent, calls, sent, config } = makeAutoAgent();
  assert.equal(await agent.autoUpdateArrApps(config, 'goliath'), null);
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
});

test('auto-update: inside the window it updates the outdated app, quietly, once a day', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 4, 0).getTime() });
  const { agent, calls, sent, config } = makeAutoAgent();
  const r = await drive(t, agent.autoUpdateArrApps(config, 'goliath'));
  assert.equal(r.app, 'sonarr');
  assert.equal(r.success, true, r.message);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].o.urgent, false);
  assert.match(sent[0].m, /Updated sonarr/);
  const st = agent.getState().arrAutoUpdate;
  assert.deepEqual(st.handled, ['radarr', 'sonarr']);
  assert.equal(st.history.length, 1);
  const before = calls.length;
  assert.equal(await agent.autoUpdateArrApps(config, 'goliath'), null, 'second run the same day does nothing');
  assert.equal(calls.length, before);
});

test('auto-update: a failure is urgent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 4, 0).getTime() });
  const { agent, sent, config } = makeAutoAgent({ backupStatus: 'failed' });
  const r = await drive(t, agent.autoUpdateArrApps(config, 'goliath'), 5);
  assert.equal(r.success, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].o.urgent, true);
  assert.match(sent[0].m, /update NOT attempted/);
});

test('auto-update: an app the owner stopped is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 3, 4, 0).getTime() });
  const { agent, calls, sent, config } = makeAutoAgent();
  await agent.updateState({ monitoredApps: { sonarr: { manuallyStopped: true } } });
  assert.equal(await agent.autoUpdateArrApps(config, 'goliath'), null);
  assert.ok(!calls.some(c => c.includes('"name":"Backup"')));
  assert.equal(sent.length, 0);
});

test('an approval is asked once and never stops the agent', async () => {
  const { agent } = makeAgent();
  agent.agentDoc.status = 'idle';
  agent.agentDoc.state.pendingApprovals = [];
  await agent.requestApproval('apt_upgrade', '79 apt updates. Run apt-get upgrade?', { updateCount: 79 });
  await agent.requestApproval('apt_upgrade', '80 apt updates. Run apt-get upgrade?', { updateCount: 80 });
  await agent.requestApproval('service_restart', 'smbd down', { service: 'smbd' });
  await agent.requestApproval('service_restart', 'smbd down', { service: 'smbd' });
  await agent.requestApproval('service_restart', 'docker down', { service: 'docker' });
  assert.deepEqual(agent.agentDoc.state.pendingApprovals.map(a => `${a.action}:${a.data.service || ''}`),
    ['apt_upgrade:', 'service_restart:smbd', 'service_restart:docker']);
  assert.equal(agent.agentDoc.status, 'idle');
});
