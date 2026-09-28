import { logger } from '../../utils/logger.js';

/**
 * Peer identity and reputation: what a peer can PROVE, as opposed to what it announces.
 *
 * A peer's capabilities_response announces a wallet, an ERC-8004 agent id and balances.
 * None of that is evidence on its own: any peer can type in another agent's wallet or
 * claim agent #2930. So:
 *
 *   1. The peer signs a wallet proof: an EIP-191 message naming its P2P fingerprint, made
 *      with the wallet's key. Messages from a fingerprint are already authenticated (signed
 *      with the Ed25519 key whose hash IS the fingerprint), so a proof carried in them binds
 *      that wallet to that peer. A proof copied from another agent names the wrong
 *      fingerprint and fails.
 *   2. Everything on-chain (SKYNET held, SKYNET staked, Sentinel badges, ERC-8004 identity)
 *      is read for the PROVEN wallet, from contracts WE configure. A peer never chooses the
 *      contract its balance is read from.
 *   3. The genesis agent is the peer whose proven wallet owns ERC-8004 agent GENESIS_AGENT_ID.
 *      Genesis is trusted by default on every agent.
 */

export const GENESIS_AGENT_ID = Number(process.env.P2P_GENESIS_AGENT_ID) || 2930;
export const ERC8004_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const SENTINEL_REGISTRY = '0xEa68dad9D44a51428206B4ECFE38147C7783b9e9';
export const DEFAULT_SKYNET_ERC20 = '0x8b77CC5c6cB3d846608d9d5Dd03fA406BA03b8F1';
export const DEFAULT_SKYNET_STAKING = '0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7';

const PROOF_HEADER = 'LANAgent P2P wallet proof v1';
const PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROOF_MAX_SKEW_MS = 10 * 60 * 1000;
const PROOF_REFRESH_MS = 12 * 60 * 60 * 1000;

export function walletProofMessage({ fingerprint, address, issued }) {
  return `${PROOF_HEADER}\nfingerprint: ${fingerprint}\naddress: ${String(address).toLowerCase()}\nissued: ${issued}`;
}

let cachedProof = null;

/**
 * Our own proof, signed with the agent wallet. Cached and re-signed every 12h, so the
 * wallet key is not decrypted on every capabilities exchange.
 * @param {{ fingerprint: string, address: string, sign: (message: string) => Promise<string>, now?: number }} opts
 */
export async function createWalletProof({ fingerprint, address, sign, now = Date.now() }) {
  if (!fingerprint || !address || typeof sign !== 'function') return null;
  if (cachedProof && cachedProof.fingerprint === fingerprint && cachedProof.address === address.toLowerCase()
      && now - Date.parse(cachedProof.issued) < PROOF_REFRESH_MS) {
    return cachedProof;
  }
  const issued = new Date(now).toISOString();
  const signature = await sign(walletProofMessage({ fingerprint, address, issued }));
  cachedProof = { v: 1, fingerprint, address: address.toLowerCase(), issued, signature };
  return cachedProof;
}

export function _resetProofCache() {
  cachedProof = null;
}

/**
 * Check a peer's wallet proof. The fingerprint is the AUTHENTICATED sender, never the one
 * written in the proof.
 * @returns {Promise<{ valid: boolean, address?: string, reason?: string }>}
 */
export async function verifyWalletProof(proof, { fingerprint, announcedAddress, now = Date.now() }) {
  if (!proof || typeof proof !== 'object') return { valid: false, reason: 'no proof' };
  const { address, issued, signature } = proof;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { valid: false, reason: 'bad address' };
  if (announcedAddress && announcedAddress.toLowerCase() !== address.toLowerCase()) {
    return { valid: false, reason: 'proof is for a different wallet than announced' };
  }
  const issuedMs = Date.parse(issued);
  if (!Number.isFinite(issuedMs)) return { valid: false, reason: 'bad issued time' };
  if (issuedMs - now > PROOF_MAX_SKEW_MS) return { valid: false, reason: 'issued in the future' };
  if (now - issuedMs > PROOF_MAX_AGE_MS) return { valid: false, reason: 'proof expired' };
  if (typeof signature !== 'string') return { valid: false, reason: 'no signature' };
  try {
    const { ethers } = await import('ethers');
    const recovered = ethers.verifyMessage(walletProofMessage({ fingerprint, address, issued }), signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) return { valid: false, reason: 'signature is not from that wallet' };
    return { valid: true, address: address.toLowerCase() };
  } catch (error) {
    return { valid: false, reason: `unreadable signature: ${error.message}` };
  }
}

/**
 * Reputation points on a log scale between 10k SKYNET (0 points) and 10M SKYNET (max),
 * i.e. 0.01% to 10% of the 100M supply.
 */
export function reputationCurve(amount, maxPoints) {
  if (!(amount > 0)) return 0;
  const f = Math.log10(amount / 1e4) / 3;
  return Math.round(Math.max(0, Math.min(1, f)) * maxPoints);
}

async function configuredAddresses() {
  try {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    return {
      token: await SystemSettings.getSetting('skynet_token_address', process.env.SKYNET_TOKEN_ADDRESS || DEFAULT_SKYNET_ERC20),
      staking: await SystemSettings.getSetting('skynet_staking_address', null) || DEFAULT_SKYNET_STAKING
    };
  } catch {
    return { token: process.env.SKYNET_TOKEN_ADDRESS || DEFAULT_SKYNET_ERC20, staking: DEFAULT_SKYNET_STAKING };
  }
}

/**
 * Read a proven wallet's on-chain standing. Each field is null when its read failed, so a
 * flaky RPC never turns into "holds nothing" (callers keep the previous value instead).
 */
export async function readChainReputation(wallet, { agentId = null } = {}) {
  const out = { balance: null, stakeAmount: null, stakeEffective: null, sentinel: null, erc8004Owner: null };
  let provider, ethers;
  try {
    const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
    provider = await contractService.getProvider('bsc');
    ({ ethers } = await import('ethers'));
  } catch (error) {
    logger.debug(`Peer reputation: no BSC provider (${error.message})`);
    return out;
  }
  const { token, staking } = await configuredAddresses();

  await Promise.all([
    (async () => {
      const c = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider);
      out.balance = parseFloat(ethers.formatUnits(await c.balanceOf(wallet), 18));
    })().catch(e => logger.debug(`Peer reputation: balance read failed: ${e.message}`)),
    (async () => {
      const c = new ethers.Contract(staking, ['function getStakeInfo(address) view returns (uint256 amount, uint256 effectiveBalance, uint256 tierId, uint256 lockExpiry, bool locked, uint256 stakedAt)'], provider);
      const info = await c.getStakeInfo(wallet);
      out.stakeAmount = parseFloat(ethers.formatUnits(info.amount, 18));
      out.stakeEffective = parseFloat(ethers.formatUnits(info.effectiveBalance, 18));
    })().catch(e => logger.debug(`Peer reputation: stake read failed: ${e.message}`)),
    (async () => {
      const reg = new ethers.Contract(SENTINEL_REGISTRY, ['function sentinelToken() external view returns (address)'], provider);
      const sentinel = new ethers.Contract(await reg.sentinelToken(), ['function balanceOf(address) view returns (uint256)'], provider);
      out.sentinel = Number(await sentinel.balanceOf(wallet));
    })().catch(e => logger.debug(`Peer reputation: sentinel read failed: ${e.message}`)),
    agentId == null ? null : (async () => {
      const reg = new ethers.Contract(ERC8004_REGISTRY, ['function ownerOf(uint256 tokenId) external view returns (address)'], provider);
      out.erc8004Owner = String(await reg.ownerOf(agentId)).toLowerCase();
    })().catch(e => logger.debug(`Peer reputation: ERC-8004 owner read failed: ${e.message}`))
  ]);
  return out;
}

/**
 * Apply a capabilities_response to a peer document: prove the wallet, then read its
 * standing. Mutates `peer` (the caller saves it). `read` is injectable for tests.
 * @returns {Promise<{ walletVerified: boolean, isGenesis: boolean, reason?: string }>}
 */
export async function applyPeerIdentity(peer, announced, { fingerprint, read = readChainReputation, now = Date.now() } = {}) {
  const { walletAddress, walletProof, erc8004 } = announced || {};
  // The announced wallet stays the address we PAY this peer at; it earns no reputation unproven.
  if (walletAddress) peer.skynetWallet = walletAddress;
  const agentId = erc8004?.agentId != null && Number.isInteger(Number(erc8004.agentId)) ? Number(erc8004.agentId) : null;

  const proof = await verifyWalletProof(walletProof, { fingerprint, announcedAddress: walletAddress, now });
  const previousWallet = peer.walletVerified ? String(peer.provenWallet || '').toLowerCase() : null;

  if (!proof.valid) {
    peer.walletVerified = false;
    peer.provenWallet = null;
    peer.walletProofError = proof.reason;
    peer.skynetBalance = 0;
    peer.skynetBalanceVerified = false;
    peer.skynetStaked = 0;
    peer.skynetStakeEffective = 0;
    peer.sentinelBalance = 0;
    peer.sentinelBalanceVerified = false;
    peer.erc8004 = { agentId: agentId ?? undefined, verified: false };
    peer.isGenesis = false;
    return { walletVerified: false, isGenesis: false, reason: proof.reason };
  }

  const wallet = proof.address;
  const sameWallet = previousWallet === wallet;
  peer.walletVerified = true;
  peer.provenWallet = wallet;
  peer.walletVerifiedAt = new Date(now);
  peer.walletProofError = '';
  if (!sameWallet) {
    // A different wallet: nothing read for the old one carries over.
    peer.skynetBalance = 0; peer.skynetBalanceVerified = false;
    peer.skynetStaked = 0; peer.skynetStakeEffective = 0;
    peer.sentinelBalance = 0; peer.sentinelBalanceVerified = false;
  }

  const chain = await read(wallet, { agentId });
  if (chain.balance != null) {
    peer.skynetBalance = chain.balance;
    peer.skynetBalanceVerified = true;
    peer.skynetBalanceVerifiedAt = new Date(now);
  }
  if (chain.stakeEffective != null) {
    peer.skynetStaked = chain.stakeAmount || 0;
    peer.skynetStakeEffective = chain.stakeEffective;
    peer.skynetStakeVerifiedAt = new Date(now);
  }
  if (chain.sentinel != null) {
    peer.sentinelBalance = chain.sentinel;
    peer.sentinelBalanceVerified = true;
  }

  if (agentId == null) {
    peer.erc8004 = { verified: false };
  } else if (chain.erc8004Owner != null) {
    const verified = chain.erc8004Owner === wallet;
    peer.erc8004 = { agentId, verified, verifiedAt: verified ? new Date(now) : undefined };
    if (!verified) logger.warn(`P2P peer ${fingerprint.slice(0, 8)}... claims ERC-8004 #${agentId}, but it is owned by ${chain.erc8004Owner.slice(0, 10)}..., not its proven wallet`);
  } else {
    // Owner read failed: keep an earlier verification only for the same id and wallet.
    const keep = sameWallet && peer.erc8004?.verified && Number(peer.erc8004.agentId) === agentId;
    peer.erc8004 = keep ? { agentId, verified: true, verifiedAt: peer.erc8004.verifiedAt } : { agentId, verified: false };
  }

  peer.isGenesis = !!(peer.erc8004?.verified && Number(peer.erc8004.agentId) === GENESIS_AGENT_ID);
  return { walletVerified: true, isGenesis: peer.isGenesis };
}
