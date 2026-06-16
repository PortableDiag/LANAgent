import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import revenueService from '../services/crypto/revenueService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300 // limit each IP to 300 requests per windowMs
});

router.use(limiter);

async function getCachedData(key, fetchFunc) {
    const cached = cache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const data = await fetchFunc();
    cache.set(key, data);
    return data;
}

// Track revenue
router.post('/track/revenue', authenticateToken, async (req, res) => {
    try {
        const record = await retryOperation(() => revenueService.trackRevenue(req.body));
        res.json({ success: true, data: record });
    } catch (error) {
        logger.error('Failed to track revenue:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Track expense
router.post('/track/expense', authenticateToken, async (req, res) => {
    try {
        const record = await retryOperation(() => revenueService.trackExpense(req.body));
        res.json({ success: true, data: record });
    } catch (error) {
        logger.error('Failed to track expense:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get revenue summary
router.get('/summary/revenue', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, category, network, groupBy } = req.query;
        const cacheKey = `revenueSummary-${startDate}-${endDate}-${category}-${network}-${groupBy}`;
        
        const summary = await getCachedData(cacheKey, async () => {
            return await revenueService.getRevenueSummary(
                startDate ? new Date(startDate) : null,
                endDate ? new Date(endDate) : null,
                { category, network, groupBy }
            );
        });
        
        res.json({ success: true, data: summary });
    } catch (error) {
        logger.error('Failed to get revenue summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get expense summary
router.get('/summary/expense', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, category, network, groupBy } = req.query;
        const cacheKey = `expenseSummary-${startDate}-${endDate}-${category}-${network}-${groupBy}`;
        
        const summary = await getCachedData(cacheKey, async () => {
            return await revenueService.getExpenseSummary(
                startDate ? new Date(startDate) : null,
                endDate ? new Date(endDate) : null,
                { category, network, groupBy }
            );
        });
        
        res.json({ success: true, data: summary });
    } catch (error) {
        logger.error('Failed to get expense summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get profit/loss report
router.get('/report/profit-loss', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, groupBy } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'Start date and end date are required'
            });
        }
        
        const report = await retryOperation(() => revenueService.getProfitLossReport(
            new Date(startDate),
            new Date(endDate),
            { groupBy }
        ));
        
        res.json({ success: true, data: report });
    } catch (error) {
        logger.error('Failed to get profit/loss report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate tax report
router.get('/report/tax/:year', authenticateToken, async (req, res) => {
    try {
        const taxYear = parseInt(req.params.year);
        
        if (isNaN(taxYear) || taxYear < 2020 || taxYear > new Date().getFullYear()) {
            return res.status(400).json({
                success: false,
                error: 'Invalid tax year'
            });
        }
        
        const report = await retryOperation(() => revenueService.generateTaxReport(taxYear));
        res.json({ success: true, data: report });
    } catch (error) {
        logger.error('Failed to generate tax report:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Import wallet transactions
router.post('/import/wallet', authenticateToken, async (req, res) => {
    try {
        const { network, startBlock, endBlock } = req.body;
        
        if (!network) {
            return res.status(400).json({
                success: false,
                error: 'Network is required'
            });
        }
        
        const imported = await retryOperation(() => revenueService.importWalletTransactions(
            network,
            startBlock,
            endBlock
        ));
        
        res.json({ success: true, data: imported });
    } catch (error) {
        logger.error('Failed to import wallet transactions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Export records to CSV
router.get('/export/csv', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, type } = req.query;
        
        let records = await retryOperation(() => revenueService.getAllRecords());
        
        if (startDate || endDate) {
            records = records.filter(record => {
                if (startDate && record.timestamp < new Date(startDate).getTime()) return false;
                if (endDate && record.timestamp > new Date(endDate).getTime()) return false;
                return true;
            });
        }
        
        if (type && ['revenue', 'expense'].includes(type)) {
            records = records.filter(record => record.type === type);
        }
        
        const csv = revenueService.exportToCSV(records);
        
        const filename = `crypto-revenue-${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        res.send(csv);
    } catch (error) {
        logger.error('Failed to export CSV:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Track transaction gas
router.post('/track/gas', authenticateToken, async (req, res) => {
    try {
        const { txHash, network } = req.body;
        
        if (!txHash || !network) {
            return res.status(400).json({
                success: false,
                error: 'Transaction hash and network are required'
            });
        }
        
        const gasRecord = await retryOperation(() => revenueService.trackTransactionGas(txHash, network));
        res.json({ success: true, data: gasRecord });
    } catch (error) {
        logger.error('Failed to track gas fee:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get daily P&L history for charting
router.get('/report/daily-pnl', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 86400000);
        const end = endDate ? new Date(endDate) : new Date();
        const data = await retryOperation(() => revenueService.getDailyPnL(start, end));
        res.json({ success: true, data });
    } catch (error) {
        logger.error('Failed to get daily P&L:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all records
router.get('/records', authenticateToken, async (req, res) => {
    try {
        const records = await retryOperation(() => revenueService.getAllRecords());
        res.json({ success: true, data: records });
    } catch (error) {
        logger.error('Failed to get records:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get revenue categories
router.get('/categories/revenue', authenticateToken, async (req, res) => {
    res.json({
        success: true,
        data: [
            { value: 'donation', label: 'Donation' },
            { value: 'payment', label: 'Payment' },
            { value: 'service_fee', label: 'Service Fee' },
            { value: 'subscription', label: 'Subscription' },
            { value: 'nft_sale', label: 'NFT Sale' },
            { value: 'token_sale', label: 'Token Sale' },
            { value: 'trade_sell', label: 'Trade Sell' },
            { value: 'defi_yield', label: 'DeFi Yield' },
            { value: 'staking_reward', label: 'Staking Reward' },
            { value: 'airdrop', label: 'Airdrop' },
            { value: 'other', label: 'Other' }
        ]
    });
});

// Get expense categories
router.get('/categories/expense', authenticateToken, async (req, res) => {
    res.json({
        success: true,
        data: [
            { value: 'gas_fee', label: 'Gas Fee' },
            { value: 'transaction_fee', label: 'Transaction Fee' },
            { value: 'contract_deployment', label: 'Contract Deployment' },
            { value: 'trade_buy', label: 'Trade Buy' },
            { value: 'service_payment', label: 'Service Payment' },
            { value: 'subscription_fee', label: 'Subscription Fee' },
            { value: 'other', label: 'Other' }
        ]
    });
});

export default router;