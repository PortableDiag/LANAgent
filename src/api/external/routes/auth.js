import { Router } from 'express';
import crypto from 'crypto';
import NodeCache from 'node-cache';
import jwt from 'jsonwebtoken';
import { logger } from '../../../utils/logger.js';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import rateLimit from 'express-rate-limit';
import { retryOperation } from '../../../utils/retryUtils.js';

const router = Router();

// Nonce cache — 5 minute TTL
const nonceCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// JWT secret — persists for process lifetime, regenerated on restart
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Export for use by creditAuth middleware
export { JWT_SECRET };

// Rate limiting middleware
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per windowMs
  message: { success: false, error: 'Too many requests, please try again later.' }
});

/**
 * GET /api/external/auth/nonce?wallet=0x...
 * Generate a signing nonce for wallet authentication
 */
router.get('/nonce', authRateLimiter, (req, res) => {
  const { wallet } = req.query;

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ success: false, error: 'Valid wallet address required' });
  }

  const normalizedWallet = wallet.toLowerCase();
  const nonce = `lanagent_auth_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  nonceCache.set(`nonce:${normalizedWallet}`, nonce);

  res.json({
    success: true,
    nonce,
    expiresIn: 300
  });
});

/**
 * POST /api/external/auth/verify
 * Verify wallet signature and issue JWT
 */
router.post('/verify', authRateLimiter, async (req, res) => {
  try {
    const { wallet, signature, nonce } = req.body;

    if (!wallet || !signature || !nonce) {
      return res.status(400).json({ success: false, error: 'wallet, signature, and nonce are required' });
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ success: false, error: 'Invalid wallet address' });
    }

    const normalizedWallet = wallet.toLowerCase();

    // Verify nonce exists and matches
    const storedNonce = nonceCache.get(`nonce:${normalizedWallet}`);
    if (!storedNonce || storedNonce !== nonce) {
      return res.status(400).json({ success: false, error: 'Invalid or expired nonce' });
    }

    // Consume nonce (one-time use)
    nonceCache.del(`nonce:${normalizedWallet}`);

    // Verify signature using ethers
    const { ethers } = await import('ethers');
    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyMessage(nonce, signature);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== normalizedWallet) {
      return res.status(403).json({ success: false, error: 'Signature does not match wallet' });
    }

    // Ensure account exists
    let account = await retryOperation(() => ExternalCreditBalance.findByWallet(normalizedWallet), { retries: 3 });
    if (!account) {
      account = await retryOperation(() => ExternalCreditBalance.create({ wallet: normalizedWallet }), { retries: 3 });
    }

    // Issue JWT (1 hour expiry — used for key management and credit purchases)
    const token = jwt.sign(
      { wallet: normalizedWallet },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      token,
      expiresIn: 3600,
      wallet: normalizedWallet,
      credits: account.credits
    });
  } catch (error) {
    logger.error('Auth verify error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

/**
 * Middleware: require JWT for key management routes
 */
function requireJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'JWT required' });
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.wallet = decoded.wallet;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * POST /api/external/auth/api-key
 * Generate a new API key for the authenticated wallet
 */
router.post('/api-key', requireJWT, async (req, res) => {
  try {
    const { name } = req.body;
    const key = `lsk_${crypto.randomBytes(16).toString('hex')}`;

    const account = await retryOperation(() => ExternalCreditBalance.findOneAndUpdate(
      { wallet: req.wallet },
      {
        $push: {
          apiKeys: {
            key,
            name: name || 'Default',
            createdAt: new Date()
          }
        }
      },
      { new: true, upsert: true }
    ), { retries: 3 });

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to create API key' });
    }

    res.json({
      success: true,
      apiKey: key,
      name: name || 'Default',
      message: 'Store this key securely. It cannot be retrieved again.'
    });
  } catch (error) {
    logger.error('API key creation error:', error);
    res.status(500).json({ success: false, error: 'Failed to create API key' });
  }
});

/**
 * DELETE /api/external/auth/api-key/:key
 * Revoke an API key
 */
router.delete('/api-key/:key', requireJWT, async (req, res) => {
  try {
    const { key } = req.params;

    const result = await retryOperation(() => ExternalCreditBalance.findOneAndUpdate(
      { wallet: req.wallet, 'apiKeys.key': key },
      { $set: { 'apiKeys.$.revoked': true } },
      { new: true }
    ), { retries: 3 });

    if (!result) {
      return res.status(404).json({ success: false, error: 'API key not found' });
    }

    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    logger.error('API key revocation error:', error);
    res.status(500).json({ success: false, error: 'Failed to revoke API key' });
  }
});

/**
 * GET /api/external/auth/api-keys
 * List all API keys for the authenticated wallet
 */
router.get('/api-keys', requireJWT, async (req, res) => {
  try {
    const account = await retryOperation(() => ExternalCreditBalance.findByWallet(req.wallet), { retries: 3 });
    if (!account) {
      return res.json({ success: true, apiKeys: [] });
    }

    // Return keys with masked values
    const apiKeys = account.apiKeys.map(k => ({
      key: `${k.key.slice(0, 8)}...${k.key.slice(-4)}`,
      name: k.name,
      createdAt: k.createdAt,
      lastUsed: k.lastUsed,
      revoked: k.revoked
    }));

    res.json({ success: true, apiKeys });
  } catch (error) {
    logger.error('API key list error:', error);
    res.status(500).json({ success: false, error: 'Failed to list API keys' });
  }
});

export default router;
