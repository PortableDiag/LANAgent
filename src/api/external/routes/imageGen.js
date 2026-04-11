import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';

const SUPPORTED_FORMATS = ['png', 'jpeg', 'webp', 'tiff'];

const router = Router();

router.post('/generate',
  ...hybridAuth('image-generation', 30),
  async (req, res) => {
    const { prompt, style, size, provider, model, format = 'png', count = 1 } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'prompt required (min 3 characters)' });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({ success: false, error: 'prompt too long (max 4000 characters)' });
    }

    if (!SUPPORTED_FORMATS.includes(format)) {
      return res.status(400).json({ success: false, error: `Unsupported format '${format}'. Supported: ${SUPPORTED_FORMATS.join(', ')}` });
    }

    const imageCount = Math.max(1, Math.min(10, parseInt(count, 10) || 1));

    try {
      const imageService = (await import('../../../services/media/imageGenerationService.js')).default;
      if (!imageService.initialized) {
        const providerManager = req.app.locals.agent?.providerManager;
        if (!providerManager) {
          return res.status(503).json({ success: false, error: 'Image generation service not available — agent not fully initialized' });
        }
        await imageService.initialize(providerManager);
      }

      const options = {};
      if (provider) options.provider = provider;
      if (model) options.model = model;
      if (size) options.size = size;
      if (style) options.style = style;

      // Generate imageCount images using Promise.allSettled for partial success
      const generateOne = () => retryOperation(() => imageService.generate(prompt, options), { retries: 3 });
      const settled = await Promise.allSettled(
        Array.from({ length: imageCount }, () => generateOne())
      );

      const images = [];
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled' || !outcome.value.success || !outcome.value.images?.length) continue;
        const image = outcome.value.images[0];
        const buffer = image.buffer || (image.base64 ? Buffer.from(image.base64, 'base64') : null);
        if (!buffer) continue;

        const filename = `generated-${crypto.randomBytes(8).toString('hex')}.${format}`;
        const filePath = path.resolve('data/external-uploads', filename);
        if (format !== 'png') {
          await sharp(buffer).toFormat(format).toFile(filePath);
        } else {
          await fs.writeFile(filePath, buffer);
        }

        const token = generateDownloadToken({
          filePath,
          filename,
          agentId: req.externalAgentId,
          maxDownloads: 3,
          expiresInMinutes: 60
        });

        images.push({
          downloadUrl: `/api/external/download/${token}`,
          filename,
          model: outcome.value.model,
          tokenExpires: '60 minutes',
          maxDownloads: 3
        });
      }

      if (images.length === 0) {
        return res.status(500).json({ success: false, error: 'Image generation failed' });
      }

      // Backward compatible: single-image fields + images array
      res.json({
        success: true,
        downloadUrl: images[0].downloadUrl,
        filename: images[0].filename,
        model: images[0].model,
        tokenExpires: '60 minutes',
        maxDownloads: 3,
        images,
        requested: imageCount,
        generated: images.length
      });
    } catch (error) {
      logger.error('Image generation failed:', error);
      res.status(500).json({ success: false, error: 'Image generation failed' });
    }
  }
);

export default router;
