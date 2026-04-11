import { Router } from 'express';
import NodeCache from 'node-cache';
import axios from 'axios';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import ExternalPayment from '../../../models/ExternalPayment.js';
import { creditAuth } from '../middleware/creditAuth.js';

const router = Router();

// Price cache — 5 minute TTL
const priceCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Double-spend prevention cache (also checked in DB)
const usedTxHashes = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// SKYNET token on BSC
const SKYNET_TOKEN = '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Fetch BNB price in USD
 * Try Chainlink on-chain oracle first, fallback to CoinGecko API
 */
async function getBnbPriceUsd() {
  const cached = priceCache.get('bnbPriceUsd');
  if (cached !== undefined) return cached;

  // Try Chainlink BNB/USD on BSC
  try {
    const contractService = (await import('../../../services/crypto/contractServiceWrapper.js')).default;
    const provider = await contractService.getProvider('bsc');
    const { ethers } = await import('ethers');

    // Chainlink BNB/USD price feed on BSC
    const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
    const aggregatorAbi = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];
    const priceFeed = new ethers.Contract(CHAINLINK_BNB_USD, aggregatorAbi, provider);

    const [, answer] = await retryOperation(
      () => priceFeed.latestRoundData(),
      { retries: 2, context: 'Chainlink BNB/USD' }
    );

    // Chainlink returns 8 decimals for BNB/USD
    const price = Number(answer) / 1e8;
    if (price > 0) {
      priceCache.set('bnbPriceUsd', price);
      return price;
    }
  } catch (err) {
    logger.warn('Chainlink BNB/USD failed, falling back to CoinGecko:', err.message);
  }

  // Fallback: CoinGecko API
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
      { timeout: 10000 }
    );
    const price = response.data?.binancecoin?.usd;
    if (price && price > 0) {
      priceCache.set('bnbPriceUsd', price);
      return price;
    }
  } catch (err) {
    logger.warn('CoinGecko BNB price failed:', err.message);
  }

  // Use stale price if available
  const stale = priceCache.get('bnbPriceUsd');
  if (stale) return stale;

  throw new Error('Unable to fetch BNB price');
}

/**
 * Fetch SKYNET price in USD via DexScreener
 */
async function getSkynetPriceUsd() {
  const cached = priceCache.get('skynetPriceUsd');
  if (cached !== undefined) return cached;

  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${SKYNET_TOKEN}`,
      { timeout: 10000 }
    );

    const pairs = response.data?.pairs;
    if (pairs && pairs.length > 0) {
      // Use the pair with highest liquidity
      const bestPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const price = parseFloat(bestPair.priceUsd);
      if (price > 0) {
        priceCache.set('skynetPriceUsd', price);
        return price;
      }
    }
  } catch (err) {
    logger.warn('DexScreener SKYNET price failed:', err.message);
  }

  // Fallback: calculate from PancakeSwap V2 LP pair reserves on-chain
  try {
    const { ethers } = await import('ethers');
    const provider = await (await import('../../../services/crypto/contractServiceWrapper.js')).default.getProvider('bsc');
    // Get pair address from factory
    const factory = new ethers.Contract('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      ['function getPair(address,address) view returns (address)'], provider);
    const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const pairAddr = await factory.getPair(SKYNET_TOKEN, WBNB);

    if (pairAddr && pairAddr !== ethers.ZeroAddress) {
      const pair = new ethers.Contract(pairAddr,
        ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'], provider);
      const [r0, r1] = await pair.getReserves();
      const token0 = await pair.token0();
      const isT0BNB = token0.toLowerCase() === WBNB.toLowerCase();
      const bnbReserve = parseFloat(ethers.formatEther(isT0BNB ? r0 : r1));
      const skynetReserve = parseFloat(ethers.formatUnits(isT0BNB ? r1 : r0, 18));

      if (skynetReserve > 0 && bnbReserve > 0) {
        const bnbPrice = await getBnbPriceUsd();
        const skynetPriceUsd = (bnbReserve / skynetReserve) * bnbPrice;
        if (skynetPriceUsd > 0) {
          priceCache.set('skynetPriceUsd', skynetPriceUsd);
          logger.info(`SKYNET price from LP reserves: $${skynetPriceUsd.toFixed(8)}`);
          return skynetPriceUsd;
        }
      }
    }
  } catch (err) {
    logger.warn('LP reserve SKYNET price fallback failed:', err.message);
  }

  // Use stale price if available
  const stale = priceCache.get('skynetPriceUsd');
  if (stale) return stale;

  throw new Error('Unable to fetch SKYNET price');
}

/**
 * GET /api/external/credits/price
 * Return current credit prices in BNB and SKYNET (no auth required)
 */
router.get('/price', async (req, res) => {
  try {
    const [bnbPrice, skynetPrice] = await Promise.allSettled([
      getBnbPriceUsd(),
      getSkynetPriceUsd()
    ]);

    const recipient = await getRecipientAddress();

    const result = {
      success: true,
      recipientAddress: recipient,
      network: 'bsc',
      chainId: 56,
      minimumCredits: 10,
      creditValueUsd: 0.01,
      pricePerCredit: {},
      acceptedCurrencies: ['BNB'],
      skynetTokenAddress: SKYNET_TOKEN,
      purchaseEndpoint: '/api/external/credits/purchase',
      updatedAt: new Date().toISOString()
    };

    if (bnbPrice.status === 'fulfilled') {
      result.bnbPrice = bnbPrice.value;
      result.pricePerCredit.bnb = (0.01 / bnbPrice.value).toFixed(10);
      result.acceptedCurrencies = ['BNB', 'SKYNET'];
    }

    if (skynetPrice.status === 'fulfilled') {
      result.skynetPrice = skynetPrice.value;
      result.pricePerCredit.skynet = (0.01 / skynetPrice.value).toFixed(10);
    }

    if (!result.pricePerCredit.bnb && !result.pricePerCredit.skynet) {
      return res.status(503).json({ success: false, error: 'Price feeds unavailable' });
    }

    res.json(result);
  } catch (error) {
    logger.error('Price endpoint error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch prices' });
  }
});

/**
 * GET /api/external/credits/balance
 * Return credit balance for authenticated user
 */
router.get('/balance', creditAuth(true), async (req, res) => {
  try {
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    if (!account) {
      return res.json({
        success: true,
        credits: 0,
        totalPurchased: 0,
        totalSpent: 0,
        totalRefunded: 0
      });
    }

    res.json({
      success: true,
      credits: account.credits,
      totalPurchased: account.totalPurchased,
      totalSpent: account.totalSpent,
      totalRefunded: account.totalRefunded
    });
  } catch (error) {
    logger.error('Balance endpoint error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch balance' });
  }
});

/**
 * Get recipient wallet address for receiving payments
 */
async function getRecipientAddress() {
  try {
    const walletService = (await import('../../../services/crypto/walletService.js')).default;
    const info = await walletService.getWalletInfo();
    if (!info.initialized || !info.addresses) return null;
    const bscAddr = info.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth');
    return bscAddr?.address || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/external/credits/purchase
 * Purchase credits with BNB or SKYNET on-chain transaction
 */
router.post('/purchase', creditAuth(true), async (req, res) => {
  try {
    const { txHash, currency } = req.body;

    if (!txHash || !currency) {
      return res.status(400).json({ success: false, error: 'txHash and currency are required' });
    }

    if (!['BNB', 'SKYNET'].includes(currency.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'currency must be BNB or SKYNET' });
    }

    const normalizedCurrency = currency.toUpperCase();

    // Double-spend check (in-memory)
    if (usedTxHashes.get(txHash)) {
      return res.status(409).json({ success: false, error: 'Transaction already used' });
    }

    // Double-spend check (database)
    const existing = await ExternalPayment.findOne({ txHash });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Transaction already used' });
    }

    const recipient = await getRecipientAddress();
    if (!recipient) {
      return res.status(500).json({ success: false, error: 'Payment recipient not configured' });
    }

    // Verify on-chain
    const contractService = (await import('../../../services/crypto/contractServiceWrapper.js')).default;
    const provider = await contractService.getProvider('bsc');
    const { ethers } = await import('ethers');

    const tx = await retryOperation(
      () => provider.getTransaction(txHash),
      { retries: 2, context: `getTransaction(${txHash})` }
    );

    if (!tx) {
      return res.status(400).json({ success: false, error: 'Transaction not found on-chain' });
    }

    const receipt = await retryOperation(
      () => provider.getTransactionReceipt(txHash),
      { retries: 2, context: `getReceipt(${txHash})` }
    );

    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ success: false, error: 'Transaction failed or not yet confirmed' });
    }

    // Check confirmations
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;
    const requiredConfirmations = normalizedCurrency === 'SKYNET' ? 3 : 1;

    if (confirmations < requiredConfirmations) {
      return res.status(400).json({
        success: false,
        error: `Insufficient confirmations: ${confirmations}/${requiredConfirmations}. Please wait and retry.`
      });
    }

    let amountPaid;
    let pricePerUnit;

    if (normalizedCurrency === 'BNB') {
      // Verify recipient for BNB native transfer
      if (tx.to?.toLowerCase() !== recipient.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Transaction recipient does not match' });
      }

      amountPaid = parseFloat(ethers.formatEther(tx.value));
      const bnbPrice = await getBnbPriceUsd();
      pricePerUnit = bnbPrice;

    } else {
      // SKYNET: parse Transfer event logs
      const transferLog = receipt.logs.find(log => {
        return log.address?.toLowerCase() === SKYNET_TOKEN.toLowerCase()
          && log.topics[0] === ERC20_TRANSFER_TOPIC
          && log.topics.length >= 3;
      });

      if (!transferLog) {
        return res.status(400).json({ success: false, error: 'No SKYNET transfer found in transaction' });
      }

      // Decode recipient from topics[2]
      const logRecipient = '0x' + transferLog.topics[2].slice(26);
      if (logRecipient.toLowerCase() !== recipient.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'SKYNET transfer recipient does not match' });
      }

      // Decode amount (SKYNET is 18 decimals)
      amountPaid = parseFloat(ethers.formatEther(transferLog.data));
      const skynetPrice = await getSkynetPriceUsd();
      pricePerUnit = skynetPrice;
    }

    // Calculate credits: (amountPaid * pricePerUnit) / 0.01
    const usdValue = amountPaid * pricePerUnit;
    const credits = Math.floor(usdValue / 0.01);

    if (credits < 10) {
      return res.status(400).json({
        success: false,
        error: `Minimum purchase is 10 credits ($0.10 USD). Your payment covers ${credits} credits.`
      });
    }

    // Mark tx as used
    usedTxHashes.set(txHash, true);

    // Record payment
    await ExternalPayment.create({
      txHash,
      chain: 'bsc',
      serviceId: 'credit-purchase',
      callerAgentId: req.wallet,
      amount: String(amountPaid),
      recipientAddress: recipient,
      blockNumber: receipt.blockNumber,
      confirmations,
      verifiedAt: new Date(),
      consumed: true,
      consumedAt: new Date()
    });

    // Add credits to account
    const account = await ExternalCreditBalance.findOneAndUpdate(
      { wallet: req.wallet },
      {
        $inc: { credits, totalPurchased: credits },
        $set: { lastPurchase: new Date() }
      },
      { new: true, upsert: true }
    );

    // Track revenue
    try {
      const revenueService = (await import('../../../services/crypto/revenueService.js')).default;
      await revenueService.trackRevenue({
        txHash,
        network: 'bsc',
        from: tx.from,
        to: recipient,
        amount: String(amountPaid),
        tokenSymbol: normalizedCurrency,
        category: 'credit_purchase',
        description: `Credit purchase: ${credits} credits via ${normalizedCurrency}`,
        metadata: { wallet: req.wallet, credits, currency: normalizedCurrency }
      });
    } catch (revErr) {
      logger.error('Failed to track credit purchase revenue:', revErr);
    }

    // Notify owner
    try {
      const agent = req.app?.locals?.agent;
      if (agent?.notify) {
        const bscscanTx = `https://bscscan.com/tx/${txHash}`;
        const bscscanWallet = `https://bscscan.com/address/${req.wallet}`;
        const message = [
          'Credit Purchase',
          '',
          `Wallet: ${req.wallet}`,
          `${bscscanWallet}`,
          '',
          `Amount: ${amountPaid} ${normalizedCurrency}`,
          `Credits: +${credits} (total: ${account.credits})`,
          '',
          `TX: ${bscscanTx}`
        ].join('\n');
        agent.notify(message).catch(() => {});
      }
    } catch {
      // Notification is best-effort
    }

    res.json({
      success: true,
      credits,
      newBalance: account.credits,
      amountPaid: String(amountPaid),
      currency: normalizedCurrency
    });
  } catch (error) {
    logger.error('Credit purchase error:', error);
    res.status(500).json({ success: false, error: 'Credit purchase failed' });
  }
});

export default router;
