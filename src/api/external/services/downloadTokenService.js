import jwt from 'jsonwebtoken';
import NodeCache from 'node-cache';
import { logger } from '../../../utils/logger.js';

// Track download counts per token
const downloadCounters = new NodeCache({ stdTTL: 7200, checkperiod: 300 });

function getSecret() {
  return process.env.JWT_SECRET + '-download-tokens';
}

export function generateDownloadToken({ filePath, filename, agentId, maxDownloads = 3, expiresInMinutes = 60 }) {
  const token = jwt.sign(
    {
      type: 'download',
      filePath,
      filename,
      agentId,
      maxDownloads
    },
    getSecret(),
    { expiresIn: `${expiresInMinutes}m` }
  );

  // Initialize download counter
  downloadCounters.set(token, maxDownloads, expiresInMinutes * 60);

  logger.info(`Download token generated for ${filename} (agent: ${agentId}, max: ${maxDownloads})`);
  return token;
}

export function verifyDownloadToken(token) {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (decoded.type !== 'download') {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

export function consumeDownload(token) {
  const remaining = downloadCounters.get(token);

  if (remaining === undefined || remaining <= 0) {
    return false;
  }

  downloadCounters.set(token, remaining - 1, downloadCounters.getTtl(token));
  return true;
}
