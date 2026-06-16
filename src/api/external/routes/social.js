/**
 * Generic social-media downloader route.
 *
 * Accepts any URL and dispatches to the right extractor:
 *   - x.com / twitter.com → twitter plugin (custom syndication-API extractor)
 *   - everything else     → ytdlp plugin (yt-dlp's ~1800-site extractor list)
 *
 * Returns the same downloadUrl-token shape as /youtube/download so existing
 * downstream consumers (SKYNET API bot etc.) only need to swap the path.
 *
 * Phase 1 scope: cookie-free sites that work without special infrastructure.
 * Verified working from production: YouTube, TikTok, SoundCloud, Dailymotion,
 * Bilibili, Streamable, Twitch (live URLs), x.com (via twitter plugin), plus
 * the long tail of yt-dlp's other extractors. Cloudflare-gated sites (Rumble,
 * BitChute) and cookie-required sites (Instagram, Facebook) are deferred to
 * phases 2 + 3.
 */

import { Router } from 'express';
import { stat } from 'fs/promises';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { creditAuth } from '../middleware/creditAuth.js';
import { creditDebit } from '../middleware/creditDebit.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

const CREDIT_COSTS = { mp4: 10, mp3: 8 };

function getServiceId(format) {
  return format === 'mp3' ? 'social-audio' : 'social-download';
}

// Identify which plugin should handle this URL. Returns one of:
//   'twitter' — dispatch to the twitter plugin's `download` action
//   'ytdlp'   — dispatch to yt-dlp (default)
//   null      — URL is not a parseable http(s) URL
function pickExtractor(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'twitter';
  return 'ytdlp';
}

router.post('/download',
  // Same auth/payment chain as /youtube/download — credit auth first, fall
  // back to legacy externalAuth + paymentMiddleware for non-credit clients.
  creditAuth(false),
  (req, res, next) => {
    const format = req.body?.format || 'mp4';
    const cost = CREDIT_COSTS[format] || CREDIT_COSTS.mp4;
    return creditDebit(cost)(req, res, next);
  },
  (req, res, next) => {
    if (req.creditsPaid) return next();
    externalAuthMiddleware(req, res, (err) => {
      if (err) return next(err);
      const format = req.body?.format || 'mp4';
      return paymentMiddleware(getServiceId(format))(req, res, next);
    });
  },
  async (req, res) => {
    const { url, format = 'mp4', quality = 'best' } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing url parameter' });
    }
    if (!['mp3', 'mp4'].includes(format)) {
      return res.status(400).json({ success: false, error: 'Format must be mp3 or mp4' });
    }

    const extractor = pickExtractor(url);
    if (!extractor) {
      return res.status(400).json({ success: false, error: 'Invalid URL' });
    }

    try {
      const apis = req.app.locals.agent?.apiManager?.apis;
      if (!apis) {
        return res.status(503).json({ success: false, error: 'Agent not ready' });
      }

      let result;
      if (extractor === 'twitter') {
        // The twitter plugin has its own audio/video logic; it doesn't take
        // a `format` param — mp3 requests fall back to the embedded video
        // (caller can transcode via /transcode if pure audio is needed).
        const entry = apis.get('twitter');
        const twitter = entry?.instance || entry;
        if (!twitter?.execute) {
          return res.status(503).json({ success: false, error: 'Twitter extractor not available' });
        }
        result = await twitter.execute({ action: 'download', url });
      } else {
        const entry = apis.get('ytdlp');
        const ytdlp = entry?.instance || entry;
        if (!ytdlp?.execute) {
          return res.status(503).json({ success: false, error: 'yt-dlp extractor not available' });
        }
        const action = format === 'mp3' ? 'audio' : 'download';
        result = await ytdlp.execute({
          action,
          url,
          format: format === 'mp3' ? 'mp3' : format,
          quality
        });
      }

      // No file produced — could be a text-only post, oversized, or extractor
      // failure. Return whatever the plugin captured so the caller can show
      // the user something meaningful.
      if (!result?.success || !result?.file?.path) {
        return res.status(result?.success ? 200 : 500).json({
          success: !!result?.success,
          extractor,
          error: result?.error || (result?.success ? null : 'Download failed'),
          result: result?.result || null
        });
      }

      // Best-effort size lookup if the extractor didn't fill it in.
      let size = result.file.size;
      if (!size) {
        try { size = (await stat(result.file.path)).size; } catch {}
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
        extractor,
        downloadUrl: `/api/external/download/${token}`,
        filename: result.file.filename,
        size,
        caption: result.result || null,
        tokenExpires: '60 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      logger.error(`[social/download] ${extractor} failed for ${url}: ${error.message}`);
      res.status(500).json({ success: false, extractor, error: 'Download processing failed' });
    }
  }
);

// Probe an arbitrary URL — returns which extractor would handle it and (for
// yt-dlp URLs) basic metadata. No download, no credit charge — useful for
// the SKYNET API bot to confirm a URL is supported before debiting credits.
router.post('/probe', creditAuth(false), async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing url parameter' });
  }
  const extractor = pickExtractor(url);
  if (!extractor) {
    return res.status(400).json({ success: false, error: 'Invalid URL' });
  }
  try {
    const apis = req.app.locals.agent?.apiManager?.apis;
    if (extractor === 'twitter') {
      // Twitter probe == extract metadata without downloading media.
      const entry = apis?.get('twitter');
      const twitter = entry?.instance || entry;
      if (!twitter?.execute) return res.json({ success: true, extractor, available: false });
      const r = await twitter.execute({ action: 'extract', url });
      return res.json({ success: !!r?.success, extractor, ...(r?.data || {}), summary: r?.result || null });
    }
    const entry = apis?.get('ytdlp');
    const ytdlp = entry?.instance || entry;
    if (!ytdlp?.execute) return res.json({ success: true, extractor, available: false });
    // ytdlp plugin already exposes an `info` action that runs --dump-json.
    const r = await ytdlp.execute({ action: 'info', url });
    return res.json({ success: !!r?.success, extractor, ...(r?.data || r || {}) });
  } catch (e) {
    return res.status(500).json({ success: false, extractor, error: e.message });
  }
});

router.get('/supported-sites', async (req, res) => {
  try {
    const apis = req.app.locals.agent?.apiManager?.apis;
    if (!apis) {
      return res.status(503).json({ success: false, error: 'Agent not ready' });
    }

    const sites = [];

    const twitterEntry = apis.get('twitter');
    const twitter = twitterEntry?.instance || twitterEntry;
    if (twitter?.execute) {
      sites.push({ extractor: 'twitter', hosts: ['x.com', 'twitter.com'], capabilities: ['download', 'extract'] });
    }

    const ytdlpEntry = apis.get('ytdlp');
    const ytdlp = ytdlpEntry?.instance || ytdlpEntry;
    if (ytdlp?.execute) {
      sites.push({
        extractor: 'ytdlp',
        verified: ['youtube.com', 'tiktok.com', 'soundcloud.com', 'dailymotion.com', 'bilibili.com', 'streamable.com', 'twitch.tv'],
        capabilities: ['download', 'audio', 'info']
      });
    }

    res.json({ success: true, sites });
  } catch (error) {
    logger.error(`[social/supported-sites] ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to retrieve supported sites' });
  }
});

export default router;
