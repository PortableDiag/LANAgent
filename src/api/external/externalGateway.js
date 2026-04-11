import { Router } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { killSwitchMiddleware } from './middleware/killSwitch.js';
import { auditLogMiddleware } from './middleware/auditLog.js';
import { responseSanitizer } from './middleware/responseSanitizer.js';
import { setKillSwitch, isKillSwitchActive } from './middleware/killSwitch.js';
import ExternalServiceConfig from '../../models/ExternalServiceConfig.js';
import { logger } from '../../utils/logger.js';
import { authenticateToken } from '../../interfaces/web/auth.js';

import catalogRoutes from './routes/catalog.js';
import downloadRoutes from './routes/download.js';
import youtubeRoutes from './routes/youtube.js';
import transcodeRoutes from './routes/transcode.js';
import imageGenRoutes from './routes/imageGen.js';
import scrapingRoutes from './routes/scraping.js';
import documentsRoutes from './routes/documents.js';
import sandboxRoutes from './routes/sandbox.js';
import pdfRoutes from './routes/pdf.js';
import jobsRoutes from './routes/jobs.js';
import trustRoutes from './routes/trust.js';
import oracleRoutes from './routes/oracle.js';
import authRoutes from './routes/auth.js';
import creditRoutes from './routes/credits.js';
import pluginRoutes from './routes/plugins.js';

const router = Router();

// Global middleware
router.use(helmet({ contentSecurityPolicy: false }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' }
});
router.use(globalLimiter);

router.use(responseSanitizer);
router.use(killSwitchMiddleware);
router.use(auditLogMiddleware);

// Public routes (no auth/payment)
router.use('/catalog', catalogRoutes);
router.use('/download', downloadRoutes);
router.use('/auth', authRoutes);
router.use('/credits', creditRoutes);

// Authenticated + paid routes
router.use('/youtube', youtubeRoutes);
router.use('/transcode', transcodeRoutes);
router.use('/image', imageGenRoutes);
router.use('/scrape', scrapingRoutes);
router.use('/documents', documentsRoutes);
router.use('/sandbox', sandboxRoutes);
router.use('/pdf', pdfRoutes);
router.use('/jobs', jobsRoutes);
router.use('/trust', trustRoutes);
router.use('/oracle', oracleRoutes);
router.use('/service', pluginRoutes); // Generic plugin service proxy

// Admin routes (standard JWT auth)
router.get('/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    const ExternalPayment = (await import('../../models/ExternalPayment.js')).default;
    const ExternalAuditLog = (await import('../../models/ExternalAuditLog.js')).default;

    const [services, totalPayments, recentRequests, paymentSum, requestCounts] = await Promise.all([
      ExternalServiceConfig.find().lean(),
      ExternalPayment.countDocuments(),
      ExternalAuditLog.find().sort({ timestamp: -1 }).limit(20),
      ExternalPayment.aggregate([
        { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } }
      ]),
      // Aggregate actual request counts per service path from audit log
      ExternalAuditLog.aggregate([
        { $match: { method: 'POST', path: { $regex: '^/api/external/' } } },
        { $group: {
          _id: '$path',
          count: { $sum: 1 },
          lastUsed: { $max: '$timestamp' }
        }}
      ])
    ]);

    // Build a map of path → count for merging into service configs
    const pathCounts = {};
    for (const rc of requestCounts) {
      // Map audit paths to service IDs
      const path = rc._id;
      let serviceId = null;
      if (path.includes('/scrape')) serviceId = 'web-scraping';
      else if (path.includes('/youtube/download')) serviceId = 'youtube-download';
      else if (path.includes('/youtube/audio')) serviceId = 'youtube-audio';
      else if (path.includes('/transcode')) serviceId = 'media-transcode';
      else if (path.includes('/image/')) serviceId = 'image-generation';
      else if (path.includes('/documents/')) serviceId = 'document-processing';
      else if (path.includes('/sandbox/')) serviceId = 'code-sandbox';
      else if (path.includes('/pdf/')) serviceId = 'pdf-toolkit';
      else if (path.includes('/service/')) {
        // Generic plugin: /api/external/service/chainlink/price → chainlink
        const parts = path.split('/service/')[1]?.split('/');
        if (parts?.[0]) serviceId = 'plugin-' + parts[0];
      }
      if (serviceId) {
        if (!pathCounts[serviceId]) pathCounts[serviceId] = { count: 0, lastUsed: null };
        pathCounts[serviceId].count += rc.count;
        if (!pathCounts[serviceId].lastUsed || rc.lastUsed > pathCounts[serviceId].lastUsed) {
          pathCounts[serviceId].lastUsed = rc.lastUsed;
        }
      }
    }

    // Merge counts into service configs
    const enrichedServices = services.map(s => {
      const counts = pathCounts[s.serviceId] || { count: 0, lastUsed: null };
      const lastUsed = counts.lastUsed || s.lastUsed;
      return {
        ...s,
        totalRequests: counts.count || s.totalRequests || 0,
        lastUsed: lastUsed ? new Date(lastUsed).toISOString() : null
      };
    });

    res.json({
      success: true,
      killSwitchActive: isKillSwitchActive(),
      services: enrichedServices,
      stats: {
        totalPayments,
        totalRevenue: paymentSum[0]?.total || 0,
        recentRequests
      }
    });
  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/admin/services', authenticateToken, async (req, res) => {
  try {
    const services = await ExternalServiceConfig.find();
    res.json({ success: true, services });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/admin/services/:serviceId', authenticateToken, async (req, res) => {
  try {
    const { serviceId } = req.params;
    const updates = {};

    if (req.body.price !== undefined) updates.price = String(req.body.price);
    if (req.body.enabled !== undefined) updates.enabled = !!req.body.enabled;
    if (req.body.rateLimit !== undefined) updates.rateLimit = req.body.rateLimit;

    const service = await ExternalServiceConfig.findOneAndUpdate(
      { serviceId },
      { $set: updates },
      { new: true }
    );

    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    res.json({ success: true, service });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/admin/kill-switch', authenticateToken, async (req, res) => {
  const { active } = req.body;
  const { PluginSettings } = await import('../../models/PluginSettings.js');

  setKillSwitch(!!active);
  await PluginSettings.setCached('external-gateway', 'kill_switch', !!active);

  logger.warn(`External gateway kill switch ${active ? 'ACTIVATED' : 'deactivated'} by admin`);
  res.json({ success: true, killSwitchActive: !!active });
});

router.get('/admin/payments', authenticateToken, async (req, res) => {
  try {
    const ExternalPayment = (await import('../../models/ExternalPayment.js')).default;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const [rawPayments, total] = await Promise.all([
      ExternalPayment.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ExternalPayment.countDocuments()
    ]);

    // Normalize dates and detect currency
    const payments = rawPayments.map(p => ({
      ...p,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : (p.verifiedAt ? new Date(p.verifiedAt).toISOString() : null),
      verifiedAt: p.verifiedAt ? new Date(p.verifiedAt).toISOString() : null,
      currency: p.currency || (parseFloat(p.amount) > 1 ? 'SKYNET' : 'BNB')
    }));

    res.json({ success: true, payments, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/admin/audit', authenticateToken, async (req, res) => {
  try {
    const ExternalAuditLog = (await import('../../models/ExternalAuditLog.js')).default;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const [logs, total] = await Promise.all([
      ExternalAuditLog.find().sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ExternalAuditLog.countDocuments()
    ]);

    res.json({ success: true, logs, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Seed default service configs
async function seedServiceConfigs() {
  const defaults = [
    {
      serviceId: 'youtube-download',
      name: 'YouTube Download (MP4)',
      description: 'Download YouTube videos in MP4 format',
      price: '0.001',
      rateLimit: { maxPerAgent: 10, windowMinutes: 15 },
      estimatedTime: '1-5 minutes',
      inputFormat: 'json',
      outputFormat: 'file'
    },
    {
      serviceId: 'youtube-audio',
      name: 'YouTube Audio (MP3)',
      description: 'Extract audio from YouTube videos in MP3 format',
      price: '0.0008',
      rateLimit: { maxPerAgent: 10, windowMinutes: 15 },
      estimatedTime: '1-3 minutes',
      inputFormat: 'json',
      outputFormat: 'file'
    },
    {
      serviceId: 'media-transcode',
      name: 'Media Transcoding',
      description: 'Convert media files between formats using FFmpeg',
      price: '0.002',
      enabled: false,
      rateLimit: { maxPerAgent: 5, windowMinutes: 15 },
      maxFileSize: 524288000,
      estimatedTime: '2-10 minutes',
      inputFormat: 'multipart',
      outputFormat: 'file'
    },
    {
      serviceId: 'image-generation',
      name: 'AI Image Generation',
      description: 'Generate images from text prompts using AI',
      price: '0.003',
      enabled: false,
      rateLimit: { maxPerAgent: 10, windowMinutes: 15 },
      estimatedTime: '10-30 seconds',
      inputFormat: 'json',
      outputFormat: 'file'
    },
    {
      serviceId: 'web-scraping',
      name: 'Web Scraping',
      description: 'Extract structured data from web pages',
      price: '0.0005',
      enabled: false,
      rateLimit: { maxPerAgent: 20, windowMinutes: 15 },
      estimatedTime: '5-15 seconds',
      inputFormat: 'json',
      outputFormat: 'json'
    },
    {
      serviceId: 'document-processing',
      name: 'Document Processing',
      description: 'OCR and text extraction from documents',
      price: '0.001',
      enabled: false,
      rateLimit: { maxPerAgent: 10, windowMinutes: 15 },
      maxFileSize: 52428800,
      estimatedTime: '10-60 seconds',
      inputFormat: 'multipart',
      outputFormat: 'json'
    },
    {
      serviceId: 'code-sandbox',
      name: 'Code Execution Sandbox',
      description: 'Execute code in isolated Docker containers (Python, Node, Bash, Ruby, Go)',
      price: '0.002',
      rateLimit: { maxPerAgent: 10, windowMinutes: 15 },
      estimatedTime: '1-30 seconds',
      inputFormat: 'json',
      outputFormat: 'json'
    },
    {
      serviceId: 'pdf-toolkit',
      name: 'PDF Toolkit',
      description: 'Merge, split, compress, watermark, and extract text from PDFs',
      price: '0.0005',
      rateLimit: { maxPerAgent: 20, windowMinutes: 15 },
      maxFileSize: 104857600,
      estimatedTime: '5-30 seconds',
      inputFormat: 'multipart',
      outputFormat: 'file'
    }
  ];

  for (const config of defaults) {
    const existing = await ExternalServiceConfig.findOne({ serviceId: config.serviceId });
    if (!existing) {
      await ExternalServiceConfig.create(config);
      logger.info(`Seeded external service config: ${config.serviceId}`);
    }
  }
}

// Catch-all: prevent unmatched routes from falling through to SPA
router.use('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Seed on load
seedServiceConfigs().catch(err => {
  logger.error('Failed to seed external service configs:', err);
});

export default router;
