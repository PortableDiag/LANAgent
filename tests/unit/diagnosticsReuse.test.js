// selfDiagnosticsEnhanced.runDiagnostics: an interactive ask inside minTimeBetweenRuns
// (or during a run) gets the last result, not a failure that stops a plugin chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import Service from '../../src/services/selfDiagnosticsEnhanced.js';

function svc() {
  const s = Object.create(Service.prototype);
  s.config = { minTimeBetweenRuns: 60000, startupDelay: 0 };
  s.startupTime = 0;
  s.isRunning = false;
  s.lastRun = new Date(Date.now() - 22000);
  s.lastResult = { success: true, reportId: 'r1', overallHealth: 'healthy', summary: 'ok' };
  return s;
}

test('manual ask 22 s after a run reuses it', async () => {
  const r = await svc().runDiagnostics('manual', 'dialx-owner');
  assert.equal(r.success, true);
  assert.equal(r.reportId, 'r1');
  assert.equal(r.cached, true);
  assert.ok(r.ageSeconds >= 22);
});

test('scheduled run inside the window still skips', async () => {
  const r = await svc().runDiagnostics('scheduled', 'system');
  assert.equal(r.success, false);
});

test('manual ask during a run waits for it', async () => {
  const s = svc();
  s.isRunning = true; s.lastRun = null; s.lastResult = null;
  setTimeout(() => { s.isRunning = false; s.lastRun = new Date(); s.lastResult = { success: true, reportId: 'r2' }; }, 300);
  const r = await s.runDiagnostics('manual', 'user');
  assert.equal(r.success, true);
  assert.equal(r.reportId, 'r2');
});
