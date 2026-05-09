#!/usr/bin/env node
/**
 * One-shot backfill: sum historical V3 NonfungiblePositionManager Collect
 * events for our LP MM position, so the lifetime totals reflect the 70+ days
 * of fees collected before v2.25.33 wired up the per-collect accounting.
 *
 * Reads the chain only — prints the totals and a mongosh update command you
 * can paste into ALICE. Doesn't write to MongoDB itself (avoids needing the
 * ALICE DB tunnel from this dev box).
 *
 * Run: node scripts/backfill-lpmm-fees.js
 */

import { ethers } from 'ethers';

const NPM_ADDRESS = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'; // BSC V3 NonfungiblePositionManager
const TOKEN_ID    = 6694001n;
const OPENED_AT_ISO = '2026-02-27T02:50:01.132Z';

// Public RPCs split into two roles: ARCHIVE_RPCS keep historical logs (needed
// to scan back 70+ days). PUBLIC_RPCS (Binance dataseed) prune logs after a
// few days but are fine for the binary-search timestamp lookup.
//
// NodeReal's public endpoint is the only free tier that consistently serves
// archive logs for BSC. The embedded UUID is a public WalletConnect-style key
// — fine for one-shot backfill use; not committed as a secret.
const ARCHIVE_RPCS = [
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3', // 50k block cap, archive
];
const PUBLIC_RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  ...ARCHIVE_RPCS,
];

// keccak256("Collect(uint256,address,uint256,uint256)") — NPM event
const COLLECT_TOPIC0 = ethers.id('Collect(uint256,address,uint256,uint256)');
// tokenId padded to 32 bytes (indexed param topic)
const COLLECT_TOPIC1 = ethers.zeroPadValue(ethers.toBeHex(TOKEN_ID), 32);

const COLLECT_IFACE = new ethers.Interface([
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)'
]);

const CHUNK = 49999; // NodeReal free tier caps at 50k blocks per getLogs

async function withProvider(rpcs, fn) {
  let lastErr;
  for (const url of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      return await fn(p);
    } catch (err) {
      lastErr = err;
      console.warn(`RPC ${url} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// Try each archive RPC for a single getLogs call until one succeeds.
async function getLogsAcrossRpcs(filter) {
  let lastErr;
  for (const url of ARCHIVE_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      return await p.getLogs(filter);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Binary-search for the first block with timestamp >= target.
// BSC ~3s blocks; this converges in ~25 calls for 100M-block chains.
async function findBlockAtOrAfter(provider, targetTs) {
  const latest = await provider.getBlock('latest');
  let lo = 1, hi = latest.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const blk = await provider.getBlock(mid);
    if (!blk) break;
    if (blk.timestamp < targetTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  console.log(`Backfilling Collect events for tokenId=${TOKEN_ID}, NPM=${NPM_ADDRESS}`);
  console.log(`Position openedAt=${OPENED_AT_ISO}`);

  // Step 1: find fromBlock and current head via any working RPC.
  const targetTs = Math.floor(new Date(OPENED_AT_ISO).getTime() / 1000);
  const { fromBlock, toBlock } = await withProvider(PUBLIC_RPCS, async (provider) => {
    const fromBlock = await findBlockAtOrAfter(provider, targetTs);
    const latest = await provider.getBlock('latest');
    return { fromBlock, toBlock: latest.number };
  });
  console.log(`Block range: ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} blocks, ~${((toBlock - fromBlock) * 3 / 86400).toFixed(1)} days)`);

  // Step 2: scan in chunks across archive RPCs (round-robin on failure).
  let amount0Total = 0n;
  let amount1Total = 0n;
  let collectCount = 0;
  const events = [];
  const totalChunks = Math.ceil((toBlock - fromBlock + 1) / CHUNK);
  let chunkIdx = 0;

  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    chunkIdx++;
    const logs = await getLogsAcrossRpcs({
      address: NPM_ADDRESS,
      topics: [COLLECT_TOPIC0, COLLECT_TOPIC1],
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const parsed = COLLECT_IFACE.parseLog(log);
      const a0 = BigInt(parsed.args.amount0);
      const a1 = BigInt(parsed.args.amount1);
      amount0Total += a0;
      amount1Total += a1;
      collectCount++;
      events.push({ block: log.blockNumber, tx: log.transactionHash, amount0: a0.toString(), amount1: a1.toString() });
    }

    if (chunkIdx % 50 === 0 || chunkIdx === totalChunks) {
      process.stdout.write(`  ${chunkIdx}/${totalChunks} chunks (block ${end}, ${collectCount} collects so far)\r`);
    }
  }
  process.stdout.write('\n');

  const totals = { amount0Total, amount1Total, collectCount, events, fromBlock, toBlock };

  const skynet = ethers.formatUnits(totals.amount0Total, 18);
  const wbnb   = ethers.formatUnits(totals.amount1Total, 18);

  console.log('');
  console.log('═'.repeat(60));
  console.log(`Collect events found: ${totals.collectCount}`);
  console.log(`Total amount0 (SKYNET): ${skynet}`);
  console.log(`Total amount1 (WBNB):   ${wbnb}`);
  console.log('═'.repeat(60));

  if (totals.events.length > 0) {
    console.log('\nPer-event breakdown:');
    for (const e of totals.events) {
      const s = ethers.formatUnits(BigInt(e.amount0), 18);
      const w = ethers.formatUnits(BigInt(e.amount1), 18);
      console.log(`  block=${e.block} tx=${e.tx}`);
      console.log(`    SKYNET=${s}  WBNB=${w}`);
    }
  }

  console.log('\nMongo update for ALICE (paste into:');
  console.log('  sshpass -p \'al1c3\' ssh root@192.168.0.52 "mongosh lanagent --quiet --eval ...")');
  console.log('');
  console.log(`db.systemsettings.updateOne(`);
  console.log(`  { key: 'lp_market_maker_state' },`);
  console.log(`  { $set: { 'value.totalFeesCollectedSKYNET': '${skynet}', 'value.totalFeesCollectedWBNB': '${wbnb}' } }`);
  console.log(`);`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
