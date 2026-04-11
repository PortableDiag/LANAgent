import { Router } from 'express';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { creditAuth } from '../middleware/creditAuth.js';
import { creditDebit } from '../middleware/creditDebit.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

const CREDIT_COSTS = { mp4: 10, mp3: 8 };

// Determine service ID based on format
function getServiceId(format) {
  return format === 'mp3' ? 'youtube-audio' : 'youtube-download';
}

router.post('/download',
  // Try credit auth first (non-blocking)
  creditAuth(false),
  // If credit auth succeeded, debit credits based on format
  (req, res, next) => {
    const format = req.body?.format || 'mp4';
    const cost = CREDIT_COSTS[format] || CREDIT_COSTS.mp4;
    return creditDebit(cost)(req, res, next);
  },
  // If no credits were used, fall back to legacy auth + payment
  (req, res, next) => {
    if (req.creditsPaid) return next();
    externalAuthMiddleware(req, res, (err) => {
      if (err) return next(err);
      const format = req.body?.format || 'mp4';
      const serviceId = getServiceId(format);
      return paymentMiddleware(serviceId)(req, res, next);
    });
  },
  async (req, res) => {
    const { url, format = 'mp4', quality = 'best' } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'Missing url parameter' });
    }

    // Basic URL validation
    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
      return res.status(400).json({ success: false, error: 'Format must be mp3 or mp4' });
    }

    try {
      const ytdlp = req.app.locals.agent?.apiManager?.apis?.get('ytdlp');
      if (!ytdlp) {
        return res.status(503).json({ success: false, error: 'YouTube service not available' });
      }

      const action = format === 'mp3' ? 'audio' : 'download';
      const result = await ytdlp.execute({
        action,
        url,
        format: format === 'mp3' ? 'mp3' : format,
        quality
      });

      if (!result.success || !result.file?.path) {
        return res.status(500).json({
          success: false,
          error: result.error || 'Download failed'
        });
      }

      const token = generateDownloadToken({
        filePath: result.file.path,
        filename: result.file.filename,
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 60
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: result.file.filename,
        size: result.file.size,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      logger.error('YouTube download failed:', error);
      res.status(500).json({ success: false, error: 'Download processing failed' });
    }
  }
);

export default router;
