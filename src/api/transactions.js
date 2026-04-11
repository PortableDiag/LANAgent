import express from 'express';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import transactionService from '../services/crypto/transactionService.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Cache for finalized transaction statuses only (confirmed/failed — never pending)
const txStatusCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Rate limiting for status polling endpoint
const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many status requests, please try again later' }
});

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Estimate gas for a transaction
 */
router.post('/estimate-gas', async (req, res) => {
    try {
        const { to, data, value = '0', network } = req.body;
        
        if (!to || !network) {
            return res.status(400).json({ 
                error: 'Missing required fields: to, network' 
            });
        }

        const estimate = await transactionService.estimateGas(
            to, 
            data || '0x', 
            value, 
            network
        );

        res.json({ 
            success: true, 
            estimate 
        });
    } catch (error) {
        logger.error('Gas estimation error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Write to a smart contract
 */
router.post('/write-contract', async (req, res) => {
    try {
        const { 
            address, 
            network, 
            functionName, 
            params = [], 
            options = {} 
        } = req.body;
        
        if (!address || !network || !functionName) {
            return res.status(400).json({ 
                error: 'Missing required fields: address, network, functionName' 
            });
        }

        const result = await transactionService.writeContract(
            address,
            network,
            functionName,
            params,
            options
        );

        res.json({ 
            success: true, 
            transaction: result 
        });
    } catch (error) {
        logger.error('Contract write error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Send native currency
 */
router.post('/send-native', async (req, res) => {
    try {
        const { to, amount, network } = req.body;
        
        if (!to || !amount || !network) {
            return res.status(400).json({ 
                error: 'Missing required fields: to, amount, network' 
            });
        }

        // Validate amount
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ 
                error: 'Invalid amount' 
            });
        }

        const result = await transactionService.sendNative(
            to,
            amount,
            network
        );

        res.json({ 
            success: true, 
            transaction: result 
        });
    } catch (error) {
        logger.error('Native send error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get transaction status (with rate limiting, smart caching, and retry)
 * Only caches finalized statuses (confirmed/failed) — pending statuses are always fresh
 */
router.get('/status/:txHash', statusLimiter, async (req, res) => {
    try {
        const { txHash } = req.params;
        const { network } = req.query;

        if (!network) {
            return res.status(400).json({
                error: 'Missing required parameter: network'
            });
        }

        // Check cache for finalized transactions
        const cacheKey = `tx:${txHash}:${network}`;
        const cached = txStatusCache.get(cacheKey);
        if (cached) {
            return res.json({ success: true, status: cached, cached: true });
        }

        const status = await retryOperation(
            () => transactionService.getTransactionStatus(txHash, network),
            { retries: 2, context: 'getTransactionStatus' }
        );

        // Only cache finalized statuses — never cache pending
        if (status.status === 'confirmed' || status.status === 'failed') {
            txStatusCache.set(cacheKey, status);
        }

        res.json({
            success: true,
            status
        });
    } catch (error) {
        logger.error('Transaction status error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Get pending transactions
 */
router.get('/pending', (req, res) => {
    try {
        const pending = transactionService.getPendingTransactions();
        
        res.json({ 
            success: true, 
            transactions: pending 
        });
    } catch (error) {
        logger.error('Get pending transactions error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

export default router;