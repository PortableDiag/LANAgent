import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { verifyDownloadToken, consumeDownload } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

// HTTP header values must be visible-ASCII (RFC 7230); Node strictly enforces
// this and throws ERR_INVALID_CHAR on non-ASCII bytes. yt-dlp routinely yields
// filenames with smart quotes / em-dashes / CJK, so a naive `filename="..."`
// crashed the response → 500 → gateway turned it into 502.
function buildContentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Retrieve metadata for a download token without consuming a download attempt
 */
router.get('/:token/metadata', (req, res) => {
  const { token } = req.params;

  const decoded = verifyDownloadToken(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired download token'
    });
  }

  const filePath = decoded.filePath;
  const filename = decoded.filename || path.basename(filePath);

  // Stat the file to get metadata
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.warn(`Download file missing: ${filePath} (${err.code})`);
    return res.status(404).json({
      success: false,
      error: 'File no longer available'
    });
  }

  // Get content type - for now we'll use a generic binary type since we don't store
  // the original content type in the token, but this could be extended in the future
  const contentType = 'application/octet-stream';

  // Return metadata without consuming download
  return res.json({
    success: true,
    data: {
      size: stat.size,
      created: stat.birthtime.toISOString(),
      filename: filename,
      contentType: contentType
    }
  });
});

router.get('/:token', (req, res) => {
  const { token } = req.params;

  const decoded = verifyDownloadToken(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired download token'
    });
  }

  const filePath = decoded.filePath;
  const filename = decoded.filename || path.basename(filePath);

  // Stat BEFORE consuming the counter — a missing/moved file shouldn't burn
  // one of the user's allotted download attempts.
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.warn(`Download file missing: ${filePath} (${err.code})`);
    return res.status(404).json({
      success: false,
      error: 'File no longer available'
    });
  }

  if (!consumeDownload(token)) {
    return res.status(410).json({
      success: false,
      error: 'Download limit exceeded'
    });
  }

  logger.info(`Download served: ${filename} (agent: ${decoded.agentId})`);

  const fileSize = stat.size;
  const range = req.headers.range;
  const contentDisposition = buildContentDisposition(filename);

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).json({ success: false, error: 'Requested range not satisfiable' });
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
