import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { verifyDownloadToken, consumeDownload } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

router.get('/:token', (req, res) => {
  const { token } = req.params;

  const decoded = verifyDownloadToken(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired download token'
    });
  }

  if (!consumeDownload(token)) {
    return res.status(410).json({
      success: false,
      error: 'Download limit exceeded'
    });
  }

  const filePath = decoded.filePath;
  const filename = decoded.filename || path.basename(filePath);

  logger.info(`Download served: ${filename} (agent: ${decoded.agentId})`);

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

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
      'Content-Disposition': `attachment; filename="${filename}"`
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
