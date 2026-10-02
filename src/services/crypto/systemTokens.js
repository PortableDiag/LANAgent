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

const SKYNET_TOKEN_KEY = 'bsc:0x8b77cc5c6cb3d846608d9d5dd03fa406ba03b8f1';

export const SYSTEM_TOKEN_ALLOWLIST = new Set([
  SKYNET_TOKEN_KEY // SKYNET
]);

/**
 * Operational metadata for system tokens. Keeping this alongside the
 * allowlist allows future operator tokens to declare different roles and
 * exemption sets without duplicating policy checks in individual strategies.
 */
export const SYSTEM_TOKEN_POLICY_METADATA = new Map([
  [
    SKYNET_TOKEN_KEY,
    Object.freeze({
      exemptions: Object.freeze({
        sweep: true,
        blacklist: true,
        scamRegistry: true,
        arbitrageScan: true
      }),
      role: 'operator-token'
    })
  ]
]);

/**
 * @param {string} network - e.g. 'bsc'
 * @param {string} tokenAddress - contract address, any case
 * @returns {boolean} true when the token is operated by this agent, not traded
 */
export const isSystemToken = (network, tokenAddress) =>
  !!tokenAddress && SYSTEM_TOKEN_ALLOWLIST.has(`${network}:${tokenAddress.toLowerCase()}`);

/**
 * Return the operational policy for a token.
 *
 * The policy deliberately has a stable shape for both system and tradable
 * tokens, allowing callers to consume exemptions without inferring them from
 * the boolean returned by isSystemToken().
 *
 * @param {string} network - e.g. 'bsc'
 * @param {string} tokenAddress - contract address, any case
 * @returns {{
 *   isSystemToken: boolean,
 *   network: string,
 *   tokenAddress: string,
 *   exemptions: {
 *     sweep: boolean,
 *     blacklist: boolean,
 *     scamRegistry: boolean,
 *     arbitrageScan: boolean
 *   },
 *   role: string
 * }} structured operational policy
 */
export const getSystemTokenPolicy = (network, tokenAddress) => {
  const systemToken = isSystemToken(network, tokenAddress);
  const metadata = systemToken
    ? SYSTEM_TOKEN_POLICY_METADATA.get(`${network}:${tokenAddress.toLowerCase()}`)
    : undefined;

  const policy = metadata || {
    exemptions: {
      sweep: false,
      blacklist: false,
      scamRegistry: false,
      arbitrageScan: false
    },
    role: 'tradable-token'
  };

  return Object.freeze({
    isSystemToken: systemToken,
    network,
    tokenAddress,
    exemptions: Object.freeze({ ...policy.exemptions }),
    role: policy.role
  });
};

/**
 * @param {string} network - e.g. 'bsc'
 * @param {string} tokenAddress - contract address, any case
 * @param {'sweep'|'blacklist'|'scamRegistry'|'arbitrageScan'} exemption
 * @returns {boolean} true when this token's policy exempts it from that operation
 */
export const isSystemTokenExempt = (network, tokenAddress, exemption) =>
  getSystemTokenPolicy(network, tokenAddress).exemptions[exemption] === true;

/**
 * Every system token exempt from one operation, for callers that build a skip
 * list up front instead of checking token by token (the residual sweep).
 * @param {'sweep'|'blacklist'|'scamRegistry'|'arbitrageScan'} exemption
 * @returns {{network: string, address: string}[]} addresses are lowercase
 */
export const systemTokensExemptFrom = (exemption) =>
  [...SYSTEM_TOKEN_POLICY_METADATA.entries()]
    .filter(([, policy]) => policy.exemptions[exemption] === true)
    .map(([key]) => {
      const [network, address] = key.split(':');
      return { network, address };
    });
