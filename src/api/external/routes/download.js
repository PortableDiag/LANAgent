import { Router } from 'express';
import path from 'path';
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

  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) {
      logger.error(`Download failed for ${filename}:`, err);
      res.status(500).json({ success: false, error: 'File download failed' });
    }
  });
});

export default router;
