import mongoose from 'mongoose';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const addressSchema = new mongoose.Schema({
    chain: {
        type: String,
        required: true,
        enum: ['btc', 'eth', 'bsc', 'polygon', 'nano']
    },
    name: {
        type: String,
        required: true
    },
    address: {
        type: String,
        required: true
    },
    path: {
        type: String,
        required: true
    }
});

const transactionSchema = new mongoose.Schema({
    chain: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['sent', 'received', 'swap', 'buy', 'sell', 'contract_write', 'approval'],
        required: true
    },
    hash: {
        type: String,
        required: true
    },
    from: String,
    to: String,
    amount: String,
    tokenIn: String,
    tokenOut: String,
    amountIn: String,
    amountOut: String,
    expectedOut: String,
    timestamp: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'failed'],
        default: 'pending'
    },
    categories: [String], // New field for categories
    tags: [String] // New field for tags
});

const cryptoWalletSchema = new mongoose.Schema({
    encryptedSeed: {
        type: String,
        required: true
    },
    addresses: [addressSchema],
    transactions: [transactionSchema],
    settings: {
        autoRefreshBalance: {
            type: Boolean,
            default: true
        },
        transactionNotifications: {
            type: Boolean,
            default: true
        }
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActive: {
        type: Date,
        default: Date.now
    }
});

// Initialize cache
const walletCache = new NodeCache();

/**
 * Batch transactions and save them to the database.
 * @param {Array} transactions - The transactions to batch.
 * @returns {Promise<void>}
 */
cryptoWalletSchema.methods.batchTransactions = async function(transactions) {
    try {
        if (!Array.isArray(transactions) || transactions.length === 0) {
            throw new Error('Invalid transactions array');
        }
        this.transactions.push(...transactions);
        await retryOperation(() => this.save(), { retries: 3 });
        logger.info(`Successfully batched ${transactions.length} transactions.`);
    } catch (error) {
        logger.error('Error in batchTransactions:', error);
        throw error;
    }
};

/**
 * Categorize a transaction based on predefined rules or user input.
 * @param {String} transactionHash - The hash of the transaction to categorize.
 * @param {Array} categories - The categories to assign.
 * @returns {Promise<void>}
 */
cryptoWalletSchema.methods.categorizeTransaction = async function(transactionHash, categories) {
    try {
        const transaction = this.transactions.find(tx => tx.hash === transactionHash);
        if (!transaction) {
            throw new Error('Transaction not found');
        }
        transaction.categories = categories;
        await retryOperation(() => this.save(), { retries: 3 });
        logger.info(`Transaction ${transactionHash} categorized with: ${categories.join(', ')}`);
    } catch (error) {
        logger.error('Error in categorizeTransaction:', error);
        throw error;
    }
};

/**
 * Tag a transaction for better organization and retrieval.
 * @param {String} transactionHash - The hash of the transaction to tag.
 * @param {Array} tags - The tags to assign.
 * @returns {Promise<void>}
 */
cryptoWalletSchema.methods.tagTransaction = async function(transactionHash, tags) {
    try {
        const transaction = this.transactions.find(tx => tx.hash === transactionHash);
        if (!transaction) {
            throw new Error('Transaction not found');
        }
        transaction.tags = tags;
        await retryOperation(() => this.save(), { retries: 3 });
        logger.info(`Transaction ${transactionHash} tagged with: ${tags.join(', ')}`);
    } catch (error) {
        logger.error('Error in tagTransaction:', error);
        throw error;
    }
};

/**
 * Analyze transactions and provide insights.
 * @returns {Object} Insights from transaction data.
 */
cryptoWalletSchema.methods.analyzeTransactions = function() {
    const insights = {
        frequentPartners: {},
        averageAmount: 0,
        peakTimes: {}
    };

    if (this.transactions.length === 0) {
        return insights;
    }

    let totalAmount = 0;
    const timeBuckets = {};

    this.transactions.forEach(tx => {
        const partner = tx.to || tx.from;
        if (partner) {
            insights.frequentPartners[partner] = (insights.frequentPartners[partner] || 0) + 1;
        }

        const amount = parseFloat(tx.amount || '0');
        totalAmount += amount;

        const hour = new Date(tx.timestamp).getHours();
        timeBuckets[hour] = (timeBuckets[hour] || 0) + 1;
    });

    insights.averageAmount = totalAmount / this.transactions.length;

    const peakHour = Object.keys(timeBuckets).reduce((a, b) => timeBuckets[a] > timeBuckets[b] ? a : b);
    insights.peakTimes = { hour: peakHour, transactions: timeBuckets[peakHour] };

    return insights;
};

/**
 * Find or create a crypto wallet.
 * @returns {Promise<mongoose.Document>} The wallet document.
 */
cryptoWalletSchema.statics.findOrCreate = async function() {
    try {
        let wallet = walletCache.get('wallet');
        if (!wallet) {
            wallet = await retryOperation(async () => this.findOne(), { retries: 3 });
            if (!wallet) {
                wallet = new this({});
                await wallet.save();
            }
            walletCache.set('wallet', wallet);
        }
        return wallet;
    } catch (error) {
        logger.error('Error in findOrCreate:', error);
        throw error;
    }
};

/**
 * Health check endpoint for the crypto wallet.
 * @returns {Promise<boolean>} The health status.
 */
cryptoWalletSchema.statics.healthCheck = async function() {
    try {
        const wallet = await this.findOne();
        return !!wallet;
    } catch (error) {
        logger.error('Health check failed:', error);
        return false;
    }
};

const CryptoWallet = mongoose.model('CryptoWallet', cryptoWalletSchema);

export default CryptoWallet;
