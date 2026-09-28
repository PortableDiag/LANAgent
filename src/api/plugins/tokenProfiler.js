import { BasePlugin } from '../core/basePlugin.js';
import axios from 'axios';
import NodeCache from 'node-cache';

const tokenCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

const CHAIN_IDS = {
  bsc: '56',
  ethereum: '1'
};

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1/token_security';

/**
 * Token Profiler Plugin
 *
 * Analyzes ERC20 tokens on BSC and Ethereum for scam indicators using
 * the GoPlus Security API. Provides honeypot detection, holder analysis,
 * tax checks, and an overall safety score.
 */
export default class TokenProfilerPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'tokenProfiler';
    this.version = '1.0.0';
    this.description = 'ERC20 token scam analysis for BSC and Ethereum';
    this.category = 'crypto';
    this.commands = [
      {
        command: 'audit',
        description: 'Full token audit with all scam indicators',
        usage: 'audit({ address: "0x...", network: "bsc" })'
      },
      {
        command: 'honeypotCheck',
        description: 'Quick honeypot detection — can you sell?',
        usage: 'honeypotCheck({ address: "0x...", network: "bsc" })'
      },
      {
        command: 'holderAnalysis',
        description: 'Top holder distribution analysis',
        usage: 'holderAnalysis({ address: "0x...", network: "bsc" })'
      },
      {
        command: 'score',
        description: 'Safety score 0-100 based on all checks',
        usage: 'score({ address: "0x...", network: "bsc" })'
      },
      {
        command: 'compare',
        description: 'Compare two tokens on the same network side-by-side',
        usage: 'compare({ addressA: "0x...", addressB: "0x...", network: "bsc" })'
      }
    ];
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'audit':
        return await this.audit(data);
      case 'honeypotCheck':
        return await this.honeypotCheck(data);
      case 'holderAnalysis':
        return await this.holderAnalysis(data);
      case 'score':
        return await this.score(data);
      case 'compare':
        return await this.compare(data);
      default:
        return { success: false, error: `Unknown action: ${action}. Available: audit, honeypotCheck, holderAnalysis, score` };
    }
  }

  /**
   * Fetch token security data from GoPlus, with caching.
   */
  async fetchTokenData(address, network) {
    this.validateParams({ address, network }, {
      address: { required: true, type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      network: { required: true, type: 'string', enum: ['bsc', 'ethereum'] }
    });

    const chainId = CHAIN_IDS[network];
    const normalizedAddress = address.toLowerCase();
    const cacheKey = `goplus_${chainId}_${normalizedAddress}`;

    const cached = tokenCache.get(cacheKey);
    if (cached) {
      this.logger.info(`Cache hit for ${normalizedAddress} on ${network}`);
      return cached;
    }

    const url = `${GOPLUS_BASE}/${chainId}?contract_addresses=${normalizedAddress}`;
    this.logger.info(`Fetching GoPlus data: ${url}`);

    try {
      const response = await axios.get(url, { timeout: 15000 });

      if (response.data?.code !== 1) {
        throw new Error(`GoPlus API error: ${response.data?.message || 'unknown error'}`);
      }

      const tokenData = response.data.result?.[normalizedAddress];
      if (!tokenData) {
        throw new Error(`No data returned for token ${normalizedAddress} on ${network}`);
      }

      tokenCache.set(cacheKey, tokenData);
      return tokenData;
    } catch (error) {
      if (error.response) {
        throw new Error(`GoPlus API HTTP ${error.response.status}: ${error.response.statusText}`);
      }
      throw error;
    }
  }

  /**
   * Full token audit.
   */
  async audit({ address, network }) {
    try {
      const data = await this.fetchTokenData(address, network);

      // null = GoPlus could not tell (unverified source), not "no"
      const known = (v) => v === '0' || v === '1';
      const isHoneypot = known(data.is_honeypot) ? data.is_honeypot === '1' : null;
      const buyTax = parseFloat(data.buy_tax || '0') * 100;
      const sellTax = parseFloat(data.sell_tax || '0') * 100;
      const isOpenSource = data.is_open_source === '1';
      const ownerAddress = data.owner_address || '';
      const ownershipRenounced = ownerAddress === ''
        ? (isOpenSource ? true : null)
        : ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'].includes(ownerAddress.toLowerCase());
      const isMintable = known(data.is_mintable) ? data.is_mintable === '1' : null;
      const canTakeBackOwnership = data.can_take_back_ownership === '1';
      const isProxy = data.is_proxy === '1';
      const holderCount = parseInt(data.holder_count || '0', 10);
      const lpHolderCount = parseInt(data.lp_holder_count || '0', 10);
      const totalSupply = data.total_supply || '0';
      const creatorAddress = data.creator_address || 'unknown';

      // Top holder concentration
      const topHolderPct = this.getTopHolderConcentration(data.holders);

      // Liquidity info
      const liquidityInfo = this.getLiquidityInfo(data);

      // Token age approximation from transfer_count if available
      const transferCount = parseInt(data.transfer_count || '0', 10);

      const flaggedInRegistry = await this.isRegistryFlagged(address);
      const safetyScore = this.calculateScore(data, { flaggedInRegistry });

      return {
        success: true,
        token: address,
        network,
        audit: {
          flaggedInRegistry,
          rating: TokenProfilerPlugin.rating(safetyScore, flaggedInRegistry),
          contractVerified: isOpenSource,
          ownershipRenounced,
          ownerAddress: ownerAddress || 'none',
          isHoneypot,
          buyTax: `${buyTax.toFixed(1)}%`,
          sellTax: `${sellTax.toFixed(1)}%`,
          topHolderConcentration: `${topHolderPct.toFixed(1)}%`,
          liquidityLocked: liquidityInfo.locked,
          liquidityAmount: liquidityInfo.amount,
          isMintable,
          canTakeBackOwnership,
          isProxy,
          holderCount,
          lpHolderCount,
          totalSupply,
          creatorAddress,
          transferCount,
          safetyScore
        }
      };
    } catch (error) {
      this.logger.error(`Audit failed for ${address}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Quick honeypot check.
   */
  async honeypotCheck({ address, network }) {
    try {
      const data = await this.fetchTokenData(address, network);

      const isHoneypot = data.is_honeypot === '1';
      const buyTax = parseFloat(data.buy_tax || '0') * 100;
      const sellTax = parseFloat(data.sell_tax || '0') * 100;
      const cannotSellAll = data.cannot_sell_all === '1';
      const cannotBuy = data.cannot_buy === '1';
      const transferPausable = data.transfer_pausable === '1';

      return {
        success: true,
        token: address,
        network,
        honeypot: {
          isHoneypot,
          cannotBuy,
          cannotSellAll,
          buyTax: `${buyTax.toFixed(1)}%`,
          sellTax: `${sellTax.toFixed(1)}%`,
          transferPausable,
          verdict: isHoneypot ? 'HONEYPOT DETECTED — cannot sell' :
                   sellTax > 50 ? 'HIGH SELL TAX — likely scam' :
                   cannotSellAll ? 'SELL RESTRICTED — partial honeypot' :
                   'Appears tradeable'
        }
      };
    } catch (error) {
      this.logger.error(`Honeypot check failed for ${address}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Holder distribution analysis.
   */
  async holderAnalysis({ address, network }) {
    try {
      const data = await this.fetchTokenData(address, network);

      const holders = data.holders || [];
      const holderCount = parseInt(data.holder_count || '0', 10);
      const creatorAddress = (data.creator_address || '').toLowerCase();
      const ownerAddress = (data.owner_address || '').toLowerCase();

      const topHolders = holders.slice(0, 10).map(h => {
        const addr = (h.address || '').toLowerCase();
        let tag = h.tag || '';
        if (addr === creatorAddress) tag = tag ? `${tag}, creator` : 'creator';
        if (addr === ownerAddress) tag = tag ? `${tag}, owner` : 'owner';
        if (h.is_locked === 1) tag = tag ? `${tag}, locked` : 'locked';
        if (h.is_contract === 1) tag = tag ? `${tag}, contract` : 'contract';

        return {
          address: h.address,
          percent: `${(parseFloat(h.percent || '0') * 100).toFixed(2)}%`,
          tag: tag || 'unknown',
          isLocked: h.is_locked === 1
        };
      });

      const topHolderPct = this.getTopHolderConcentration(holders);
      const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100;

      return {
        success: true,
        token: address,
        network,
        holderAnalysis: {
          totalHolders: holderCount,
          topHolderConcentration: `${topHolderPct.toFixed(1)}%`,
          top10Concentration: `${top10Pct.toFixed(1)}%`,
          topHolders,
          risk: topHolderPct > 50 ? 'HIGH — single holder owns >50%' :
                topHolderPct > 25 ? 'MEDIUM — single holder owns >25%' :
                top10Pct > 80 ? 'MEDIUM — top 10 hold >80%' :
                'LOW'
        }
      };
    } catch (error) {
      this.logger.error(`Holder analysis failed for ${address}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate and return a 0-100 safety score.
   */
  async score({ address, network }) {
    try {
      const data = await this.fetchTokenData(address, network);
      const flaggedInRegistry = await this.isRegistryFlagged(address);
      const safetyScore = this.calculateScore(data, { flaggedInRegistry });

      return {
        success: true,
        token: address,
        network,
        safetyScore: safetyScore.total,
        breakdown: safetyScore.breakdown,
        rating: TokenProfilerPlugin.rating(safetyScore, flaggedInRegistry),
        contractVerified: data.is_open_source === '1',
        flaggedInRegistry
      };
    } catch (error) {
      this.logger.error(`Score calculation failed for ${address}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Compare two tokens on the same network side-by-side. Returns each token's
   * safety score, top-holder concentration, taxes, honeypot/mintable flags,
   * ownership-renounced status, and liquidity info, plus a `winner` field
   * (whichever address scored higher; 'tie' on equal).
   */
  async compare({ addressA, addressB, network, weights }) {
    try {
      this.validateParams({ addressA, addressB, network }, {
        addressA: { required: true, type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        addressB: { required: true, type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
        network:  { required: true, type: 'string', enum: ['bsc', 'ethereum'] }
      });

      const [dataA, dataB] = await Promise.all([
        this.fetchTokenData(addressA, network),
        this.fetchTokenData(addressB, network)
      ]);

      const scoreA = this.calculateScore(dataA, weights);
      const scoreB = this.calculateScore(dataB, weights);

      const topA = this.getTopHolderConcentration(dataA.holders);
      const topB = this.getTopHolderConcentration(dataB.holders);

      const buyTaxA  = parseFloat(dataA.buy_tax  || '0') * 100;
      const sellTaxA = parseFloat(dataA.sell_tax || '0') * 100;
      const buyTaxB  = parseFloat(dataB.buy_tax  || '0') * 100;
      const sellTaxB = parseFloat(dataB.sell_tax || '0') * 100;

      const liqA = this.getLiquidityInfo(dataA);
      const liqB = this.getLiquidityInfo(dataB);

      const isRenounced = (owner) => {
        const o = (owner || '').toLowerCase();
        return o === '' || o === '0x0000000000000000000000000000000000000000' || o === '0x000000000000000000000000000000000000dead';
      };

      const summarize = (addr, data, score, top, buyTax, sellTax, liq) => ({
        address: addr,
        safetyScore: score.total,
        topHolderPercent: `${top.toFixed(1)}%`,
        buyTax: `${buyTax.toFixed(1)}%`,
        sellTax: `${sellTax.toFixed(1)}%`,
        honeypot: data.is_honeypot === '1',
        mintable: data.is_mintable === '1',
        ownershipRenounced: isRenounced(data.owner_address),
        liquidity: { locked: liq.locked, amount: liq.amount }
      });

      const A = summarize(addressA, dataA, scoreA, topA, buyTaxA, sellTaxA, liqA);
      const B = summarize(addressB, dataB, scoreB, topB, buyTaxB, sellTaxB, liqB);
      const winner = scoreA.total === scoreB.total ? 'tie' : (scoreA.total > scoreB.total ? addressA : addressB);

      return { success: true, network, tokens: { A, B }, winner };
    } catch (error) {
      this.logger.error(`Compare failed for ${addressA} vs ${addressB} on ${network}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * Get the largest single-holder percentage from the holders array.
   */
  getTopHolderConcentration(holders) {
    if (!holders || holders.length === 0) return 0;
    return Math.max(...holders.map(h => parseFloat(h.percent || '0'))) * 100;
  }

  /**
   * Extract liquidity information from GoPlus data.
   */
  getLiquidityInfo(data) {
    const lpHolders = data.lp_holders || [];
    const pools = Array.isArray(data.dex) ? data.dex : [];
    let locked = false;
    let lpUsd = 0;

    for (const lp of lpHolders) {
      if (lp.is_locked === 1) {
        locked = true;
      }
      // GoPlus sometimes provides value in USD
      if (lp.value) {
        lpUsd += parseFloat(lp.value || '0');
      }
    }

    // GoPlus lists each DEX pool with its liquidity in USD. This was never read, so a pool
    // holding $0.00007 was not "low liquidity" (2026-09-27, an airdropped token scored 90).
    let dexUsd = 0;
    for (const pool of pools) dexUsd += parseFloat(pool.liquidity || '0') || 0;

    const known = lpUsd > 0 || pools.length > 0;
    const usd = lpUsd > 0 ? lpUsd : dexUsd;

    // Fallback: use lp_total_supply if no USD value
    const lpTotalSupply = data.lp_total_supply || '0';

    return {
      locked,
      usd: known ? usd : null,
      amount: known ? `$${usd.toFixed(2)}` : `${lpTotalSupply} LP tokens`
    };
  }

  /**
   * Calculate safety score 0-100. Higher is safer.
   *
   * Deductions:
   *   Honeypot:              -30 pts
   *   High tax (>10%):       -15 pts
   *   Not open source:       -10 pts
   *   Ownership not renounced:-10 pts
   *   Top holder >50%:       -15 pts
   *   Low liquidity (<$1000): -10 pts
   *   Mintable:              -10 pts
   */
  calculateScore(data, { flaggedInRegistry = false } = {}) {
    let total = 100;
    const breakdown = {};
    const penalize = (key, points, applies) => {
      breakdown[key] = applies ? -points : 0;
      if (applies) total -= points;
    };
    // GoPlus answers "0"/"1" for what it could check and nothing for what it could not (an
    // unverified contract comes back with every field empty). Unknown is not safe.
    const isOpenSource = data.is_open_source === '1';

    // Honeypot: confirmed (-30), or unknown (-15)
    penalize('honeypot', 30, data.is_honeypot === '1');
    penalize('honeypotUnknown', 15, data.is_honeypot !== '1' && data.is_honeypot !== '0');

    // Tax check (-15)
    const buyTax = parseFloat(data.buy_tax || '0') * 100;
    const sellTax = parseFloat(data.sell_tax || '0') * 100;
    penalize('highTax', 15, Math.max(buyTax, sellTax) > 10);

    // Open source check (-10)
    penalize('notOpenSource', 10, !isOpenSource);

    // Ownership (-10). An empty owner means "no owner function" only when GoPlus could read
    // the source; for an unverified contract it means nobody knows.
    const ownerAddress = String(data.owner_address || '').toLowerCase();
    const renounced = ownerAddress === '0x0000000000000000000000000000000000000000' ||
      ownerAddress === '0x000000000000000000000000000000000000dead' ||
      (ownerAddress === '' && isOpenSource);
    penalize('ownershipNotRenounced', 10, ownerAddress !== '' && !renounced);
    penalize('ownershipUnknown', 10, ownerAddress === '' && !isOpenSource);

    // Top holder concentration (-15)
    penalize('topHolderConcentration', 15, this.getTopHolderConcentration(data.holders) > 50);

    // Liquidity: none to speak of (-25) or low (-10)
    const liquidity = this.getLiquidityInfo(data);
    penalize('noMarket', 25, liquidity.usd !== null && liquidity.usd < 10);
    penalize('lowLiquidity', 10, liquidity.usd !== null && liquidity.usd >= 10 && liquidity.usd < 1000);

    // Sent to a crowd with nothing to sell into: the shape of an airdrop lure (-20)
    const holders = parseInt(data.holder_count || '0', 10);
    penalize('massAirdropNoMarket', 20, holders >= 10000 && liquidity.usd !== null && liquidity.usd < 100);

    // Mintable check (-10)
    penalize('mintable', 10, data.is_mintable === '1');

    // Reported in the on-chain scammer registry: that is the verdict
    if (flaggedInRegistry) {
      breakdown.scammerRegistry = -Math.max(total, 0);
      total = 0;
    }

    return { total: Math.max(total, 0), breakdown };
  }

  /** Rating label for a score; a registry hit is named as such. */
  static rating(safetyScore, flaggedInRegistry = false) {
    if (flaggedInRegistry) return 'SCAM (reported in the scammer registry)';
    const t = safetyScore.total;
    return t >= 80 ? 'SAFE' : t >= 60 ? 'CAUTION' : t >= 40 ? 'RISKY' : 'DANGEROUS';
  }

  /** Our synced copy of the on-chain scammer registry (no network call). */
  async isRegistryFlagged(address) {
    try {
      const registry = (await import('../../services/crypto/scammerRegistryService.js')).default;
      return registry.isAddressFlagged(address);
    } catch {
      return false;
    }
  }
}
