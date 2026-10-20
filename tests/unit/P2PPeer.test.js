import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2PPeer } from '../../src/models/P2PPeer.js';

const fullPeer = () => new P2PPeer({
  fingerprint: 'abcd1234abcd1234abcd1234abcd1234',
  signPublicKey: 'signkey',
  dhPublicKey: 'dhkey',
  displayName: 'peer-a',
  trustLevel: 'trusted',
  erc8004: { verified: true },
  walletVerified: true,
  skynetStakeEffective: 10000000,
  skynetBalance: 10000000,
  skynetBalanceVerified: true,
  sentinelBalance: 3,
  sentinelBalanceVerified: true,
  firstSeen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  transferCount: 50,
  sessionCount: 4,
  reconnectionCount: 3,
  totalConnectionSeconds: 400
});

test('getTrustScoreBreakdown itemises every factor and calculateTrustScore persists its total', () => {
  const peer = fullPeer();
  const b = peer.getTrustScoreBreakdown();
  assert.deepEqual(b, {
    manualTrust: 25,
    genesis: 0,
    erc8004Verification: 15,
    stake: 25,
    tokenBalances: { skynet: 5, sentinel: 10 },
    longevity: 10,
    activity: 10,
    total: 100
  });
  assert.equal(peer.calculateTrustScore(), 100);
  assert.equal(peer.trustScore, 100);
});

test('breakdown caps and gates match the documented weights', () => {
  const peer = new P2PPeer({
    fingerprint: 'f', signPublicKey: 's', dhPublicKey: 'd',
    trustLevel: 'unknown',
    walletVerified: true,
    skynetBalance: 1000000,       // (log10(1e6/1e4)/3)*5 = 3.33 → 3
    skynetBalanceVerified: true,
    skynetStakeEffective: 100000, // (log10(1e5/1e4)/3)*25 = 8.33 → 8
    sentinelBalance: 5,           // unverified → 0
    sentinelBalanceVerified: false,
    firstSeen: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 5
    transferCount: 500            // capped at 10
  });
  const b = peer.getTrustScoreBreakdown();
  assert.equal(b.manualTrust, 0);
  assert.equal(b.erc8004Verification, 0);
  assert.equal(b.stake, 8);
  assert.equal(b.tokenBalances.skynet, 3);
  assert.equal(b.tokenBalances.sentinel, 0);
  assert.equal(b.longevity, 5);
  assert.equal(b.activity, 10);
  assert.equal(b.total, 26);
  assert.equal(peer.calculateTrustScore(), 26);
});

test('nothing on-chain counts until the peer proves its wallet', () => {
  const peer = fullPeer();
  peer.walletVerified = false;
  const b = peer.getTrustScoreBreakdown();
  assert.equal(b.erc8004Verification, 0);
  assert.equal(b.stake, 0);
  assert.deepEqual(b.tokenBalances, { skynet: 0, sentinel: 0 });
  assert.equal(b.total, 25 + 10 + 10, 'manual trust, longevity and activity only');
});

test('stake below 10k SKYNET earns nothing and the curve tops out at 10M', () => {
  const at = (stake) => new P2PPeer({ fingerprint: 'f', signPublicKey: 's', dhPublicKey: 'd', walletVerified: true, skynetStakeEffective: stake }).getTrustScoreBreakdown().stake;
  assert.equal(at(5000), 0);
  assert.equal(at(10000), 0);
  assert.equal(at(1000000), 17);
  assert.equal(at(5966909), 23, 'ALICE on 2026-09-27');
  assert.equal(at(10000000), 25);
  assert.equal(at(90000000), 25);
});

test('genesis is trusted by default and its trust points do not stack with manual trust', () => {
  const peer = new P2PPeer({ fingerprint: 'f', signPublicKey: 's', dhPublicKey: 'd', isGenesis: true });
  assert.equal(peer.isTrusted(), true);
  assert.equal(peer.getTrustScoreBreakdown().genesis, 25);
  assert.equal(peer.getTrustScoreBreakdown().total, 25);
  peer.trustLevel = 'trusted';
  assert.equal(peer.getTrustScoreBreakdown().total, 25, 'manual + genesis = the same 25');
  const plain = new P2PPeer({ fingerprint: 'g', signPublicKey: 's', dhPublicKey: 'd' });
  assert.equal(plain.isTrusted(), false);
  plain.trustLevel = 'trusted';
  assert.equal(plain.isTrusted(), true);
});

test('getPeerReputationReport assembles the breakdown, stability and real schema fields', async (t) => {
  const peer = fullPeer();
  t.mock.method(P2PPeer, 'findById', async () => peer);
  const r = await P2PPeer.getPeerReputationReport(peer._id);
  assert.equal(r.fingerprint, peer.fingerprint);
  assert.equal(r.displayName, 'peer-a');
  assert.equal(r.trustScoreBreakdown.total, 100);
  assert.equal(r.connectionStability.averageSessionDuration, 100);
  assert.equal(r.connectionStability.disconnectionFrequency, 0.75);
  assert.equal(r.tokenBalances.skynet.balance, 10000000);
  assert.equal(r.wallet.verified, true);
  assert.equal(r.stake.effective, 10000000);
  assert.equal(r.isGenesis, false);
  assert.equal(r.tokenBalances.sentinel.verified, true);
  assert.equal(r.activityMetrics.sessionCount, 4);
  assert.equal(r.activityMetrics.reconnectionCount, 3);
});

test('getPeerReputationReport rejects an unknown peer', async (t) => {
  t.mock.method(P2PPeer, 'findById', async () => null);
  await assert.rejects(() => P2PPeer.getPeerReputationReport('nope'), /not found/);
});

// --- recordOnline: atomic session counting ---

function stubAtomic(t, startSessions) {
  const doc = { _id: 'id1', fingerprint: 'fp', sessionCount: startSessions, reconnectionCount: Math.max(0, startSessions - 1) };
  const calls = [];
  t.mock.method(P2PPeer, 'findOneAndUpdate', async (filter, update, opts) => {
    calls.push({ filter, update, opts });
    if (filter.fingerprint && filter.fingerprint !== doc.fingerprint) return null;
    const pre = { ...doc };
    for (const [k, v] of Object.entries(update.$inc || {})) doc[k] += v;
    Object.assign(doc, update.$set || {});
    return opts.new ? { ...doc } : pre;
  });
  t.mock.method(P2PPeer, 'findById', async () => ({ ...doc }));
  return { doc, calls };
}

test('recordOnline: first-ever session counts a session but not a reconnection', async (t) => {
  const { doc } = stubAtomic(t, 0);
  const peer = await P2PPeer.recordOnline('fp', 'caps1');
  assert.equal(peer.sessionCount, 1);
  assert.equal(peer.reconnectionCount, 0);
  assert.equal(doc.isOnline, true);
  assert.equal(doc.capabilitiesHash, 'caps1');
});

test('recordOnline: later sessions count a reconnection, decided from the atomic pre-image', async (t) => {
  const { calls } = stubAtomic(t, 3);
  const peer = await P2PPeer.recordOnline('fp');
  assert.equal(peer.sessionCount, 4);
  assert.equal(peer.reconnectionCount, 3);
  assert.deepEqual(calls[0].update.$inc, { sessionCount: 1 });
  assert.equal(calls[0].opts.new, false);
  assert.equal('capabilitiesHash' in calls[0].update.$set, false);
});

test('recordOnline: two concurrent announcements both count (no lost update)', async (t) => {
  const { doc } = stubAtomic(t, 0);
  await Promise.all([P2PPeer.recordOnline('fp'), P2PPeer.recordOnline('fp')]);
  assert.equal(doc.sessionCount, 2);
  assert.equal(doc.reconnectionCount, 1);
});

test('recordOnline: unknown fingerprint returns null', async (t) => {
  stubAtomic(t, 0);
  assert.equal(await P2PPeer.recordOnline('other'), null);
});
