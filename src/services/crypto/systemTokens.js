/**
 * System tokens — tokens this agent operates rather than trades.
 *
 * Extracted from CryptoStrategyAgent so strategies can consult it without
 * importing the agent back (StrategyRegistry -> strategies is already imported
 * BY the agent, so the reverse edge would be a cycle). CryptoStrategyAgent
 * re-exports these to keep its existing import surface intact.
 *
 * SKYNET is this operator's own token and holds the LP that trades would route
 * through, so it is exempt from sweeps, blacklisting, the scam registry, and
 * arbitrage scanning.
 */

export const SYSTEM_TOKEN_ALLOWLIST = new Set([
  'bsc:0x8b77cc5c6cb3d846608d9d5dd03fa406ba03b8f1' // SKYNET
]);

/**
 * @param {string} network - e.g. 'bsc'
 * @param {string} tokenAddress - contract address, any case
 * @returns {boolean} true when the token is operated by this agent, not traded
 */
export const isSystemToken = (network, tokenAddress) =>
  !!tokenAddress && SYSTEM_TOKEN_ALLOWLIST.has(`${network}:${tokenAddress.toLowerCase()}`);
