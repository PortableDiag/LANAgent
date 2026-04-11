import NodeCache from 'node-cache';
import ExternalPayment from '../../../models/ExternalPayment.js';
import ExternalServiceConfig from '../../../models/ExternalServiceConfig.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';

// In-memory double-spend prevention (also checked in DB)
const usedTxHashes = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// Cache service prices for 5 minutes
const priceCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

async function getServicePrice(serviceId) {
  const cached = priceCache.get(serviceId);
  if (cached !== undefined) return cached;

  const config = await ExternalServiceConfig.findOne({ serviceId, enabled: true });
  if (!config) return null;

  const price = config.price;
  priceCache.set(serviceId, price);
  return price;
}

async function getRecipientAddress() {
  try {
    const walletService = (await import('../../../services/crypto/walletService.js')).default;
    const info = await walletService.getWalletInfo();
    if (!info.initialized || !info.addresses) return null;

    const bscAddr = info.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth');
    return bscAddr?.address || null;
  } catch (error) {
    logger.error('Failed to get recipient address:', error);
    return null;
  }
}

export function paymentMiddleware(serviceId) {
  return async (req, res, next) => {
    const txHash = req.headers['x-payment-tx'];
    const price = await getServicePrice(serviceId);

    if (!price) {
      return res.status(404).json({
        success: false,
        error: `Service ${serviceId} not found or disabled`
      });
    }

    const recipient = await getRecipientAddress();
    if (!recipient) {
      return res.status(500).json({
        success: false,
        error: 'Payment recipient not configured'
      });
    }

    // No payment tx provided — return 402 with payment instructions
    if (!txHash) {
      return res.status(402).json({
        success: false,
        error: 'Payment required',
        payment: {
          amount: price,
          currency: 'BNB',
          recipient,
          chainId: 56,
          serviceId
        }
      });
    }

    // Verify payment
    try {
      // Double-spend check (in-memory)
      if (usedTxHashes.get(txHash)) {
        return res.status(409).json({
          success: false,
          error: 'Transaction already used'
        });
      }

      // Double-spend check (database)
      const existing = await ExternalPayment.findOne({ txHash });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'Transaction already used'
        });
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
        return res.status(400).json({
          success: false,
          error: 'Transaction not found on-chain'
        });
      }

      const receipt = await retryOperation(
        () => provider.getTransactionReceipt(txHash),
        { retries: 2, context: `getReceipt(${txHash})` }
      );

      if (!receipt || receipt.status !== 1) {
        return res.status(400).json({
          success: false,
          error: 'Transaction failed or not yet confirmed'
        });
      }

      // Verify recipient
      if (tx.to?.toLowerCase() !== recipient.toLowerCase()) {
        return res.status(400).json({
          success: false,
          error: 'Transaction recipient does not match'
        });
      }

      // Verify amount (5% tolerance)
      const paidAmount = parseFloat(ethers.formatEther(tx.value));
      const requiredAmount = parseFloat(price);
      if (paidAmount < requiredAmount * 0.95) {
        return res.status(400).json({
          success: false,
          error: `Insufficient payment. Required: ${price} BNB, received: ${paidAmount} BNB`
        });
      }

      // Check confirmations
      const currentBlock = await provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber;
      if (confirmations < 3) {
        return res.status(400).json({
          success: false,
          error: `Insufficient confirmations: ${confirmations}/3. Please wait and retry.`
        });
      }

      // Mark as used
      usedTxHashes.set(txHash, true);

      // Record payment
      await ExternalPayment.create({
        txHash,
        chain: 'bsc',
        serviceId,
        callerAgentId: req.externalAgentId,
        amount: price,
        recipientAddress: recipient,
        blockNumber: receipt.blockNumber,
        confirmations,
        verifiedAt: new Date(),
        consumed: true,
        consumedAt: new Date()
      });

      // Track revenue
      try {
        const revenueService = (await import('../../../services/crypto/revenueService.js')).default;
        await revenueService.trackRevenue({
          txHash,
          network: 'bsc',
          from: tx.from,
          to: recipient,
          amount: price,
          tokenSymbol: 'BNB',
          category: 'service_fee',
          description: `External service: ${serviceId}`,
          metadata: { serviceId, callerAgentId: req.externalAgentId }
        });
      } catch (revErr) {
        logger.error('Failed to track revenue:', revErr);
      }

      // Notify owner via Telegram
      try {
        const agent = req.app?.locals?.agent;
        if (agent?.notify) {
          const svcConfig = await ExternalServiceConfig.findOne({ serviceId });
          const svcName = svcConfig?.name || serviceId;
          const truncatedTx = `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;
          const message = [
            '💰 External Service Payment Received',
            '',
            `Service: ${svcName}`,
            `From: Agent #${req.externalAgentId || 'unknown'}`,
            `Amount: ${price} BNB`,
            `TX: ${truncatedTx}`,
            `Confirmations: ${confirmations}`
          ].join('\n');
          agent.notify(message).catch(e => logger.error('Payment notification failed:', e));
        }
      } catch (notifyErr) {
        logger.error('Payment notification error:', notifyErr);
      }

      // Update service stats
      ExternalServiceConfig.findOneAndUpdate(
        { serviceId },
        {
          $inc: { totalRequests: 1 },
          $set: { lastUsed: new Date() }
        }
      ).catch(err => logger.error('Failed to update service stats:', err));

      req.paymentTx = txHash;
      req.paymentAmount = price;
      next();
    } catch (error) {
      logger.error(`Payment verification failed for tx ${txHash}:`, error);
      return res.status(500).json({
        success: false,
        error: 'Payment verification failed'
      });
    }
  };
}
