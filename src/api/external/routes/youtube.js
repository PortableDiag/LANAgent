import { Router } from 'express';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { creditAuth } from '../middleware/creditAuth.js';
import { creditDebit } from '../middleware/creditDebit.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';
import YoutubeDownload from '../../../models/YoutubeDownload.js';

const router = Router();

const CREDIT_COSTS = { mp4: 10, mp3: 8 };

// Determine service ID based on format
function getServiceId(format) {
  return format === 'mp3' ? 'youtube-audio' : 'youtube-download';
}

// Best-effort history recording — fire-and-forget so it can never add latency
// to, or fail, a download response.
function recordDownload(fields) {
  YoutubeDownload.create(fields).catch(err =>
    logger.warn(`YouTube history: failed to record download: ${err.message}`)
  );
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
      // apiManager.apis.get(name) returns a wrapper { instance, enabled, ... };
      // unwrap to the actual plugin instance before calling execute().
      const ytdlpEntry = req.app.locals.agent?.apiManager?.apis?.get('ytdlp');
      const ytdlp = ytdlpEntry?.instance || ytdlpEntry;
      if (!ytdlp || ytdlpEntry?.enabled === false || typeof ytdlp.execute !== 'function') {
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
        recordDownload({
          agentId: req.externalAgentId, url, format, quality,
          status: 'failed', error: result.error || 'Download failed'
        });
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

      recordDownload({
        agentId: req.externalAgentId, url, format, quality,
        title: result.title || result.info?.title || '',
        filename: result.file.filename || '',
        fileSize: result.file.size || 0,
        status: 'completed'
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
      recordDownload({
        agentId: req.externalAgentId, url, format, quality,
        status: 'failed', error: error.message || 'Download processing failed'
      });
      res.status(500).json({ success: false, error: 'Download processing failed' });
    }
  }
);

// Paginated download history for the authenticated agent.
router.get('/history', externalAuthMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const history = await YoutubeDownload.getHistory(req.externalAgentId, page, limit);
    res.json({ success: true, ...history });
  } catch (error) {
    logger.error('YouTube history failed:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve download history' });
  }
});

/**
 * Get download quota information for the authenticated agent
 */
router.get('/quota', creditAuth(true), (req, res) => {
  try {
    // creditAuth populates req.creditBalance (the account's remaining credits).
    // Billing here is per-download credit spend, not a daily quota — so report
    // the credit balance and how many downloads of each format it affords.
    const creditsRemaining = req.creditBalance || 0;
    const formatLimits = Object.fromEntries(
      Object.entries(CREDIT_COSTS).map(([format, cost]) => [
        format,
        { cost, remaining: Math.floor(creditsRemaining / cost) }
      ])
    );
    const quotaInfo = {
      creditsRemaining,
      formatLimits
    };

    res.json({
      success: true,
      quota: quotaInfo
    });
  } catch (error) {
    logger.error('YouTube quota check failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve quota information' 
    });
  }
});

export default router;
