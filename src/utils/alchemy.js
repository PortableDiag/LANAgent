import axios from 'axios';
import { logger } from './logger.js';

// Alchemy enhanced APIs (Transfers, Token) for chains where the free explorer tier
// refuses service (Etherscan V2 free no longer serves BSC). The key is pay-as-you-go,
// so callers use these only as a fallback or for one-shot discovery, never for
// chunked log scans.
const NETWORKS = {
  bsc: 'bnb-mainnet',
  ethereum: 'eth-mainnet',
  polygon: 'polygon-mainnet'
};

export function alchemyAvailable(network) {
  return !!process.env.ALCHEMY_API_KEY && !!NETWORKS[network];
}

/**
 * One JSON-RPC call to Alchemy. Returns the `result`, or null on any failure.
 * The key is part of the URL, so errors are logged by message only.
 */
export async function alchemyRpc(network, method, params, timeout = 20000) {
  const key = process.env.ALCHEMY_API_KEY;
  const host = NETWORKS[network];
  if (!key || !host) return null;
  try {
    const { data } = await axios.post(
      `https://${host}.g.alchemy.com/v2/${key}`,
      { jsonrpc: '2.0', id: 1, method, params },
      { timeout, headers: { 'Content-Type': 'application/json' } }
    );
    if (data?.error) {
      logger.warn(`Alchemy ${method} on ${network} failed: ${data.error.message || data.error.code}`);
      return null;
    }
    return data?.result ?? null;
  } catch (error) {
    logger.warn(`Alchemy ${method} on ${network} failed: ${error.message}`);
    return null;
  }
}

/**
 * Token contracts the address currently holds (non-zero ERC-20 balances).
 * Returns [{ contractAddress, rawBalance: bigint }] or null when unavailable.
 */
export async function alchemyTokenBalances(network, address, maxPages = 5) {
  const held = [];
  let pageKey;
  for (let page = 0; page < maxPages; page++) {
    const params = pageKey ? [address, 'erc20', { pageKey }] : [address, 'erc20'];
    const result = await alchemyRpc(network, 'alchemy_getTokenBalances', params);
    if (!result) return page === 0 ? null : held;
    for (const t of result.tokenBalances || []) {
      if (t.error || !t.tokenBalance) continue;
      let raw;
      try { raw = BigInt(t.tokenBalance); } catch { continue; }
      if (raw > 0n) held.push({ contractAddress: t.contractAddress.toLowerCase(), rawBalance: raw });
    }
    pageKey = result.pageKey;
    if (!pageKey) break;
  }
  return held;
}
