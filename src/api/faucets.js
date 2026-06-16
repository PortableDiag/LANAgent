import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import faucetService from '../services/crypto/faucetService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // Cache for 10 minutes

// Rate limiting for faucet claims (more restrictive)
const claimLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // limit each IP to 10 claims per hour
    message: { error: 'Too many faucet claims, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get all available faucets
 */
router.get('/', async (req, res) => {
    try {
        const cacheKey = 'allFaucets';
        let faucets = cache.get(cacheKey);

        if (!faucets) {
            faucets = await retryOperation(() => faucetService.getAllFaucets(), { retries: 3 });
            cache.set(cacheKey, faucets);
        }

        res.json({ 
            success: true, 
            faucets 
        });
    } catch (error) {
        logger.error('Get faucets error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get faucets for specific network
 */
router.get('/network/:network', async (req, res) => {
    try {
        const { network } = req.params;
        const cacheKey = `networkFaucets_${network}`;
        let faucetInfo = cache.get(cacheKey);

        if (!faucetInfo) {
            faucetInfo = await retryOperation(() => faucetService.getFaucetsForNetwork(network), { retries: 3 });
            cache.set(cacheKey, faucetInfo);
        }

        res.json({ 
            success: true, 
            ...faucetInfo 
        });
    } catch (error) {
        logger.error('Get network faucets error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get faucet instructions for a network
 */
router.get('/instructions/:network', async (req, res) => {
    try {
        const { network } = req.params;
        const instructions = await retryOperation(() => faucetService.generateFaucetInstructions(network), { retries: 3 });
        
        res.json({ 
            success: true, 
            instructions 
        });
    } catch (error) {
        logger.error('Get faucet instructions error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Claim from automated faucet (Mumbai)
 */
router.post('/claim/mumbai', claimLimiter, async (req, res) => {
    try {
        const addresses = await retryOperation(() => faucetService.getWalletAddresses(), { retries: 3 });
        const address = addresses.mumbai;
        
        if (!address) {
            return res.status(400).json({ 
                error: 'No Mumbai wallet address found' 
            });
        }
        
        const result = await retryOperation(() => faucetService.claimFromMumbaiFaucet(address), { retries: 3 });
        
        res.json({ 
            success: true, 
            claim: result 
        });
    } catch (error) {
        logger.error('Mumbai faucet claim error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Check testnet token balances
 */
router.get('/balances/:network', async (req, res) => {
    try {
        const { network } = req.params;
        const balances = await retryOperation(() => faucetService.checkTestnetBalances(network), { retries: 3 });
        
        res.json({ 
            success: true, 
            balances 
        });
    } catch (error) {
        logger.error('Check balances error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get claim history
 */
router.get('/history', async (req, res) => {
    try {
        const history = await retryOperation(() => faucetService.getClaimHistory(), { retries: 3 });

        res.json({
            success: true,
            history
        });
    } catch (error) {
        logger.error('Get claim history error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Batch claim from multiple network faucets
 */
router.post('/claim/multi', claimLimiter, async (req, res) => {
    try {
        const { networks } = req.body;

        if (!Array.isArray(networks) || networks.length === 0) {
            return res.status(400).json({
                error: 'networks must be a non-empty array of network names'
            });
        }

        if (networks.length > 5) {
            return res.status(400).json({
                error: 'Maximum 5 networks per batch claim'
            });
        }

        const addresses = await retryOperation(() => faucetService.getWalletAddresses(), { retries: 3 });
        const results = {};

        await Promise.all(networks.map(async (network) => {
            const address = addresses[network];
            if (!address) {
                results[network] = { success: false, error: `No wallet address for ${network}` };
                return;
            }

            let networkFaucets;
            try {
                networkFaucets = await faucetService.getFaucetsForNetwork(network);
            } catch (err) {
                results[network] = { success: false, error: `Unknown network: ${network}` };
                return;
            }

            const automatedFaucets = (networkFaucets.faucets || []).filter(f => f.automated);
            if (automatedFaucets.length === 0) {
                results[network] = { success: false, error: 'No automated faucets available for this network' };
                return;
            }

            const claims = await Promise.all(automatedFaucets.map(async (faucet) => {
                const canClaim = faucetService.canClaim(faucet.apiUrl || faucet.url, address);
                if (!canClaim) {
                    return { faucet: faucet.name, success: false, error: 'Cooldown active' };
                }

                try {
                    const claimResult = await retryOperation(
                        () => faucetService.claimFromApiFaucet(faucet.apiUrl || faucet.url, address, network),
                        { retries: 2 }
                    );
                    return { faucet: faucet.name, ...claimResult };
                } catch (err) {
                    return { faucet: faucet.name, success: false, error: err.message };
                }
            }));

            results[network] = {
                success: claims.some(c => c.success),
                claims
            };
        }));

        // Invalidate faucet caches after claims
        for (const network of networks) {
            cache.del(`networkFaucets_${network}`);
        }
        cache.del('allFaucets');

        res.json({
            success: true,
            results
        });
    } catch (error) {
        logger.error('Multi-network faucet claim error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Claim from Nano faucet (thenanobutton.com via browser automation)
 */
router.post('/claim/nano', claimLimiter, async (req, res) => {
    try {
        const addresses = await faucetService.getWalletAddresses();
        const address = addresses.nano;

        if (!address) {
            return res.status(400).json({ error: 'No Nano wallet address found' });
        }

        const result = await faucetService.claimFromNanoFaucet(address);
        res.json({ success: result.success, claim: result });
    } catch (error) {
        logger.error('Nano faucet claim error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get Nano faucet status
 */
router.get('/nano/status', async (req, res) => {
    try {
        const nanoButtonFaucet = (await import('../services/crypto/nanoButtonFaucet.js')).default;
        res.json({ success: true, ...nanoButtonFaucet.getStatus() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        service: 'faucets',
        timestamp: new Date().toISOString()
    });
});

export default router;