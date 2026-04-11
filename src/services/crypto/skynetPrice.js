/**
 * Shared SKYNET/USD oracle.
 *
 * Reads SKYNET reserves from the canonical PancakeSwap V2 LP and BNB/USD
 * from Chainlink, and returns the implied USD price of one SKYNET token.
 *
 * Used by:
 *   - src/interfaces/web/p2p.js (P2P service auto-pricer)
 *   - src/services/crypto/scammerRegistryService.js (registry fee/immunity auto-pricer)
 *
 * Both callers want the same number — keep the oracle path here so the two
 * loops can never drift apart.
 */

import { logger } from '../../utils/logger.js';

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const SKYNET_ADDR = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
const PCS_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
const BSC_RPC = 'https://bsc-dataseed.binance.org';

let _cached = null; // { skynetUsd, bnbUsd, skyReserve, bnbReserve, ts }
const CACHE_TTL_MS = 60 * 1000; // 60s — both callers run on minute+ schedules

/**
 * Get the current SKYNET/USD price (and the BNB/USD it was derived from).
 *
 * @param {object} opts
 * @param {boolean} [opts.fresh=false] — bypass the 60s cache
 * @returns {Promise<{ skynetUsd: number, bnbUsd: number, skyReserve: number, bnbReserve: number } | null>}
 *          Returns null on any oracle failure (caller should treat as "skip this cycle").
 */
export async function getSkynetUsdPrice({ fresh = false } = {}) {
  if (!fresh && _cached && (Date.now() - _cached.ts) < CACHE_TTL_MS) {
    return _cached;
  }

  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(BSC_RPC);

    const factory = new ethers.Contract(
      PCS_FACTORY,
      ['function getPair(address,address) view returns (address)'],
      provider
    );
    const pairAddr = await factory.getPair(SKYNET_ADDR, WBNB);
    if (!pairAddr || pairAddr === ethers.ZeroAddress) return null;

    const pair = new ethers.Contract(pairAddr, [
      'function getReserves() view returns (uint112,uint112,uint32)',
      'function token0() view returns (address)'
    ], provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    const isT0BNB = token0.toLowerCase() === WBNB.toLowerCase();
    const bnbReserve = parseFloat(ethers.formatEther(isT0BNB ? r0 : r1));
    const skyReserve = parseFloat(ethers.formatEther(isT0BNB ? r1 : r0));

    const chainlink = new ethers.Contract(
      CHAINLINK_BNB_USD,
      ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'],
      provider
    );
    const [, answer] = await chainlink.latestRoundData();
    const bnbUsd = Number(answer) / 1e8;

    if (skyReserve <= 0 || bnbUsd <= 0) return null;
    const skynetUsd = (bnbReserve / skyReserve) * bnbUsd;
    if (!isFinite(skynetUsd) || skynetUsd <= 0) return null;

    _cached = { skynetUsd, bnbUsd, skyReserve, bnbReserve, ts: Date.now() };
    return _cached;
  } catch (err) {
    logger.debug(`getSkynetUsdPrice failed: ${err.message}`);
    return null;
  }
}

export default { getSkynetUsdPrice };
