import { logger } from '../../utils/logger.js';
import LPPosition from '../../models/LPPosition.js';
import swapService from './swapService.js';
import contractServiceWrapper from './contractServiceWrapper.js';

// PancakeSwap V3 contract addresses on BSC
const V3_POSITION_MANAGER = {
  bsc: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  ethereum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
};

const V3_FACTORY = {
  bsc: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  ethereum: '0x1F98431c8aD98523631AE4a59f267346ea31F984'
};

const POSITION_MANAGER_ABI = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function burn(uint256 tokenId) external payable',
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)'
];

const V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function fee() external view returns (uint24)'
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

/**
 * LPManager - Manages liquidity provider positions.
 *
 * Responsibilities:
 * - Track LP positions across V2 pools
 * - Add/remove liquidity through swapService
 * - Refresh position data (reserves, share %, value)
 * - Provide stats for the Web UI
 */
class LPManager {
  /**
   * Get all tracked LP positions
   */
  async getPositions() {
    return LPPosition.getActivePositions();
  }

  /**
   * Get a specific position by pair address
   */
  async getPosition(pairAddress, network = 'bsc') {
    return LPPosition.findByPair(pairAddress.toLowerCase(), network);
  }

  /**
   * Refresh on-chain data for a position
   */
  async refreshPosition(pairAddress, network = 'bsc') {
    const position = await LPPosition.findByPair(pairAddress.toLowerCase(), network);
    if (!position) return null;

    try {
      const info = await swapService.getLPInfo(
        position.tokenA.address,
        position.tokenB.address,
        network
      );
      if (!info) return position;

      position.reserveA = info.reserve0;
      position.reserveB = info.reserve1;
      position.totalSupply = info.totalSupply;
      position.lpBalance = info.lpBalance;

      const totalSupplyNum = parseFloat(info.totalSupply);
      const lpBalanceNum = parseFloat(info.lpBalance);
      position.sharePercent = totalSupplyNum > 0 ? (lpBalanceNum / totalSupplyNum) * 100 : 0;
      position.active = lpBalanceNum > 0;
      position.lastUpdated = new Date();

      await position.save();
      return position;
    } catch (err) {
      logger.error(`Failed to refresh LP position ${pairAddress}: ${err.message}`);
      return position;
    }
  }

  /**
   * Refresh all active positions
   */
  async refreshAll() {
    const positions = await LPPosition.find({ active: true });
    const results = [];
    for (const pos of positions) {
      try {
        const refreshed = await this.refreshPosition(pos.pairAddress, pos.network);
        results.push(refreshed);
      } catch (err) {
        logger.error(`Failed to refresh position ${pos.pairAddress}: ${err.message}`);
        results.push(pos);
      }
    }
    return results;
  }

  /**
   * Add liquidity to a V2 pool and track the position
   */
  async addLiquidity(tokenA, tokenB, amountA, amountB, slippage = 1, network = 'bsc') {
    const result = await swapService.addLiquidity(tokenA, tokenB, amountA, amountB, slippage, network);

    // Get updated LP info
    const info = await swapService.getLPInfo(tokenA, tokenB, network);
    if (!info) {
      logger.warn('Could not get LP info after adding liquidity');
      return result;
    }

    // Upsert position
    let position = await LPPosition.findByPair(info.pairAddress.toLowerCase(), network);
    if (!position) {
      position = new LPPosition({
        pairAddress: info.pairAddress.toLowerCase(),
        network,
        tokenA: info.tokenA,
        tokenB: info.tokenB,
        protocol: 'v2'
      });
    }

    position.lpBalance = info.lpBalance;
    position.reserveA = info.reserve0;
    position.reserveB = info.reserve1;
    position.totalSupply = info.totalSupply;
    const totalSupplyNum = parseFloat(info.totalSupply);
    const lpBalanceNum = parseFloat(info.lpBalance);
    position.sharePercent = totalSupplyNum > 0 ? (lpBalanceNum / totalSupplyNum) * 100 : 0;
    position.active = true;
    position.lastUpdated = new Date();

    position.transactions.push({
      type: 'add',
      txHash: result.txHash,
      lpAmount: info.lpBalance,
      amountA: amountA.toString(),
      amountB: amountB.toString()
    });

    await position.save();
    logger.info(`LP position tracked: ${info.tokenA.symbol}/${info.tokenB.symbol} on ${network} (${position.sharePercent.toFixed(4)}% share)`);

    return { ...result, position };
  }

  /**
   * Remove liquidity from a V2 pool
   */
  async removeLiquidity(tokenA, tokenB, lpAmount, slippage = 1, network = 'bsc') {
    const result = await swapService.removeLiquidity(tokenA, tokenB, lpAmount, slippage, network);

    // Refresh position
    const info = await swapService.getLPInfo(tokenA, tokenB, network);
    if (info) {
      const position = await LPPosition.findByPair(info.pairAddress.toLowerCase(), network);
      if (position) {
        position.lpBalance = info.lpBalance;
        position.reserveA = info.reserve0;
        position.reserveB = info.reserve1;
        position.totalSupply = info.totalSupply;
        const totalSupplyNum = parseFloat(info.totalSupply);
        const lpBalanceNum = parseFloat(info.lpBalance);
        position.sharePercent = totalSupplyNum > 0 ? (lpBalanceNum / totalSupplyNum) * 100 : 0;
        position.active = lpBalanceNum > 0;
        position.lastUpdated = new Date();

        position.transactions.push({
          type: 'remove',
          txHash: result.txHash,
          lpAmount: typeof lpAmount === 'string' ? lpAmount : lpAmount.toString()
        });

        await position.save();
      }
    }

    return result;
  }

  // ==================== V3 CONCENTRATED LIQUIDITY ====================

  /**
   * Add concentrated liquidity to a V3 pool via NonfungiblePositionManager.mint()
   * @param {string} tokenA - Token A address
   * @param {string} tokenB - Token B address
   * @param {number|string} amountA - Amount of token A
   * @param {number|string} amountB - Amount of token B
   * @param {number} feeTier - Fee tier in bps (100, 500, 2500, 10000)
   * @param {number} rangePercent - Price range as % around current price (e.g., 10 = ±10%)
   * @param {string} network - Network (bsc, ethereum)
   */
  async addLiquidityV3(tokenA, tokenB, amountA, amountB, feeTier = 2500, rangePercent = 10, network = 'bsc') {
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(network);
    const signer = await contractServiceWrapper.getSigner(network);

    const posManagerAddr = V3_POSITION_MANAGER[network];
    const factoryAddr = V3_FACTORY[network];
    if (!posManagerAddr || !factoryAddr) throw new Error(`V3 not available on ${network}`);

    // Sort tokens (V3 requires token0 < token1)
    const [token0, token1, amount0, amount1] = tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB, amountA, amountB]
      : [tokenB, tokenA, amountB, amountA];

    // Get pool and current tick
    const factory = new ethers.Contract(factoryAddr, V3_FACTORY_ABI, provider);
    const poolAddr = await factory.getPool(token0, token1, feeTier);
    if (!poolAddr || poolAddr === ethers.ZeroAddress) {
      throw new Error(`No V3 pool for ${token0}/${token1} fee=${feeTier}`);
    }

    const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
    const slot0 = await pool.slot0();
    const currentTick = Number(slot0.tick);

    // Calculate tick range based on rangePercent
    const tickSpacing = this._getTickSpacing(feeTier);
    const rangeTicks = Math.ceil(Math.log(1 + rangePercent / 100) / Math.log(1.0001));
    const tickLower = Math.floor((currentTick - rangeTicks) / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil((currentTick + rangeTicks) / tickSpacing) * tickSpacing;

    // Parse amounts
    const dec0 = await this._getDecimals(token0, provider);
    const dec1 = await this._getDecimals(token1, provider);
    const amount0Wei = ethers.parseUnits(amount0.toString(), dec0);
    const amount1Wei = ethers.parseUnits(amount1.toString(), dec1);

    // Approve tokens to position manager
    await this._approveToken(token0, posManagerAddr, amount0Wei, signer);
    await this._approveToken(token1, posManagerAddr, amount1Wei, signer);

    // Mint position
    const posManager = new ethers.Contract(posManagerAddr, POSITION_MANAGER_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const tx = await posManager.mint({
      token0, token1,
      fee: feeTier,
      tickLower, tickUpper,
      amount0Desired: amount0Wei,
      amount1Desired: amount1Wei,
      amount0Min: 0, // Accept any amount (slippage handled by range)
      amount1Min: 0,
      recipient: await signer.getAddress(),
      deadline
    });

    const receipt = await tx.wait();
    logger.info(`V3 LP minted: tx=${receipt.hash}, block=${receipt.blockNumber}`);

    // Extract tokenId from mint event (Transfer event from NFT)
    let tokenId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = posManager.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === 'IncreaseLiquidity') {
          tokenId = parsed.args.tokenId.toString();
          break;
        }
      } catch { /* not our event */ }
    }

    // If we couldn't parse IncreaseLiquidity, try Transfer event
    if (!tokenId) {
      const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === posManagerAddr.toLowerCase() && log.topics[0] === TRANSFER_TOPIC) {
          tokenId = ethers.toBigInt(log.topics[3]).toString();
          break;
        }
      }
    }

    // Get token symbols
    const sym0 = await this._getSymbol(token0, provider);
    const sym1 = await this._getSymbol(token1, provider);

    // Upsert position (reuse existing record if pool was used before)
    let position = await LPPosition.findOne({ pairAddress: poolAddr.toLowerCase(), network });
    if (!position) {
      position = new LPPosition({
        pairAddress: poolAddr.toLowerCase(),
        network,
        tokenA: { address: token0, symbol: sym0, decimals: dec0 },
        tokenB: { address: token1, symbol: sym1, decimals: dec1 },
        protocol: 'v3',
      });
    }
    position.active = true;
    position.v3 = {
      ...position.v3,
      tokenId,
      tickLower,
      tickUpper,
      feeTier,
      inRange: currentTick >= tickLower && currentTick < tickUpper,
      liquidity: '0',
    };
    position.transactions.push({
      type: 'add',
      txHash: receipt.hash,
      amountA: amount0.toString(),
      amountB: amount1.toString()
    });
    await position.save();

    logger.info(`V3 LP position tracked: ${sym0}/${sym1} fee=${feeTier} range=[${tickLower},${tickUpper}] tokenId=${tokenId}`);
    return { txHash: receipt.hash, tokenId, tickLower, tickUpper, position };
  }

  /**
   * Remove liquidity from a V3 position
   */
  async removeLiquidityV3(tokenId, percentToRemove = 100, network = 'bsc') {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(network);
    const posManagerAddr = V3_POSITION_MANAGER[network];
    const posManager = new ethers.Contract(posManagerAddr, POSITION_MANAGER_ABI, signer);

    // Get current position
    const pos = await posManager.positions(tokenId);
    const liquidity = pos.liquidity;
    if (liquidity === 0n) throw new Error('Position has no liquidity');

    const liquidityToRemove = (liquidity * BigInt(percentToRemove)) / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // Decrease liquidity
    const tx = await posManager.decreaseLiquidity({
      tokenId,
      liquidity: liquidityToRemove,
      amount0Min: 0,
      amount1Min: 0,
      deadline
    });
    const receipt = await tx.wait();

    // Collect tokens
    const collectTx = await posManager.collect({
      tokenId,
      recipient: await signer.getAddress(),
      amount0Max: (2n ** 128n - 1n),
      amount1Max: (2n ** 128n - 1n)
    });
    await collectTx.wait();

    // Update DB position
    const dbPos = await LPPosition.findOne({ 'v3.tokenId': tokenId.toString(), network });
    if (dbPos) {
      if (percentToRemove >= 100) {
        dbPos.active = false;
        dbPos.v3.liquidity = '0';
      } else {
        const remainingLiquidity = liquidity - liquidityToRemove;
        dbPos.v3.liquidity = remainingLiquidity.toString();
      }
      dbPos.transactions.push({ type: 'remove', txHash: receipt.hash });
      dbPos.lastUpdated = new Date();
      await dbPos.save();
    }

    logger.info(`V3 LP removed: tokenId=${tokenId}, ${percentToRemove}%, tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  /**
   * Collect accumulated fees from a V3 position
   */
  async collectFeesV3(tokenId, network = 'bsc') {
    const { ethers } = await import('ethers');
    const signer = await contractServiceWrapper.getSigner(network);
    const posManagerAddr = V3_POSITION_MANAGER[network];
    const posManager = new ethers.Contract(posManagerAddr, POSITION_MANAGER_ABI, signer);

    // Check pending fees before spending gas — tokensOwed is a free view call
    const pos = await posManager.positions(tokenId);
    const owed0 = BigInt(pos.tokensOwed0);
    const owed1 = BigInt(pos.tokensOwed1);
    if (owed0 === 0n && owed1 === 0n) {
      logger.debug(`V3 fee collect skipped: tokenId=${tokenId}, no pending fees`);
      return { txHash: null, success: true, skipped: true, reason: 'no_pending_fees' };
    }

    const tx = await posManager.collect({
      tokenId,
      recipient: await signer.getAddress(),
      amount0Max: (2n ** 128n - 1n),
      amount1Max: (2n ** 128n - 1n)
    });
    const receipt = await tx.wait();

    // Update collected fees in DB
    const dbPos = await LPPosition.findOne({ 'v3.tokenId': tokenId.toString(), network });
    if (dbPos) {
      dbPos.lastUpdated = new Date();
      await dbPos.save();
    }

    logger.info(`V3 fees collected: tokenId=${tokenId}, owed0=${owed0}, owed1=${owed1}, tx=${receipt.hash}`);
    return { txHash: receipt.hash, success: true };
  }

  /**
   * Check if a V3 position is in range and rebalance if needed
   */
  async checkAndRebalanceV3(tokenId, rangePercent = 10, network = 'bsc') {
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(network);
    const posManagerAddr = V3_POSITION_MANAGER[network];
    const posManager = new ethers.Contract(posManagerAddr, POSITION_MANAGER_ABI, provider);

    const pos = await posManager.positions(tokenId);
    const poolAddr = await this._getV3PoolAddress(pos.token0, pos.token1, Number(pos.fee), network);
    if (!poolAddr) return { rebalanced: false, reason: 'Pool not found' };

    const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, provider);
    const slot0 = await pool.slot0();
    const currentTick = Number(slot0.tick);
    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const inRange = currentTick >= tickLower && currentTick < tickUpper;

    // Update in-range status
    const dbPos = await LPPosition.findOne({ 'v3.tokenId': tokenId.toString(), network });
    if (dbPos) {
      dbPos.v3.inRange = inRange;
      await dbPos.save();
    }

    if (inRange) {
      return { rebalanced: false, reason: 'Position is in range', currentTick, tickLower, tickUpper };
    }

    // Position out of range — needs rebalance
    logger.info(`V3 position ${tokenId} out of range (tick=${currentTick}, range=[${tickLower},${tickUpper}]). Rebalancing...`);

    // 1. Remove all liquidity and collect
    await this.removeLiquidityV3(tokenId, 100, network);
    await this.collectFeesV3(tokenId, network);

    // 2. Get token balances and re-add with new range centered on current tick
    // The caller should re-add liquidity with new range
    return {
      rebalanced: true,
      reason: 'Position removed. Re-add liquidity with new range.',
      currentTick,
      oldRange: [tickLower, tickUpper]
    };
  }

  // V3 helper methods

  _getTickSpacing(feeTier) {
    const spacings = { 100: 1, 500: 10, 2500: 50, 10000: 200 };
    return spacings[feeTier] || 50;
  }

  async _getV3PoolAddress(token0, token1, feeTier, network) {
    const { ethers } = await import('ethers');
    const provider = await contractServiceWrapper.getProvider(network);
    const factoryAddr = V3_FACTORY[network];
    if (!factoryAddr) return null;
    const factory = new ethers.Contract(factoryAddr, V3_FACTORY_ABI, provider);
    const pool = await factory.getPool(token0, token1, feeTier);
    return pool && pool !== ethers.ZeroAddress ? pool : null;
  }

  async _getDecimals(tokenAddr, provider) {
    const { ethers } = await import('ethers');
    try {
      const contract = new ethers.Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
      return Number(await contract.decimals());
    } catch {
      return 18;
    }
  }

  async _getSymbol(tokenAddr, provider) {
    const { ethers } = await import('ethers');
    try {
      const contract = new ethers.Contract(tokenAddr, ['function symbol() view returns (string)'], provider);
      return await contract.symbol();
    } catch {
      return tokenAddr.slice(0, 8);
    }
  }

  async _approveToken(tokenAddr, spender, amount, signer) {
    const { ethers } = await import('ethers');
    const token = new ethers.Contract(tokenAddr, [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)'
    ], signer);
    const current = await token.allowance(await signer.getAddress(), spender);
    if (current < amount) {
      const tx = await token.approve(spender, ethers.MaxUint256);
      await tx.wait();
    }
  }

  /**
   * Get summary stats across all positions
   */
  async getStats() {
    const positions = await LPPosition.find({ active: true });
    return {
      totalPositions: positions.length,
      positions: positions.map(p => ({
        pair: `${p.tokenA.symbol}/${p.tokenB.symbol}`,
        pairAddress: p.pairAddress,
        network: p.network,
        protocol: p.protocol,
        lpBalance: p.lpBalance,
        sharePercent: p.sharePercent,
        reserveA: p.reserveA,
        reserveB: p.reserveB,
        active: p.active,
        lastUpdated: p.lastUpdated,
        txCount: p.transactions.length
      }))
    };
  }
}

export default new LPManager();
