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
