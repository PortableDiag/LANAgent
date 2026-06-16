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
