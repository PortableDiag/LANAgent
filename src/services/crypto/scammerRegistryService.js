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

const DEFAULT_REGISTRY_ADDRESS = '0xFfA95Ec77d7Ed205d48fea72A888aE1C93e30fF7'; // SkynetDiamond (RegistryFacet)
const DEFAULT_SKYNET_ADDRESS = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';

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
    } catch (err) {
      logger.debug(`Scammer registry init: ${err.message}`);
    }
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
    const evidences = [];
    const reasons = [];

    for (const r of reports) {
      if (!ethers.isAddress(r.address)) continue;
      addresses.push(r.address);
      categories.push(r.category || 7);
      evidences.push(r.evidenceTxHash
        ? (r.evidenceTxHash.startsWith('0x') && r.evidenceTxHash.length === 66
          ? r.evidenceTxHash
          : ethers.encodeBytes32String((r.evidenceTxHash || '').slice(0, 31)))
        : ethers.ZeroHash);
      reasons.push(ethers.encodeBytes32String((r.reason || '').slice(0, 31)));
    }

    const tx = await contract.batchReportScammer(addresses, categories, evidences, reasons);
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
      category: parseInt(category) || 7,
      evidenceTxHash: opts.evidenceTxHash || null,
      reason: (opts.reason || opts.symbol || 'scam token').slice(0, 31),
      symbol: opts.symbol || 'UNKNOWN',
      network: opts.network || 'bsc',
      confidence: opts.confidence || 0
    });
    logger.info(`Scam report queued: ${opts.symbol || address} (cat=${category}, confidence=${opts.confidence})`);
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
        return { reported: 0, reason: 'disabled' };
      }
    } catch { /* default to enabled */ }

    const queued = Array.from(this._reportQueue.values());
    this._reportQueue.clear();

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

  /**
   * Scan fee income using a hybrid approach:
   *
   * 1. Bootstrap (first run): Uses on-chain registry state — getScammerCount() × reportFee()
   *    to seed the ledger with all historical fee income. BSC public RPCs prune event logs
   *    beyond ~50k blocks, so this is the only reliable way to capture past reports.
   *
   * 2. Ongoing: Scans ScammerRegistered events for new blocks since last scan.
   *    Recent events ARE available on free RPCs. Tracks self vs external reports.
   *
   * The fee goes directly from reporter → genesis wallet via transferFrom (not through
   * the registry contract), so we count registry events × fee rather than token transfers.
   */
  async scanFeeIncome() {
    try {
      const { ethers } = await import('ethers');
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const SkynetTokenLedger = (await import('../../models/SkynetTokenLedger.js')).default;

      const contract = await this._getContract(false);
      const [scammerCount, reportFee] = await Promise.all([
        contract.getScammerCount(),
        contract.reportFee()
      ]);
      const totalOnChainReports = Number(scammerCount);
      const feePerReport = parseFloat(ethers.formatUnits(reportFee, 18));

      let lastBlock = await SystemSettings.getSetting('crypto.lastFeeIncomeBlock', 0);
      const bootstrapped = lastBlock > 0;

      // ── Step 1: Bootstrap from registry state (first run only) ──
      if (!bootstrapped) {
        const totalHistoricalFees = totalOnChainReports * feePerReport;

        if (totalHistoricalFees > 0) {
          await SkynetTokenLedger.recordFeeIncome(totalHistoricalFees);
          logger.info(`Ledger: bootstrapped ${totalHistoricalFees.toLocaleString()} SKYNET fee income from ${totalOnChainReports} historical reports`);
        }

        // Mark as bootstrapped — set lastBlock to current so future scans only get new events
        const provider = await contractServiceWrapper.getProvider(this.network);
        const currentBlock = await provider.getBlockNumber();
        await SystemSettings.setSetting('crypto.lastFeeIncomeBlock', currentBlock);
        await SystemSettings.setSetting('crypto.bootstrappedFeeReports', totalOnChainReports);

        return {
          scanned: true,
          bootstrapped: true,
          historicalReports: totalOnChainReports,
          feePerReport,
          totalFeeIncome: totalHistoricalFees
        };
      }

      // ── Step 2: Scan new ScammerRegistered events since last block ──
      // Use scan-friendly RPCs (public BSC RPCs rate-limit getLogs)
      const scanRpcs = [
        'https://bsc-mainnet.public.blastapi.io',
        'https://bsc.drpc.org',
        'https://bsc-pokt.nodies.app'
      ];
      const CHUNK_SIZE = 5000;

      let provider;
      for (const rpc of scanRpcs) {
        try {
          const staticNetwork = ethers.Network.from(56);
          provider = new ethers.JsonRpcProvider(rpc, staticNetwork, { staticNetwork, batchMaxCount: 1 });
          await provider.getBlockNumber();
          break;
        } catch { provider = null; }
      }
      if (!provider) {
        provider = await contractServiceWrapper.getProvider(this.network);
      }

      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) {
        return { scanned: false, reason: 'no_new_blocks' };
      }

      const registry = new ethers.Contract(this.registryAddress, [
        'event ScammerRegistered(address indexed scammer, address indexed reporter, uint8 category, bytes32 evidenceTxHash)'
      ], provider);

      const signer = await contractServiceWrapper.getSigner(this.network);
      const walletAddress = (await signer.getAddress()).toLowerCase();

      let fromBlock = lastBlock + 1;
      let newReports = 0;
      let selfReports = 0;
      let externalReports = 0;

      while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);
        try {
          const logs = await registry.queryFilter(registry.filters.ScammerRegistered(), fromBlock, toBlock);
          for (const log of logs) {
            newReports++;
            if (log.args.reporter.toLowerCase() === walletAddress) {
              selfReports++;
            } else {
              externalReports++;
            }
          }
        } catch (err) {
          logger.debug(`Fee scan chunk ${fromBlock}-${toBlock} failed: ${err.message}`);
        }
        fromBlock = toBlock + 1;
      }

      const newFeeIncome = newReports * feePerReport;

      if (newFeeIncome > 0) {
        await SkynetTokenLedger.recordFeeIncome(newFeeIncome);
        logger.info(`Ledger: recorded ${newFeeIncome.toLocaleString()} SKYNET new fee income from ${newReports} report(s) (${selfReports} self, ${externalReports} external)`);
      }

      await SystemSettings.setSetting('crypto.lastFeeIncomeBlock', currentBlock);

      return {
        scanned: true,
        bootstrapped: false,
        newReports,
        selfReports,
        externalReports,
        feePerReport,
        newFeeIncome,
        totalOnChainReports,
        fromBlock: lastBlock + 1,
        toBlock: currentBlock
      };
    } catch (err) {
      logger.debug(`Fee income scan failed (non-fatal): ${err.message}`);
      return { scanned: false, error: err.message };
    }
  }

  /**
   * Route accumulated registry fee income to staking rewards.
   * Only routes SKYNET tracked in the registryFees ledger bucket — never
   * touches LP, treasury, reserve, or other allocations.
   *
   * Settings:
   *   crypto.stakingFeeRouting        — enable/disable (default: true)
   *   crypto.stakingFeeThreshold      — min fee balance to trigger (default: 500000)
   *   crypto.stakingFeePercent        — % of fee balance to route (default: 100)
   *   crypto.stakingEpochDuration     — reward epoch duration in seconds (default: 604800 = 7 days)
   */
  async routeFeesToStaking() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const enabled = await SystemSettings.getSetting('crypto.stakingFeeRouting', true);
      if (!enabled) return { routed: false, reason: 'disabled' };

      const stakingService = (await import('./skynetStakingService.js')).default;
      if (!stakingService.isAvailable()) {
        return { routed: false, reason: 'staking_unavailable' };
      }

      // Check if current epoch is still active — don't fund mid-epoch
      const stats = await stakingService.getContractStats();
      if (stats.timeUntilEnd > 0) {
        return { routed: false, reason: 'epoch_active', endsIn: stats.timeUntilEnd };
      }

      // Check registry fee balance from ledger (not wallet balance)
      const SkynetTokenLedger = (await import('../../models/SkynetTokenLedger.js')).default;
      const feeBalance = await SkynetTokenLedger.getRegistryFeeBalance();

      const threshold = await SystemSettings.getSetting('crypto.stakingFeeThreshold', 500000);
      if (feeBalance < threshold) {
        return { routed: false, reason: 'below_threshold', feeBalance, threshold };
      }

      const percent = await SystemSettings.getSetting('crypto.stakingFeePercent', 100);
      const duration = await SystemSettings.getSetting('crypto.stakingEpochDuration', 604800);
      const fundAmount = Math.floor(feeBalance * (percent / 100));

      logger.info(`Routing ${fundAmount.toLocaleString()} SKYNET registry fees (${percent}% of ${feeBalance.toLocaleString()}) to staking rewards`);
      const result = await stakingService.fundRewards(fundAmount, duration);

      // Debit from ledger and track total routed
      await SkynetTokenLedger.debitFeesForStaking(fundAmount);
      const prevRouted = await SystemSettings.getSetting('crypto.totalFeesRoutedToStaking', 0);
      await SystemSettings.setSetting('crypto.totalFeesRoutedToStaking', prevRouted + fundAmount);

      logger.info(`Staking epoch funded from fees: ${fundAmount.toLocaleString()} SKYNET over ${(duration / 86400).toFixed(1)} days — tx=${result.txHash}`);

      // Log to historical transactions for staking history
      try {
        const mongoose = (await import('mongoose')).default;
        const HistoricalTransaction = mongoose.model('HistoricalTransaction');
        await new HistoricalTransaction({
          transactionType: 'stakingFund',
          category: 'staking',
          amount: fundAmount,
          txHash: result.txHash,
          network: 'bsc',
          description: `Funded staking epoch: ${fundAmount.toLocaleString()} SKYNET from registry fees (${(duration / 86400).toFixed(1)} day epoch)`
        }).save();
      } catch { /* non-critical */ }

      return { routed: true, amount: fundAmount, duration, txHash: result.txHash };
    } catch (err) {
      logger.warn(`Fee-to-staking routing failed: ${err.message}`);
      return { routed: false, error: err.message };
    }
  }
}

export default new ScammerRegistryService();
