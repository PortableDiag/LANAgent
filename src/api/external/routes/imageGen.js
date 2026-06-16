import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { generateDownloadToken, verifyDownloadToken } from '../services/downloadTokenService.js';
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

/**
 * Technical metadata for a previously generated image, looked up by
 * the same download token returned from /generate. Pulls sharp's
 * decoder-level details (format, dims, color, EXIF, ICC, animation
 * frame info) plus the token-encoded provenance (filename, agentId,
 * expiry). The token must already exist and the underlying file must
 * still be on disk; expired tokens 401, missing files 404.
 *
 * Intentionally does NOT return AI-content-analysis fields (objects,
 * scenes, OCR) or generation parameters (prompt, model, style) —
 * neither has a real source today (no vision service is wired, and
 * imageGenerationService does not persist per-image generation
 * params anywhere queryable). Adding stub fields that are always
 * empty creates a worse API than not having them.
 */
router.get('/images/:token/metadata', externalAuthMiddleware, async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid token' });
    }

    const tokenData = verifyDownloadToken(token);
    if (!tokenData || !tokenData.filePath) {
      return res.status(401).json({ success: false, error: 'Token expired or invalid' });
    }

    // Same agent that minted the token must be requesting it.
    if (tokenData.agentId && req.externalAgentId && tokenData.agentId !== req.externalAgentId) {
      return res.status(403).json({ success: false, error: 'Token does not belong to this agent' });
    }

    try {
      await fs.access(tokenData.filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'Image file no longer on disk' });
    }

    let raw;
    try {
      raw = await sharp(tokenData.filePath).metadata();
    } catch (err) {
      logger.warn(`Sharp metadata extraction failed for ${tokenData.filename}: ${err.message}`);
      return res.status(500).json({ success: false, error: 'Could not read image metadata' });
    }

    // Sharp returns EXIF/ICC as Buffers when present — pass back length-only
    // descriptors (parsing the actual bytes would need a separate decoder).
    const technical = {
      format: raw.format ?? null,
      width: raw.width ?? null,
      height: raw.height ?? null,
      channels: raw.channels ?? null,
      depth: raw.depth ?? null,
      density: raw.density ?? null,
      space: raw.space ?? null,
      hasAlpha: raw.hasAlpha ?? null,
      hasProfile: raw.hasProfile ?? null,
      isProgressive: raw.isProgressive ?? null,
      orientation: raw.orientation ?? null,
      pages: raw.pages ?? null,
      pageHeight: raw.pageHeight ?? null,
      loop: raw.loop ?? null,
      size: raw.size ?? null,
      exifBytes: Buffer.isBuffer(raw.exif) ? raw.exif.length : null,
      iccBytes: Buffer.isBuffer(raw.icc) ? raw.icc.length : null,
      iptcBytes: Buffer.isBuffer(raw.iptc) ? raw.iptc.length : null,
      xmpBytes: Buffer.isBuffer(raw.xmp) ? raw.xmp.length : null
    };

    const tokenInfo = {
      filename: tokenData.filename || null,
      agentId: tokenData.agentId || null,
      maxDownloads: tokenData.maxDownloads ?? null,
      // jwt's `exp` claim is unix seconds; surface as ISO for caller clarity
      expiresAt: tokenData.exp ? new Date(tokenData.exp * 1000).toISOString() : null
    };

    res.json({ success: true, technical, token: tokenInfo });
  } catch (error) {
    logger.error('Image metadata endpoint error:', error);
    res.status(500).json({ success: false, error: 'Metadata lookup failed' });
  }
});

router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    supportedFormats: SUPPORTED_FORMATS
  });
});

export default router;
