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
    const params = {
      target: body.target,
      sourceFormat: body.sourceFormat,
      quality: num(body.quality),
      effort: num(body.effort),
      maxPixels: num(body.maxPixels),
      lossless: body.lossless === true || body.lossless === 'true',
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
