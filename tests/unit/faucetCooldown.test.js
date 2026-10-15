/**
 * Faucet cooldown status reads the same claim history canClaim() and the
 * auto-claimer write, keyed by the faucet's `api` (falling back to `url`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import faucetService from '../../src/services/crypto/faucetService.js';
import nanoButtonFaucet from '../../src/services/crypto/nanoButtonFaucet.js';

const ADDR = '0xabc';
const HOUR = 60 * 60 * 1000;

test('no claims recorded: every faucet claimable, no next time', async () => {
  faucetService.claimHistory.clear();
  const s = await faucetService.getCooldownStatus('sepolia', ADDR);
  assert.equal(s.canClaim, true);
  assert.equal(s.nextClaimAt, null);
  assert.equal(s.remainingSeconds, 0);
  assert.ok(s.faucets.length > 0);
});

test('a claim filed under the api key puts that faucet on a 24h cooldown', async () => {
  faucetService.claimHistory.clear();
  const { faucets } = faucetService.getFaucetsForNetwork('sepolia');
  const chainlink = faucets.find(f => f.api);
  assert.ok(chainlink, 'sepolia has an API faucet');
  faucetService.claimHistory.set(`${chainlink.api}:${ADDR}`, Date.now() - 2 * HOUR);

  const s = await faucetService.getCooldownStatus('sepolia', ADDR);
  const row = s.faucets.find(f => f.faucet === chainlink.name);
  assert.equal(row.canClaim, false);
  assert.ok(row.remainingSeconds > 21.9 * 3600 && row.remainingSeconds <= 22 * 3600);
  // agrees with canClaim()
  assert.equal(faucetService.canClaim(chainlink.api, ADDR), false);
});

test('every faucet on cooldown: reports the soonest next claim', async () => {
  faucetService.claimHistory.clear();
  const { faucets } = faucetService.getFaucetsForNetwork('sepolia');
  faucets.forEach((f, i) => faucetService.claimHistory.set(`${f.api || f.url}:${ADDR}`, Date.now() - (i + 1) * HOUR));
  const s = await faucetService.getCooldownStatus('sepolia', ADDR);
  assert.equal(s.canClaim, false);
  const min = Math.min(...s.faucets.map(f => f.remainingSeconds));
  assert.equal(s.remainingSeconds, min);
  assert.ok(s.nextClaimAt);
});

test('nano reads the button faucet clock (4h), not the 24h history', async () => {
  const orig = nanoButtonFaucet.lastClaim;
  nanoButtonFaucet.lastClaim = Date.now() - HOUR;
  try {
    const s = await faucetService.getCooldownStatus('nano', 'nano_1x');
    assert.equal(s.faucets.length, 1);
    const r = s.faucets[0].remainingSeconds;
    assert.ok(r > 2.9 * 3600 && r <= 3 * 3600, `remaining ${r}`);
  } finally {
    nanoButtonFaucet.lastClaim = orig;
  }
});
