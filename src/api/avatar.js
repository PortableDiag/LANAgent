import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../interfaces/web/auth.js';
import { logger } from '../utils/logger.js';
import avatarService from '../services/avatar/avatarService.js';

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

let initialized = false;

// Auth middleware — also accept ?token= query param for img/GLTFLoader requests
router.use((req, res, next) => {
    // Allow query-string token for asset endpoints (model, export, thumbnails)
    if (!req.headers.authorization && req.query.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
    }
    authenticateToken(req, res, next);
});

router.use(async (req, res, next) => {
    if (!initialized) {
        try {
            await avatarService.initialize();
            initialized = true;
        } catch (err) {
            logger.debug('Avatar service init on request:', err.message);
        }
    }
    next();
});

// POST /api/avatar/create
router.post('/create', upload.single('photo'), async (req, res) => {
    try {
        let avatar;
        if (req.file) {
            avatar = await avatarService.createFromPhoto(req.file.buffer, {
                owner: req.body.owner || null,
                provider: req.body.provider || undefined,
                agentId: req.body.agentId ? Number(req.body.agentId) : 0,
                customizations: req.body.customizations ? JSON.parse(req.body.customizations) : {}
            });
        } else if (req.body.prompt) {
            avatar = await avatarService.createFromPrompt(req.body.prompt, {
                owner: req.body.owner || null,
                provider: req.body.provider || undefined,
                agentId: req.body.agentId ? Number(req.body.agentId) : 0,
                customizations: req.body.customizations || {}
            });
        } else {
            return res.status(400).json({ success: false, error: 'Provide a photo file or a prompt' });
        }

        res.json({ success: true, data: avatar });
    } catch (error) {
        logger.error('Failed to create avatar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/gallery
router.get('/gallery', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const avatars = await avatarService.getGallery(limit);
        res.json({ success: true, data: avatars });
    } catch (error) {
        logger.error('Failed to get avatar gallery:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/stats
router.get('/stats', async (req, res) => {
    try {
        const stats = await avatarService.getStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error('Failed to get avatar stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/:avatarId
router.get('/:avatarId', async (req, res) => {
    try {
        const avatar = await avatarService.getAvatar(req.params.avatarId);
        res.json({ success: true, data: avatar });
    } catch (error) {
        logger.error('Failed to get avatar:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// PUT /api/avatar/:avatarId/rename
router.put('/:avatarId/rename', async (req, res) => {
    try {
        const { name } = req.body;
        if (typeof name !== 'string') {
            return res.status(400).json({ success: false, error: 'name string required' });
        }
        const { Avatar } = await import('../models/Avatar.js');
        const avatar = await Avatar.findOneAndUpdate(
            { avatarId: req.params.avatarId },
            { name: name.trim().slice(0, 100) },
            { new: true }
        );
        if (!avatar) return res.status(404).json({ success: false, error: 'Avatar not found' });
        res.json({ success: true, data: avatar });
    } catch (error) {
        logger.error('Failed to rename avatar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/avatar/:avatarId
router.delete('/:avatarId', async (req, res) => {
    try {
        const { Avatar } = await import('../models/Avatar.js');
        const avatar = await Avatar.findOne({ avatarId: req.params.avatarId });
        if (!avatar) return res.status(404).json({ success: false, error: 'Avatar not found' });

        // Delete files
        const fs = (await import('fs')).promises;
        const paths = [avatar.baseModelPath, avatar.bakedModelPath, avatar.thumbnailPath];
        // Also delete source photo
        const path = await import('path');
        const photoPath = path.join(avatarService.dataDir || '/root/lanagent-deploy/data/avatars', 'photos', `${avatar.avatarId}.jpg`);
        paths.push(photoPath);

        for (const p of paths) {
            if (p) await fs.unlink(p).catch(() => {});
        }

        await Avatar.deleteOne({ avatarId: req.params.avatarId });
        logger.info(`Avatar deleted: ${req.params.avatarId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('Failed to delete avatar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/avatar/:avatarId/rig — auto-rig with Blender
router.post('/:avatarId/rig', async (req, res) => {
    try {
        const result = await avatarService.autoRig(req.params.avatarId);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to auto-rig avatar:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// PUT /api/avatar/:avatarId/customize
router.put('/:avatarId/customize', async (req, res) => {
    try {
        const { customizations } = req.body;
        if (!customizations) {
            return res.status(400).json({ success: false, error: 'customizations object required' });
        }

        const avatar = await avatarService.applyCustomizations(req.params.avatarId, customizations);
        res.json({ success: true, data: avatar });
    } catch (error) {
        logger.error('Failed to customize avatar:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/:avatarId/export
router.get('/:avatarId/export', async (req, res) => {
    try {
        const format = req.query.format || 'glb';
        const validFormats = ['glb', 'vrm', 'fbx', 'png', 'gif'];
        if (!validFormats.includes(format)) {
            return res.status(400).json({ success: false, error: `Invalid format. Supported: ${validFormats.join(', ')}` });
        }

        const result = await avatarService.exportAvatar(req.params.avatarId, format);
        res.download(result.path, `avatar-${req.params.avatarId}.${result.format}`);
    } catch (error) {
        logger.error('Failed to export avatar:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/:avatarId/model — serve GLB binary for Three.js viewer
router.get('/:avatarId/model', async (req, res) => {
    try {
        const avatar = await avatarService.getAvatar(req.params.avatarId);
        const modelPath = avatar.bakedModelPath || avatar.baseModelPath;
        if (!modelPath) {
            return res.status(404).json({ success: false, error: 'No model file' });
        }
        res.set('Content-Type', 'model/gltf-binary');
        res.set('Access-Control-Allow-Origin', '*');
        res.sendFile(modelPath);
    } catch (error) {
        logger.error('Failed to serve avatar model:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/avatar/:avatarId/mint
router.post('/:avatarId/mint', async (req, res) => {
    try {
        const result = await avatarService.mintAvatar(req.params.avatarId);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to mint avatar NFT:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/avatar/:avatarId/items
router.get('/:avatarId/items', async (req, res) => {
    try {
        const avatar = await avatarService.getAvatar(req.params.avatarId);
        const items = await avatarService.getAvailableItems(avatar.owner);
        res.json({ success: true, data: items });
    } catch (error) {
        logger.error('Failed to get avatar items:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/avatar/:avatarId/items/unlock
router.post('/:avatarId/items/unlock', async (req, res) => {
    try {
        const { itemId, achievement } = req.body;
        if (!itemId) {
            return res.status(400).json({ success: false, error: 'itemId required' });
        }

        const result = await avatarService.unlockItem(req.params.avatarId, itemId, achievement);
        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('Failed to unlock avatar item:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ success: false, error: error.message });
    }
});

export default router;
