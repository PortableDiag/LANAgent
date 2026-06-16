import { logger } from '../../utils/logger.js';
import transactionService from './transactionService.js';
import walletService from './walletService.js';
import { ethers } from 'ethers';
import { strategyRegistry } from './strategies/StrategyRegistry.js';

// Revenue categories
const REVENUE_CATEGORIES = {
    DONATION: 'donation',
    PAYMENT: 'payment',
    SERVICE_FEE: 'service_fee',
    SUBSCRIPTION: 'subscription',
    NFT_SALE: 'nft_sale',
    TOKEN_SALE: 'token_sale',
    TRADE_SELL: 'trade_sell',
    DEFI_YIELD: 'defi_yield',
    STAKING_REWARD: 'staking_reward',
    AIRDROP: 'airdrop',
    OTHER: 'other'
};

// Expense categories
const EXPENSE_CATEGORIES = {
    GAS_FEE: 'gas_fee',
    TRANSACTION_FEE: 'transaction_fee',
    CONTRACT_DEPLOYMENT: 'contract_deployment',
    TRADE_BUY: 'trade_buy',
    SERVICE_PAYMENT: 'service_payment',
    SUBSCRIPTION_FEE: 'subscription_fee',
    OTHER: 'other'
};

// Known stablecoin addresses (lowercase) for identifying USD-equivalent swaps
const STABLECOIN_ADDRESSES = new Set([
    // BSC
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    // Ethereum
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    // Polygon
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    // Base
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
]);

class RevenueService {
    constructor() {
        this.revenueRecords = new Map();
        this.expenseRecords = new Map();
        this.taxableEvents = new Map();
        this._synced = false;

        // Update today's P&L record every 15 minutes (after 2 min startup delay)
        setTimeout(() => {
            this.updateTodayPnL();
            this._pnlInterval = setInterval(() => this.updateTodayPnL(), 15 * 60 * 1000);
        }, 120000);
    }

    /**
     * Check if a tokenIn/tokenOut value is a stablecoin
     */
    _isStablecoin(tokenValue) {
        if (!tokenValue || tokenValue === 'NATIVE') return false;
        return STABLECOIN_ADDRESSES.has(tokenValue.toLowerCase());
    }

    /**
     * Auto-sync crypto swap transactions into revenue/expense records.
     * Called lazily on first data request. Reads wallet transactions from MongoDB
     * and categorizes swaps based on stablecoin direction:
     *   Receiving stablecoins (selling native/token → stablecoin) = revenue
     *   Spending stablecoins (buying native/token ← stablecoin) = expense
     */
    async syncFromCryptoTransactions() {
        if (this._synced) return;
        this._synced = true;
        try {
            const transactions = await walletService.getTransactions();
            if (!transactions || transactions.length === 0) return;

            const chainToNetwork = { 'bsc': 'bsc', 'bsc-testnet': 'bsc', 'eth': 'ethereum', 'ethereum': 'ethereum', 'sepolia': 'ethereum', 'polygon': 'polygon' };

            for (const tx of transactions) {
                const validTypes = ['swap', 'buy', 'sell'];
                if (!validTypes.includes(tx.type) || tx.status !== 'confirmed') continue;
                const id = this.generateRecordId(tx.hash, tx.chain);
                if (this.revenueRecords.has(id) || this.expenseRecords.has(id)) continue;

                const network = chainToNetwork[tx.chain] || tx.chain;
                const timestamp = new Date(tx.timestamp).getTime();

                // Determine direction by checking which side is a stablecoin
                const outIsStable = this._isStablecoin(tx.tokenOut);
                const inIsStable = this._isStablecoin(tx.tokenIn);

                if (outIsStable || (tx.tokenIn === 'NATIVE' && !inIsStable)) {
                    // REVENUE: receiving stablecoins (or selling native token)
                    // USD value = the stablecoin amount (expectedOut for sells)
                    const usdValue = outIsStable
                        ? parseFloat(tx.expectedOut || 0)
                        : parseFloat(tx.expectedOut || tx.amountIn || 0);
                    const tokenSymbol = tx.tokenIn === 'NATIVE'
                        ? this.getNetworkSymbol(network)
                        : (tx.tokenInSymbol || 'TOKEN');
                    this.revenueRecords.set(id, {
                        id,
                        type: 'revenue',
                        txHash: tx.hash,
                        network,
                        from: tx.from || 'wallet',
                        to: 'DEX',
                        amount: tx.amountIn || '0',
                        tokenSymbol,
                        category: REVENUE_CATEGORIES.TRADE_SELL,
                        description: `Swap ${tx.amountIn || '?'} ${tokenSymbol} → stablecoin`,
                        usdValue,
                        timestamp,
                        metadata: { tokenOut: tx.tokenOut, expectedOut: tx.expectedOut },
                        taxYear: new Date(timestamp).getFullYear()
                    });
                } else if (inIsStable || (tx.tokenOut === 'NATIVE' && !outIsStable)) {
                    // EXPENSE: spending stablecoins (or buying native token)
                    // USD value = the stablecoin amount (amountIn for buys)
                    const usdValue = inIsStable
                        ? parseFloat(tx.amountIn || 0)
                        : parseFloat(tx.amountIn || tx.expectedOut || 0);
                    const tokenSymbol = tx.tokenOut === 'NATIVE'
                        ? this.getNetworkSymbol(network)
                        : (tx.tokenOutSymbol || 'TOKEN');
                    this.expenseRecords.set(id, {
                        id,
                        type: 'expense',
                        txHash: tx.hash,
                        network,
                        from: 'wallet',
                        to: 'DEX',
                        amount: tx.amountIn || '0',
                        tokenSymbol: inIsStable ? 'STABLE' : tokenSymbol,
                        category: EXPENSE_CATEGORIES.TRADE_BUY,
                        description: `Swap stablecoin → ${tx.expectedOut || '?'} ${tokenSymbol}`,
                        usdValue,
                        timestamp,
                        metadata: { tokenIn: tx.tokenIn, amountIn: tx.amountIn },
                        taxYear: new Date(timestamp).getFullYear()
                    });
                } else {
                    // Token↔Token or Token↔Native swap with no stablecoin involved — skip
                    logger.debug(`Revenue sync: skipping non-stablecoin swap ${tx.hash?.substring(0, 10)}`);
                }
            }

            const revCount = this.revenueRecords.size;
            const expCount = this.expenseRecords.size;
            if (revCount > 0 || expCount > 0) {
                logger.info(`Revenue auto-sync: ${revCount} revenue, ${expCount} expense records from ${transactions.length} transactions`);
            }
        } catch (error) {
            logger.error('Failed to auto-sync crypto transactions:', error);
        }
    }

    /**
     * Track incoming revenue
     */
    async trackRevenue(params) {
        const {
            txHash,
            network,
            from,
            to,
            amount,
            tokenAddress = null,
            tokenSymbol = null,
            category = REVENUE_CATEGORIES.OTHER,
            description = '',
            metadata = {}
        } = params;

        try {
            const timestamp = Date.now();
            const id = this.generateRecordId(txHash, network);
            
            // Get USD value
            const usdValue = await this.calculateUSDValue(
                amount,
                tokenSymbol || this.getNetworkSymbol(network),
                timestamp
            );

            const record = {
                id,
                type: 'revenue',
                txHash,
                network,
                from,
                to,
                amount,
                tokenAddress,
                tokenSymbol,
                category,
                description,
                usdValue,
                timestamp,
                metadata,
                taxYear: new Date(timestamp).getFullYear()
            };

            this.revenueRecords.set(id, record);
            
            logger.info('Revenue tracked:', {
                category,
                amount,
                usdValue,
                network
            });

            return record;
        } catch (error) {
            logger.error('Failed to track revenue:', error);
            throw error;
        }
    }

    /**
     * Track outgoing expense
     */
    async trackExpense(params) {
        const {
            txHash,
            network,
            from,
            to,
            amount,
            category = EXPENSE_CATEGORIES.OTHER,
            description = '',
            metadata = {}
        } = params;

        try {
            const timestamp = Date.now();
            const id = this.generateRecordId(txHash, network);
            
            // Get USD value
            const usdValue = await this.calculateUSDValue(
                amount,
                this.getNetworkSymbol(network),
                timestamp
            );

            const record = {
                id,
                type: 'expense',
                txHash,
                network,
                from,
                to,
                amount,
                category,
                description,
                usdValue,
                timestamp,
                metadata,
                taxYear: new Date(timestamp).getFullYear()
            };

            this.expenseRecords.set(id, record);
            
            logger.info('Expense tracked:', {
                category,
                amount,
                usdValue,
                network
            });

            return record;
        } catch (error) {
            logger.error('Failed to track expense:', error);
            throw error;
        }
    }

    /**
     * Get revenue summary for a period
     */
    async getRevenueSummary(startDate, endDate, options = {}) {
        await this.syncFromCryptoTransactions();
        const { 
            category = null, 
            network = null,
            groupBy = 'category' // category, network, day, month
        } = options;

        const records = this.filterRecords(
            this.revenueRecords,
            startDate,
            endDate,
            { category, network }
        );

        const summary = {
            totalRevenue: 0,
            totalUSD: 0,
            count: records.length,
            breakdown: new Map(),
            records: records
        };

        // Calculate totals and breakdown
        records.forEach(record => {
            summary.totalRevenue += parseFloat(record.amount);
            summary.totalUSD += record.usdValue || 0;

            // Group by specified field
            const groupKey = this.getGroupKey(record, groupBy);
            if (!summary.breakdown.has(groupKey)) {
                summary.breakdown.set(groupKey, {
                    revenue: 0,
                    usd: 0,
                    count: 0,
                    records: []
                });
            }

            const group = summary.breakdown.get(groupKey);
            group.revenue += parseFloat(record.amount);
            group.usd += record.usdValue || 0;
            group.count += 1;
            group.records.push(record);
        });

        // Convert breakdown to array
        summary.breakdown = Array.from(summary.breakdown.entries()).map(([key, value]) => ({
            [groupBy]: key,
            ...value
        }));

        return summary;
    }

    /**
     * Get expense summary for a period
     */
    async getExpenseSummary(startDate, endDate, options = {}) {
        await this.syncFromCryptoTransactions();
        const { 
            category = null, 
            network = null,
            groupBy = 'category'
        } = options;

        const records = this.filterRecords(
            this.expenseRecords,
            startDate,
            endDate,
            { category, network }
        );

        const summary = {
            totalExpense: 0,
            totalUSD: 0,
            count: records.length,
            breakdown: new Map(),
            records: records
        };

        // Calculate totals
        records.forEach(record => {
            summary.totalExpense += parseFloat(record.amount);
            summary.totalUSD += record.usdValue || 0;

            // Group by specified field
            const groupKey = this.getGroupKey(record, groupBy);
            if (!summary.breakdown.has(groupKey)) {
                summary.breakdown.set(groupKey, {
                    expense: 0,
                    usd: 0,
                    count: 0,
                    records: []
                });
            }

            const group = summary.breakdown.get(groupKey);
            group.expense += parseFloat(record.amount);
            group.usd += record.usdValue || 0;
            group.count += 1;
            group.records.push(record);
        });

        // Convert breakdown to array
        summary.breakdown = Array.from(summary.breakdown.entries()).map(([key, value]) => ({
            [groupBy]: key,
            ...value
        }));

        return summary;
    }

    /**
     * Get profit/loss report
     */
    async getProfitLossReport(startDate, endDate, options = {}) {
        const revenueSummary = await this.getRevenueSummary(startDate, endDate, options);
        const expenseSummary = await this.getExpenseSummary(startDate, endDate, options);

        const cashflowProfit = revenueSummary.totalUSD - expenseSummary.totalUSD;

        // Include unrealized position value from active strategies
        let unrealizedValue = 0;
        let strategyPnL = null;
        try {
            // Aggregate across all token trader instances
            const allTraders = strategyRegistry.getAllTokenTraders();
            if (allTraders.size > 0) {
                strategyPnL = { tokenTrader: { realized: 0, unrealized: 0, lifetimeRealized: 0, lifetimeGasCost: 0, currentPositionValue: 0, instances: {} } };
                for (const [addr, instance] of allTraders) {
                    const ttStatus = instance.getTokenTraderStatus();
                    const pos = ttStatus.position || {};
                    const pnl = ttStatus.pnl || {};
                    const lastPrice = instance.state.tokenPriceHistory?.length > 0
                        ? instance.state.tokenPriceHistory[instance.state.tokenPriceHistory.length - 1].price
                        : pos.averageEntryPrice || 0;
                    const posValue = ((pos.tokenBalance || 0) * lastPrice) + (pos.stablecoinReserve || 0);
                    unrealizedValue += posValue;
                    strategyPnL.tokenTrader.realized += pnl.realized || 0;
                    strategyPnL.tokenTrader.unrealized += pnl.unrealized || 0;
                    strategyPnL.tokenTrader.lifetimeRealized += pnl.lifetimeRealized || pnl.realized || 0;
                    strategyPnL.tokenTrader.lifetimeGasCost += pnl.lifetimeGasCost || pnl.totalGasCost || 0;
                    strategyPnL.tokenTrader.currentPositionValue += posValue;
                    strategyPnL.tokenTrader.instances[addr] = { symbol: instance.config.tokenSymbol, positionValue: posValue, realized: pnl.realized || 0 };
                }
            }
        } catch (err) {
            logger.debug('Revenue P&L: could not fetch strategy data:', err.message);
        }

        // Net profit includes unrealized position value (assets still held)
        const netProfit = cashflowProfit + unrealizedValue;
        const totalValue = revenueSummary.totalUSD + unrealizedValue;
        const profitMargin = totalValue > 0
            ? (netProfit / totalValue * 100).toFixed(2)
            : 0;

        return {
            period: {
                start: startDate,
                end: endDate
            },
            revenue: {
                total: revenueSummary.totalUSD,
                count: revenueSummary.count,
                breakdown: revenueSummary.breakdown
            },
            expenses: {
                total: expenseSummary.totalUSD,
                count: expenseSummary.count,
                breakdown: expenseSummary.breakdown
            },
            netProfit,
            cashflowProfit,
            unrealizedPositionValue: unrealizedValue,
            strategyPnL,
            profitMargin: `${profitMargin}%`,
            summary: {
                profitable: netProfit > 0,
                totalTransactions: revenueSummary.count + expenseSummary.count
            }
        };
    }

    /**
     * Generate tax report
     */
    async generateTaxReport(taxYear) {
        const startDate = new Date(taxYear, 0, 1);
        const endDate = new Date(taxYear, 11, 31, 23, 59, 59);

        const revenues = this.filterRecords(
            this.revenueRecords,
            startDate,
            endDate
        );

        const expenses = this.filterRecords(
            this.expenseRecords,
            startDate,
            endDate
        );

        // Get taxable events (sales, trades, etc)
        const taxableEvents = [];
        
        revenues.forEach(record => {
            if (this.isTaxableEvent(record)) {
                taxableEvents.push({
                    ...record,
                    type: 'income',
                    taxableAmount: record.usdValue
                });
            }
        });

        // Calculate totals
        const totalIncome = revenues.reduce((sum, r) => sum + (r.usdValue || 0), 0);
        const totalExpenses = expenses.reduce((sum, e) => sum + (e.usdValue || 0), 0);
        const netIncome = totalIncome - totalExpenses;

        return {
            taxYear,
            summary: {
                totalIncome,
                totalExpenses,
                netIncome,
                taxableEvents: taxableEvents.length
            },
            incomeByCategory: this.groupByCategory(revenues),
            expensesByCategory: this.groupByCategory(expenses),
            taxableEvents,
            gasFees: expenses.filter(e => e.category === EXPENSE_CATEGORIES.GAS_FEE),
            disclaimer: 'This is a summary report. Please consult a tax professional for accurate tax filing.'
        };
    }

    /**
     * Track gas fees automatically
     */
    async trackTransactionGas(txHash, network) {
        try {
            const receipt = await transactionService.getTransactionReceipt(txHash, network);
            if (!receipt) return null;

            const gasUsed = receipt.gasUsed;
            const gasPrice = receipt.effectiveGasPrice || receipt.gasPrice;
            const gasCost = gasUsed.mul(gasPrice);
            const gasCostETH = ethers.utils.formatEther(gasCost);

            return await this.trackExpense({
                txHash,
                network,
                from: receipt.from,
                to: 'network',
                amount: gasCostETH,
                category: EXPENSE_CATEGORIES.GAS_FEE,
                description: `Gas fee for transaction ${txHash.substring(0, 10)}...`
            });
        } catch (error) {
            logger.error('Failed to track gas fee:', error);
            return null;
        }
    }

    /**
     * Import transactions from wallet
     */
    async importWalletTransactions(network, startBlock, endBlock) {
        try {
            const wallet = await walletService.getWallet();
            const address = wallet.addresses.find(a => a.network === network)?.address;
            
            if (!address) {
                throw new Error(`No wallet address found for network ${network}`);
            }

            const transactions = await transactionService.getAddressTransactions(
                address,
                network,
                { startBlock, endBlock }
            );

            const imported = {
                revenue: 0,
                expenses: 0,
                gasFees: 0
            };

            for (const tx of transactions) {
                // Track as revenue if receiving
                if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value > 0) {
                    await this.trackRevenue({
                        txHash: tx.hash,
                        network,
                        from: tx.from,
                        to: tx.to,
                        amount: ethers.utils.formatEther(tx.value),
                        category: REVENUE_CATEGORIES.PAYMENT,
                        description: 'Incoming transaction'
                    });
                    imported.revenue++;
                }

                // Track as expense if sending
                if (tx.from?.toLowerCase() === address.toLowerCase() && tx.value > 0) {
                    await this.trackExpense({
                        txHash: tx.hash,
                        network,
                        from: tx.from,
                        to: tx.to,
                        amount: ethers.utils.formatEther(tx.value),
                        category: EXPENSE_CATEGORIES.SERVICE_PAYMENT,
                        description: 'Outgoing transaction'
                    });
                    imported.expenses++;
                }

                // Track gas fee
                if (tx.from?.toLowerCase() === address.toLowerCase()) {
                    await this.trackTransactionGas(tx.hash, network);
                    imported.gasFees++;
                }
            }

            return imported;
        } catch (error) {
            logger.error('Failed to import wallet transactions:', error);
            throw error;
        }
    }

    /**
     * Export records to CSV
     */
    exportToCSV(records) {
        const headers = [
            'Date',
            'Type',
            'Category',
            'Amount',
            'Token',
            'USD Value',
            'Network',
            'From',
            'To',
            'Transaction Hash',
            'Description'
        ];

        const rows = records.map(record => [
            new Date(record.timestamp).toISOString(),
            record.type,
            record.category,
            record.amount,
            record.tokenSymbol || this.getNetworkSymbol(record.network),
            record.usdValue?.toFixed(2) || '0.00',
            record.network,
            record.from,
            record.to,
            record.txHash,
            record.description
        ]);

        // Build CSV
        const csv = [
            headers.join(','),
            ...rows.map(row => row.map(cell => 
                `"${String(cell).replace(/"/g, '""')}"`
            ).join(','))
        ].join('\n');

        return csv;
    }

    /**
     * Helper methods
     */
    filterRecords(recordMap, startDate, endDate, filters = {}) {
        const records = Array.from(recordMap.values());
        
        return records.filter(record => {
            // Date filter
            if (startDate && record.timestamp < startDate.getTime()) return false;
            if (endDate && record.timestamp > endDate.getTime()) return false;
            
            // Category filter
            if (filters.category && record.category !== filters.category) return false;
            
            // Network filter
            if (filters.network && record.network !== filters.network) return false;
            
            return true;
        });
    }

    getGroupKey(record, groupBy) {
        switch (groupBy) {
            case 'category':
                return record.category;
            case 'network':
                return record.network;
            case 'day':
                return new Date(record.timestamp).toISOString().split('T')[0];
            case 'month':
                const date = new Date(record.timestamp);
                return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            default:
                return 'all';
        }
    }

    groupByCategory(records) {
        const grouped = {};
        
        records.forEach(record => {
            if (!grouped[record.category]) {
                grouped[record.category] = {
                    count: 0,
                    totalUSD: 0,
                    records: []
                };
            }
            
            grouped[record.category].count++;
            grouped[record.category].totalUSD += record.usdValue || 0;
            grouped[record.category].records.push(record);
        });
        
        return grouped;
    }

    isTaxableEvent(record) {
        // Define taxable events based on category
        const taxableCategories = [
            REVENUE_CATEGORIES.PAYMENT,
            REVENUE_CATEGORIES.SERVICE_FEE,
            REVENUE_CATEGORIES.NFT_SALE,
            REVENUE_CATEGORIES.TOKEN_SALE,
            REVENUE_CATEGORIES.DEFI_YIELD,
            REVENUE_CATEGORIES.STAKING_REWARD
        ];
        
        return taxableCategories.includes(record.category);
    }

    async calculateUSDValue(amount, tokenSymbol, timestamp) {
        const parsedAmount = parseFloat(amount) || 0;
        // Stablecoins are 1:1 USD
        const stableSymbols = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD'];
        if (stableSymbols.includes(tokenSymbol?.toUpperCase())) {
            return parsedAmount;
        }
        // For non-stablecoins used in manual tracking, return 0
        // (auto-synced records already have correct usdValue from swap data)
        return 0;
    }

    getNetworkSymbol(network) {
        const symbols = {
            'ethereum': 'ETH',
            'bsc': 'BNB',
            'polygon': 'MATIC',
            'bitcoin': 'BTC'
        };
        return symbols[network] || 'ETH';
    }

    generateRecordId(txHash, network) {
        return `${network}:${txHash}`;
    }

    /**
     * Get daily P&L history for charting.
     * Reads from DailyPnL collection (backfilled from logs),
     * updates today's entry live from current token trader data.
     */
    async getDailyPnL(startDate, endDate) {
        try {
            const { default: DailyPnL } = await import('../../models/DailyPnL.js');
            const records = await DailyPnL.find({
                date: { $gte: startDate.toISOString().slice(0, 10), $lte: endDate.toISOString().slice(0, 10) }
            }).sort({ date: 1 }).lean();

            if (records.length > 0) {
                return records.map(r => ({
                    date: r.date,
                    dailyPnL: r.dailyNet,
                    cumulativePnL: r.cumulativePnL
                }));
            }
        } catch (err) {
            logger.debug('DailyPnL collection not available, falling back to live calculation:', err.message);
        }

        // Fallback: compute from revenue records if no backfill data
        return this._computeLiveDailyPnL(startDate, endDate);
    }

    async _computeLiveDailyPnL(startDate, endDate) {
        await this.syncFromCryptoTransactions();

        const allTrades = [];
        for (const r of this.revenueRecords.values()) {
            if (r.timestamp >= startDate.getTime() && r.timestamp <= endDate.getTime()) {
                allTrades.push({ timestamp: r.timestamp, pnlDelta: r.usdValue || 0 });
            }
        }
        for (const e of this.expenseRecords.values()) {
            if (e.timestamp >= startDate.getTime() && e.timestamp <= endDate.getTime()) {
                allTrades.push({ timestamp: e.timestamp, pnlDelta: -(e.usdValue || 0) });
            }
        }
        allTrades.sort((a, b) => a.timestamp - b.timestamp);
        if (allTrades.length === 0) return [];

        const dailyMap = new Map();
        for (const t of allTrades) {
            const day = new Date(t.timestamp).toISOString().slice(0, 10);
            dailyMap.set(day, (dailyMap.get(day) || 0) + t.pnlDelta);
        }

        // Get actual token trader P&L for scaling
        let actualTotalPnL = 0;
        try {
            const allTraders = strategyRegistry.getAllTokenTraders();
            for (const [, instance] of allTraders) {
                const pnl = instance.getTokenTraderStatus()?.pnl || {};
                const lr = pnl.lifetimeRealized != null ? pnl.lifetimeRealized : (pnl.realized || 0);
                actualTotalPnL += lr + (pnl.unrealized || 0);
            }
        } catch { /* use raw */ }

        const rawTotal = allTrades.reduce((s, t) => s + t.pnlDelta, 0);
        const scale = rawTotal !== 0 && actualTotalPnL !== 0 ? actualTotalPnL / rawTotal : 1;

        const days = Array.from(dailyMap.entries()).sort(([a], [b]) => a.localeCompare(b));
        let cumulative = 0;
        return days.map(([date, rawDelta]) => {
            const delta = rawDelta * scale;
            cumulative += delta;
            return { date, dailyPnL: delta, cumulativePnL: cumulative };
        });
    }

    /**
     * Update today's DailyPnL record from live token trader data.
     * Called periodically to keep the chart current.
     */
    async updateTodayPnL() {
        try {
            const { default: DailyPnL } = await import('../../models/DailyPnL.js');
            const today = new Date().toISOString().slice(0, 10);

            // Get yesterday's cumulative as baseline
            const yesterday = await DailyPnL.findOne({ date: { $lt: today } }).sort({ date: -1 }).lean();
            const prevCumulative = yesterday ? yesterday.cumulativePnL : 0;

            // Get current token trader P&L and gas costs
            let currentTotalPnL = 0;
            let totalGasCost = 0;
            try {
                const allTraders = strategyRegistry.getAllTokenTraders();
                for (const [, instance] of allTraders) {
                    const status = instance.getTokenTraderStatus() || {};
                    const pnl = status.pnl || {};
                    const lr = pnl.lifetimeRealized != null ? pnl.lifetimeRealized : (pnl.realized || 0);
                    currentTotalPnL += lr + (pnl.unrealized || 0);
                    totalGasCost += pnl.lifetimeGasCost || pnl.totalGasCost || 0;
                }
            } catch { return; }

            const dailyNet = currentTotalPnL - prevCumulative;

            await DailyPnL.findOneAndUpdate(
                { date: today },
                {
                    date: today,
                    dailyNet,
                    cumulativePnL: currentTotalPnL,
                    realizedPnL: dailyNet,
                    gasCost: totalGasCost,
                    source: 'live'
                },
                { upsert: true }
            );

            // Cache for the web UI to read via getTodayPnLSummary()
            this._todayPnLCache = { dailyNet, cumulativePnL: currentTotalPnL, gasCost: totalGasCost, updatedAt: Date.now() };
        } catch (err) {
            logger.debug('Failed to update today PnL:', err.message);
        }
    }

    /**
     * Get cached today P&L summary (updated periodically by updateTodayPnL)
     */
    getTodayPnLSummary() {
        return this._todayPnLCache || { dailyNet: 0, cumulativePnL: 0, gasCost: 0 };
    }

    /**
     * Get all records for export
     */
    async getAllRecords() {
        await this.syncFromCryptoTransactions();
        const revenues = Array.from(this.revenueRecords.values());
        const expenses = Array.from(this.expenseRecords.values());

        return [...revenues, ...expenses].sort((a, b) => b.timestamp - a.timestamp);
    }
}

export default new RevenueService();