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

      const isHoneypot = data.is_honeypot === '1';
      const buyTax = parseFloat(data.buy_tax || '0') * 100;
      const sellTax = parseFloat(data.sell_tax || '0') * 100;
      const isOpenSource = data.is_open_source === '1';
      const ownerAddress = data.owner_address || '';
      const ownershipRenounced = ownerAddress === '' || ownerAddress === '0x0000000000000000000000000000000000000000' || ownerAddress === '0x000000000000000000000000000000000000dead';
      const isMintable = data.is_mintable === '1';
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

      const safetyScore = this.calculateScore(data);

      return {
        success: true,
        token: address,
        network,
        audit: {
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
      const safetyScore = this.calculateScore(data);

      return {
        success: true,
        token: address,
        network,
        safetyScore: safetyScore.total,
        breakdown: safetyScore.breakdown,
        rating: safetyScore.total >= 80 ? 'SAFE' :
                safetyScore.total >= 60 ? 'CAUTION' :
                safetyScore.total >= 40 ? 'RISKY' :
                'DANGEROUS'
      };
    } catch (error) {
      this.logger.error(`Score calculation failed for ${address}: ${error.message}`);
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
    let locked = false;
    let totalLiquidityUsd = 0;

    for (const lp of lpHolders) {
      if (lp.is_locked === 1) {
        locked = true;
      }
      // GoPlus sometimes provides value in USD
      if (lp.value) {
        totalLiquidityUsd += parseFloat(lp.value || '0');
      }
    }

    // Fallback: use lp_total_supply if no USD value
    const lpTotalSupply = data.lp_total_supply || '0';

    return {
      locked,
      amount: totalLiquidityUsd > 0 ? `$${totalLiquidityUsd.toFixed(2)}` : `${lpTotalSupply} LP tokens`
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
  calculateScore(data) {
    let total = 100;
    const breakdown = {};

    // Honeypot check (-30)
    const isHoneypot = data.is_honeypot === '1';
    if (isHoneypot) {
      total -= 30;
      breakdown.honeypot = -30;
    } else {
      breakdown.honeypot = 0;
    }

    // Tax check (-15)
    const buyTax = parseFloat(data.buy_tax || '0') * 100;
    const sellTax = parseFloat(data.sell_tax || '0') * 100;
    const maxTax = Math.max(buyTax, sellTax);
    if (maxTax > 10) {
      total -= 15;
      breakdown.highTax = -15;
    } else {
      breakdown.highTax = 0;
    }

    // Open source check (-10)
    const isOpenSource = data.is_open_source === '1';
    if (!isOpenSource) {
      total -= 10;
      breakdown.notOpenSource = -10;
    } else {
      breakdown.notOpenSource = 0;
    }

    // Ownership check (-10)
    const ownerAddress = data.owner_address || '';
    const ownershipRenounced = ownerAddress === '' ||
      ownerAddress === '0x0000000000000000000000000000000000000000' ||
      ownerAddress === '0x000000000000000000000000000000000000dead';
    if (!ownershipRenounced) {
      total -= 10;
      breakdown.ownershipNotRenounced = -10;
    } else {
      breakdown.ownershipNotRenounced = 0;
    }

    // Top holder concentration (-15)
    const topHolderPct = this.getTopHolderConcentration(data.holders);
    if (topHolderPct > 50) {
      total -= 15;
      breakdown.topHolderConcentration = -15;
    } else {
      breakdown.topHolderConcentration = 0;
    }

    // Liquidity check (-10)
    const liquidityInfo = this.getLiquidityInfo(data);
    // Only penalize if we have USD data and it is below threshold
    const usdMatch = liquidityInfo.amount.match(/^\$([0-9.]+)/);
    if (usdMatch && parseFloat(usdMatch[1]) < 1000) {
      total -= 10;
      breakdown.lowLiquidity = -10;
    } else {
      breakdown.lowLiquidity = 0;
    }

    // Mintable check (-10)
    const isMintable = data.is_mintable === '1';
    if (isMintable) {
      total -= 10;
      breakdown.mintable = -10;
    } else {
      breakdown.mintable = 0;
    }

    return { total: Math.max(total, 0), breakdown };
  }
}
