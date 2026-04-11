#!/bin/bash
# V4 Pool Debug Script — discovers PancakeSwap Infinity pool parameters
# Usage: ./scripts/crypto/v4-pool-debug.sh

SERVER="$PRODUCTION_USER@$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
CMD=${1:-"discover"}

run_remote() {
  sshpass -p "$PASS" ssh "$SERVER" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 > /dev/null 2>&1 && $1"
}

case "$CMD" in
  discover)
    # Discover pool parameters by checking PancakeSwap's SmartRouter quoter (supports all pool types)
    run_remote 'node -e "
const { ethers } = require(\"ethers\");
const provider = new ethers.JsonRpcProvider(\"https://bsc-dataseed4.ninicoin.io/\");

// PancakeSwap SmartRouter QuoterV2 — knows about V2, V3, and Infinity pools
const quoterV2 = new ethers.Contract(\"0xB048Bbc1Ee6b733FFFcFb9e9CeF7375518e25997\", [
  \"function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint256 gasEstimate)\"
], provider);

const tokens = {
  BTW: \"0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA\",
  KITE: \"0x904567252d8f48555b7447c67dca23f0372e16be\"
};
const USDT = \"0x55d398326f99059fF775485246999027B3197955\";
const WBNB = \"0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c\";

(async () => {
  for (const [sym, addr] of Object.entries(tokens)) {
    console.log(\"\\n=== \" + sym + \" ===\");
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      // USDT -> token
      try {
        const r = await quoterV2.quoteExactInputSingle.staticCall({
          tokenIn: USDT, tokenOut: addr,
          amountIn: ethers.parseUnits(\"50\", 18),
          fee, sqrtPriceLimitX96: 0n
        });
        const out = ethers.formatUnits(r[0], 18);
        console.log(\"  USDT->\" + sym + \" fee=\" + fee + \": \" + out + \" tokens (gas: \" + r[1].toString() + \")\");
      } catch(e) {}
      // WBNB -> token
      try {
        const r = await quoterV2.quoteExactInputSingle.staticCall({
          tokenIn: WBNB, tokenOut: addr,
          amountIn: ethers.parseUnits(\"0.08\", 18),
          fee, sqrtPriceLimitX96: 0n
        });
        const out = ethers.formatUnits(r[0], 18);
        console.log(\"  WBNB->\" + sym + \" fee=\" + fee + \": \" + out + \" tokens (gas: \" + r[1].toString() + \")\");
      } catch(e) {}
    }
  }
  console.log(\"\\nDone\");
})();
"'
    ;;

  clquoter)
    # Try CLQuoter with different hook addresses
    run_remote 'node -e "
const { ethers } = require(\"ethers\");
const provider = new ethers.JsonRpcProvider(\"https://bsc-dataseed4.ninicoin.io/\");

const quoter = new ethers.Contract(\"0xd0737C9762912dD34c3271197E362Aa736Df0926\", [
  \"function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (int128[] deltaAmounts, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)\"
], provider);

const tokens = {
  BTW: \"0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA\",
  KITE: \"0x904567252d8f48555b7447c67dca23f0372e16be\"
};
const USDT = \"0x55d398326f99059fF775485246999027B3197955\";
const poolManager = \"0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b\";
const DYNAMIC_FEE = 0x800000;

// Known PancakeSwap hook addresses to try
const hooks = [
  ethers.ZeroAddress,
  \"0x498f093F14B3C3b1588116FbDE1a45aA3F5b0b00\",  // common PCS hook
];

(async () => {
  for (const [sym, addr] of Object.entries(tokens)) {
    const c0 = addr.toLowerCase() < USDT.toLowerCase() ? addr : USDT;
    const c1 = addr.toLowerCase() < USDT.toLowerCase() ? USDT : addr;
    const zfo = USDT.toLowerCase() === c0.toLowerCase();
    console.log(\"\\n=== \" + sym + \" (c0=\" + c0.slice(0,10) + \", zfo=\" + zfo + \") ===\");

    for (const hook of hooks) {
      for (const fee of [DYNAMIC_FEE, 100, 500, 2500, 10000, 67]) {
        for (const ts of [1, 10, 50, 100, 200]) {
          try {
            const parameters = ethers.zeroPadValue(ethers.toBeHex(ts << 16), 32);
            const poolKey = { currency0: c0, currency1: c1, hooks: hook, poolManager, fee, parameters };
            const r = await quoter.quoteExactInputSingle.staticCall({
              poolKey, zeroForOne: zfo, exactAmount: ethers.parseUnits(\"50\", 18), hookData: \"0x\"
            });
            const deltas = r[0];
            const outIdx = zfo ? 1 : 0;
            const rawDelta = deltas[outIdx];
            const amountOut = rawDelta < 0n ? -rawDelta : rawDelta;
            if (amountOut > 0n) {
              console.log(\"  FOUND: hook=\" + hook.slice(0,10) + \" fee=\" + fee + \"(0x\" + fee.toString(16) + \") ts=\" + ts + \" -> \" + ethers.formatUnits(amountOut, 18) + \" tokens\");
            }
          } catch(e) {}
        }
      }
    }
  }
  console.log(\"\\nDone\");
})();
"'
    ;;

  logs)
    # Check recent crypto logs for V4 and token activity
    run_remote 'grep -E "V4 quote|TokenHeartbeat.*(tick complete|error)|TokenTrader.*(buy|sell|impact|aborted)" $PRODUCTION_PATH/logs/crypto.log 2>/dev/null | tail -30'
    ;;

  status)
    # Quick token trader status
    run_remote 'curl -s -H "X-API-Key: ${LANAGENT_API_KEY:-your-api-key}" http://127.0.0.1:80/api/crypto/strategy/token-trader/status 2>/dev/null | python3 -m json.tool | head -60'
    ;;

  find-hook)
    # Reconstruct the PoolKey by computing keccak256 and matching the known pool ID
    run_remote 'node -e "
const { ethers } = require(\"ethers\");

const BTW = \"0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA\";
const KITE = \"0x904567252d8f48555b7447c67dca23f0372e16be\";
const USDT = \"0x55d398326f99059fF775485246999027B3197955\";
const poolManager = \"0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b\";

// Known pool IDs from CoinMarketCap DEX
const targetIds = {
  \"0x3122a3fa830e4918d6a9c09bd4769d0d95bf291548e7c7960cd7ccd9e3ac3627\": \"BTW/USDT\"
};

// PancakeSwap Infinity known hooks on BSC (from recent deployments)
const knownHooks = [
  ethers.ZeroAddress,
  \"0x9c8b822caee69fe5a10e1a3c8b98b2b008c00f00\",
  \"0xb88158cc8b7b1ecd09c7f8d06fa2e89b2a3e2500\",
  \"0xfedb42f0a7cbfe9ed43ba5b6c0f88d0a05c85600\",
].map(h => h === ethers.ZeroAddress ? h : ethers.getAddress(h));

const DYNAMIC_FEE = 0x800000;

// Try all combinations to find which PoolKey hashes to the target ID
// PoolKey = abi.encode(currency0, currency1, hooks, poolManager, fee, parameters)
const coder = ethers.AbiCoder.defaultAbiCoder();

(async () => {
  const c0_btw = BTW.toLowerCase() < USDT.toLowerCase() ? BTW : USDT;
  const c1_btw = BTW.toLowerCase() < USDT.toLowerCase() ? USDT : BTW;
  console.log(\"BTW c0:\", c0_btw.slice(0,10), \"c1:\", c1_btw.slice(0,10));

  for (const hook of knownHooks) {
    for (const fee of [DYNAMIC_FEE, 100, 500, 2500, 10000, 67, DYNAMIC_FEE | 67]) {
      for (const ts of [1, 10, 50, 100, 200]) {
        const parameters = ethers.zeroPadValue(ethers.toBeHex(ts << 16), 32);
        const encoded = coder.encode(
          [\"address\", \"address\", \"address\", \"address\", \"uint24\", \"bytes32\"],
          [c0_btw, c1_btw, hook, poolManager, fee, parameters]
        );
        const id = ethers.keccak256(encoded);
        for (const [targetId, name] of Object.entries(targetIds)) {
          if (id.toLowerCase() === targetId.toLowerCase()) {
            console.log(\"MATCH for \" + name + \"!\");
            console.log(\"  hook:\", hook);
            console.log(\"  fee:\", fee, \"(0x\" + fee.toString(16) + \")\");
            console.log(\"  tickSpacing:\", ts);
            console.log(\"  parameters:\", parameters);
          }
        }
      }
    }
  }
  console.log(\"No match with known hooks. Searching Swap events for hook address...\");

  // Look at Swap events on the CLPoolManager — indexed by poolId
  const provider = new ethers.JsonRpcProvider(\"https://bsc-dataseed4.ninicoin.io/\");
  const pmContract = new ethers.Contract(poolManager, [
    \"event Swap(bytes32 indexed id, address indexed sender, int128 delta0, int128 delta1, uint160 sqrtPriceX96After, uint128 liquidity, int24 tick, uint24 fee)\"
  ], provider);

  const block = await provider.getBlockNumber();
  const targetPoolId = \"0x3122a3fa830e4918d6a9c09bd4769d0d95bf291548e7c7960cd7ccd9e3ac3627\";

  // Search recent blocks for swaps on this pool
  for (let end = block; end > block - 5000; end -= 1000) {
    const start = end - 999;
    try {
      const filter = pmContract.filters.Swap(targetPoolId);
      const events = await pmContract.queryFilter(filter, start, end);
      if (events.length > 0) {
        const ev = events[0];
        console.log(\"Found swap at block\", ev.blockNumber, \"tx:\", ev.transactionHash);
        console.log(\"  fee:\", ev.args.fee?.toString());

        // Get the tx receipt and look at all logs to find the hook
        const receipt = await provider.getTransactionReceipt(ev.transactionHash);
        console.log(\"  Receipt logs:\", receipt.logs.length);
        for (const log of receipt.logs) {
          const addr = log.address.toLowerCase();
          if (addr !== poolManager.toLowerCase() &&
              addr !== c0_btw.toLowerCase() &&
              addr !== c1_btw.toLowerCase() &&
              addr !== \"0xd9c500dff816a1da21a48a732d3498bf09dc9aeb\" && // Universal Router
              addr !== \"0x238a358808379702088667322f80ac48bad5e6c4\") { // Vault
            console.log(\"  Possible hook:\", log.address);
          }
        }
        break;
      }
    } catch(e) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
})();
"'
    ;;

  dexscreener)
    # Get pool details from DexScreener to find the pool address
    run_remote 'curl -s "https://api.dexscreener.com/latest/dex/tokens/0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get(\"pairs\", []):
    if p.get(\"chainId\") == \"bsc\" and \"infinity\" in p.get(\"dexId\",\"\").lower() or \"v4\" in p.get(\"dexId\",\"\").lower() or p.get(\"liquidity\",{}).get(\"usd\",0) > 10000:
        print(f\"DEX: {p.get(\"dexId\")} | pair: {p.get(\"pairAddress\")} | liq: {p.get(\"liquidity\",{}).get(\"usd\")} | {p.get(\"baseToken\",{}).get(\"symbol\")}/{p.get(\"quoteToken\",{}).get(\"symbol\")}\")
"'
    # Also try KITE
    run_remote 'curl -s "https://api.dexscreener.com/latest/dex/tokens/0x904567252d8f48555b7447c67dca23f0372e16be" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get(\"pairs\", []):
    if p.get(\"chainId\") == \"bsc\" and (p.get(\"liquidity\",{}).get(\"usd\",0) or 0) > 1000:
        print(f\"DEX: {p.get(\"dexId\")} | pair: {p.get(\"pairAddress\")} | liq: {p.get(\"liquidity\",{}).get(\"usd\")} | {p.get(\"baseToken\",{}).get(\"symbol\")}/{p.get(\"quoteToken\",{}).get(\"symbol\")}\")
"'
    ;;

  decode-tx)
    # Decode a recent swap tx to extract the hook address from PoolKey
    run_remote 'cd $PRODUCTION_PATH && node -e "
const { ethers } = require(\"ethers\");
const provider = new ethers.JsonRpcProvider(\"https://bsc-dataseed3.defibit.io/\");

const poolManager = \"0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b\";
const BTW = \"0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA\".toLowerCase();
const USDT = \"0x55d398326f99059fF775485246999027B3197955\".toLowerCase();
const vault = \"0x238a358808379702088667322f80ac48bad5e6c4\".toLowerCase();
const router = \"0xd9c500dff816a1da21a48a732d3498bf09dc9aeb\".toLowerCase();

// Look at Swap events on CLPoolManager with the known poolId
const pm = new ethers.Contract(poolManager, [
  \"event Swap(bytes32 indexed id, address indexed sender, int128 delta0, int128 delta1, uint160 sqrtPriceX96After, uint128 liquidity, int24 tick, uint24 fee)\"
], provider);

const targetId = \"0x3122a3fa830e4918d6a9c09bd4769d0d95bf291548e7c7960cd7ccd9e3ac3627\";

(async () => {
  const block = await provider.getBlockNumber();
  console.log(\"Block:\", block);

  for (let end = block; end > block - 3000; end -= 500) {
    const start = end - 499;
    try {
      const filter = pm.filters.Swap(targetId);
      const events = await pm.queryFilter(filter, start, end);
      if (events.length > 0) {
        const ev = events[events.length - 1];
        console.log(\"Swap found at block\", ev.blockNumber, \"tx:\", ev.transactionHash);
        console.log(\"  fee:\", ev.args.fee?.toString());

        // Get receipt and find hook address
        const receipt = await provider.getTransactionReceipt(ev.transactionHash);
        const hookAddrs = new Set();
        for (const log of receipt.logs) {
          const a = log.address.toLowerCase();
          if (a !== poolManager.toLowerCase() && a !== BTW && a !== USDT && a !== vault && a !== router) {
            hookAddrs.add(log.address);
          }
        }
        console.log(\"  Other addresses in tx:\", [...hookAddrs]);

        // Try to decode the tx input to find the PoolKey
        const tx = await provider.getTransaction(ev.transactionHash);
        // Look for 20-byte addresses in the calldata that aren't known
        const data = tx.data.toLowerCase();
        console.log(\"  Tx to:\", tx.to);
        console.log(\"  Data length:\", data.length);

        // The PoolKey struct has hooks address — search for unknown addresses in the calldata
        // Each address in ABI encoding is 32 bytes (12 bytes zeros + 20 bytes address)
        for (let i = 10; i < data.length - 64; i += 64) {
          const chunk = data.slice(i, i + 64);
          if (chunk.startsWith(\"000000000000000000000000\") && !chunk.endsWith(\"0000000000000000000000000000000000000000\")) {
            const addr = \"0x\" + chunk.slice(24);
            if (addr !== BTW && addr !== USDT && addr !== poolManager.toLowerCase() && addr !== vault && addr !== router && !addr.startsWith(\"0x00000000000000\")) {
              console.log(\"  Possible hook in calldata:\", ethers.getAddress(addr));
            }
          }
        }
        break;
      }
    } catch(e) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(\"Done\");
})();
"'
    ;;

  try-hook)
    # Try quoting with a specific hook address (pass as $2)
    HOOK=${2:-"0x0000000000000000000000000000000000000000"}
    run_remote "node -e \"
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://bsc-dataseed4.ninicoin.io/');

const quoter = new ethers.Contract('0xd0737C9762912dD34c3271197E362Aa736Df0926', [
  'function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (int128[] deltaAmounts, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)'
], provider);

const tokens = { BTW: '0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA', KITE: '0x904567252d8f48555b7447c67dca23f0372e16be' };
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const pm = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b';
const hook = '$HOOK';
const DYNAMIC = 0x800000;

(async () => {
  for (const [sym, addr] of Object.entries(tokens)) {
    const c0 = addr.toLowerCase() < USDT.toLowerCase() ? addr : USDT;
    const c1 = addr.toLowerCase() < USDT.toLowerCase() ? USDT : addr;
    const zfo = USDT.toLowerCase() === c0.toLowerCase();
    console.log('=== ' + sym + ' hook=' + hook.slice(0,10) + ' ===');
    for (const fee of [DYNAMIC, 100, 500, 2500, 10000]) {
      for (const ts of [1, 10, 50, 100, 200]) {
        try {
          const parameters = ethers.zeroPadValue(ethers.toBeHex(ts << 16), 32);
          const poolKey = { currency0: c0, currency1: c1, hooks: hook, poolManager: pm, fee, parameters };
          const r = await quoter.quoteExactInputSingle.staticCall({ poolKey, zeroForOne: zfo, exactAmount: ethers.parseUnits('50', 18), hookData: '0x' });
          const d = r[0]; const outIdx = zfo ? 1 : 0;
          const out = d[outIdx] < 0n ? -d[outIdx] : d[outIdx];
          if (out > 0n) console.log('  fee=' + fee + ' ts=' + ts + ' -> ' + ethers.formatUnits(out, 18));
        } catch(e) {}
      }
    }
  }
  console.log('Done');
})();
\""
    ;;

  *)
    echo "Usage: $0 {discover|clquoter|find-hook|try-hook <hookAddr>|logs|status}"
    ;;
esac
