#!/usr/bin/env node
/**
 * BSC Token Discovery Script
 * Tests various free RPC endpoints and APIs to discover all tokens
 * held by the wallet on BSC.
 *
 * Usage: node scripts/crypto/bsc-token-discovery.js [action]
 * Actions: scan, test-rpcs, test-apis
 */

const WALLET = '0xc0C0D080650C941D8901889248c6eD4C31Ef08F4';
const WALLET_PADDED = '0x000000000000000000000000' + WALLET.slice(2).toLowerCase();
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// BSC RPC endpoints to test
const BSC_RPCS = [
    'https://bsc-pokt.nodies.app',
    'https://bsc-mainnet.public.blastapi.io',
    'https://bsc.drpc.org',
    'https://bsc-rpc.publicnode.com',
    'https://rpc.ankr.com/bsc',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
];

async function rpcCall(url, method, params) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
}

async function getBlockNumber(rpc) {
    const hex = await rpcCall(rpc, 'eth_blockNumber', []);
    return parseInt(hex, 16);
}

async function getTransferLogs(rpc, fromBlock, toBlock, direction = 'to') {
    const topics = [TRANSFER_TOPIC];
    if (direction === 'to') {
        topics.push(null, WALLET_PADDED);
    } else {
        topics.push(WALLET_PADDED);
    }

    const fromHex = '0x' + fromBlock.toString(16);
    const toHex = '0x' + toBlock.toString(16);

    return await rpcCall(rpc, 'eth_getLogs', [{
        fromBlock: fromHex,
        toBlock: toHex,
        topics
    }]);
}

async function testRPCs() {
    console.log('=== Testing BSC RPC endpoints for getLogs support ===\n');

    for (const rpc of BSC_RPCS) {
        try {
            const blockNum = await getBlockNumber(rpc);
            const fromBlock = blockNum - 10000; // Small range test

            const logs = await getTransferLogs(rpc, fromBlock, blockNum, 'to');
            console.log(`✓ ${rpc}`);
            console.log(`  Block: ${blockNum}, Logs in last 10K blocks: ${logs.length}`);

            // Test wider range
            try {
                const wideLogs = await getTransferLogs(rpc, blockNum - 1000000, blockNum, 'to');
                console.log(`  Logs in last 1M blocks: ${wideLogs.length}`);
            } catch (e) {
                console.log(`  1M block range: ${e.message.substring(0, 80)}`);
            }
        } catch (e) {
            console.log(`✗ ${rpc}: ${e.message.substring(0, 80)}`);
        }
        console.log();
    }
}

async function scanForTokens() {
    console.log('=== BSC Token Discovery Scan ===\n');
    console.log(`Wallet: ${WALLET}\n`);

    // Find best RPC
    let bestRpc = null;
    let currentBlock = 0;

    for (const rpc of BSC_RPCS) {
        try {
            currentBlock = await getBlockNumber(rpc);
            // Quick test - can it do getLogs?
            await getTransferLogs(rpc, currentBlock - 1000, currentBlock, 'to');
            bestRpc = rpc;
            console.log(`Using RPC: ${rpc} (block ${currentBlock})\n`);
            break;
        } catch (e) {
            continue;
        }
    }

    if (!bestRpc) {
        console.log('ERROR: No BSC RPC supports getLogs. Trying chunked approach...');
        bestRpc = BSC_RPCS[0];
        currentBlock = await getBlockNumber(bestRpc);
    }

    // Scan in chunks - try larger chunks first, fall back to smaller
    const allTokens = new Set();
    const chunkSizes = [5000000, 1000000, 500000, 100000];
    const scanBlocks = 20000000; // ~8 months
    const startBlock = Math.max(0, currentBlock - scanBlocks);

    let successfulChunkSize = null;

    for (const chunkSize of chunkSizes) {
        if (successfulChunkSize) break;

        console.log(`Trying chunk size: ${chunkSize.toLocaleString()} blocks...`);
        try {
            const logs = await getTransferLogs(bestRpc, currentBlock - chunkSize, currentBlock, 'to');
            successfulChunkSize = chunkSize;
            console.log(`  Success! Found ${logs.length} transfer events\n`);

            for (const log of logs) {
                allTokens.add(log.address.toLowerCase());
            }
        } catch (e) {
            console.log(`  Failed: ${e.message.substring(0, 80)}`);
        }
    }

    if (!successfulChunkSize) {
        console.log('\nAll chunk sizes failed. Cannot scan via getLogs on this RPC.');
        return;
    }

    // Now scan the full range in successful chunk sizes
    console.log(`Scanning ${scanBlocks.toLocaleString()} blocks in ${successfulChunkSize.toLocaleString()}-block chunks...\n`);

    let scanned = 0;
    for (let from = startBlock; from < currentBlock; from += successfulChunkSize) {
        const to = Math.min(from + successfulChunkSize - 1, currentBlock);
        try {
            // Transfers TO wallet
            const toWallet = await getTransferLogs(bestRpc, from, to, 'to');
            for (const log of toWallet) allTokens.add(log.address.toLowerCase());

            // Transfers FROM wallet (tokens we may have traded)
            const fromWallet = await getTransferLogs(bestRpc, from, to, 'from');
            for (const log of fromWallet) allTokens.add(log.address.toLowerCase());

            scanned++;
            if (scanned % 5 === 0) {
                const pct = (((from - startBlock) / scanBlocks) * 100).toFixed(0);
                console.log(`  ${pct}% — ${allTokens.size} unique tokens so far`);
            }
        } catch (e) {
            // Try smaller chunk
            console.log(`  Chunk error at block ${from}: ${e.message.substring(0, 60)}`);
            // Skip and continue
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n=== Results ===`);
    console.log(`Total unique token contracts: ${allTokens.size}`);
    console.log(`\nToken addresses:`);
    for (const addr of [...allTokens].sort()) {
        console.log(`  ${addr}`);
    }
}

async function testAPIs() {
    console.log('=== Testing free BSC balance/token APIs ===\n');

    const apis = [
        {
            name: 'Blockscout BSC',
            url: `https://bsc.blockscout.com/api/v2/addresses/${WALLET}/tokens?type=ERC-20`,
        },
        {
            name: 'dRPC BSC getLogs',
            test: async () => {
                const block = await getBlockNumber('https://bsc.drpc.org');
                const logs = await getTransferLogs('https://bsc.drpc.org', block - 100000, block, 'to');
                return `${logs.length} transfer events in last 100K blocks`;
            }
        },
        {
            name: 'BlastAPI BSC getLogs',
            test: async () => {
                const block = await getBlockNumber('https://bsc-mainnet.public.blastapi.io');
                const logs = await getTransferLogs('https://bsc-mainnet.public.blastapi.io', block - 100000, block, 'to');
                return `${logs.length} transfer events in last 100K blocks`;
            }
        },
        {
            name: 'Nodies BSC getLogs',
            test: async () => {
                const block = await getBlockNumber('https://bsc-pokt.nodies.app');
                const logs = await getTransferLogs('https://bsc-pokt.nodies.app', block - 1000000, block, 'to');
                return `${logs.length} transfer events in last 1M blocks`;
            }
        }
    ];

    for (const api of apis) {
        try {
            let result;
            if (api.test) {
                result = await api.test();
            } else {
                const res = await fetch(api.url, { signal: AbortSignal.timeout(10000) });
                const data = await res.json();
                if (data.items) {
                    result = `${data.items.length} tokens found`;
                    for (const item of data.items.slice(0, 5)) {
                        const token = item.token || {};
                        result += `\n    ${token.symbol || '?'}: ${item.value || '?'} (${token.address || '?'})`;
                    }
                } else {
                    result = JSON.stringify(data).substring(0, 200);
                }
            }
            console.log(`✓ ${api.name}: ${result}`);
        } catch (e) {
            console.log(`✗ ${api.name}: ${e.message.substring(0, 80)}`);
        }
        console.log();
    }
}

// Main
const action = process.argv[2] || 'test-apis';

switch (action) {
    case 'test-rpcs':
        testRPCs().catch(console.error);
        break;
    case 'test-apis':
        testAPIs().catch(console.error);
        break;
    case 'scan':
        scanForTokens().catch(console.error);
        break;
    default:
        console.log('Usage: node scripts/crypto/bsc-token-discovery.js [test-rpcs|test-apis|scan]');
}
