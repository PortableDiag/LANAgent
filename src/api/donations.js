import express from 'express';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import donationService from '../services/crypto/donationService.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Initialize cache with a 5-minute TTL and a 1-minute check period
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Rate limiter to limit requests to 100 per 15 minutes per IP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all routes
router.use(limiter);

// Apply authentication middleware to all routes
router.use(authMiddleware);

/**
 * Get donation addresses for all networks
 */
router.get('/addresses', async (req, res) => {
    try {
        const addresses = await getCachedData('donationAddresses', donationService.getDonationAddresses);
        res.json({ 
            success: true, 
            addresses 
        });
    } catch (error) {
        logger.error('Get donation addresses error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Generate QR code for address
 */
router.post('/qr-code', async (req, res) => {
    try {
        const { address, network = 'ethereum', size = 256, amount = null } = req.body;
        
        if (!address) {
            return res.status(400).json({ 
                error: 'Address is required' 
            });
        }
        
        const qrCode = await donationService.generateQRCode(address, {
            network,
            size,
            amount,
            format: 'png'
        });
        
        res.json({ 
            success: true, 
            qrCode 
        });
    } catch (error) {
        logger.error('Generate QR code error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get donation widget configuration
 */
router.post('/widget', async (req, res) => {
    try {
        const widget = await donationService.createDonationWidget(req.body);
        res.json({ 
            success: true, 
            widget 
        });
    } catch (error) {
        logger.error('Create donation widget error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Generate payment links
 */
router.get('/payment-links/:network/:address', async (req, res) => {
    try {
        const { network, address } = req.params;
        const { amount } = req.query;
        
        const links = donationService.generatePaymentLinks(address, network, amount);
        
        res.json({ 
            success: true, 
            links 
        });
    } catch (error) {
        logger.error('Generate payment links error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Track donation (analytics)
 */
router.post('/track', async (req, res) => {
    try {
        const { network, address, amount, currency } = req.body;
        
        await retryOperation(() => donationService.trackDonation(network, address, amount, currency), {
            retries: 3,
            factor: 2,
            minTimeout: 1000,
            randomize: true // Add jitter to the retry mechanism
        });
        
        res.json({ 
            success: true 
        });
    } catch (error) {
        logger.error('Track donation error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Generate donation page HTML
 */
router.post('/generate-page', async (req, res) => {
    try {
        const html = await donationService.generateDonationHTML(req.body);
        
        res.json({ 
            success: true, 
            html 
        });
    } catch (error) {
        logger.error('Generate donation page error:', error);
        res.status(500).json({ 
            error: error.message 
        });
    }
});

/**
 * Get cached data or fetch and cache it
 * @param {string} key - Cache key
 * @param {Function} fetchFunc - Function to fetch data if not cached
 * @returns {Promise<any>} - Cached or fetched data
 */
async function getCachedData(key, fetchFunc) {
    const cached = cache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const data = await fetchFunc();
    cache.set(key, data);
    return data;
}

export default router;
