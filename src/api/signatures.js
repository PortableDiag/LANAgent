import express from 'express';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import signatureService, { MESSAGE_TYPES } from '../services/crypto/signatureService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const MAX_SIGN_BATCH_SIZE = 100;

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Apply compression middleware
router.use(compression());

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
router.use(limiter);

/**
 * Get cached data or fetch if not present
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

/**
 * Batch verify signatures
 */
router.post('/verify-batch', async (req, res) => {
    try {
        const { messages, signatures, expectedAddresses } = req.body;

        if (!messages || !signatures || messages.length !== signatures.length) {
            return res.status(400).json({
                error: 'Messages and signatures are required and must be of the same length'
            });
        }

        const verifyPromises = messages.map((message, index) => {
            return retryOperation(() => signatureService.verifySignature(
                message,
                signatures[index],
                expectedAddresses ? expectedAddresses[index] : undefined
            ));
        });

        const results = await Promise.all(verifyPromises);

        res.json({
            success: true,
            results
        });
    } catch (error) {
        logger.error('Batch verify signatures error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Sign a message
 */
router.post('/sign-message', async (req, res) => {
    try {
        const { message, network = 'ethereum', purpose } = req.body;

        if (!message) {
            return res.status(400).json({
                error: 'Message is required'
            });
        }

        const result = await getCachedData(`sign-message-${message}`, () => 
            signatureService.signMessage(message, { network, purpose })
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Sign message error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Sign typed data (EIP-712)
 */
router.post('/sign-typed-data', async (req, res) => {
    try {
        const { domain, types, value, network = 'ethereum' } = req.body;

        if (!types || !value) {
            return res.status(400).json({
                error: 'Types and value are required'
            });
        }

        const result = await getCachedData(`sign-typed-data-${JSON.stringify(value)}`, () => 
            signatureService.signTypedData(domain, types, value, { network })
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Sign typed data error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Create SIWE message
 */
router.post('/siwe/create', async (req, res) => {
    try {
        const message = signatureService.createSIWEMessage(req.body);

        res.json({
            success: true,
            message
        });
    } catch (error) {
        logger.error('Create SIWE message error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Sign SIWE message
 */
router.post('/siwe/sign', async (req, res) => {
    try {
        const result = await signatureService.signSIWE(req.body);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Sign SIWE error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Verify signature
 */
router.post('/verify', async (req, res) => {
    try {
        const { message, signature, expectedAddress } = req.body;

        if (!message || !signature) {
            return res.status(400).json({
                error: 'Message and signature are required'
            });
        }

        const result = await retryOperation(() => signatureService.verifySignature(
            message,
            signature,
            expectedAddress
        ));

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Verify signature error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Verify typed data signature
 */
router.post('/verify-typed-data', async (req, res) => {
    try {
        const { domain, types, value, signature, expectedAddress } = req.body;

        if (!domain || !types || !value || !signature) {
            return res.status(400).json({
                error: 'Domain, types, value and signature are required'
            });
        }

        const result = await retryOperation(() => signatureService.verifyTypedDataSignature(
            domain,
            types,
            value,
            signature,
            expectedAddress
        ));

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Verify typed data signature error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Batch verify typed data signatures
 */
router.post('/verify-typed-data-batch', async (req, res) => {
    try {
        const { domains, types, values, signatures, expectedAddresses } = req.body;

        if (!domains || !types || !values || !signatures ||
            domains.length !== types.length ||
            domains.length !== values.length ||
            domains.length !== signatures.length) {
            return res.status(400).json({
                error: 'Domains, types, values, and signatures arrays are required and must be of the same length'
            });
        }

        const results = await signatureService.verifyTypedDataSignaturesBatch(
            domains, types, values, signatures, expectedAddresses
        );

        res.json({
            success: true,
            results
        });
    } catch (error) {
        logger.error('Batch verify typed data signatures error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Create multi-signature request
 */
router.post('/multisig/create', async (req, res) => {
    try {
        const result = await signatureService.createMultiSigRequest(req.body);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Create multisig request error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Add signature to multi-sig request
 */
router.post('/multisig/:requestId/sign', async (req, res) => {
    try {
        const { requestId } = req.params;
        const { signature, signerAddress } = req.body;

        if (!signature || !signerAddress) {
            return res.status(400).json({
                error: 'Signature and signer address are required'
            });
        }

        const result = await signatureService.addMultiSigSignature(
            requestId,
            signature,
            signerAddress
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('Add multisig signature error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Get signing history
 */
router.get('/history', async (req, res) => {
    try {
        const { address } = req.query;
        const history = await getCachedData(`history-${address}`, () => 
            signatureService.getSigningHistory(address)
        );

        res.json({
            success: true,
            history
        });
    } catch (error) {
        logger.error('Get signing history error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Export signature
 */
router.post('/export', async (req, res) => {
    try {
        const { signature, message, metadata } = req.body;

        if (!signature || !message) {
            return res.status(400).json({
                error: 'Signature and message are required'
            });
        }

        const exported = signatureService.exportSignature(
            signature,
            message,
            metadata
        );

        res.json({
            success: true,
            exported
        });
    } catch (error) {
        logger.error('Export signature error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Create signature proof
 */
router.post('/proof', async (req, res) => {
    try {
        const { signature, message, metadata } = req.body;

        if (!signature || !message) {
            return res.status(400).json({
                error: 'Signature and message are required'
            });
        }

        const proof = await signatureService.createSignatureProof(
            signature,
            message,
            metadata
        );

        res.json({
            success: true,
            proof
        });
    } catch (error) {
        logger.error('Create signature proof error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Sign a batch of messages
 */
router.post('/sign-batch', async (req, res) => {
    try {
        const {
            messages,
            items,
            network = 'ethereum',
            purpose
        } = req.body || {};

        if (Array.isArray(messages) && Array.isArray(items)) {
            return res.status(400).json({
                error: 'Provide either messages or items, not both'
            });
        }

        let signingItems;

        if (Array.isArray(items)) {
            if (items.length === 0) {
                return res.status(400).json({
                    error: 'An array of items is required'
                });
            }

            if (items.length > MAX_SIGN_BATCH_SIZE) {
                return res.status(400).json({
                    error: `Batch size must not exceed ${MAX_SIGN_BATCH_SIZE} items`
                });
            }

            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];

                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    return res.status(400).json({
                        error: `Item at index ${index} must be an object`
                    });
                }

                if (typeof item.message !== 'string' || item.message.length === 0) {
                    return res.status(400).json({
                        error: `Item at index ${index} must include a non-empty message`
                    });
                }

                if (item.network !== undefined &&
                    (typeof item.network !== 'string' || item.network.length === 0)) {
                    return res.status(400).json({
                        error: `Item at index ${index} must include a non-empty network`
                    });
                }

                if (item.purpose !== undefined &&
                    (typeof item.purpose !== 'string' || item.purpose.length === 0)) {
                    return res.status(400).json({
                        error: `Item at index ${index} must include a non-empty purpose`
                    });
                }
            }

            signingItems = items.map(item => ({
                message: item.message,
                network: item.network === undefined ? 'ethereum' : item.network,
                purpose: item.purpose
            }));
        } else {
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({
                    error: 'An array of messages or items is required'
                });
            }

            if (messages.length > MAX_SIGN_BATCH_SIZE) {
                return res.status(400).json({
                    error: `Batch size must not exceed ${MAX_SIGN_BATCH_SIZE} messages`
                });
            }

            for (let index = 0; index < messages.length; index += 1) {
                if (typeof messages[index] !== 'string' || messages[index].length === 0) {
                    return res.status(400).json({
                        error: `Message at index ${index} must be a non-empty string`
                    });
                }
            }

            signingItems = messages.map(message => ({
                message,
                network,
                purpose
            }));
        }

        const results = await Promise.all(
            signingItems.map(async item => {
                const result = await signatureService.signMessage(
                    item.message,
                    {
                        network: item.network,
                        purpose: item.purpose
                    }
                );

                // Echo what was actually signed with: signMessage defaults a missing
                // purpose to CUSTOM, so report that rather than undefined.
                return {
                    ...result,
                    network: item.network,
                    purpose: item.purpose ?? MESSAGE_TYPES.CUSTOM
                };
            })
        );

        res.json({
            success: true,
            results
        });
    } catch (error) {
        logger.error('Sign batch error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

export default router;
