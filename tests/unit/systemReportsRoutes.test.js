import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import router, { diffReports } from '../../src/api/services/systemReports.js';

// The last handler of a GET route (the one after authenticateToken).
function handler(path) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods.get);
  assert.ok(layer, `route ${path} exists`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

describe('diffReports', () => {
  it('diffs metrics both reports carry and skips non-numeric and one-sided keys', () => {
    const r1 = { content: { performance: { avgResponseTime: 8071, jobSuccessRate: 100 },
      issues: { errorsLogged: 633, criticalIssues: 3, lastMaintenance: '11/10/2026' } } };
    const r2 = { content: { performance: { avgResponseTime: 7409, jobSuccessRate: 100, peakMemoryUsage: 11036 },
      issues: { errorsLogged: 45, criticalIssues: 0, lastMaintenance: '11/11/2026' } } };
    const d = diffReports(r1, r2);
    assert.equal(d.performance.avgResponseTime.absoluteChange, -662);
    assert.equal(d.performance.jobSuccessRate.percentageChange, 0);
    assert.equal(d.performance.peakMemoryUsage, undefined);
    assert.equal(d.issues.criticalIssues.percentageChange, -100);
    assert.equal(d.issues.lastMaintenance, undefined);
  });

  it('reports a null percentage when the base value is 0', () => {
    const d = diffReports({ content: { issues: { criticalIssues: 0 } } }, { content: { issues: { criticalIssues: 2 } } });
    assert.equal(d.issues.criticalIssues.absoluteChange, 2);
    assert.equal(d.issues.criticalIssues.percentageChange, null);
  });
});

describe('GET /reports/diff', () => {
  it('rejects missing and malformed ids with 400 before querying', async () => {
    const h = handler('/reports/diff');
    let res = fakeRes();
    await h({ query: { id1: '6af49f127b9425704492c8d3' } }, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await h({ query: { id1: 'abc', id2: '6af49f127b9425704492c8d3' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

describe('GET /reports/:id', () => {
  it('passes named paths on to the later routes instead of treating them as ids', async () => {
    const h = handler('/reports/:id');
    for (const id of ['trends', 'comparison']) {
      let nexted = false;
      const res = fakeRes();
      await h({ params: { id } }, res, () => { nexted = true; });
      assert.equal(nexted, true, `${id} reaches its own route`);
      assert.equal(res.body, null);
    }
  });

  it('registers /reports/diff before /reports/:id', () => {
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    assert.ok(paths.indexOf('/reports/diff') < paths.indexOf('/reports/:id'));
  });
});
