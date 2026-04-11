import { logger } from '../../utils/logger.js';
import contractServiceWrapper from './contractServiceWrapper.js';

/**
 * ENSService — Manages ENS name registration, subnames, and renewals on Ethereum mainnet.
 *
 * Supports:
 *   - Register .eth names via commit/reveal (ETHRegistrarController)
 *   - Create subnames via NameWrapper (e.g., alice.lanagent.eth)
 *   - Set address records and reverse resolution
 *   - Check availability and expiry
 *   - Auto-renew before expiry (via scheduled job)
 */

const ENS_CONTRACTS = {
  REGISTRY: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  ETH_REGISTRAR_CONTROLLER: '0x253553366Da8546fC250F225fe3d25d0C782303b',
  PUBLIC_RESOLVER: '0xF29100983E058B709F3D539b0c765937B804AC15',
  NAME_WRAPPER: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
  REVERSE_REGISTRAR: '0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb',
  BASE_REGISTRAR: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
};

const CONTROLLER_ABI = [
  'function available(string name) view returns (bool)',
  'function rentPrice(string name, uint256 duration) view returns (tuple(uint256 base, uint256 premium) price)',
  'function makeCommitment(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, bool reverseRecord, uint16 ownerControlledFuses) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, bool reverseRecord, uint16 ownerControlledFuses) payable',
  'function renew(string name, uint256 duration) payable',
];

const REGISTRY_ABI = [
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
];

const NAME_WRAPPER_ABI = [
  'function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) returns (bytes32 node)',
  'function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)',
  'function ownerOf(uint256 id) view returns (address)',
];

const REVERSE_REGISTRAR_ABI = [
  'function setName(string name) returns (bytes32)',
];

const BASE_REGISTRAR_ABI = [
  'function nameExpires(uint256 id) view returns (uint256)',
];

const RESOLVER_ABI = [
  'function setAddr(bytes32 node, address a)',
  'function addr(bytes32 node) view returns (address)',
];

const ONE_YEAR = 365 * 24 * 3600;
const COMMIT_WAIT = 65; // 60s minimum + 5s buffer
const NETWORK = 'ethereum';

class ENSService {
  constructor() {
    this.baseName = null; // e.g., 'lanagent'
    this.pendingCommitments = new Map(); // secret → { name, owner, duration, commitTx, timestamp }
  }

  async initialize() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      this.baseName = await SystemSettings.getSetting('ens.baseName', null);
      if (this.baseName) {
        logger.info(`ENS service initialized: ${this.baseName}.eth`);
      }
    } catch (err) {
      logger.debug(`ENS service init: ${err.message}`);
    }
  }

  isAvailable() {
    return !!this.baseName;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  async _getEthers() {
    return await import('ethers');
  }

  _namehash(ethers, name) {
    return ethers.namehash(name);
  }

  _labelhash(ethers, label) {
    return ethers.keccak256(ethers.toUtf8Bytes(label));
  }

  async _getController(needsSigner = false) {
    const { ethers } = await this._getEthers();
    const signerOrProvider = needsSigner
      ? await contractServiceWrapper.getSigner(NETWORK)
      : await contractServiceWrapper.getProvider(NETWORK);
    return new ethers.Contract(ENS_CONTRACTS.ETH_REGISTRAR_CONTROLLER, CONTROLLER_ABI, signerOrProvider);
  }

  async _getNameWrapper(needsSigner = false) {
    const { ethers } = await this._getEthers();
    const signerOrProvider = needsSigner
      ? await contractServiceWrapper.getSigner(NETWORK)
      : await contractServiceWrapper.getProvider(NETWORK);
    return new ethers.Contract(ENS_CONTRACTS.NAME_WRAPPER, NAME_WRAPPER_ABI, signerOrProvider);
  }

  async _getOwnerAddress() {
    const signer = await contractServiceWrapper.getSigner(NETWORK);
    return await signer.getAddress();
  }

  // ─── Availability & Pricing ───────────────────────────────────────────

  async checkAvailability(name) {
    const controller = await this._getController(false);
    const available = await controller.available(name);
    let price = null;
    if (available) {
      const { ethers } = await this._getEthers();
      const priceData = await controller.rentPrice(name, ONE_YEAR);
      price = {
        base: ethers.formatEther(priceData.base),
        premium: ethers.formatEther(priceData.premium),
        total: ethers.formatEther(priceData.base + priceData.premium),
        durationYears: 1
      };
    }
    return { name: `${name}.eth`, available, price };
  }

  async getExpiry(name) {
    const { ethers } = await this._getEthers();
    const provider = await contractServiceWrapper.getProvider(NETWORK);
    const baseRegistrar = new ethers.Contract(ENS_CONTRACTS.BASE_REGISTRAR, BASE_REGISTRAR_ABI, provider);
    const labelHash = this._labelhash(ethers, name);
    const tokenId = BigInt(labelHash);
    const expiry = await baseRegistrar.nameExpires(tokenId);
    const expiryTs = Number(expiry);
    return {
      name: `${name}.eth`,
      expiry: expiryTs > 0 ? new Date(expiryTs * 1000) : null,
      expired: expiryTs > 0 && expiryTs < Math.floor(Date.now() / 1000),
      daysUntilExpiry: expiryTs > 0
        ? Math.floor((expiryTs - Math.floor(Date.now() / 1000)) / 86400)
        : null
    };
  }

  // ─── Registration (Commit/Reveal) ─────────────────────────────────────

  async commitRegistration(name, durationYears = 1) {
    const { ethers } = await this._getEthers();
    const controller = await this._getController(true);

    // Verify available
    const avail = await controller.available(name);
    if (!avail) throw new Error(`${name}.eth is not available`);

    const owner = await this._getOwnerAddress();
    const duration = durationYears * ONE_YEAR;
    const secret = ethers.randomBytes(32);
    const secretHex = ethers.hexlify(secret);

    // Simple commitment — resolver + reverse record set as separate steps after registration
    // to avoid parameter encoding mismatches between commit and register
    const commitment = await controller.makeCommitment(
      name, owner, duration, secretHex,
      ethers.ZeroAddress, [], false, 0
    );

    const tx = await controller.commit(commitment);
    const receipt = await tx.wait();

    // Store pending commitment for the reveal step
    this.pendingCommitments.set(secretHex, {
      name, owner, duration, secret: secretHex,
      commitTxHash: receipt.hash,
      timestamp: Math.floor(Date.now() / 1000)
    });

    // Also persist to DB in case of restart
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    await SystemSettings.setSetting(`ens.pendingCommit.${name}`, {
      name, owner, duration, secret: secretHex,
      commitTxHash: receipt.hash,
      timestamp: Math.floor(Date.now() / 1000)
    }, `ENS commit for ${name}.eth`, 'crypto');

    logger.info(`ENS commit submitted for ${name}.eth: tx=${receipt.hash} — wait ${COMMIT_WAIT}s then call register`);
    return {
      name: `${name}.eth`,
      commitTxHash: receipt.hash,
      waitSeconds: COMMIT_WAIT,
      readyAt: new Date((Math.floor(Date.now() / 1000) + COMMIT_WAIT) * 1000)
    };
  }

  async completeRegistration(name) {
    const { ethers } = await this._getEthers();

    // Retrieve pending commitment from memory or DB
    let pending = null;
    for (const [, v] of this.pendingCommitments) {
      if (v.name === name) { pending = v; break; }
    }
    if (!pending) {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      pending = await SystemSettings.getSetting(`ens.pendingCommit.${name}`, null);
    }
    if (!pending) throw new Error(`No pending commitment for ${name}.eth — call commit first`);

    // Verify wait time elapsed
    const elapsed = Math.floor(Date.now() / 1000) - pending.timestamp;
    if (elapsed < 60) {
      throw new Error(`Commit wait not met: ${60 - elapsed}s remaining (need 60s minimum)`);
    }

    const controller = await this._getController(true);

    // Get price (with 10% buffer for price fluctuation)
    const priceData = await controller.rentPrice(name, pending.duration);
    const totalPrice = priceData.base + priceData.premium;
    const priceWithBuffer = totalPrice * 110n / 100n;

    // Register with simple params (must match commit exactly)
    const tx = await controller.register(
      pending.name, pending.owner, pending.duration, pending.secret,
      ethers.ZeroAddress, [], false, 0,
      { value: priceWithBuffer }
    );
    const receipt = await tx.wait();

    // Clean up pending commitment
    this.pendingCommitments.delete(pending.secret);
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    await SystemSettings.setSetting(`ens.pendingCommit.${name}`, null);

    // Save as base name if this is the first registration
    if (!this.baseName) {
      this.baseName = name;
      await SystemSettings.setSetting('ens.baseName', name, 'Primary ENS name', 'crypto');
    }

    // Post-registration: set resolver address record and reverse resolution
    try {
      const node = this._namehash(ethers, `${name}.eth`);

      // Set address record on the public resolver
      const signer = await contractServiceWrapper.getSigner(NETWORK);
      const resolver = new ethers.Contract(ENS_CONTRACTS.PUBLIC_RESOLVER, RESOLVER_ABI, signer);
      const addrTx = await resolver['setAddr(bytes32,address)'](node, pending.owner);
      await addrTx.wait();
      logger.info(`ENS address record set: ${name}.eth → ${pending.owner}`);

      // Set reverse resolution (address → name)
      const reverseRegistrar = new ethers.Contract(ENS_CONTRACTS.REVERSE_REGISTRAR, REVERSE_REGISTRAR_ABI, signer);
      const reverseTx = await reverseRegistrar.setName(`${name}.eth`);
      await reverseTx.wait();
      logger.info(`ENS reverse record set: ${pending.owner} → ${name}.eth`);
    } catch (postErr) {
      logger.warn(`ENS post-registration setup partial failure: ${postErr.message}`);
    }

    // Track registration
    await SystemSettings.setSetting(`ens.registered.${name}`, {
      name: `${name}.eth`,
      registeredAt: new Date().toISOString(),
      txHash: receipt.hash,
      owner: pending.owner,
      cost: ethers.formatEther(totalPrice)
    }, `ENS registration for ${name}.eth`, 'crypto');

    logger.info(`ENS name registered: ${name}.eth — tx=${receipt.hash}, cost=${ethers.formatEther(totalPrice)} ETH`);
    return {
      name: `${name}.eth`,
      txHash: receipt.hash,
      owner: pending.owner,
      cost: ethers.formatEther(totalPrice)
    };
  }

  // ─── Subnames ─────────────────────────────────────────────────────────

  async createSubname(label, ownerAddress) {
    if (!this.baseName) throw new Error('No base ENS name configured');
    const { ethers } = await this._getEthers();

    const parentNode = this._namehash(ethers, `${this.baseName}.eth`);
    const wrapper = await this._getNameWrapper(true);
    const fullName = `${label}.${this.baseName}.eth`;
    const signer = await contractServiceWrapper.getSigner(NETWORK);
    const signerAddress = await signer.getAddress();

    // Get parent expiry for subname expiry
    const parentTokenId = BigInt(parentNode);
    const parentData = await wrapper.getData(parentTokenId);
    const parentExpiry = parentData.expiry;

    // Step 1: Create subname with OURSELVES as owner (so we can set resolver records)
    const tx = await wrapper.setSubnodeRecord(
      parentNode,
      label,
      signerAddress,           // We own it initially
      ENS_CONTRACTS.PUBLIC_RESOLVER,
      0,    // TTL
      0,    // fuses — no restrictions
      parentExpiry // match parent expiry
    );
    const receipt = await tx.wait();
    logger.info(`ENS subname node created: ${fullName} (tx=${receipt.hash})`);

    // Track subname immediately after creation (before setAddr/transfer which may timeout)
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const subnames = await SystemSettings.getSetting('ens.subnames', {});
    subnames[label] = {
      fullName,
      owner: ownerAddress,
      createdAt: new Date().toISOString(),
      txHash: receipt.hash
    };
    await SystemSettings.setSetting('ens.subnames', subnames, 'ENS subnames registry', 'crypto');

    logger.info(`ENS subname created: ${fullName} → ${ownerAddress.slice(0, 10)}... tx=${receipt.hash}`);

    // Best-effort: set address record and transfer ownership (non-blocking)
    // These may fail if the RPC is rate-limited, but the subname is already created
    (async () => {
      try {
        const subNode = this._namehash(ethers, fullName);
        const resolverContract = new ethers.Contract(ENS_CONTRACTS.PUBLIC_RESOLVER, RESOLVER_ABI, signer);
        const addrTx = await resolverContract['setAddr(bytes32,address)'](subNode, ownerAddress);
        await addrTx.wait();
        logger.info(`ENS subname address set: ${fullName} → ${ownerAddress.slice(0, 10)}...`);
      } catch (resolverErr) {
        logger.warn(`ENS setAddr failed (non-fatal, subname exists): ${resolverErr.message?.slice(0, 100)}`);
      }

      if (ownerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
        try {
          const transferTx = await wrapper.setSubnodeRecord(
            parentNode, label, ownerAddress, ENS_CONTRACTS.PUBLIC_RESOLVER, 0, 0, parentExpiry
          );
          await transferTx.wait();
          logger.info(`ENS subname ownership transferred: ${fullName} → ${ownerAddress.slice(0, 10)}...`);
        } catch (transferErr) {
          logger.warn(`ENS ownership transfer failed (non-fatal): ${transferErr.message?.slice(0, 100)}`);
        }
      }
    })().catch(() => {});

    return { name: fullName, owner: ownerAddress, txHash: receipt.hash };
  }

  // ─── Reverse Resolution ───────────────────────────────────────────────

  async setReverseRecord(name) {
    const { ethers } = await this._getEthers();
    const signer = await contractServiceWrapper.getSigner(NETWORK);
    const reverseRegistrar = new ethers.Contract(ENS_CONTRACTS.REVERSE_REGISTRAR, REVERSE_REGISTRAR_ABI, signer);

    const tx = await reverseRegistrar.setName(name);
    const receipt = await tx.wait();

    logger.info(`ENS reverse record set: ${await signer.getAddress()} → ${name} tx=${receipt.hash}`);
    return { name, txHash: receipt.hash };
  }

  // ─── Renewal ──────────────────────────────────────────────────────────

  async renew(name, durationYears = 1) {
    const { ethers } = await this._getEthers();
    const controller = await this._getController(true);
    const duration = durationYears * ONE_YEAR;

    const priceData = await controller.rentPrice(name, duration);
    const totalPrice = priceData.base + priceData.premium;
    const priceWithBuffer = totalPrice * 110n / 100n;

    const tx = await controller.renew(name, duration, { value: priceWithBuffer });
    const receipt = await tx.wait();

    logger.info(`ENS renewed: ${name}.eth for ${durationYears}yr — tx=${receipt.hash}, cost=${ethers.formatEther(totalPrice)} ETH`);
    return {
      name: `${name}.eth`,
      txHash: receipt.hash,
      renewedFor: `${durationYears} year(s)`,
      cost: ethers.formatEther(totalPrice)
    };
  }

  /**
   * Check all tracked ENS names and renew any expiring within 30 days.
   * Called by the scheduled Agenda job.
   */
  async checkAndRenew() {
    if (!this.baseName) return { checked: false, reason: 'no_base_name' };

    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const autoRenew = await SystemSettings.getSetting('ens.autoRenew', true);
      if (!autoRenew) return { checked: false, reason: 'disabled' };

      const expiryInfo = await this.getExpiry(this.baseName);
      const results = { baseName: expiryInfo, renewed: [] };

      if (expiryInfo.daysUntilExpiry !== null && expiryInfo.daysUntilExpiry <= 30) {
        logger.info(`ENS name ${this.baseName}.eth expires in ${expiryInfo.daysUntilExpiry} days — auto-renewing`);
        const result = await this.renew(this.baseName, 1);
        results.renewed.push(result);
      }

      return { checked: true, ...results };
    } catch (err) {
      logger.warn(`ENS auto-renewal check failed: ${err.message}`);
      return { checked: false, error: err.message };
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────

  async getStatus() {
    if (!this.baseName) return { configured: false };

    const { ethers } = await this._getEthers();
    const { SystemSettings } = await import('../../models/SystemSettings.js');

    const timeoutMs = 15000;
    const withTimeout = (promise, fallback) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]).catch(() => fallback);

    const [expiryInfo, subnames, registration, ownerAddress] = await Promise.all([
      withTimeout(this.getExpiry(this.baseName), { daysUntilExpiry: null }),
      SystemSettings.getSetting('ens.subnames', {}),
      SystemSettings.getSetting(`ens.registered.${this.baseName}`, null),
      withTimeout(this._getOwnerAddress(), null)
    ]);

    // Check forward resolution
    let resolvedAddress = null;
    try {
      const provider = await contractServiceWrapper.getProvider(NETWORK);
      const resolver = new ethers.Contract(ENS_CONTRACTS.PUBLIC_RESOLVER, RESOLVER_ABI, provider);
      const node = this._namehash(ethers, `${this.baseName}.eth`);
      resolvedAddress = await withTimeout(resolver.addr(node), null);
    } catch { /* ignore */ }

    return {
      configured: true,
      baseName: `${this.baseName}.eth`,
      expiry: expiryInfo.expiry,
      daysUntilExpiry: expiryInfo.daysUntilExpiry,
      resolvedAddress,
      ownerAddress,
      registration,
      subnames: Object.entries(subnames).map(([label, data]) => ({
        label,
        ...data
      })),
      autoRenew: await SystemSettings.getSetting('ens.autoRenew', true),
      subnamePrice: await SystemSettings.getSetting('ens.subnamePrice', 0)
    };
  }

  // ─── P2P Subname Request Handling (Genesis Side) ──────────────────────

  /**
   * Check if this instance is the genesis (owns the base ENS name).
   */
  isGenesisENS() {
    return this.isAvailable();
  }

  /**
   * Get the SKYNET price for subname creation.
   * Uses dynamic gas-based pricing if enabled, otherwise falls back to static setting.
   * Returns 0 if no price is configured.
   */
  async getSubnamePrice() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const staticPrice = await SystemSettings.getSetting('ens.subnamePrice', 0);

    // If a static price is explicitly set to a non-zero value, use it
    if (staticPrice > 0) return staticPrice;

    // Otherwise use dynamic gas-based pricing
    try {
      const dynamic = await this.calculateDynamicPrice();
      if (dynamic > 0) return dynamic;
    } catch (err) {
      logger.debug(`ENS dynamic pricing failed, using fallback: ${err.message}`);
    }

    // Fallback: 100 SKYNET
    return 100;
  }

  /**
   * Calculate dynamic ENS subname price based on current ETH gas cost + SKYNET market price.
   *
   * Flow:
   *   1. Get current ETH gas price from Ethereum RPC
   *   2. Estimate total gas for subname creation (~300k gas for setSubnodeRecord + setAddr + transfer)
   *   3. Get ETH/USD from Chainlink or CoinGecko
   *   4. Get SKYNET/USD from PancakeSwap reserves
   *   5. Convert ETH cost → USD → SKYNET, add 25% margin for gas volatility
   *   6. Clamp to [50, 1000] SKYNET range
   *
   * Caches result for 15 minutes.
   *
   * @returns {Promise<number>} Price in SKYNET tokens (whole number)
   */
  async calculateDynamicPrice() {
    // Check cache
    if (this._priceCache && (Date.now() - this._priceCache.ts) < 15 * 60 * 1000) {
      return this._priceCache.price;
    }

    const { ethers } = await this._getEthers();

    // Step 1: Get ETH gas price
    const provider = await contractServiceWrapper.getProvider('ethereum');
    const feeData = await provider.getFeeData();
    const gasPriceWei = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('30', 'gwei');

    // Step 2: Estimate total gas for subname creation
    // setSubnodeRecord: ~120k gas, setAddr: ~50k gas, ownership transfer: ~100k gas
    const ESTIMATED_GAS = 300000n;
    const ethCostWei = gasPriceWei * ESTIMATED_GAS;
    const ethCost = Number(ethers.formatEther(ethCostWei));

    // Step 3: Get ETH/USD price
    let ethUsd = 0;
    try {
      // Try Chainlink ETH/USD on Ethereum mainnet
      const chainlinkEthUsd = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
      const priceFeed = new ethers.Contract(chainlinkEthUsd, [
        'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'
      ], provider);
      const [, answer] = await priceFeed.latestRoundData();
      ethUsd = Number(answer) / 1e8;
    } catch {
      // Fallback: CoinGecko
      try {
        const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const data = await resp.json();
        ethUsd = data?.ethereum?.usd || 0;
      } catch {
        logger.debug('ENS pricing: could not fetch ETH/USD');
      }
    }

    if (ethUsd <= 0) {
      throw new Error('Could not determine ETH/USD price');
    }

    // Step 4: Get SKYNET/USD price from PancakeSwap reserves
    let skynetUsd = 0;
    try {
      const bscProvider = await contractServiceWrapper.getProvider('bsc');
      const SKYNET_TOKEN = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
      const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

      // Get SKYNET/WBNB pair
      const factory = new ethers.Contract(PANCAKE_FACTORY, [
        'function getPair(address, address) view returns (address)'
      ], bscProvider);
      const pairAddr = await factory.getPair(SKYNET_TOKEN, WBNB);

      if (pairAddr !== ethers.ZeroAddress) {
        const pair = new ethers.Contract(pairAddr, [
          'function getReserves() view returns (uint112, uint112, uint32)',
          'function token0() view returns (address)'
        ], bscProvider);

        const [reserve0, reserve1] = await pair.getReserves();
        const token0 = await pair.token0();
        const isSkynetToken0 = token0.toLowerCase() === SKYNET_TOKEN.toLowerCase();

        const skynetReserve = Number(ethers.formatUnits(isSkynetToken0 ? reserve0 : reserve1, 18));
        const wbnbReserve = Number(ethers.formatUnits(isSkynetToken0 ? reserve1 : reserve0, 18));

        if (skynetReserve > 0) {
          const skynetPerBnb = skynetReserve / wbnbReserve;

          // Get BNB/USD from Chainlink on BSC
          let bnbUsd = 0;
          try {
            const chainlinkBnbUsd = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
            const bnbFeed = new ethers.Contract(chainlinkBnbUsd, [
              'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'
            ], bscProvider);
            const [, bnbAnswer] = await bnbFeed.latestRoundData();
            bnbUsd = Number(bnbAnswer) / 1e8;
          } catch {
            // Fallback: CoinGecko
            const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
            const data = await resp.json();
            bnbUsd = data?.binancecoin?.usd || 600;
          }

          skynetUsd = bnbUsd / skynetPerBnb;
        }
      }
    } catch (err) {
      logger.debug(`ENS pricing: SKYNET/USD lookup failed: ${err.message}`);
    }

    if (skynetUsd <= 0) {
      throw new Error('Could not determine SKYNET/USD price');
    }

    // Step 5: Calculate SKYNET price
    const gasCostUsd = ethCost * ethUsd;
    const baseSkynetPrice = gasCostUsd / skynetUsd;

    // Add 25% margin for gas volatility
    const withMargin = baseSkynetPrice * 1.25;

    // Clamp to [50, 1000] range
    const price = Math.max(50, Math.min(1000, Math.round(withMargin)));

    // Cache for 15 minutes
    this._priceCache = { price, ts: Date.now(), gasCostUsd: gasCostUsd.toFixed(2), ethGwei: Number(ethers.formatUnits(gasPriceWei, 'gwei')).toFixed(1) };

    logger.info(`ENS dynamic price: ${price} SKYNET (gas=${this._priceCache.ethGwei} gwei, cost=$${this._priceCache.gasCostUsd}, SKYNET=$${skynetUsd.toFixed(8)})`);

    return price;
  }

  /**
   * Get full pricing details (for API/UI display).
   * @returns {Promise<{price: number, dynamic: boolean, gasCostUsd: string, ethGwei: string}>}
   */
  async getSubnamePriceDetails() {
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const staticPrice = await SystemSettings.getSetting('ens.subnamePrice', 0);

    if (staticPrice > 0) {
      return { price: staticPrice, dynamic: false };
    }

    try {
      const price = await this.calculateDynamicPrice();
      return {
        price,
        dynamic: true,
        gasCostUsd: this._priceCache?.gasCostUsd || '?',
        ethGwei: this._priceCache?.ethGwei || '?'
      };
    } catch {
      return { price: 100, dynamic: false, fallback: true };
    }
  }

  /**
   * Handle an incoming P2P subname request from a forked instance.
   * Called by the message handler on the genesis instance.
   *
   * @param {string} fromFingerprint - The requesting peer
   * @param {object} message - { label, ownerAddress, paymentTxHash? }
   * @param {function} sendFn - P2P send function for replies
   */
  async handleSubnameRequest(fromFingerprint, message, sendFn) {
    const { label, ownerAddress, paymentTxHash } = message;
    const fp = fromFingerprint.slice(0, 8);

    if (!this.isAvailable()) {
      return sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: false,
        error: 'This instance does not manage ENS names'
      });
    }

    if (!label || !ownerAddress) {
      return sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: false,
        error: 'Missing label or ownerAddress'
      });
    }

    // Check if subname already exists
    const { SystemSettings } = await import('../../models/SystemSettings.js');
    const subnames = await SystemSettings.getSetting('ens.subnames', {});
    if (subnames[label]) {
      return sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: false,
        error: `Subname ${label}.${this.baseName}.eth is already taken`,
        requestedLabel: label
      });
    }

    // Check payment if price > 0
    const price = await this.getSubnamePrice();
    if (price > 0) {
      if (!paymentTxHash) {
        // Request payment
        let walletAddress = null;
        let tokenAddress = null;
        try {
          const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
          walletAddress = await skynetExecutor.getRecipientAddress();
          tokenAddress = await skynetExecutor.getSkynetTokenAddress();
        } catch {
          walletAddress = await this._getOwnerAddress();
        }
        return sendFn(fromFingerprint, {
          type: 'ens_subname_payment_required',
          label,
          amount: price,
          currency: 'SKYNET',
          tokenAddress,
          recipientWallet: walletAddress,
          baseName: `${this.baseName}.eth`
        });
      }

      // Verify payment
      try {
        const skynetExecutor = (await import('../p2p/skynetServiceExecutor.js')).default;
        const paymentResult = await skynetExecutor.verifyPayment(
          paymentTxHash, price, fromFingerprint, 'ens_subname'
        );
        if (!paymentResult.success) {
          return sendFn(fromFingerprint, {
            type: 'ens_subname_response',
            success: false,
            error: `Payment verification failed: ${paymentResult.error}`
          });
        }
      } catch (err) {
        return sendFn(fromFingerprint, {
          type: 'ens_subname_response',
          success: false,
          error: `Payment verification error: ${err.message}`
        });
      }
    }

    // Create the subname on-chain
    try {
      logger.info(`Creating ENS subname for peer ${fp}...: ${label}.${this.baseName}.eth → ${ownerAddress.slice(0, 10)}...`);
      const result = await this.createSubname(label, ownerAddress);

      return sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: true,
        name: result.name,
        owner: result.owner,
        txHash: result.txHash,
        paidAmount: price > 0 ? price : 0
      });
    } catch (err) {
      logger.error(`ENS subname creation failed for peer ${fp}...: ${err.message}`);
      return sendFn(fromFingerprint, {
        type: 'ens_subname_response',
        success: false,
        error: `On-chain creation failed: ${err.message}`
      });
    }
  }

  // ─── P2P Subname Request (Fork Side) ──────────────────────────────────

  /**
   * Request a subname from a genesis peer that advertises ens_provider.
   * Called automatically after wallet generation on forked instances.
   *
   * @param {object} p2pService - The P2P service instance
   * @param {string} genesisFingerprint - Genesis peer's fingerprint
   * @param {string} label - Desired subname label (e.g., agent name)
   * @param {string} ownerAddress - The wallet address for the subname
   */
  async requestSubnameFromGenesis(p2pService, genesisFingerprint, label, ownerAddress) {
    logger.info(`Requesting ENS subname ${label} from genesis peer ${genesisFingerprint.slice(0, 8)}...`);

    return p2pService.sendMessage(genesisFingerprint, {
      type: 'ens_subname_request',
      label: label.toLowerCase(),
      ownerAddress
    });
  }

  /**
   * Retry subname request with payment after receiving payment_required.
   */
  async requestSubnameWithPayment(p2pService, genesisFingerprint, label, ownerAddress, paymentTxHash) {
    logger.info(`Retrying ENS subname ${label} with payment tx=${paymentTxHash.slice(0, 10)}...`);

    return p2pService.sendMessage(genesisFingerprint, {
      type: 'ens_subname_request',
      label: label.toLowerCase(),
      ownerAddress,
      paymentTxHash
    });
  }

  /**
   * Auto-pay for subname using SKYNET tokens, then retry the request.
   */
  async autoPayAndRequest(p2pService, genesisFingerprint, label, ownerAddress, paymentInfo) {
    const { amount, tokenAddress, recipientWallet } = paymentInfo;

    try {
      const { ethers } = await this._getEthers();
      const signer = await contractServiceWrapper.getSigner('bsc');
      const token = new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount) returns (bool)'
      ], signer);

      const amountWei = ethers.parseUnits(String(amount), 18);
      const tx = await token.transfer(recipientWallet, amountWei);
      const receipt = await tx.wait();

      logger.info(`ENS subname payment sent: ${amount} SKYNET → ${recipientWallet.slice(0, 10)}... tx=${receipt.hash}`);

      // Wait for confirmations then retry with payment proof
      await new Promise(r => setTimeout(r, 15000));
      return this.requestSubnameWithPayment(p2pService, genesisFingerprint, label, ownerAddress, receipt.hash);
    } catch (err) {
      logger.error(`ENS subname auto-payment failed: ${err.message}`);

      // Save pending request so it can be retried when funds arrive
      try {
        const { SystemSettings } = await import('../../models/SystemSettings.js');
        await SystemSettings.setSetting('ens.pendingSubnameRequest', {
          genesisFingerprint,
          label,
          ownerAddress,
          amount,
          currency: 'SKYNET',
          tokenAddress,
          recipientWallet,
          failedAt: new Date().toISOString(),
          reason: err.message
        }, 'ENS subname request pending — insufficient funds', 'crypto');
        logger.info('ENS subname request saved as pending — will retry when SKYNET balance is sufficient');
      } catch (saveErr) {
        logger.debug(`Failed to save pending ENS request: ${saveErr.message}`);
      }
      return false;
    }
  }

  /**
   * Find a genesis peer that can provide ENS subnames.
   * Looks for peers with ens_provider capability or ERC-8004 verified genesis agent.
   */
  async findGenesisENSProvider(p2pService) {
    try {
      const { peerManager } = await import('../p2p/peerManager.js');
      const peers = await peerManager.getAllPeers();

      for (const peer of peers) {
        // Check for ens_provider capability
        if (peer.capabilities?.some(c => c.name === 'ens_provider')) {
          return peer;
        }
        // Fallback: check for verified ERC-8004 genesis agent (#2930)
        if (peer.erc8004?.verified && peer.erc8004?.agentId === 2930) {
          return peer;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Retry a pending ENS subname request (e.g., after receiving SKYNET funds).
   * Called from scheduler or manually.
   */
  async retryPendingSubnameRequest() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      const pending = await SystemSettings.getSetting('ens.pendingSubnameRequest', null);
      if (!pending) return false;

      // Already have a subname? Clear pending.
      const existing = await SystemSettings.getSetting('ens.mySubname', null);
      if (existing) {
        await SystemSettings.deleteSetting('ens.pendingSubnameRequest');
        return false;
      }

      // Check if genesis peer is online
      const { peerManager } = await import('../p2p/peerManager.js');
      const peer = await peerManager.getPeer(pending.genesisFingerprint);
      if (!peer || !peer.online) {
        logger.debug('ENS pending retry: genesis peer offline');
        return false;
      }

      // Get P2P service
      let p2pService = null;
      try {
        const { default: agent } = await import('../../core/agent.js');
        p2pService = agent?.services?.get('p2p');
      } catch {}
      if (!p2pService) return false;

      logger.info(`Retrying pending ENS subname request: ${pending.label}`);
      await this.autoPayAndRequest(
        p2pService, pending.genesisFingerprint,
        pending.label, pending.ownerAddress,
        { amount: pending.amount, tokenAddress: pending.tokenAddress, recipientWallet: pending.recipientWallet }
      );

      // Clear pending on success (autoPayAndRequest saves it again if it fails)
      // The response handler will clear it when the subname is actually granted
      return true;
    } catch (err) {
      logger.debug(`ENS pending retry failed: ${err.message}`);
      return false;
    }
  }
}

export default new ENSService();
