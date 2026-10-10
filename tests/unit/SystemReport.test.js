import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SystemReport } from '../../src/models/SystemReport.js';

const mk = (i, { type = 'daily', avg = 100, errors = 3, totalPnL = i * 10 } = {}) => ({
  _id: `report_${type}_${i}`,
  reportType: type,
  content: {
    performance: { avgResponseTime: avg, peakMemoryUsage: 500, jobSuccessRate: 95 },
    issues: { errorsLogged: errors, criticalIssues: 0, systemRestarts: 0 },
    cryptoActivity: { totalPnL }
  },
  createdAt: new Date(Date.UTC(2026, 0, 1 + i))
});

describe('SystemReport.detectAnomalies', () => {
  let original;
  beforeEach(() => { original = SystemReport.getReportsInRange; });
  afterEach(() => { SystemReport.getReportsInRange = original; });

  it('flags an outlier against a varying leave-one-out baseline', async () => {
    const avgs = [100, 104, 98, 102, 101, 99, 103, 400];
    const reports = avgs.map((avg, i) => mk(i, { avg }));
    SystemReport.getReportsInRange = () => Promise.resolve(reports);

    const anomalies = await SystemReport.detectAnomalies(30, 2.0);
    const hits = anomalies.filter(a => a.metric === 'performance.avgResponseTime');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].reportId, 'report_daily_7');
    assert.equal(hits[0].reportType, 'daily');
    assert.equal(hits[0].observedValue, 400);
    assert.ok(hits[0].zScore > 2);
    assert.ok(hits[0].expectedRange.max < 400);
    assert.ok(hits[0].timestamp instanceof Date);
  });

  it('can flag an outlier in a small window (outlier excluded from its own baseline)', async () => {
    // 6 points: with the outlier inside the baseline max |z| = 5/sqrt(6) ≈ 2.04 — barely possible;
    // leave-one-out makes it clear-cut.
    const reports = [100, 101, 99, 100, 102, 300].map((avg, i) => mk(i, { avg }));
    SystemReport.getReportsInRange = () => Promise.resolve(reports);
    const hits = (await SystemReport.detectAnomalies()).filter(a => a.metric === 'performance.avgResponseTime');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].observedValue, 300);
  });

  it('does not compare daily reports against weekly ones', async () => {
    // weekly counts are ~7x daily counts; mixed they would look anomalous
    // one weekly report among dailies would be a huge z-score if pooled
    const daily = [3, 4, 3, 4, 3, 4, 3, 4].map((errors, i) => mk(i, { errors }));
    const weekly = [mk(0, { type: 'weekly', errors: 24 })];
    SystemReport.getReportsInRange = () => Promise.resolve([...daily, ...weekly]);
    const hits = (await SystemReport.detectAnomalies()).filter(a => a.metric === 'issues.errorsLogged');
    assert.deepEqual(hits, []);
  });

  it('ignores cumulative totalPnL and needs enough samples', async () => {
    const reports = Array.from({ length: 8 }, (_, i) => mk(i, { totalPnL: i === 7 ? 9999 : i * 10 }));
    SystemReport.getReportsInRange = () => Promise.resolve(reports);
    const anomalies = await SystemReport.detectAnomalies();
    assert.equal(anomalies.filter(a => a.metric.includes('totalPnL')).length, 0);

    SystemReport.getReportsInRange = () => Promise.resolve([100, 100, 900].map((avg, i) => mk(i, { avg })));
    assert.deepEqual(await SystemReport.detectAnomalies(), [], 'too few samples');
  });

  it('returns [] when there are no reports or a flat baseline', async () => {
    SystemReport.getReportsInRange = () => Promise.resolve([]);
    assert.deepEqual(await SystemReport.detectAnomalies(), []);
    SystemReport.getReportsInRange = () => Promise.resolve(Array.from({ length: 6 }, (_, i) => mk(i)));
    assert.deepEqual(await SystemReport.detectAnomalies(), []);
  });
});
