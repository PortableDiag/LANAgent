/**
 * Image transcode service — POST /api/external/service/imageTools/transcode
 *
 * Stateless format transcode (avif/png/jpeg/webp) with server-side oversize
 * passthrough. Offloads the heavy libvips/AOM AVIF working set off small caller
 * boxes (e.g. ScrapeCache) onto the agent host. Flat 2 credits, refunded on any
 * failure. Mounted BEFORE the generic /service proxy so it takes precedence.
 *
 * Transport: multipart field "image" (≤100MB, under the CF body cap), or base64
 * in "image", or "url" for sources too large to upload. Encoder is sharp
 * (libvips→libaom); at quality:82/effort:2/4:4:4 output matches a libaom q82 4:4:4.
 *
 * Optional "preset" supplies DEFAULTS for target/quality/effort/lossless. Any
 * field sent explicitly always wins, so adding a preset can never change the
 * result for a caller that already specifies its own parameters.
 */
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { creditAuth } from '../middleware/creditAuth.js';
import { creditDebit } from '../middleware/creditDebit.js';
import { logger } from '../../../utils/logger.js';
import { ConcurrencyLimiter } from '../../../utils/concurrencyLimiter.js';

const router = Router();

const CREDIT_COST = 2;
const MAX_UPLOAD = 100 * 1024 * 1024; // 100MB — under the CF body cap; larger sources use url mode

// In-memory multipart (sharp reads the buffer directly). Permissive: accept any
// upload and let sharp sniff the format — per the spec, don't 415 unusual rasters.
const imgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

// Cap concurrent heavy encodes so a burst can't OOM the host or starve trading.
// Tunable via env; overflow sheds load (503 + refund) rather than buffering.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.IMAGE_TRANSCODE_MAX_CONCURRENT || '2', 10));
const limiter = new ConcurrencyLimiter({ maxConcurrent: MAX_CONCURRENT, maxQueue: 8 });
// Bound libvips threads so two parallel encodes don't saturate every core.
try { sharp.concurrency(4); } catch { /* older sharp */ }

// Named starting points, so a caller that just wants "make it small" doesn't have
// to know libvips quality/effort scales. `target` is part of the preset because a
// preset that only moved quality would be misleading — "smallest" has to be allowed
// to pick the codec that actually gets smallest, not just lower the quality of
// whatever the caller happened to ask for.
export const PRESET_CONFIGS = {
  smallest: { target: 'avif', quality: 55, effort: 4 },
  balanced: { target: 'webp', quality: 80, effort: 3 },
  quality:  { target: 'webp', quality: 90, effort: 2 },
  lossless: { target: 'png',  quality: 100, effort: 1, lossless: true }
};

export const PRESET_NAMES = Object.keys(PRESET_CONFIGS);

/**
 * Resolve a preset name to its parameter defaults.
 * @param {string} preset - The preset name
 * @returns {Object|null} - The preset's defaults, or null if the name is unknown
 */
export function mapPresetToParams(preset) {
  const config = PRESET_CONFIGS[preset];
  if (!config) return null;
  return {
    target: config.target,
    quality: config.quality,
    effort: config.effort,
    lossless: config.lossless === true
  };
}

// Parse multipart up front (before we charge), with graceful oversize handling.
function uploadImage(req, res, next) {
  imgUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      success: false,
      error: tooBig
        ? `Image exceeds the ${MAX_UPLOAD / 1024 / 1024}MB upload limit — pass a "url" instead for larger sources`
        : `Upload error: ${err.message}`
    });
  });
}

router.post('/',
  creditAuth(true),   // require X-API-Key (gsk_*) / JWT; sets req.wallet, no charge yet
  uploadImage,        // multipart parsed (and oversize rejected) before billing
  creditDebit(CREDIT_COST), // debits 2cr; auto-refunds on { success:false, targetError:true }; appends creditsRemaining
  async (req, res) => {
    const body = req.body || {};
    const num = (v) => (v != null && v !== '' ? Number(v) : undefined);
    
    // Reject an unknown preset before charging rather than silently ignoring it —
    // a typo'd preset would otherwise bill 2 credits and quietly return defaults.
    // targetError:true so creditDebit refunds.
    const preset = body.preset ? mapPresetToParams(body.preset) : null;
    if (body.preset && !preset) {
      return res.status(400).json({
        success: false,
        targetError: true,
        error: `Invalid preset: ${body.preset}. Valid presets are: ${PRESET_NAMES.join(', ')}`
      });
    }

    // Preset supplies defaults only; anything the caller sent explicitly wins. This
    // keeps every existing caller byte-identical — they all send target/quality
    // themselves — and makes "preset plus one override" the obvious usage.
    // `lossless` and `passthroughBytes` are checked for presence rather than
    // truthiness so an explicit false is honoured instead of falling back.
    const has = (k) => body[k] != null && body[k] !== '';
    const bool = (v) => v === true || v === 'true';
    const params = {
      target: body.target || preset?.target,
      sourceFormat: body.sourceFormat,
      quality: has('quality') ? num(body.quality) : preset?.quality,
      effort: has('effort') ? num(body.effort) : preset?.effort,
      maxPixels: num(body.maxPixels),
      lossless: has('lossless') ? bool(body.lossless) : (preset?.lossless ?? false),
      passthroughBytes: !(body.passthroughBytes === false || body.passthroughBytes === 'false')
    };

    if (req.file?.buffer) params._buffer = req.file.buffer;
    else if (body.image) params.image = body.image;
    else if (body.base64) params.base64 = body.base64;
    else if (body.url) params.url = body.url;
    else {
      return res.status(400).json({
        success: false, targetError: true,
        error: 'Provide an image: multipart "image" file, base64 in "image", or a "url"'
      });
    }

    const entry = req.app.locals.agent?.apiManager?.apis?.get('imageTools');
    const imageTools = entry?.instance || entry;
    if (!imageTools) {
      return res.status(503).json({ success: false, targetError: true, error: 'imageTools service unavailable' });
    }

    let result;
    try {
      result = await limiter.run(() => imageTools.execute({ action: 'transcode', ...params }));
    } catch (e) {
      if (e.code === 'QUEUE_FULL') {
        logger.warn(`imageTools/transcode capacity reached ${JSON.stringify(limiter.stats())}`);
        return res.status(503).json({ success: false, targetError: true, error: 'Transcode capacity reached — retry shortly' });
      }
      logger.error(`imageTools/transcode failed: ${e.message}`);
      return res.status(500).json({ success: false, targetError: true, error: e.message });
    }

    if (!result || result.success === false) {
      const code = result?.code;
      const clientErr = code === 'INVALID_TARGET' || code === 'BAD_INPUT' || code === 'UNDECODABLE';
      return res.status(clientErr ? 400 : 500).json({
        success: false, targetError: true, code, error: result?.error || 'Transcode failed'
      });
    }

    const agentName = req.app.locals.agent?.name || process.env.AGENT_NAME || 'LANAgent';
    return res.json({ success: true, data: result.data, creditsCharged: CREDIT_COST, agent: { name: agentName } });
  }
);

export default router;
