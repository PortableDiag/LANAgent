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
import NodeCache from 'node-cache';

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const SKYNET_ADDR = '0x8b77CC5c6cB3d846608d9d5Dd03fA406BA03b8F1';
const PCS_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
const BSC_RPC = 'https://bsc-dataseed.binance.org';

let _cached = null; // { skynetUsd, bnbUsd, skyReserve, bnbReserve, ts }
const CACHE_TTL_MS = 60 * 1000; // 60s — both callers run on minute+ schedules

// Recent flagged anomalies (cap+evict). Visible via getSkynetOracleHealth().
const _anomalies = [];
const ANOMALY_HISTORY_CAP = 50;

// In-memory cache for price history (24h retention, keyed by capture timestamp)
const priceHistoryCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 60 });

function _recordAnomaly(entry) {
  _anomalies.push({ ...entry, ts: Date.now() });
  if (_anomalies.length > ANOMALY_HISTORY_CAP) _anomalies.shift();
}

/**
 * Get the current SKYNET/USD price (and the BNB/USD it was derived from).
 *
 * Optional anomaly-detection inputs are advisory: out-of-bounds or
 * large-swing prices are logged and recorded in the in-process anomaly
 * history but the function still returns the observed price. Callers that
 * want to gate behavior on anomalies can check getSkynetOracleHealth().
 *
 * @param {object} opts
 * @param {boolean} [opts.fresh=false] — bypass the 60s cache
 * @param {number}  [opts.minPrice]    — flag when price < minPrice USD
 * @param {number}  [opts.maxPrice]    — flag when price > maxPrice USD
 * @param {number}  [opts.maxPctChange] — flag when |%Δ| from last cached > maxPctChange (e.g. 25 for 25%)
 * @returns {Promise<{skynetUsd:number, bnbUsd:number, skyReserve:number, bnbReserve:number, anomalies?:string[]} | null>}
 *          Returns null on oracle failure (caller treats as "skip this cycle").
 */
export async function getSkynetUsdPrice({ fresh = false, minPrice, maxPrice, maxPctChange } = {}) {
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
    const [, answer, , updatedAt] = await chainlink.latestRoundData();
    const bnbUsd = Number(answer) / 1e8;
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);

    if (skyReserve <= 0 || bnbUsd <= 0 || ageSeconds > 600) {
      if (ageSeconds > 600) logger.debug(`Chainlink BNB/USD stale (${ageSeconds}s old), skipping`);
      return null;
    }
    const skynetUsd = (bnbReserve / skyReserve) * bnbUsd;
    if (!isFinite(skynetUsd) || skynetUsd <= 0) return null;

    const anomalies = [];
    if (typeof minPrice === 'number' && skynetUsd < minPrice) {
      anomalies.push(`below_min:${skynetUsd.toFixed(8)}<${minPrice}`);
      logger.warn(`SKYNET price below configured minimum: ${skynetUsd.toFixed(8)} < ${minPrice}`);
    }
    if (typeof maxPrice === 'number' && skynetUsd > maxPrice) {
      anomalies.push(`above_max:${skynetUsd.toFixed(8)}>${maxPrice}`);
      logger.warn(`SKYNET price above configured maximum: ${skynetUsd.toFixed(8)} > ${maxPrice}`);
    }
    if (typeof maxPctChange === 'number' && maxPctChange > 0 && _cached?.skynetUsd > 0) {
      const pct = Math.abs((skynetUsd - _cached.skynetUsd) / _cached.skynetUsd) * 100;
      if (pct > maxPctChange) {
        anomalies.push(`swing:${pct.toFixed(2)}%>${maxPctChange}%`);
        logger.warn(`SKYNET price swing exceeds ${maxPctChange}%: ${_cached.skynetUsd.toFixed(8)} -> ${skynetUsd.toFixed(8)} (${pct.toFixed(2)}%)`);
      }
    }
    if (anomalies.length) _recordAnomaly({ skynetUsd, prev: _cached?.skynetUsd, reasons: anomalies });

    _cached = { skynetUsd, bnbUsd, skyReserve, bnbReserve, ts: Date.now() };
    priceHistoryCache.set(String(_cached.ts), _cached);
    return anomalies.length ? { ..._cached, anomalies } : _cached;
  } catch (err) {
    logger.debug(`getSkynetUsdPrice failed: ${err.message}`);
    return null;
  }
}

/**
 * Health snapshot for the SKYNET price oracle.
 * Returns the last cached price (if any) plus recent flagged anomalies.
 */
export function getSkynetOracleHealth() {
  return {
    lastPrice: _cached ? { ..._cached } : null,
    cacheAgeMs: _cached ? Date.now() - _cached.ts : null,
    anomalies: _anomalies.slice(-20)
  };
}

/**
 * Get the historical SKYNET/USD price data captured by getSkynetUsdPrice().
 *
 * Each successful price fetch is recorded in an in-memory node-cache with a
 * 24h TTL. This returns those captures, optionally aggregated into hourly
 * buckets (volume-weighted averages within each UTC hour).
 *
 * @param {object} opts
 * @param {number} [opts.hours=24]      - Number of hours to look back
 * @param {string} [opts.interval='hour'] - 'hour' (aggregated) or 'minute' (raw)
 * @returns {Array<{timestamp:number, skynetUsd:number, bnbUsd:number, skyReserve:number, bnbReserve:number}>}
 */
export function getSkynetPriceHistory({ hours = 24, interval = 'hour' } = {}) {
  const now = Date.now();
  const cutoff = now - hours * 60 * 60 * 1000;

  // node-cache keys are strings; parse back to numeric ts, drop expired entries.
  const data = priceHistoryCache.keys()
    .map(k => priceHistoryCache.get(k))
    .filter(entry => entry && entry.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);

  if (interval === 'minute') {
    return data.map(entry => ({
      timestamp: entry.ts,
      skynetUsd: entry.skynetUsd,
      bnbUsd: entry.bnbUsd,
      skyReserve: entry.skyReserve,
      bnbReserve: entry.bnbReserve
    }));
  }

  return _bucketByHour(data);
}

/**
 * Aggregate raw price captures into hourly buckets.
 *
 * Buckets by the absolute hour key `floor(ts / 3600000)` so captures from the
 * same clock hour on different days never collide. Each bucket's timestamp is
 * the bucket start (bucketKey * 3600000), and numeric fields are averaged.
 *
 * @param {Array<{ts:number, skynetUsd:number, bnbUsd:number, skyReserve:number, bnbReserve:number}>} data
 *        Must be sorted ascending by ts.
 * @returns {Array<{timestamp:number, skynetUsd:number, bnbUsd:number, skyReserve:number, bnbReserve:number}>}
 */
export function _bucketByHour(data) {
  const HOUR_MS = 60 * 60 * 1000;
  const buckets = [];
  let currentKey = null;
  let aggregated = null;

  const flush = () => {
    if (!aggregated) return;
    buckets.push({
      timestamp: aggregated.bucketKey * HOUR_MS,
      skynetUsd: aggregated.skynetUsd / aggregated.count,
      bnbUsd: aggregated.bnbUsd / aggregated.count,
      skyReserve: aggregated.skyReserve / aggregated.count,
      bnbReserve: aggregated.bnbReserve / aggregated.count
    });
  };

  for (const entry of data) {
    const bucketKey = Math.floor(entry.ts / HOUR_MS);
    if (currentKey !== bucketKey) {
      flush();
      currentKey = bucketKey;
      aggregated = {
        bucketKey,
        skynetUsd: entry.skynetUsd,
        bnbUsd: entry.bnbUsd,
        skyReserve: entry.skyReserve,
        bnbReserve: entry.bnbReserve,
        count: 1
      };
    } else {
      aggregated.skynetUsd += entry.skynetUsd;
      aggregated.bnbUsd += entry.bnbUsd;
      aggregated.skyReserve += entry.skyReserve;
      aggregated.bnbReserve += entry.bnbReserve;
      aggregated.count += 1;
    }
  }
  flush();

  return buckets;
}

/**
 * Test seam: inject raw price captures into the history cache.
 * Not used in production paths — only exercised by unit tests.
 * @param {Array<{ts:number}>} entries
 */
export function _seedPriceHistoryForTest(entries) {
  priceHistoryCache.flushAll();
  for (const entry of entries) {
    priceHistoryCache.set(String(entry.ts), entry);
  }
}

export default { getSkynetUsdPrice, getSkynetOracleHealth, getSkynetPriceHistory };
