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
 * Detect a file's MIME type from its leading bytes.
 *
 * Downloads are served from yt-dlp output and user uploads, and the token
 * carries no content type, so the alternative is `application/octet-stream`
 * for everything — which makes a browser download an MP4 instead of playing it.
 *
 * Signature notes (each of these was wrong on the first pass):
 *  - ID3 is a THREE byte magic. Comparing a 4-byte slice against it makes
 *    Buffer.equals() false on length alone, so the branch never fired.
 *  - JPEG only guarantees `FF D8 FF`; the fourth byte is the segment marker and
 *    is E0/E1 only for JFIF/Exif. Real files also use E2..EF, DB and EE.
 *  - MP4's first four bytes are the ftyp BOX SIZE, which varies per muxer.
 *    The stable check is the literal `ftyp` at offset 4.
 *
 * @param {Buffer} buffer — leading bytes of the file (12 are needed for MP4)
 * @returns {string} a MIME type, or 'application/octet-stream' when unrecognised
 */
export function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return 'application/octet-stream';
  }

  const startsWith = (...bytes) =>
    buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';         // %PDF
  if (startsWith(0xFF, 0xD8, 0xFF)) return 'image/jpeg';                    // JPEG SOI + marker
  if (startsWith(0x89, 0x50, 0x4E, 0x47)) return 'image/png';               // .PNG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';               // GIF8
  if (startsWith(0x49, 0x44, 0x33)) return 'audio/mpeg';                    // ID3
  if (startsWith(0x1A, 0x45, 0xDF, 0xA3)) return 'video/webm';              // EBML (webm/mkv)

  // ISO base media (mp4/m4a/mov): `ftyp` at offset 4, then a brand at 8.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }

  return 'application/octet-stream';
}

/**
 * Read a file's leading bytes and derive a content type. Never throws — an
 * unreadable file falls back to the generic type the route used before.
 *
 * @param {string} filePath
 * @returns {string}
 */
function detectContentType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buffer, 0, 12, 0);
    // Short files must not be sniffed against the zero-fill of the remainder.
    return detectMimeType(buffer.subarray(0, bytesRead));
  } catch (err) {
    logger.warn(`Failed to read file for MIME type detection: ${filePath} (${err.code})`);
    return 'application/octet-stream';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed / never opened */ }
    }
  }
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

  const contentType = detectContentType(filePath);

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

  const contentType = detectContentType(filePath);

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
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
