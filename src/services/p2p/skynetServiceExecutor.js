import { logger } from '../../utils/logger.js';
import NodeCache from 'node-cache';
import SkynetServiceConfig from '../../models/SkynetServiceConfig.js';
import SkynetPayment from '../../models/SkynetPayment.js';
import { retryOperation } from '../../utils/retryUtils.js';

// In-memory double-spend prevention for SKYNET payments
const usedTxHashes = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// Per-peer rate limiting
const peerRateLimits = new NodeCache({ stdTTL: 900, checkperiod: 60 });

// Priority queue: tracks concurrent execution count and pending requests
let activeExecutions = 0;
const MAX_CONCURRENT = 3;
const priorityQueue = []; // { resolve, priority, fromFingerprint, serviceId }

// SKYNET token Transfer event signature
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * SkynetServiceExecutor - Handles paid service execution between Skynet peers.
 *
 * Responsibilities:
 * - Service catalog (what we offer and at what price)
 * - SKYNET token payment verification (BEP-20 Transfer events)
 * - Service execution routing to local plugins
 * - Response sanitization
 * - Per-peer rate limiting
 */
class SkynetServiceExecutor {
  constructor(agent) {
    this.agent = agent;
  }

  /**
   * Get the SKYNET token contract address from config
   */
  async getSkynetTokenAddress() {
    try {
      const { SystemSettings } = await import('../../models/SystemSettings.js');
      return await SystemSettings.getSetting(
        'skynet_token_address',
        process.env.SKYNET_TOKEN_ADDRESS || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F'
      );
    } catch {
      return process.env.SKYNET_TOKEN_ADDRESS || '0x8Ef0ecE5687417a8037F787b39417eB16972b04F';
    }
  }

  /**
   * Get the local wallet address for receiving payments
   */
  async getRecipientAddress() {
    try {
      const walletService = (await import('../crypto/walletService.js')).default;
      const info = await walletService.getWalletInfo();
      if (!info.initialized || !info.addresses) return null;
      const bscAddr = info.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth');
      return bscAddr?.address || null;
    } catch {
      return null;
    }
  }

  // ==================== SERVICE CATALOG ====================

  /**
   * Handle service_catalog_request — return our available services and prices
   */
  async handleCatalogRequest(fromFingerprint, message, sendFn) {
    logger.info(`Skynet service catalog request from ${fromFingerprint.slice(0, 8)}...`);

    const catalog = await SkynetServiceConfig.getCatalog();
    const walletAddress = await this.getRecipientAddress();
    const tokenAddress = await this.getSkynetTokenAddress();

    await sendFn(fromFingerprint, {
      type: 'service_catalog_response',
      services: catalog,
      walletAddress: walletAddress || null,
      tokenAddress
    });
  }

  /**
   * Handle service_catalog_response — store peer's service catalog
   */
  async handleCatalogResponse(fromFingerprint, message) {
    const { services, walletAddress, tokenAddress } = message;
    logger.info(`Skynet received catalog from ${fromFingerprint.slice(0, 8)}...: ${(services || []).length} services`);

    // Store peer's catalog and wallet info for future requests
    try {
      const { peerManager } = await import('./peerManager.js');
      const peer = await peerManager.getPeer(fromFingerprint);
      if (peer) {
        peer.skynetCatalog = services || [];
        peer.skynetWallet = walletAddress || null;
        peer.skynetTokenAddress = tokenAddress || null;
        await peer.save();
      }
    } catch (err) {
      logger.error(`Failed to save peer catalog: ${err.message}`);
    }
  }

  // ==================== SERVICE EXECUTION ====================

  /**
   * Handle service_request — execute a service for a remote peer
   */
  async handleServiceRequest(fromFingerprint, message, sendFn) {
    const { serviceId, params, paymentTxHash, priorityTip } = message;
    const hasTip = priorityTip && parseFloat(priorityTip) > 0;
    logger.info(`Skynet service request from ${fromFingerprint.slice(0, 8)}...: ${serviceId}${hasTip ? ` (priority tip: ${priorityTip} SKYNET)` : ''}`);

    try {
      // 1. Check if service is enabled
      const serviceConfig = await SkynetServiceConfig.getServiceConfig(serviceId);
      if (!serviceConfig) {
        return sendFn(fromFingerprint, {
          type: 'service_error',
          serviceId,
          error: 'Service not found or not enabled for Skynet'
        });
      }

      // 2. Per-peer rate limiting
      const rateLimitKey = `${fromFingerprint}:${serviceId}`;
      const currentCount = peerRateLimits.get(rateLimitKey) || 0;
      const maxPerPeer = serviceConfig.rateLimit?.maxPerPeer || 5;
      if (currentCount >= maxPerPeer) {
        return sendFn(fromFingerprint, {
          type: 'service_error',
          serviceId,
          error: 'Rate limit exceeded. Please try again later.'
        });
      }

      // 3. Priority queue: if system is busy, prioritized requests go first
      if (activeExecutions >= MAX_CONCURRENT) {
        const priority = hasTip ? parseFloat(priorityTip) : 0;
        await new Promise(resolve => {
          priorityQueue.push({ resolve, priority, fromFingerprint, serviceId });
          priorityQueue.sort((a, b) => b.priority - a.priority);
          logger.info(`Service request queued (position ${priorityQueue.length}, priority ${priority})`);
        });
      }
      activeExecutions++;

      // Verify priority tip payment if provided
      if (hasTip) {
        const tipResult = await this.verifyPayment(
          priorityTip, 0.01, fromFingerprint, `${serviceId}:tip`
        ).catch(() => ({ success: false }));
        if (tipResult.success) {
          logger.info(`Priority tip verified from ${fromFingerprint.slice(0, 8)}...`);
        }
      }

      // 4. Check payment if price > 0
      if (serviceConfig.skynetPrice > 0) {
        if (!paymentTxHash) {
          const walletAddress = await this.getRecipientAddress();
          const tokenAddress = await this.getSkynetTokenAddress();
          return sendFn(fromFingerprint, {
            type: 'payment_required',
            serviceId,
            amount: serviceConfig.skynetPrice,
            tokenAddress,
            recipientWallet: walletAddress,
            currency: 'SKYNET'
          });
        }

        // Verify the payment
        const paymentResult = await this.verifyPayment(
          paymentTxHash, serviceConfig.skynetPrice, fromFingerprint, serviceId
        );
        if (!paymentResult.success) {
          return sendFn(fromFingerprint, {
            type: 'service_error',
            serviceId,
            error: `Payment verification failed: ${paymentResult.error}`
          });
        }
      }

      // 4. Execute the service locally
      const result = await this.executeService(serviceConfig, params);

      // 5. Update rate limit counter
      peerRateLimits.set(rateLimitKey, currentCount + 1,
        (serviceConfig.rateLimit?.windowMinutes || 15) * 60);

      // 6. Record execution
      await SkynetServiceConfig.recordExecution(serviceId, serviceConfig.skynetPrice);

      // 7. Sanitize and send result
      const sanitizedResult = await this.sanitizeResult(result);

      await sendFn(fromFingerprint, {
        type: 'service_result',
        serviceId,
        result: sanitizedResult
      });

      logger.info(`Skynet service ${serviceId} executed for ${fromFingerprint.slice(0, 8)}... (price: ${serviceConfig.skynetPrice} SKYNET)`);

    } catch (error) {
      logger.error(`Skynet service execution error: ${error.message}`);
      await sendFn(fromFingerprint, {
        type: 'service_error',
        serviceId,
        error: 'Internal execution error'
      });
    } finally {
      // Release priority queue slot
      activeExecutions = Math.max(0, activeExecutions - 1);
      if (priorityQueue.length > 0) {
        const next = priorityQueue.shift();
        next.resolve();
      }
    }
  }

  /**
   * Execute a service locally via the plugin system
   */
  async executeService(serviceConfig, params) {
    const apiManager = this.agent?.apiManager || this.agent?.services?.get('apiManager');
    if (!apiManager) {
      throw new Error('API Manager not available');
    }

    const plugin = apiManager.apis?.get(serviceConfig.pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${serviceConfig.pluginName} not available`);
    }

    const result = await plugin.execute({
      action: serviceConfig.action,
      ...params
    });

    return result;
  }

  /**
   * Sanitize result to remove internal information
   */
  async sanitizeResult(result) {
    try {
      const { sanitizeValue } = await import('../../api/external/middleware/responseSanitizer.js');
      return sanitizeValue(result);
    } catch {
      // If sanitizer not available, do basic sanitization
      const str = JSON.stringify(result);
      const cleaned = str
        .replace(/\/root\/[^\s"']*/g, '[redacted]')
        .replace(/192\.168\.\d+\.\d+/g, '[internal-ip]')
        .replace(/\/home\/[^\s"']*/g, '[redacted]');
      return JSON.parse(cleaned);
    }
  }

  // ==================== PAYMENT VERIFICATION ====================

  /**
   * Verify a SKYNET BEP-20 token payment on BSC
   * Adapts the BNB payment pattern from payment.js for ERC-20 Transfer events
   */
  async verifyPayment(txHash, requiredAmount, fromFingerprint, serviceId) {
    try {
      // Double-spend check (in-memory)
      if (usedTxHashes.get(txHash)) {
        return { success: false, error: 'Transaction already used' };
      }

      // Double-spend check (database)
      const existing = await SkynetPayment.findOne({ txHash });
      if (existing) {
        return { success: false, error: 'Transaction already used' };
      }

      // Get on-chain data
      const contractService = (await import('../crypto/contractServiceWrapper.js')).default;
      const provider = await contractService.getProvider('bsc');
      const { ethers } = await import('ethers');

      const receipt = await retryOperation(
        () => provider.getTransactionReceipt(txHash),
        { retries: 2, context: `getReceipt(${txHash})` }
      );

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: 'Transaction failed or not found' };
      }

      // Check confirmations (minimum 3)
      const currentBlock = await provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber;
      if (confirmations < 3) {
        return { success: false, error: `Insufficient confirmations: ${confirmations}/3` };
      }

      // Parse Transfer event logs from the SKYNET token contract
      const skynetAddress = await this.getSkynetTokenAddress();
      const recipientAddress = await this.getRecipientAddress();

      const transferLogs = receipt.logs.filter(log =>
        log.address.toLowerCase() === skynetAddress.toLowerCase() &&
        log.topics[0] === TRANSFER_EVENT_TOPIC
      );

      if (transferLogs.length === 0) {
        return { success: false, error: 'No SKYNET token transfer found in transaction' };
      }

      // Find a Transfer event to our wallet with sufficient amount
      let validTransfer = null;
      for (const log of transferLogs) {
        // Transfer(from, to, value) — topics[1]=from, topics[2]=to, data=value
        const to = '0x' + log.topics[2].slice(26);
        const value = ethers.toBigInt(log.data);
        const transferAmount = parseFloat(ethers.formatUnits(value, 18));

        if (to.toLowerCase() === recipientAddress.toLowerCase() &&
            transferAmount >= requiredAmount * 0.95) {
          validTransfer = { from: '0x' + log.topics[1].slice(26), to, amount: transferAmount };
          break;
        }
      }

      if (!validTransfer) {
        return { success: false, error: 'No matching SKYNET transfer to our wallet found' };
      }

      // Mark as used
      usedTxHashes.set(txHash, true);

      // Record payment
      await SkynetPayment.create({
        txHash,
        chain: 'bsc',
        serviceId,
        fromFingerprint,
        fromAddress: validTransfer.from,
        toAddress: validTransfer.to,
        amount: validTransfer.amount.toString(),
        tokenAddress: skynetAddress,
        blockNumber: receipt.blockNumber,
        confirmations,
        verifiedAt: new Date(),
        consumed: true,
        consumedAt: new Date()
      });

      // Track in ledger as received (not bought — these are service payments)
      try {
        const SkynetTokenLedger = (await import('../../models/SkynetTokenLedger.js')).default;
        await SkynetTokenLedger.recordPurchase(validTransfer.amount);
      } catch (err) {
        logger.error('Failed to update token ledger:', err.message);
      }

      logger.info(`Skynet payment verified: ${validTransfer.amount} SKYNET from ${validTransfer.from.slice(0, 10)}... (tx: ${txHash.slice(0, 10)}...)`);

      return { success: true, amount: validTransfer.amount };

    } catch (error) {
      logger.error(`Skynet payment verification failed: ${error.message}`);
      return { success: false, error: 'Payment verification failed' };
    }
  }

  // ==================== INCOMING RESULTS (REQUESTER SIDE) ====================

  /**
   * Handle service_result — we received a result from a service we requested
   */
  async handleServiceResult(fromFingerprint, message) {
    const { serviceId, result } = message;
    logger.info(`Skynet service result from ${fromFingerprint.slice(0, 8)}...: ${serviceId}`);
    // Emit event for the agent to pick up
    if (this.agent?.emit) {
      this.agent.emit('skynet:service_result', { fromFingerprint, serviceId, result });
    }
  }

  /**
   * Handle service_error — a service we requested failed
   */
  async handleServiceError(fromFingerprint, message) {
    const { serviceId, error } = message;
    logger.warn(`Skynet service error from ${fromFingerprint.slice(0, 8)}...: ${serviceId} — ${error}`);
    if (this.agent?.emit) {
      this.agent.emit('skynet:service_error', { fromFingerprint, serviceId, error });
    }
  }

  /**
   * Handle payment_required — a service we requested needs payment
   */
  async handlePaymentRequired(fromFingerprint, message) {
    const { serviceId, amount, tokenAddress, recipientWallet } = message;
    logger.info(`Skynet payment required from ${fromFingerprint.slice(0, 8)}...: ${amount} SKYNET for ${serviceId}`);
    if (this.agent?.emit) {
      this.agent.emit('skynet:payment_required', {
        fromFingerprint, serviceId, amount, tokenAddress, recipientWallet
      });
    }
  }

  // ==================== STATS ====================

  /**
   * Get Skynet service revenue stats
   */
  async getStats() {
    const services = await SkynetServiceConfig.find({});
    const payments = await SkynetPayment.find({}).sort({ createdAt: -1 }).limit(50);

    const totalRevenue = services.reduce((sum, s) => sum + (s.totalRevenue || 0), 0);
    const totalRequests = services.reduce((sum, s) => sum + (s.totalRequests || 0), 0);

    return {
      totalRevenue,
      totalRequests,
      enabledServices: services.filter(s => s.skynetEnabled).length,
      totalServices: services.length,
      recentPayments: payments.map(p => ({
        txHash: p.txHash,
        serviceId: p.serviceId,
        amount: p.amount,
        fromFingerprint: p.fromFingerprint?.slice(0, 8) + '...',
        createdAt: p.createdAt
      }))
    };
  }
}

export default SkynetServiceExecutor;
