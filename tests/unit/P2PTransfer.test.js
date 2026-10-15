import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { P2PTransfer } from '../../src/models/P2PTransfer.js';

// Hydrate without saving — exercises the progress instance methods
// directly. Mongoose's `init: false` lets us run getters without a
// connected DB or write.
const makeTransfer = (overrides = {}) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    peerFingerprint: 'fp-test',
    pluginName: 'test-plugin',
    direction: 'incoming',
    status: 'transferring',
    totalChunks: 100,
    receivedChunks: 25,
    totalSize: 1_000_000, // 1MB
    startedAt: new Date(Date.now() - 5_000), // 5s ago
    completedAt: null,
    ...overrides
  };
  return new P2PTransfer(doc);
};

test('getProgressPercentage: 25/100 → 25', () => {
  assert.equal(makeTransfer().getProgressPercentage(), 25);
});

test('getProgressPercentage: clamps to 100 when overshot', () => {
  assert.equal(makeTransfer({ receivedChunks: 250 }).getProgressPercentage(), 100);
});

test('getProgressPercentage: returns 0 on missing totalChunks', () => {
  assert.equal(makeTransfer({ totalChunks: 0 }).getProgressPercentage(), 0);
});

test('getTransferSpeed: positive bytes/sec mid-transfer', () => {
  // 25% of 1MB transferred over 5s ≈ 50KB/s
  const speed = makeTransfer().getTransferSpeed();
  assert.ok(speed > 0, `expected positive speed, got ${speed}`);
  // Sanity bound: between 10KB/s and 200KB/s (tolerates host clock drift)
  assert.ok(speed > 10_000 && speed < 200_000, `speed ${speed} outside expected range`);
});

test('getTransferSpeed: returns 0 when nothing transferred yet', () => {
  assert.equal(makeTransfer({ receivedChunks: 0 }).getTransferSpeed(), 0);
});

test('getETA: returns positive seconds mid-transfer', () => {
  // 25% done in 5s → projected 20s total → ETA ~15s
  const eta = makeTransfer().getETA();
  assert.ok(typeof eta === 'number' && eta > 0, `expected positive eta, got ${eta}`);
  assert.ok(eta >= 10 && eta <= 25, `eta ${eta} outside expected range`);
});

test('getETA: returns 0 when complete', () => {
  assert.equal(makeTransfer({ receivedChunks: 100 }).getETA(), 0);
});

test('getETA: returns null when not started or no data', () => {
  assert.equal(makeTransfer({ receivedChunks: 0 }).getETA(), null);
  assert.equal(makeTransfer({ startedAt: null }).getETA(), null);
});

test('getProgressInfo: composite shape contains all fields', () => {
  const info = makeTransfer().getProgressInfo();
  assert.ok(info.transferId);
  assert.equal(info.status, 'transferring');
  assert.equal(info.direction, 'incoming');
  assert.equal(info.pluginName, 'test-plugin');
  assert.equal(info.totalChunks, 100);
  assert.equal(info.receivedChunks, 25);
  assert.equal(info.totalSize, 1_000_000);
  assert.equal(info.progressPercentage, 25);
  assert.ok(typeof info.transferSpeedBytesPerSec === 'number');
  assert.ok(typeof info.etaSeconds === 'number');
  assert.ok(info.startedAt instanceof Date);
});

test('isRetryable: true only for failed incoming transfers', () => {
  assert.equal(makeTransfer({ status: 'failed', direction: 'incoming' }).isRetryable(), true);
  // outgoing transfers are peer-initiated — we can't force a re-request
  assert.equal(makeTransfer({ status: 'failed', direction: 'outgoing' }).isRetryable(), false);
  // in-flight/settled states are not retryable
  for (const status of ['pending', 'transferring', 'awaiting_approval', 'approved', 'rejected', 'installed']) {
    assert.equal(makeTransfer({ status }).isRetryable(), false, `status ${status} must not be retryable`);
  }
});

test('verifyPayloadIntegrity: accepts matching SHA-256 and rejects tampered payload', () => {
  const assembledSource = 'export default function plugin() { return true; }';
  const sha256 = crypto.createHash('sha256').update(assembledSource).digest('hex');
  const transfer = makeTransfer({ assembledSource, sha256 });

  assert.equal(transfer.verifyPayloadIntegrity().verified, true);

  transfer.assembledSource += '\n// tampered';
  const tampered = transfer.verifyPayloadIntegrity();
  assert.equal(tampered.verified, false);
  assert.match(tampered.reason, /does not match/);

  assert.equal(makeTransfer({ assembledSource, sha256: '' }).verifyPayloadIntegrity().verified, false);
});

test('validation blocks approved/installed when the stored source no longer matches its digest', async () => {
  const assembledSource = 'export default {}';
  const sha256 = crypto.createHash('sha256').update(assembledSource).digest('hex');

  const good = makeTransfer({ assembledSource, sha256, status: 'approved' });
  await good.validate();

  const bad = makeTransfer({ assembledSource: assembledSource + ' ', sha256, status: 'installed' });
  await assert.rejects(() => bad.validate(), /payload integrity verification failed/);

  // Other states are not gated (a failed/rejected transfer may have no source at all).
  await makeTransfer({ assembledSource: '', sha256, status: 'rejected' }).validate();
});

test('retryTransfer: re-requests plugin for failed incoming, rejects others', async () => {
  const { default: P2PService } = await import('../../src/services/p2p/p2pService.js');

  // Minimal harness: stub findById + requestPlugin, no live mongo/network
  const failedDoc = makeTransfer({ status: 'failed', direction: 'incoming', error: 'Connection timeout' });
  const origFindById = P2PTransfer.findById;
  P2PTransfer.findById = async () => failedDoc;

  const svc = Object.create(P2PService.prototype);
  const requested = [];
  svc.requestPlugin = async (fp, name) => { requested.push([fp, name]); return true; };

  try {
    const result = await svc.retryTransfer(String(failedDoc._id));
    assert.equal(result.sent, true);
    assert.deepEqual(requested, [['fp-test', 'test-plugin']]);
    // the failed record is untouched — audit trail preserved
    assert.equal(failedDoc.status, 'failed');
    assert.equal(failedDoc.error, 'Connection timeout');

    // non-retryable → statusCode 400
    P2PTransfer.findById = async () => makeTransfer({ status: 'transferring' });
    await assert.rejects(() => svc.retryTransfer('any'), (err) => err.statusCode === 400);

    // missing → statusCode 404
    P2PTransfer.findById = async () => null;
    await assert.rejects(() => svc.retryTransfer('any'), (err) => err.statusCode === 404);
  } finally {
    P2PTransfer.findById = origFindById;
  }
});

test("'completed' is a valid status — an outgoing send's final save must not throw", async () => {
  const t = makeTransfer({ direction: 'outgoing', status: 'completed' });
  assert.equal(t.validateSync(), undefined);
});

test('transitionMap covers every real pluginSharing move', () => {
  const m = P2PTransfer.transitionMap;
  assert.ok(m.transferring.includes('completed'), 'outgoing send finishing');
  assert.ok(m.transferring.includes('approved'), 'trusted-peer auto-install');
  assert.ok(m.approved.includes('failed'), 'install failing after approval');
  for (const terminal of ['completed', 'installed', 'rejected', 'failed', 'cancelled']) {
    assert.deepEqual(m[terminal], [], `${terminal} is terminal`);
  }
  // every key and target is a schema status
  const statuses = P2PTransfer.schema.path('status').enumValues;
  for (const [from, tos] of Object.entries(m)) {
    assert.ok(statuses.includes(from), from);
    for (const to of tos) assert.ok(statuses.includes(to), to);
  }
});

test('transitionStatus to cancelled: conditional on a live status, clears the source', async () => {
  const orig = P2PTransfer.findOneAndUpdate;
  let seen;
  P2PTransfer.findOneAndUpdate = async (filter, update) => { seen = { filter, update }; return { _id: filter._id, status: 'cancelled' }; };
  try {
    const r = await P2PTransfer.transitionStatus('abc', 'cancelled', { error: 'stuck' });
    assert.equal(r.status, 'cancelled');
    assert.deepEqual(seen.filter.status.$in.sort(), ['awaiting_approval', 'pending', 'transferring']);
    assert.equal(seen.update.$set.assembledSource, '');
    assert.equal(seen.update.$set.error, 'stuck');
    assert.ok(seen.update.$set.completedAt instanceof Date);
  } finally {
    P2PTransfer.findOneAndUpdate = orig;
  }
});

test('transitionStatus rejects a status outside the enum', async () => {
  await assert.rejects(() => P2PTransfer.transitionStatus('abc', 'interrupted'), /Invalid status/);
});

test('cancelTransfer drops the in-memory chunk buffer so late chunks are ignored', async () => {
  const { default: PluginSharing } = await import('../../src/services/p2p/pluginSharing.js');
  const id = new mongoose.Types.ObjectId();
  const orig = P2PTransfer.transitionStatus;
  P2PTransfer.transitionStatus = async () => ({ _id: id, pluginName: 'p', error: 'x' });
  try {
    const ps = Object.create(PluginSharing.prototype);
    ps.incomingTransfers = new Map([['peer:p', { transfer: { _id: id } }], ['peer:q', { transfer: { _id: new mongoose.Types.ObjectId() } }]]);
    assert.equal(await ps.cancelTransfer(String(id)), true);
    assert.deepEqual([...ps.incomingTransfers.keys()], ['peer:q']);
  } finally {
    P2PTransfer.transitionStatus = orig;
  }
});
