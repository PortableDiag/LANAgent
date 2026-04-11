import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import accountRegistrationService from '../services/accountRegistrationService.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

const router = express.Router();
const accountCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * Invalidate account list cache after any write operation
 */
function invalidateAccountCache() {
    accountCache.flushAll();
}

// Apply auth to all routes
router.use(authenticateToken);

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
router.use(limiter);

// Middleware for logging account activity
router.use((req, res, next) => {
    const { method, originalUrl } = req;
    const userId = req.user ? req.user.id : 'anonymous';
    const timestamp = new Date().toISOString();

    res.on('finish', () => {
        logger.info('Account activity:', {
            timestamp,
            userId,
            method,
            url: originalUrl,
            statusCode: res.statusCode
        });
    });

    next();
});

// List all accounts
router.get('/', async (req, res) => {
    try {
        const { status, serviceName, tags, startDate, endDate } = req.query;
        const filter = {};

        if (status) filter.status = status;
        if (serviceName) filter.serviceName = new RegExp(serviceName, 'i');
        if (tags) filter.tags = { $in: tags.split(',') };
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = new Date(startDate);
            if (endDate) filter.createdAt.$lte = new Date(endDate);
        }
        
        // Use sorted cache key for consistent lookups
        const cacheKey = `accounts:${JSON.stringify(filter, Object.keys(filter).sort())}`;
        const cached = accountCache.get(cacheKey);
        if (cached) {
            return res.json({ success: true, accounts: cached });
        }

        const accounts = await retryOperation(() => accountRegistrationService.listAccounts(filter), { retries: 3 });
        accountCache.set(cacheKey, accounts);
        res.json({
            success: true,
            accounts: accounts
        });
    } catch (error) {
        logger.error('Failed to list accounts:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Register new account (auto-registration via browser automation)
router.post('/register', async (req, res) => {
    try {
        const { serviceName, serviceUrl, credentials, isPrimary } = req.body;

        if (!serviceName || !serviceUrl) {
            return res.status(400).json({
                success: false,
                error: 'Service name and URL are required'
            });
        }

        const account = await retryOperation(() => accountRegistrationService.registerAccount(
            serviceName,
            serviceUrl,
            { credentials, isPrimary }
        ), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            account: {
                id: account._id,
                serviceName: account.serviceName,
                status: account.status,
                verificationStatus: account.verificationStatus,
                isPrimary: account.isPrimary,
                source: account.source
            }
        });
    } catch (error) {
        logger.error('Failed to register account:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Bulk register accounts
router.post('/bulk-register', async (req, res) => {
    try {
        const { accounts } = req.body;

        if (!Array.isArray(accounts) || accounts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Accounts array is required'
            });
        }

        const results = await Promise.all(accounts.map(account =>
            retryOperation(() => accountRegistrationService.registerAccount(
                account.serviceName,
                account.serviceUrl,
                { credentials: account.credentials, isPrimary: account.isPrimary }
            ), { retries: 3 })
        ));

        invalidateAccountCache();

        res.json({
            success: true,
            results: results.map(account => ({
                id: account._id,
                serviceName: account.serviceName,
                status: account.status,
                verificationStatus: account.verificationStatus,
                isPrimary: account.isPrimary,
                source: account.source
            }))
        });
    } catch (error) {
        logger.error('Failed to bulk register accounts:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get account credentials
router.get('/:serviceName/credentials', async (req, res) => {
    try {
        const { serviceName } = req.params;
        const credentials = await retryOperation(() => accountRegistrationService.getAccountCredentials(serviceName), { retries: 3 });
        
        res.json({
            success: true,
            credentials: {
                username: credentials.username,
                email: credentials.email,
                // Don't send password in response for security
                hasPassword: !!credentials.password,
                hasApiKey: !!credentials.apiKey
            }
        });
    } catch (error) {
        logger.error('Failed to get credentials:', error);
        res.status(404).json({
            success: false,
            error: error.message
        });
    }
});

// Update account status
router.patch('/:accountId/status', async (req, res) => {
    try {
        const { accountId } = req.params;
        const { status } = req.body;
        
        if (!['active', 'suspended', 'expired'].includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid status'
            });
        }
        
        const account = await retryOperation(() => accountRegistrationService.updateAccountStatus(accountId, status), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            account: {
                id: account._id,
                status: account.status
            }
        });
    } catch (error) {
        logger.error('Failed to update account status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Bulk update account statuses
router.patch('/bulk-status', async (req, res) => {
    try {
        const { updates } = req.body;

        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Updates array is required'
            });
        }

        const results = await Promise.all(updates.map(update =>
            retryOperation(() => accountRegistrationService.updateAccountStatus(update.accountId, update.status), { retries: 3 })
        ));

        invalidateAccountCache();

        res.json({
            success: true,
            results: results.map(account => ({
                id: account._id,
                status: account.status
            }))
        });
    } catch (error) {
        logger.error('Failed to bulk update account statuses:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete account
router.delete('/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        await retryOperation(() => accountRegistrationService.deleteAccount(accountId), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            message: 'Account deleted successfully'
        });
    } catch (error) {
        logger.error('Failed to delete account:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check verification status
router.post('/:accountId/check-verification', async (req, res) => {
    try {
        const { accountId } = req.params;
        await retryOperation(() => accountRegistrationService.checkVerificationEmail(accountId), { retries: 3 });
        
        res.json({
            success: true,
            message: 'Verification check initiated'
        });
    } catch (error) {
        logger.error('Failed to check verification:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add manual account
router.post('/manual', async (req, res) => {
    try {
        const { serviceName, serviceUrl, credentials, credentialType, isPrimary, notes, tags } = req.body;

        if (!serviceName) {
            return res.status(400).json({
                success: false,
                error: 'Service name is required'
            });
        }

        if (!credentials || (!credentials.email && !credentials.username && !credentials.apiKey)) {
            return res.status(400).json({
                success: false,
                error: 'At least one credential (email, username, or apiKey) is required'
            });
        }

        const account = await retryOperation(() => accountRegistrationService.addManualAccount({
            serviceName,
            serviceUrl,
            credentials,
            credentialType,
            isPrimary,
            notes,
            tags
        }), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            account: {
                id: account._id,
                serviceName: account.serviceName,
                status: account.status,
                isPrimary: account.isPrimary,
                credentialType: account.credentialType,
                source: account.source
            }
        });
    } catch (error) {
        logger.error('Failed to add manual account:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get primary account for a service
router.get('/primary/:serviceName', async (req, res) => {
    try {
        const { serviceName } = req.params;
        const account = await retryOperation(() => accountRegistrationService.getPrimaryAccount(serviceName), { retries: 3 });

        if (!account) {
            return res.status(404).json({
                success: false,
                error: `No primary account found for ${serviceName}`
            });
        }

        res.json({
            success: true,
            account: {
                id: account._id,
                serviceName: account.serviceName,
                status: account.status,
                credentials: {
                    username: account.credentials.username,
                    email: account.credentials.email,
                    hasPassword: !!account.credentials.password,
                    hasApiKey: !!account.credentials.apiKey
                }
            }
        });
    } catch (error) {
        logger.error('Failed to get primary account:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Set account as primary
router.patch('/:accountId/primary', async (req, res) => {
    try {
        const { accountId } = req.params;
        const account = await retryOperation(() => accountRegistrationService.setPrimaryAccount(accountId), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            account: {
                id: account._id,
                serviceName: account.serviceName,
                isPrimary: account.isPrimary
            }
        });
    } catch (error) {
        logger.error('Failed to set primary account:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update account credentials
router.patch('/:accountId/credentials', async (req, res) => {
    try {
        const { accountId } = req.params;
        const { credentials } = req.body;

        if (!credentials) {
            return res.status(400).json({
                success: false,
                error: 'Credentials are required'
            });
        }

        const account = await retryOperation(() => accountRegistrationService.updateCredentials(accountId, credentials), { retries: 3 });

        invalidateAccountCache();

        res.json({
            success: true,
            message: 'Credentials updated successfully',
            account: {
                id: account._id,
                serviceName: account.serviceName
            }
        });
    } catch (error) {
        logger.error('Failed to update credentials:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add registration strategy
router.post('/strategies', async (req, res) => {
    try {
        const { serviceName, strategy } = req.body;
        
        if (!serviceName || !strategy) {
            return res.status(400).json({
                success: false,
                error: 'Service name and strategy are required'
            });
        }
        
        accountRegistrationService.addStrategy(serviceName, strategy);
        
        res.json({
            success: true,
            message: `Strategy added for ${serviceName}`
        });
    } catch (error) {
        logger.error('Failed to add strategy:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
