import express from 'express';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';
import { DeviceAlias } from '../../models/DeviceAlias.js';
import { authenticateToken } from './auth.js';
import { retryOperation } from '../../utils/retryUtils.js';

const router = express.Router();

// Initialize cache with a 5-minute TTL
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Health check endpoint (before rate limiting)
router.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', service: 'deviceAlias' });
});

// Rate limiter for unauthenticated requests only
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.DEVICE_ALIAS_RATE_LIMIT || '100'),
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Trust proxy to get correct IP
  keyGenerator: (req) => {
    // Handle X-Forwarded-For from proxies/load balancers
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.connection.remoteAddress || req.ip;
  },
  // Skip rate limiting for API key authenticated requests
  skip: (req) => {
    // API key auth has its own rate limiting
    return req.headers['x-api-key'] !== undefined;
  },
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

// Apply rate limiting before auth
router.use(limiter);

// Apply auth to all routes after rate limiting
router.use(authenticateToken);

// Helper function to get cached data
async function getCachedData(key, fetchFunc) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const data = await fetchFunc();
  cache.set(key, data);
  return data;
}

// List all aliases
router.get('/', async (req, res) => {
  try {
    const { plugin } = req.query;
    const query = plugin ? { plugin } : {};
    
    const aliases = await getCachedData(`aliases_${plugin || 'all'}`, async () => {
      return await retryOperation(() => DeviceAlias.find(query).sort({ usageCount: -1 }).lean());
    });
    
    res.json({
      success: true,
      aliases: aliases
    });
  } catch (error) {
    logger.error('Failed to list device aliases:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list aliases',
      message: error.message
    });
  }
});

// Get alias by name
router.get('/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const { plugin = 'govee' } = req.query;
    
    const deviceAlias = await getCachedData(`alias_${alias.toLowerCase()}_${plugin}`, async () => {
      return await retryOperation(() => DeviceAlias.findOne({ 
        alias: alias.toLowerCase(),
        plugin 
      }).lean());
    });
    
    if (!deviceAlias) {
      return res.status(404).json({
        success: false,
        error: 'Alias not found'
      });
    }
    
    res.json({
      success: true,
      alias: deviceAlias
    });
  } catch (error) {
    logger.error('Failed to get device alias:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get alias',
      message: error.message
    });
  }
});

// Create or update alias
router.post('/', async (req, res) => {
  try {
    const { alias, deviceName, plugin = 'govee', deviceId } = req.body;
    
    if (!alias || !deviceName) {
      return res.status(400).json({
        success: false,
        error: 'Both alias and deviceName are required'
      });
    }
    
    const userId = req.user?.userId || req.apiKey?.name || 'system';
    
    const deviceAlias = await retryOperation(() => DeviceAlias.setAlias(
      alias,
      deviceName,
      plugin,
      userId
    ));
    
    // Update deviceId if provided
    if (deviceId) {
      deviceAlias.deviceId = deviceId;
      await deviceAlias.save();
    }
    
    // Invalidate cache for updated alias
    cache.del(`alias_${alias.toLowerCase()}_${plugin}`);
    
    res.json({
      success: true,
      alias: deviceAlias,
      message: 'Alias saved successfully'
    });
  } catch (error) {
    logger.error('Failed to save device alias:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save alias',
      message: error.message
    });
  }
});

// Delete alias
router.delete('/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const { plugin = 'govee' } = req.query;
    
    const result = await retryOperation(() => DeviceAlias.deleteOne({ 
      alias: alias.toLowerCase(),
      plugin 
    }));
    
    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Alias not found'
      });
    }
    
    // Invalidate cache for deleted alias
    cache.del(`alias_${alias.toLowerCase()}_${plugin}`);
    
    res.json({
      success: true,
      message: 'Alias deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete device alias:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete alias',
      message: error.message
    });
  }
});

// Bulk import aliases
router.post('/bulk', async (req, res) => {
  try {
    const { aliases, plugin = 'govee' } = req.body;
    
    if (!Array.isArray(aliases)) {
      return res.status(400).json({
        success: false,
        error: 'Aliases must be an array'
      });
    }
    
    const userId = req.user?.userId || req.apiKey?.name || 'system';

    // Process aliases in parallel for better performance
    const results = await Promise.all(aliases.map(async ({ alias, deviceName, deviceId }) => {
      try {
        const deviceAlias = await retryOperation(() => DeviceAlias.setAlias(
          alias,
          deviceName,
          plugin,
          userId
        ));

        if (deviceId) {
          deviceAlias.deviceId = deviceId;
          await deviceAlias.save();
        }

        // Invalidate cache for updated alias
        cache.del(`alias_${alias.toLowerCase()}_${plugin}`);

        return { alias, success: true };
      } catch (error) {
        return { alias, success: false, error: error.message };
      }
    }));

    res.json({
      success: true,
      results
    });
  } catch (error) {
    logger.error('Failed to bulk import aliases:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import aliases',
      message: error.message
    });
  }
});

export default router;