import { Router } from 'express';
import crypto from 'crypto';
import path from 'path';
import { externalAuthMiddleware } from '../middleware/externalAuth.js';
import { paymentMiddleware } from '../middleware/payment.js';
import { hybridAuth } from '../middleware/hybridAuth.js';
import { upload, validateMagicBytes, scanWithVirusTotal } from '../middleware/fileUpload.js';
import { generateDownloadToken } from '../services/downloadTokenService.js';
import { logger } from '../../../utils/logger.js';
import { safeJsonParse, validateJsonSchema } from '../../../utils/jsonUtils.js';

const router = Router();

const ALLOWED_OUTPUT_FORMATS = ['mp4', 'mp3', 'wav', 'webm', 'mkv', 'avi', 'flac', 'ogg', 'aac'];

const ALLOWED_VIDEO_CODECS = ['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'copy'];
const ALLOWED_AUDIO_CODECS = ['aac', 'libmp3lame', 'libvorbis', 'libopus', 'flac', 'copy'];

const CUSTOM_PROFILE_SCHEMA = {
  required: ['videoCodec', 'audioCodec'],
  properties: {
    videoCodec: { type: 'string' },
    audioCodec: { type: 'string' },
    resolution: { type: 'string' },
    videoBitrate: { type: 'string' },
    audioBitrate: { type: 'string' }
  }
};

router.post('/convert',
  ...hybridAuth('media-transcode', 20),
  upload.single('file'),
  validateMagicBytes,
  scanWithVirusTotal,
  async (req, res) => {
    const { targetFormat, quality, customProfile } = req.body;

    if (!targetFormat || !ALLOWED_OUTPUT_FORMATS.includes(targetFormat)) {
      return res.status(400).json({
        success: false,
        error: `targetFormat required. Allowed: ${ALLOWED_OUTPUT_FORMATS.join(', ')}`
      });
    }

    try {
      const ffmpeg = req.app.locals.agent?.apiManager?.apis?.get('ffmpeg');
      if (!ffmpeg) {
        return res.status(503).json({ success: false, error: 'Transcode service not available' });
      }

      const outputName = `${crypto.randomBytes(16).toString('hex')}.${targetFormat}`;
      const outputPath = path.resolve('data/external-uploads', outputName);

      const options = {};

      if (customProfile) {
        // Parse custom profile (may arrive as JSON string from multipart form)
        const profile = typeof customProfile === 'string' ? safeJsonParse(customProfile) : customProfile;
        if (!profile) {
          return res.status(400).json({ success: false, error: 'Invalid customProfile JSON' });
        }

        const errors = validateJsonSchema(profile, CUSTOM_PROFILE_SCHEMA);
        if (errors.length > 0) {
          return res.status(400).json({
            success: false,
            error: `Invalid custom profile: ${errors.map(e => e.message).join(', ')}`
          });
        }

        // Validate codec values against allowlists
        if (!ALLOWED_VIDEO_CODECS.includes(profile.videoCodec)) {
          return res.status(400).json({ success: false, error: `Invalid videoCodec. Allowed: ${ALLOWED_VIDEO_CODECS.join(', ')}` });
        }
        if (!ALLOWED_AUDIO_CODECS.includes(profile.audioCodec)) {
          return res.status(400).json({ success: false, error: `Invalid audioCodec. Allowed: ${ALLOWED_AUDIO_CODECS.join(', ')}` });
        }

        // Validate format patterns
        if (profile.resolution && !/^\d+x\d+$/.test(profile.resolution)) {
          return res.status(400).json({ success: false, error: 'resolution must be in format WIDTHxHEIGHT (e.g., 1920x1080)' });
        }
        if (profile.videoBitrate && !/^\d+k$/.test(profile.videoBitrate)) {
          return res.status(400).json({ success: false, error: 'videoBitrate must be in format NUMBERk (e.g., 5000k)' });
        }
        if (profile.audioBitrate && !/^\d+k$/.test(profile.audioBitrate)) {
          return res.status(400).json({ success: false, error: 'audioBitrate must be in format NUMBERk (e.g., 320k)' });
        }

        options.videoCodec = profile.videoCodec;
        options.audioCodec = profile.audioCodec;
        if (profile.resolution) options.resolution = profile.resolution;
        if (profile.videoBitrate) options.videoBitrate = profile.videoBitrate;
        if (profile.audioBitrate) options.audioBitrate = profile.audioBitrate;
      } else if (quality === 'high') {
        options.videoBitrate = '5000k';
        options.audioBitrate = '320k';
      } else if (quality === 'low') {
        options.videoBitrate = '1000k';
        options.audioBitrate = '128k';
      }

      const result = await ffmpeg.execute({
        action: 'convert',
        input: req.file.path,
        output: outputPath,
        format: targetFormat,
        options
      });

      if (!result.success) {
        return res.status(500).json({ success: false, error: result.error || 'Transcoding failed' });
      }

      const token = generateDownloadToken({
        filePath: result.output || outputPath,
        filename: `transcoded.${targetFormat}`,
        agentId: req.externalAgentId,
        maxDownloads: 3,
        expiresInMinutes: 120
      });

      res.json({
        success: true,
        downloadUrl: `/api/external/download/${token}`,
        filename: `transcoded.${targetFormat}`,
        tokenExpires: '120 minutes',
        maxDownloads: 3
      });
    } catch (error) {
      logger.error('Transcode failed:', error);
      res.status(500).json({ success: false, error: 'Transcoding failed' });
    }
  }
);

export default router;
