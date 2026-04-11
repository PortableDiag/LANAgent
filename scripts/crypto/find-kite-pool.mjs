// Find KITE pool using PancakeSwap API and on-chain methods
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://bsc-dataseed3.defibit.io/');

const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b';
const VAULT = '0x238a358808379702088667322f80ac48bad5e6c4';
const KITE = '0x904567252d8f48555b7447c67dca23f0372e16be';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

async function getPoolKey(poolId) {
  const selector = ethers.id('poolIdToPoolKey(bytes32)').slice(0, 10);
  const data = selector + poolId.slice(2).padStart(64, '0');
  const result = await provider.call({ to: CL_POOL_MANAGER, data });
  if (result.length < 66) return null;
  const bytes = result.slice(2);
  const addr = (i) => '0x' + bytes.slice(i * 64 + 24, (i + 1) * 64);
  const raw = (i) => '0x' + bytes.slice(i * 64, (i + 1) * 64);
  return {
    currency0: addr(0), currency1: addr(1), hooks: addr(2),
    poolManager: addr(3), fee: parseInt(bytes.slice(4 * 64, 5 * 64), 16),
    parameters: raw(5),
  };
}

// Method 1: PCS API with correct format
async function method1_api() {
  console.log('=== PancakeSwap API ===\n');
  const amount = ethers.parseUnits('10', 18).toString();

  // Try the format from PCS frontend
  const urls = [
    `https://routing-api.pancakeswap.com/v0/quote?chainId=56&currencyA=0x55d398326f99059fF775485246999027B3197955&currencyB=0x904567252d8f48555b7447c67dca23f0372e16be&amount=${amount}&tradeType=EXACT_INPUT&gasPriceWei=3000000000&protocols=V4CL`,
    `https://routing-api.pancakeswap.com/v0/quote?chainId=56&tokenInAddress=0x55d398326f99059fF775485246999027B3197955&tokenOutAddress=0x904567252d8f48555b7447c67dca23f0372e16be&amount=${amount}&type=exactIn`,
    `https://routing-api.pancakeswap.com/v0/quote?chainId=56&inputToken=0x55d398326f99059fF775485246999027B3197955&outputToken=0x904567252d8f48555b7447c67dca23f0372e16be&amount=${amount}`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://pancakeswap.finance',
          'Referer': 'https://pancakeswap.finance/',
          'User-Agent': 'Mozilla/5.0',
        }
      });
      const text = await resp.text();
      console.log(`${resp.status}: ${text.slice(0, 300)}`);
    } catch(e) {
      console.log(`Error: ${e.message?.slice(0, 100)}`);
    }
  }
}

// Method 2: Look at KITE Transfer events and find any that go to/from Vault
async function method2_vaultTransfers() {
  console.log('\n=== KITE transfers to/from Vault ===\n');
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const vaultPadded = ethers.zeroPadValue(VAULT.toLowerCase(), 32);
  const block = await provider.getBlockNumber();

  // Search larger range - 200K blocks (~7 days on BSC)
  for (let end = block; end > block - 200000; end -= 5000) {
    const start = end - 4999;
    try {
      // KITE transfers TO Vault (swap in)
      const logs1 = await provider.getLogs({
        address: KITE,
        topics: [transferTopic, null, vaultPadded],
        fromBlock: start, toBlock: end
      });
      // KITE transfers FROM Vault (swap out)
      const logs2 = await provider.getLogs({
        address: KITE,
        topics: [transferTopic, vaultPadded],
        fromBlock: start, toBlock: end
      });

      const logs = [...logs1, ...logs2];
      if (logs.length > 0) {
        console.log(`Found ${logs.length} KITE<->Vault transfers in blocks ${start}-${end}!`);
        for (const log of logs.slice(-3)) {
          console.log(`  tx: ${log.transactionHash}`);

          // Get full receipt to find pool ID
          const receipt = await provider.getTransactionReceipt(log.transactionHash);
          console.log(`  Receipt: ${receipt.logs.length} logs`);
          for (const rl of receipt.logs) {
            if (rl.address.toLowerCase() === CL_POOL_MANAGER.toLowerCase()) {
              console.log(`    CLPoolManager log: ${rl.topics[0]?.slice(0, 18)}... topic1=${rl.topics[1]?.slice(0,18)}...`);
              // topic1 is typically poolId for Swap events
              if (rl.topics[1]) {
                const poolId = rl.topics[1];
                console.log(`    Pool ID: ${poolId}`);
                const key = await getPoolKey(poolId);
                if (key) {
                  console.log(`    hooks: ${key.hooks}`);
                  console.log(`    fee: ${key.fee}`);
                  console.log(`    params: ${key.parameters}`);
                }
              }
            }
          }
        }
        return;
      }
    } catch(e) {
      if (e.message?.includes('limit') || e.message?.includes('429')) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if ((block - end) % 50000 === 0 && block - end > 0) {
      console.log(`  ...searched ${block - end} blocks back`);
    }
  }
  console.log('  No KITE<->Vault transfers in 200K blocks');
}

// Method 3: Look at ALL KITE transfers (not just vault) - find ANY swap tx
async function method3_anyKiteTransfer() {
  console.log('\n=== ANY KITE transfers (last 200K blocks) ===\n');
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const block = await provider.getBlockNumber();

  for (let end = block; end > block - 200000; end -= 5000) {
    const start = end - 4999;
    try {
      const logs = await provider.getLogs({
        address: KITE,
        topics: [transferTopic],
        fromBlock: start, toBlock: end
      });
      if (logs.length > 0) {
        console.log(`Found ${logs.length} KITE transfers in blocks ${start}-${end}`);
        // Check receipts for CLPoolManager interactions
        for (const log of logs.slice(-5)) {
          const receipt = await provider.getTransactionReceipt(log.transactionHash);
          const hasCLPM = receipt.logs.some(l => l.address.toLowerCase() === CL_POOL_MANAGER.toLowerCase());
          if (hasCLPM) {
            console.log(`  *** Infinity swap found! tx: ${log.transactionHash}`);
            for (const rl of receipt.logs) {
              if (rl.address.toLowerCase() === CL_POOL_MANAGER.toLowerCase() && rl.topics[1]) {
                const poolId = rl.topics[1];
                console.log(`  Pool ID: ${poolId}`);
                const key = await getPoolKey(poolId);
                if (key) {
                  console.log(`  hooks: ${key.hooks}, fee: ${key.fee}, params: ${key.parameters}`);
                  const paramsInt = BigInt(key.parameters);
                  console.log(`  tickSpacing: ${Number((paramsInt >> 16n) & 0xFFFFFFn)}, hookFlags: 0x${Number(paramsInt & 0xFFFFn).toString(16)}`);
                }
              }
            }
            return;
          }
          // Check for other DEX interactions
          const addrs = [...new Set(receipt.logs.map(l => l.address.toLowerCase()))];
          if (receipt.logs.length > 3) {
            const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
            console.log(`  Transfer: ${parsed.args[0].slice(0,10)}... -> ${parsed.args[1].slice(0,10)}... (${receipt.logs.length} logs in tx)`);
          }
        }
        return;
      }
    } catch(e) {
      if (e.message?.includes('limit') || e.message?.includes('429')) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if ((block - end) % 50000 === 0 && block - end > 0) {
      console.log(`  ...searched ${block - end} blocks back`);
    }
  }
  console.log('  No KITE transfers in 200K blocks');
}

(async () => {
  await method1_api();
  await method2_vaultTransfers();
  await method3_anyKiteTransfer();
  console.log('\nDone');
})();
