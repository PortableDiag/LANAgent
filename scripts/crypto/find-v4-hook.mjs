// Decode CLQuoter raw result for hooked BTW/USDT pool
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://bsc-dataseed3.defibit.io/');

const CL_QUOTER = '0xd0737C9762912dD34c3271197E362Aa736Df0926';
const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b';
const HOOK = '0x9a9b5331ce8d74b2b721291d57de696e878353fd';
const BTW = '0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

async function rawQuote() {
  console.log('=== Raw CLQuoter call for BTW/USDT hooked pool ===\n');

  // Build the calldata manually
  const iface = new ethers.Interface([
    'function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (int128[] deltaAmounts, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed)'
  ]);

  const currency0 = ethers.getAddress(BTW);
  const currency1 = ethers.getAddress(USDT);
  const paramsVal = (10n << 16n) | 0x55n;
  const parameters = ethers.zeroPadValue(ethers.toBeHex(paramsVal), 32);

  const calldata = iface.encodeFunctionData('quoteExactInputSingle', [{
    poolKey: {
      currency0, currency1,
      hooks: ethers.getAddress(HOOK),
      poolManager: ethers.getAddress(CL_POOL_MANAGER),
      fee: 67,
      parameters
    },
    zeroForOne: false, // USDT -> BTW (currency1 -> currency0)
    exactAmount: ethers.parseUnits('10', 18),
    hookData: '0x'
  }]);

  console.log('Function selector:', calldata.slice(0, 10));
  console.log('Calldata length:', calldata.length);

  // Make raw call
  try {
    const result = await provider.call({ to: CL_QUOTER, data: calldata });
    console.log('\nRaw result:', result);
    console.log('Result length:', result.length, 'bytes:', (result.length - 2) / 2);

    // Try various decode patterns
    const bytes = result.slice(2);
    const nSlots = Math.floor(bytes.length / 64);
    console.log(`\nSlots (${nSlots}):`);
    for (let i = 0; i < nSlots; i++) {
      const slot = bytes.slice(i * 64, (i + 1) * 64);
      const num = BigInt('0x' + slot);
      // Try signed int128
      const signed = num > (1n << 127n) ? num - (1n << 128n) : num;
      console.log(`  [${i}] 0x${slot.slice(0, 20)}... = ${num} (signed: ${signed})`);
    }

    // Try decode as simple tuple
    console.log('\n--- Try decode as (int128, int128, uint160, uint32) ---');
    try {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128', 'uint160', 'uint32'], result);
      console.log('  delta0:', d[0].toString());
      console.log('  delta1:', d[1].toString());
      console.log('  sqrtPriceX96After:', d[2].toString());
      console.log('  ticksCrossed:', d[3].toString());
    } catch(e) { console.log('  Failed:', e.message?.slice(0, 80)); }

    // Try as (uint256, uint256)
    console.log('\n--- Try decode as (uint256, uint256) ---');
    try {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], result);
      console.log('  slot0:', d[0].toString(), '=', ethers.formatUnits(d[0], 18));
      console.log('  slot1:', d[1].toString(), '=', ethers.formatUnits(d[1], 18));
    } catch(e) { console.log('  Failed:', e.message?.slice(0, 80)); }

    // Try as (int128[], uint160, uint32) with dynamic array
    console.log('\n--- Try decode as (int128[], uint160, uint32) ---');
    try {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(['int128[]', 'uint160', 'uint32'], result);
      console.log('  deltaAmounts:', d[0].map(x => x.toString()));
      console.log('  sqrtPriceX96After:', d[1].toString());
      console.log('  ticksCrossed:', d[2].toString());
    } catch(e) { console.log('  Failed:', e.message?.slice(0, 80)); }

  } catch (err) {
    console.log('Call failed:', err.message?.slice(0, 200));

    // Check if it's a revert with data
    if (err.data) {
      console.log('\nRevert data:', err.data.slice(0, 200));
      const selector = err.data.slice(0, 10);
      console.log('Selector:', selector);

      // 0x6190b2b0 = UnexpectedCallSuccess(bytes)
      if (selector === '0x6190b2b0') {
        console.log('*** UnexpectedCallSuccess - decoding inner bytes ***');
        const innerBytes = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], '0x' + err.data.slice(10))[0];
        console.log('Inner bytes length:', innerBytes.length);
        console.log('Inner bytes:', innerBytes.slice(0, 200));

        // Try decode inner as (int128[], uint160, uint32)
        try {
          const d = ethers.AbiCoder.defaultAbiCoder().decode(['int128[]', 'uint160', 'uint32'], innerBytes);
          console.log('\nDecoded inner result:');
          console.log('  deltaAmounts:', d[0].map(x => x.toString()));
          console.log('  sqrtPriceX96After:', d[1].toString());
          console.log('  ticksCrossed:', d[2].toString());
        } catch(e) { console.log('Inner decode failed:', e.message?.slice(0, 100)); }
      }
    }

    // Also try error.info
    if (err.info?.error?.data) {
      const errData = err.info.error.data;
      console.log('\nProvider error data:', errData.slice(0, 200));
    }
  }
}

rawQuote();
