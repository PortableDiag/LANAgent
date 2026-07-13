import { logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';

const REGISTRY_ABI = [
  // SkynetHub combined ABI (staking + registry)
  'function reportScammer(address scammer, uint8 category, uint8 targetType, bytes32 evidenceTxHash, bytes32 reason) external',
  'function batchReportScammer(address[] scammers, uint8[] categories, uint8[] targetTypes, bytes32[] evidenceTxHashes, bytes32[] reasons) external',
  // SkynetDiamond RegistryFacet ABI
  'function removeScammer(address scammer) external',
  'function isScammer(address addr) external view returns (bool)',
  'function getScamReport(address addr) external view returns (address reporter, uint48 timestamp, uint8 category, uint8 targetType, bytes32 reason, bytes32 evidenceTxHash, bool active)',
  'function isImmune(address addr) external view returns (bool)',
  'function getScammerCount() external view returns (uint256)',
  'function getScammerAtIndex(uint256 index) external view returns (address)',
  'function reportFee() external view returns (uint256)',
  // AdminViewFacet views (added in v2.24.4 via diamondCut at tx
  // 0xc1d2d96ec8e4cf8f4b867fb9956959b4f6b377a8190a41a25c7db69f2e18cef0).
  // Before that cut, none of these had on-chain getters.
  'function immunityThreshold() external view returns (uint256)',
  'function commerceFeeBps() external view returns (uint256)',
  'function trustStakeThreshold() external view returns (uint256)',
  'function trustLPThreshold() external view returns (uint256)',
  // AdminFacet writes (genesis-agent-only)
  'function setReportFee(uint256 newFee) external',
  'function setImmunityThreshold(uint256 newThreshold) external',
  // AdminFacet views
  'function getConfig() external view returns (address,address,address,address,uint256,uint256,uint256,uint256,uint256)',
  // FeeRouterFacet views
  'function getFeeConfig() external view returns (uint256,uint256,uint256,address,uint256)',
  // OwnershipFacet (used as a pre-flight to detect the genesis instance)
  'function owner() external view returns (address)',
  // Events (for observability)
  'event ReportFeeUpdated(uint256 newFee)',
  'event ImmunityThresholdUpdated(uint256 newThreshold)'
];

const TARGET_WALLET = 1;
const TARGET_CONTRACT = 2;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

const CATEGORIES = {
  1: 'Address Poisoning',
  2: 'Phishing',
  3: 'Honeypot',
  4: 'Rug Pull',
  5: 'Fake Contract',
  6: 'Dust Attack',
  7: 'Other'
};

// Callers pass category as either an ID (1-7) or a slug ('honeypot', 'airdrop_scam').
const CATEGORY_IDS = {
  addresspoisoning: 1,
  phishing: 2,
  honeypot: 3,
  rugpull: 4,
  fakecontract: 5,
  dustattack: 6,
  airdropscam: 7,
  scamtoken: 7,
  other: 7
};

function categoryToId(category) {
  const n = parseInt(category);
  if (n >= 1 && n <= 7) return n;
  const slug = String(category || '').toLowerCase().replace(/[\s_-]+/g, '');
  return CATEGORY_IDS[slug] || 7;
}

const DEFAULT_REGISTRY_ADDRESS = '0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7'; // SkynetDiamond (RegistryFacet)
const DEFAULT_SKYNET_ADDRESS = '0x8b77CC5c6cB3d846608d9d5Dd03fA406BA03b8F1';

class ScammerRegistryService {
  constructor() {
    this.registryAddress = null;
    this.tokenAddress = null;
    this.network = 'bsc';
    // Local scammer address cache for fast lookups
    this._scammerCache = new Set();
    this._lastSyncTime = 0;
    this._syncIntervalMs = 4 * 60 * 60 * 1000; // 4 hours
    this._syncing = false;
    // Queue for batch scam reporting (flushed after each sweep cycle)
    this._reportQueue = new Map(); // address → { category, evidenceTxHash, reason, symbol, network, confidence }
  }

  async initialize() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      this.registryAddress = await SystemSettings.getSetting(
        'scammer_registry_address',
        process.env.SCAMMER_REGISTRY_ADDRESS || DEFAULT_REGISTRY_ADDRESS
      );
      this.tokenAddress = await SystemSettings.getSetting(
        'skynet_token_address',
        process.env.SKYNET_TOKEN_ADDRESS || DEFAULT_SKYNET_ADDRESS
      );
      if (this.registryAddress) {
        logger.info(`Scammer registry service initialized: ${this.registryAddress.slice(0, 10)}...`);
      }
      // Restore any reports queued before the last restart — the queue is
      // otherwise in-memory only and a restart between detection and flush
      // silently drops the reports.
      const persisted = await SystemSettings.getSetting('scammer_report_queue', []);
      if (Array.isArray(persisted) && persisted.length > 0) {
        for (const r of persisted) {
          if (r?.address && !this._reportQueue.has(r.address.toLowerCase())) {
            this._reportQueue.set(r.address.toLowerCase(), r);
          }
        }
        logger.info(`Scam report queue restored: ${this._reportQueue.size} pending report(s)`);
      }
    } catch (err) {
      logger.debug(`Scammer registry init: ${err.message}`);
    }
  }

  /**
   * Persist the report queue so it survives restarts. Fire-and-forget, non-fatal.
   */
  _persistQueue() {
    import('../../models/SystemSettings.js').then(({ SystemSettings }) =>
      SystemSettings.setSetting('scammer_report_queue', Array.from(this._reportQueue.values()),
        'Pending scam reports awaiting on-chain flush', 'crypto')
    ).catch(err => logger.debug(`Scam report queue persist failed: ${err.message}`));
  }

  isAvailable() {
    return !!this.registryAddress;
  }

  async _getContract(needsSigner = false) {
    const { ethers } = await import('ethers');
    if (needsSigner) {
      const signer = await contractServiceWrapper.getSigner(this.network);
      return new ethers.Contract(this.registryAddress, REGISTRY_ABI, signer);
    }
    const provider = await contractServiceWrapper.getProvider(this.network);
    return new ethers.Contract(this.registryAddress, REGISTRY_ABI, provider);
  }

  async _ensureApproval(amount) {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(this.network);
    const token = new ethers.Contract(this.tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, this.registryAddress);
    if (allowance < amount) {
      logger.info('Approving SKYNET spend for scammer registry...');
      const tx = await token.approve(this.registryAddress, ethers.MaxUint256);
      await tx.wait();
      logger.info(`Approval tx: ${tx.hash}`);
    }
  }

  /**
   * Report a single scammer address
   */
  async reportScammer(address, category, evidenceTxHash, reason, targetType) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');

    const { ethers } = await import('ethers');

    // Validate category
    const cat = parseInt(category);
    if (!cat || cat < 1 || cat > 7) throw new Error(`Invalid category: ${category}. Use 1-7.`);

    // Validate address
    if (!ethers.isAddress(address)) throw new Error(`Invalid address: ${address}`);

    // Determine target type: wallet (1) or contract (2)
    // Auto-detect by checking on-chain bytecode if not explicitly specified
    let tt = parseInt(targetType) || 0;
    if (!tt) {
      try {
        const contractService = (await import('./contractServiceWrapper.js')).default;
        const provider = await contractService.getProvider(this.network);
        const code = await provider.getCode(address);
        tt = (code && code !== '0x' && code.length > 2) ? TARGET_CONTRACT : TARGET_WALLET;
      } catch {
        // Fallback to category-based detection if on-chain check fails
        tt = (cat === 3 || cat === 5 || cat === 6) ? TARGET_CONTRACT : TARGET_WALLET;
      }
    }
    if (tt !== TARGET_WALLET && tt !== TARGET_CONTRACT) tt = TARGET_WALLET;

    // Get fee and ensure approval
    const contract = await this._getContract(true);
    const fee = await contract.reportFee();
    await this._ensureApproval(fee);

    // Encode bytes32 fields
    const reasonBytes = ethers.encodeBytes32String((reason || '').slice(0, 31));
    const evidenceBytes = evidenceTxHash
      ? (evidenceTxHash.startsWith('0x') && evidenceTxHash.length === 66
        ? evidenceTxHash
        : ethers.encodeBytes32String((evidenceTxHash || '').slice(0, 31)))
      : ethers.ZeroHash;

    const tx = await contract.reportScammer(address, cat, tt, evidenceBytes, reasonBytes);
    const receipt = await tx.wait();

    logger.info(`Scammer reported: ${address} (cat=${cat}) tx=${tx.hash}`);
    return {
      txHash: tx.hash,
      scammer: address,
      category: cat,
      categoryName: CATEGORIES[cat],
      gasUsed: receipt.gasUsed.toString()
    };
  }

  /**
   * Batch report multiple scammer addresses
   */
  async batchReportScammer(reports) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');
    if (reports.length > 50) throw new Error('Maximum 50 addresses per batch');

    const { ethers } = await import('ethers');
    const contract = await this._getContract(true);
    const fee = await contract.reportFee();
    await this._ensureApproval(fee * BigInt(reports.length));

    const addresses = [];
    const categories = [];
    const targetTypes = [];
    const evidences = [];
    const reasons = [];

    for (const r of reports) {
      if (!ethers.isAddress(r.address)) continue;
      addresses.push(r.address);
      const cat = categoryToId(r.category);
      categories.push(cat);
      // Same wallet-vs-contract detection as the single-report path
      let tt = parseInt(r.targetType) || 0;
      if (!tt) {
        try {
          const provider = await contractServiceWrapper.getProvider(this.network);
          const code = await provider.getCode(r.address);
          tt = (code && code !== '0x' && code.length > 2) ? TARGET_CONTRACT : TARGET_WALLET;
        } catch {
          tt = (cat === 3 || cat === 5 || cat === 6) ? TARGET_CONTRACT : TARGET_WALLET;
        }
      }
      if (tt !== TARGET_WALLET && tt !== TARGET_CONTRACT) tt = TARGET_WALLET;
      targetTypes.push(tt);
      evidences.push(r.evidenceTxHash
        ? (r.evidenceTxHash.startsWith('0x') && r.evidenceTxHash.length === 66
          ? r.evidenceTxHash
          : ethers.encodeBytes32String((r.evidenceTxHash || '').slice(0, 31)))
        : ethers.ZeroHash);
      reasons.push(ethers.encodeBytes32String((r.reason || '').slice(0, 31)));
    }

    const tx = await contract.batchReportScammer(addresses, categories, targetTypes, evidences, reasons);
    const receipt = await tx.wait();

    logger.info(`Batch scammer report: ${addresses.length} addresses, tx=${tx.hash}`);
    return {
      txHash: tx.hash,
      count: addresses.length,
      gasUsed: receipt.gasUsed.toString()
    };
  }

  /**
   * Remove a scammer flag (genesis agent only)
   */
  async removeScammer(address) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');

    const { ethers } = await import('ethers');
    if (!ethers.isAddress(address)) throw new Error(`Invalid address: ${address}`);

    const contract = await this._getContract(true);
    const tx = await contract.removeScammer(address);
    await tx.wait();

    logger.info(`Scammer removed: ${address} tx=${tx.hash}`);
    return { txHash: tx.hash, address };
  }

  /**
   * Check if an address is flagged
   */
  async isScammer(address) {
    if (!this.isAvailable()) return false;
    const contract = await this._getContract(false);
    return await contract.isScammer(address);
  }

  /**
   * Get full report for an address
   */
  async getReport(address) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');
    const contract = await this._getContract(false);
    const [reporter, timestamp, category, targetType, reason, evidenceTxHash, active] = await contract.getScamReport(address);

    const { ethers } = await import('ethers');
    return {
      address,
      reporter,
      timestamp: Number(timestamp),
      date: new Date(Number(timestamp) * 1000).toISOString(),
      category: Number(category),
      categoryName: CATEGORIES[Number(category)] || 'Unknown',
      targetType: Number(targetType),
      targetTypeName: Number(targetType) === 1 ? 'wallet' : Number(targetType) === 2 ? 'contract' : 'unknown',
      reason: ethers.decodeBytes32String(reason).replace(/\0/g, ''),
      evidenceTxHash: evidenceTxHash === ethers.ZeroHash ? null : evidenceTxHash,
      active
    };
  }

  /**
   * Get the chronological audit trail for an address — every
   * ScammerRegistered event that targeted this address. The contract's
   * getScamReport() only returns the *current* report; this returns the
   * full event history (useful when reports get revoked + re-filed, or
   * when an admin wants to see who originally flagged an address).
   *
   * Returns an array sorted oldest → newest. Empty if the address was
   * never reported.
   */
  async getReportHistory(address) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');
    const { ethers } = await import('ethers');
    const { contractServiceWrapper } = await import('./contractServiceWrapper.js');
    const provider = await contractServiceWrapper.getProvider(this.network);

    const registry = new ethers.Contract(this.registryAddress, [
      'event ScammerRegistered(address indexed scammer, address indexed reporter, uint8 category, bytes32 evidenceTxHash)'
    ], provider);

    // Filter by indexed scammer — provider returns only matching logs.
    const filter = registry.filters.ScammerRegistered(address);
    const logs = await registry.queryFilter(filter);

    // Resolve block timestamps in parallel so the response is fast even
    // for addresses with several events.
    const timestamps = await Promise.all(
      logs.map(async (log) => {
        try {
          const block = await provider.getBlock(log.blockNumber);
          return Number(block?.timestamp || 0);
        } catch {
          return 0;
        }
      })
    );

    return logs
      .map((log, i) => ({
        scammer: log.args.scammer,
        reporter: log.args.reporter,
        category: Number(log.args.category),
        categoryName: CATEGORIES[Number(log.args.category)] || 'Unknown',
        evidenceTxHash: log.args.evidenceTxHash === ethers.ZeroHash ? null : log.args.evidenceTxHash,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        timestamp: timestamps[i],
        date: timestamps[i] ? new Date(timestamps[i] * 1000).toISOString() : null
      }))
      .sort((a, b) => a.blockNumber - b.blockNumber);
  }

  /**
   * Check if an address has immunity
   */
  async checkImmunity(address) {
    if (!this.isAvailable()) return false;
    const contract = await this._getContract(false);
    return await contract.isImmune(address);
  }

  /**
   * Get registry stats
   */
  async getStats() {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');

    const { ethers } = await import('ethers');
    const contract = await this._getContract(false);

    // Diamond RegistryFacet + FeeRouterFacet views
    const [count, fee] = await Promise.all([
      contract.getScammerCount(),
      contract.reportFee()
    ]);

    // Get fee stats from FeeRouterFacet (best-effort)
    let totalFeesRouted = 0n;
    try {
      const feeConfig = await contract.getFeeConfig();
      totalFeesRouted = feeConfig[4]; // totalFeesRouted
    } catch {}

    return {
      scammerCount: Number(count),
      reportFee: ethers.formatUnits(fee, 18),
      reportFeeRaw: fee.toString(),
      registryAddress: this.registryAddress,
      totalFeesRoutedToStaking: ethers.formatUnits(totalFeesRouted, 18),
      // Badge addresses (hardcoded — deployed with diamond)
      scammerBadge: '0xb0Be1846Ed97d555842e5c725A8463eA4D174eAF',
      scamTokenBadge: '0x04c5841588f290FB12a9E4083f845647bE053952',
      sentinelBadge: '0xD3eA726D81940aDDE3cd10cBd41ebFC657E7d6d9'
    };
  }

  /**
   * List all flagged addresses
   */
  async listScammers(limit = 50) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');

    const contract = await this._getContract(false);
    const count = Number(await contract.getScammerCount());
    const max = Math.min(count, limit);
    const addresses = [];

    for (let i = 0; i < max; i++) {
      addresses.push(await contract.getScammerAtIndex(i));
    }

    return { total: count, addresses };
  }

  /**
   * Update report fee (genesis agent only)
   */
  async setReportFee(amount) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');
    const { ethers } = await import('ethers');
    const contract = await this._getContract(true);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tx = await contract.setReportFee(amountWei);
    await tx.wait();
    logger.info(`Report fee updated to ${amount} SKYNET, tx=${tx.hash}`);
    // Rate limiter timestamp only — the current value comes from the on-chain
    // reportFee() view.
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      await SystemSettings.setSetting('skynet.scammerFee.lastSetAt', Date.now());
    } catch { /* non-critical */ }
    return { txHash: tx.hash, newFee: amount };
  }

  /**
   * Update immunity threshold (genesis agent only)
   */
  async setImmunityThreshold(amount) {
    if (!this.isAvailable()) throw new Error('Scammer registry not configured');
    const { ethers } = await import('ethers');
    const contract = await this._getContract(true);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tx = await contract.setImmunityThreshold(amountWei);
    await tx.wait();
    logger.info(`Immunity threshold updated to ${amount} SKYNET, tx=${tx.hash}`);
    // Rate limiter timestamp only — the current value itself comes from the
    // on-chain immunityThreshold() view added by AdminViewFacet in v2.24.4.
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      await SystemSettings.setSetting('skynet.immunityThreshold.lastSetAt', Date.now());
    } catch { /* non-critical */ }
    return { txHash: tx.hash, newThreshold: amount };
  }

  /**
   * Pre-flight: confirm this instance's signer is the diamond owner.
   * Returns false silently on non-genesis instances so forks no-op without
   * burning gas on guaranteed-revert calls.
   */
  async _isGenesisInstance() {
    try {
      const contract = await this._getContract(false);
      const ownerAddr = await contract.owner();
      const signer = await contractServiceWrapper.getSigner(this.network);
      const signerAddr = await signer.getAddress();
      return ownerAddr.toLowerCase() === signerAddr.toLowerCase();
    } catch (err) {
      logger.debug(`_isGenesisInstance check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Auto-reprice the on-chain registry flag fee toward a USD target using the
   * shared SKYNET/USD oracle. Honors:
   *
   *   skynet.scammerFee.autoPrice           — master toggle (default true; kill switch)
   *   skynet.scammerFee.targetUsd           — desired USD-equivalent fee (default 0.50)
   *   skynet.scammerFee.driftThresholdPct   — skip if within ±N% of target (default 25)
   *   skynet.scammerFee.minIntervalHours    — hard rate limit between updates (default 24)
   *   skynet.scammerFee.minFee              — floor in SKYNET (default 1000)
   *   skynet.scammerFee.maxFee              — ceiling in SKYNET (default 10_000_000)
   *
   * Returns a structured result for logging/observability.
   */
  async autoUpdateScammerFee() {
    return this._autoUpdateOnchainParam({
      label: 'scammerFee',
      humanLabel: 'report fee',
      settingPrefix: 'skynet.scammerFee',
      defaultTargetUsd: 0.50,
      defaultMinFee: 1000,
      defaultMaxFee: 10_000_000,
      // Reads on-chain reportFee() (the contract has a public view for this one)
      readCurrent: async () => {
        const { ethers } = await import('ethers');
        const contract = await this._getContract(false);
        const wei = await contract.reportFee();
        return parseFloat(ethers.formatUnits(wei, 18));
      },
      apply: async (skynetAmount) => this.setReportFee(skynetAmount)
    });
  }

  /**
   * Auto-reprice the immunity-threshold SKYNET amount toward a USD target.
   * Same shape as autoUpdateScammerFee. Reads the current value from the
   * on-chain immunityThreshold() view (AdminViewFacet, added in v2.24.4).
   *
   *   skynet.immunityThreshold.autoPrice           — master toggle (default true; kill switch)
   *   skynet.immunityThreshold.targetUsd           — desired USD value (default 50.00)
   *   skynet.immunityThreshold.driftThresholdPct   — drift gate (default 25)
   *   skynet.immunityThreshold.minIntervalHours    — rate limit (default 24)
   *   skynet.immunityThreshold.minFee              — floor (default 10_000)
   *   skynet.immunityThreshold.maxFee              — ceiling (default 100_000_000)
   *
   * The default $50 target is intentionally higher than the flag fee — immunity
   * should require a meaningfully larger SKYNET balance than a single flag.
   */
  async autoUpdateImmunityThreshold() {
    return this._autoUpdateOnchainParam({
      label: 'immunityThreshold',
      humanLabel: 'immunity threshold',
      settingPrefix: 'skynet.immunityThreshold',
      defaultTargetUsd: 50.00,
      defaultMinFee: 10_000,
      defaultMaxFee: 100_000_000,
      readCurrent: async () => {
        const { ethers } = await import('ethers');
        const contract = await this._getContract(false);
        const wei = await contract.immunityThreshold();
        return parseFloat(ethers.formatUnits(wei, 18));
      },
      apply: async (skynetAmount) => this.setImmunityThreshold(skynetAmount)
    });
  }

  /**
   * Shared workhorse for the two auto-pricers above. Keeps the toggle/drift/
   * interval/clamp/preflight logic in one place so the two callers can never
   * diverge subtly.
   */
  async _autoUpdateOnchainParam({
    label,
    humanLabel,
    settingPrefix,
    defaultTargetUsd,
    defaultMinFee,
    defaultMaxFee,
    readCurrent,
    apply
  }) {
    try {
      if (!this.isAvailable()) return { ran: false, reason: 'registry_unavailable' };

      const { SystemSettings } = await import('../../models/SystemSettings.js');
      // Default ON — non-genesis instances are already made safe by the
      // _isGenesisInstance() pre-flight below, so the master toggle is just
      // a kill switch for the genesis operator rather than a safety gate.
      const enabled = await SystemSettings.getSetting(`${settingPrefix}.autoPrice`, true);
      if (!enabled) return { ran: false, reason: 'disabled' };

      // Hard rate limit
      const minIntervalHours = Number(await SystemSettings.getSetting(`${settingPrefix}.minIntervalHours`, 24));
      const lastAt = Number(await SystemSettings.getSetting(`${settingPrefix}.lastSetAt`, 0));
      const sinceMs = Date.now() - lastAt;
      if (lastAt > 0 && sinceMs < minIntervalHours * 3600 * 1000) {
        const hoursAgo = (sinceMs / 3600 / 1000).toFixed(1);
        return { ran: false, reason: 'rate_limited', lastUpdateHoursAgo: Number(hoursAgo), minIntervalHours };
      }

      // Pre-flight: silent no-op on non-genesis instances
      const isGenesis = await this._isGenesisInstance();
      if (!isGenesis) return { ran: false, reason: 'not_genesis_instance' };

      // Oracle
      const { getSkynetUsdPrice } = await import('./skynetPrice.js');
      const priceInfo = await getSkynetUsdPrice();
      if (!priceInfo) return { ran: false, reason: 'oracle_unavailable' };
      const { skynetUsd } = priceInfo;

      // Compute target SKYNET amount, clamped
      const targetUsd = Number(await SystemSettings.getSetting(`${settingPrefix}.targetUsd`, defaultTargetUsd));
      const minFee = Number(await SystemSettings.getSetting(`${settingPrefix}.minFee`, defaultMinFee));
      const maxFee = Number(await SystemSettings.getSetting(`${settingPrefix}.maxFee`, defaultMaxFee));
      const driftPct = Number(await SystemSettings.getSetting(`${settingPrefix}.driftThresholdPct`, 25));

      let target = Math.round(targetUsd / skynetUsd);
      target = Math.max(minFee, Math.min(maxFee, target));

      // Drift gate (skip if last-known value is within tolerance of target)
      const current = await readCurrent();
      if (current != null && current > 0) {
        const drift = Math.abs(target - current) / target;
        if (drift <= driftPct / 100) {
          logger.debug(
            `${humanLabel} auto-price: drift ${(drift * 100).toFixed(1)}% within ${driftPct}% threshold ` +
            `(current=${current.toLocaleString()} SKYNET, target=${target.toLocaleString()} SKYNET, ` +
            `SKYNET=$${skynetUsd.toFixed(8)}), skipping`
          );
          return { ran: false, reason: 'within_drift', current, target, skynetUsd, driftPct: drift * 100 };
        }
      }

      // Fire the tx
      logger.info(
        `${humanLabel} auto-price: updating ${current ? current.toLocaleString() : '?'} → ${target.toLocaleString()} SKYNET ` +
        `(target=$${targetUsd}, SKYNET=$${skynetUsd.toFixed(8)})`
      );
      const result = await apply(target);
      return { ran: true, target, current, skynetUsd, targetUsd, txHash: result.txHash };
    } catch (err) {
      logger.warn(`${humanLabel} auto-price failed: ${err.message}`);
      return { ran: false, reason: 'error', error: err.message };
    }
  }

  /**
   * Sync the local scammer address cache from the on-chain registry.
   * Only fetches if the cache is stale (>4 hours old). Safe to call frequently.
   */
  async syncScammerCache(force = false) {
    if (!this.isAvailable()) return;
    if (this._syncing) return;

    const now = Date.now();
    if (!force && (now - this._lastSyncTime) < this._syncIntervalMs) return;

    this._syncing = true;
    try {
      const contract = await this._getContract(false);
      const count = Number(await contract.getScammerCount());

      const addresses = new Set();
      // Fetch in small sequential batches with delay to avoid BSC RPC rate limits.
      // The shared provider is also used by arb scanner / TokenTrader / V4 quotes,
      // so parallel batches of 20 were causing CALL_EXCEPTION failures.
      const batchSize = 5;
      for (let i = 0; i < count; i += batchSize) {
        const batch = [];
        for (let j = i; j < Math.min(i + batchSize, count); j++) {
          batch.push(contract.getScammerAtIndex(j));
        }
        try {
          const results = await Promise.all(batch);
          for (const addr of results) {
            addresses.add(addr.toLowerCase());
          }
        } catch (batchErr) {
          // Single batch failed — try switching RPC and retry this batch once
          logger.debug(`Scammer cache batch ${i}-${i + batchSize} failed, trying RPC fallback`);
          try {
            await contractServiceWrapper.switchToNextRpc(this.network);
            const retryContract = await this._getContract(false);
            const retryBatch = [];
            for (let j = i; j < Math.min(i + batchSize, count); j++) {
              retryBatch.push(retryContract.getScammerAtIndex(j));
            }
            const retryResults = await Promise.all(retryBatch);
            for (const addr of retryResults) {
              addresses.add(addr.toLowerCase());
            }
          } catch (retryErr) {
            logger.debug(`Scammer cache batch retry also failed: ${retryErr.message?.substring(0, 80)}`);
            // Continue with partial data rather than failing entirely
          }
        }
        // Small delay between batches to avoid rate limiting
        if (i + batchSize < count) await new Promise(r => setTimeout(r, 200));
      }

      this._scammerCache = addresses;
      this._lastSyncTime = now;
      logger.info(`Scammer cache synced: ${addresses.size} flagged addresses`);
    } catch (err) {
      logger.warn(`Scammer cache sync failed (non-fatal): ${err.message}`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Fast local check if an address is in the scammer cache.
   * Returns false if cache is empty or service unavailable (graceful degradation).
   */
  isAddressFlagged(address) {
    if (!address || this._scammerCache.size === 0) return false;
    return this._scammerCache.has(address.toLowerCase());
  }

  /**
   * Get the current cache size and last sync time
   */
  getCacheStats() {
    return {
      size: this._scammerCache.size,
      lastSync: this._lastSyncTime ? new Date(this._lastSyncTime).toISOString() : null,
      stale: (Date.now() - this._lastSyncTime) > this._syncIntervalMs
    };
  }

  /**
   * Queue a scam token for batch reporting. Deduplicates by address.
   * Only queues if confidence >= 50 (2+ strong signals required).
   * @param {string} address - Token contract address
   * @param {number} category - Scam category (1-7)
   * @param {object} opts - { evidenceTxHash, reason, symbol, network, confidence }
   */
  queueScamReport(address, category, opts = {}) {
    if (!address || !category) return;
    // Require high confidence — never auto-report borderline tokens
    if ((opts.confidence || 0) < 50) {
      logger.debug(`Scam report skipped for ${opts.symbol || address}: confidence ${opts.confidence} < 50 threshold`);
      return;
    }
    const addrLower = address.toLowerCase();
    // Don't re-queue tokens already in the on-chain registry
    if (this._scammerCache.has(addrLower)) return;
    // Don't queue if already queued
    if (this._reportQueue.has(addrLower)) return;

    this._reportQueue.set(addrLower, {
      address,
      category: categoryToId(category),
      evidenceTxHash: opts.evidenceTxHash || null,
      reason: (opts.reason || opts.symbol || 'scam token').slice(0, 31),
      symbol: opts.symbol || 'UNKNOWN',
      network: opts.network || 'bsc',
      confidence: opts.confidence || 0
    });
    logger.info(`Scam report queued: ${opts.symbol || address} (cat=${category}, confidence=${opts.confidence})`);
    this._persistQueue();
  }

  /**
   * Flush the report queue — batch-report all queued scam tokens to the on-chain registry.
   * Returns results summary. Should be called after sweep/deposit scan cycles.
   */
  async flushReportQueue() {
    if (this._reportQueue.size === 0) return { reported: 0 };
    if (!this.isAvailable()) {
      logger.debug('Scam report flush skipped: registry not available');
      return { reported: 0, reason: 'registry_unavailable' };
    }

    // Check if auto-reporting is enabled
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const enabled = await SystemSettings.getSetting('crypto.autoReportScams', true);
      if (!enabled) {
        logger.debug(`Scam report flush skipped: auto-reporting disabled (${this._reportQueue.size} queued)`);
        this._reportQueue.clear();
        this._persistQueue();
        return { reported: 0, reason: 'disabled' };
      }
    } catch { /* default to enabled */ }

    const queued = Array.from(this._reportQueue.values());
    this._reportQueue.clear();
    this._persistQueue();

    logger.info(`Flushing scam report queue: ${queued.length} token(s) to report`);

    // Use batch if > 1, single report otherwise
    try {
      if (queued.length === 1) {
        const r = queued[0];
        const result = await this.reportScammer(r.address, r.category, r.evidenceTxHash, r.reason);
        // Add to local cache immediately
        this._scammerCache.add(r.address.toLowerCase());
        logger.info(`Scam token reported on-chain: ${r.symbol} (${r.address}) — cat=${CATEGORIES[r.category]}, tx=${result.txHash}`);
        return { reported: 1, txHash: result.txHash, tokens: [r.symbol] };
      } else {
        const reports = queued.map(r => ({
          address: r.address,
          category: r.category,
          evidenceTxHash: r.evidenceTxHash,
          reason: r.reason
        }));
        const result = await this.batchReportScammer(reports);
        // Add all to local cache
        for (const r of queued) this._scammerCache.add(r.address.toLowerCase());
        const symbols = queued.map(r => r.symbol);
        logger.info(`Scam tokens batch-reported on-chain: ${symbols.join(', ')} — tx=${result.txHash}`);
        return { reported: queued.length, txHash: result.txHash, tokens: symbols };
      }
    } catch (err) {
      logger.warn(`Scam report flush failed: ${err.message}`);
      // Re-queue failed reports for next cycle
      for (const r of queued) this._reportQueue.set(r.address.toLowerCase(), r);
      this._persistQueue();
      return { reported: 0, error: err.message, requeued: queued.length };
    }
  }

  /**
   * Get the current report queue status
   */
  getQueueStats() {
    return {
      queued: this._reportQueue.size,
      tokens: Array.from(this._reportQueue.values()).map(r => ({ symbol: r.symbol, address: r.address, category: CATEGORIES[r.category], confidence: r.confidence }))
    };
  }

  getCategoryName(id) {
    return CATEGORIES[id] || 'Unknown';
  }

  getCategories() {
    return { ...CATEGORIES };
  }
}

export default new ScammerRegistryService();
