import express from 'express';
import { authenticateToken } from '../interfaces/web/auth.js';
import ensService from '../services/crypto/ensService.js';
import { logger } from '../utils/logger.js';
import NodeCache from 'node-cache';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
let initialized = false;

router.use(authenticateToken);

router.use(async (req, res, next) => {
    if (!initialized) {
        try {
            await ensService.initialize();
            initialized = true;
        } catch (err) {
            logger.debug('ENS service init on request:', err.message);
        }
    }
    next();
});

// GET /api/ens/status — current ENS configuration and name status
router.get('/status', async (req, res) => {
    try {
        const cacheKey = 'ens_status';
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ success: true, data: cached });

        const status = await ensService.getStatus();
        if (status.configured) cache.set(cacheKey, status);
        res.json({ success: true, data: status });
    } catch (error) {
        logger.error('Failed to get ENS status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/ens/available/:name — check if a .eth name is available
router.get('/available/:name', async (req, res) => {
    try {
        const { name } = req.params;
        if (!name || name.length < 3) {
            return res.status(400).json({ success: false, error: 'Name must be at least 3 characters' });
        }
        const result = await ensService.checkAvailability(name.toLowerCase());
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to check ENS availability:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/ens/expiry/:name — check expiry of a .eth name
router.get('/expiry/:name', async (req, res) => {
    try {
        const result = await ensService.getExpiry(req.params.name.toLowerCase());
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to check ENS expiry:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/commit — step 1: submit registration commitment
router.post('/commit', async (req, res) => {
    try {
        const { name, years } = req.body;
        if (!name || name.length < 3) {
            return res.status(400).json({ success: false, error: 'Name must be at least 3 characters' });
        }
        const result = await ensService.commitRegistration(name.toLowerCase(), years || 1);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to commit ENS registration:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/register — step 2: complete registration (after commit wait)
router.post('/register', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name required' });
        }
        const result = await ensService.completeRegistration(name.toLowerCase());
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to complete ENS registration:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/subname — create a subname under the base name
router.post('/subname', async (req, res) => {
    try {
        const { label, owner } = req.body;
        if (!label || label.length < 1) {
            return res.status(400).json({ success: false, error: 'Label required' });
        }
        // Default owner to agent's own wallet if not specified
        let ownerAddress = owner;
        if (!ownerAddress) {
            const signer = await (await import('../services/crypto/contractServiceWrapper.js')).default.getSigner('ethereum');
            ownerAddress = await signer.getAddress();
        }
        const result = await ensService.createSubname(label.toLowerCase(), ownerAddress);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to create ENS subname:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/reverse — set reverse resolution (address → name)
router.post('/reverse', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name required (e.g., alice.lanagent.eth)' });
        }
        const result = await ensService.setReverseRecord(name.toLowerCase());
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to set ENS reverse record:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/renew — renew a .eth name
router.post('/renew', async (req, res) => {
    try {
        const { name, years } = req.body;
        const targetName = name || ensService.baseName;
        if (!targetName) {
            return res.status(400).json({ success: false, error: 'No name specified and no base name configured' });
        }
        const result = await ensService.renew(targetName.toLowerCase().replace('.eth', ''), years || 1);
        cache.flushAll();
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to renew ENS name:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/settings — update ENS settings
router.post('/settings', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const { autoRenew, subnamePrice } = req.body;

        if (autoRenew !== undefined) {
            await SystemSettings.setSetting('ens.autoRenew', !!autoRenew, 'Auto-renew ENS names before expiry', 'crypto');
        }
        if (subnamePrice !== undefined && subnamePrice >= 0) {
            await SystemSettings.setSetting('ens.subnamePrice', Number(subnamePrice), 'SKYNET price for P2P subname creation (0=free)', 'crypto');
        }

        res.json({
            success: true,
            data: {
                autoRenew: await SystemSettings.getSetting('ens.autoRenew', true),
                subnamePrice: await SystemSettings.getSetting('ens.subnamePrice', 0)
            }
        });
    } catch (error) {
        logger.error('Failed to update ENS settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/ens/request-subname — request a subname from genesis peer via P2P
router.post('/request-subname', async (req, res) => {
    try {
        const { label } = req.body;
        if (!label || label.length < 1) {
            return res.status(400).json({ success: false, error: 'Label required (e.g., "myagent")' });
        }

        const cleanLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (cleanLabel.length < 1) {
            return res.status(400).json({ success: false, error: 'Label must contain valid characters (a-z, 0-9, -)' });
        }

        // Check if we already have a subname
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const existing = await SystemSettings.getSetting('ens.mySubname', null);
        if (existing) {
            return res.status(409).json({ success: false, error: `Already have subname: ${existing.name}`, data: existing });
        }

        // Find genesis peer
        const genesisPeer = await ensService.findGenesisENSProvider(null);
        if (!genesisPeer) {
            return res.status(404).json({ success: false, error: 'No ENS provider peer found on the network' });
        }

        // Get wallet address
        const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
        const signer = await contractService.getSigner('ethereum');
        const ownerAddress = await signer.getAddress();

        // Get P2P service
        const { default: agent } = await import('../core/agent.js');
        const p2pService = agent?.services?.get('p2p');
        if (!p2pService) {
            return res.status(503).json({ success: false, error: 'P2P service not available' });
        }

        await ensService.requestSubnameFromGenesis(p2pService, genesisPeer.fingerprint, cleanLabel, ownerAddress);
        cache.flushAll();
        res.json({
            success: true,
            data: {
                label: cleanLabel,
                genesisFingerprint: genesisPeer.fingerprint.slice(0, 8) + '...',
                status: 'requested',
                message: `Subname "${cleanLabel}" requested from genesis peer. Check /api/ens/status for updates.`
            }
        });
    } catch (error) {
        logger.error('Failed to request ENS subname:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
