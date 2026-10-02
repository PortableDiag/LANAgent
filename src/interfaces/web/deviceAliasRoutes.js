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

/**
 * Maximum number of aliases accepted by the batch resolution endpoint.
 */
export const MAX_BATCH_RESOLVE_SIZE = 100;

/**
 * Normalize an alias for storage and lookup.
 *
 * @param {string} alias - Alias supplied by the caller.
 * @returns {string} Trimmed, case-insensitive alias.
 */
export function normalizeAlias(alias) {
  return String(alias).trim().toLowerCase();
}

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

/**
 * Resolve multiple aliases with a single MongoDB query for uncached entries.
 *
 * Results remain in the same order as the requested pairs. Missing aliases are
 * returned with found set to false rather than causing the whole request to
 * fail.
 */
router.post('/batch/resolve', async (req, res) => {
  try {
    const { aliases } = req.body || {};

    if (!Array.isArray(aliases)) {
      return res.status(400).json({
        success: false,
        error: 'Aliases must be an array'
      });
    }

    if (aliases.length > MAX_BATCH_RESOLVE_SIZE) {
      return res.status(400).json({
        success: false,
        error: `A maximum of ${MAX_BATCH_RESOLVE_SIZE} aliases may be resolved per request`
      });
    }

    const requests = aliases.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Alias entry at index ${index} must be an object`);
      }

      if (typeof item.alias !== 'string' || !item.alias.trim()) {
        throw new Error(`Alias entry at index ${index} must include a non-empty alias`);
      }

      const plugin = item.plugin === undefined ? 'govee' : item.plugin;
      if (typeof plugin !== 'string' || !plugin.trim()) {
        throw new Error(`Alias entry at index ${index} must include a valid plugin`);
      }

      return {
        alias: normalizeAlias(item.alias),
        plugin: plugin.trim()
      };
    });

    const resolvedByKey = new Map();
    const uncachedRequests = [];
    const uncachedKeys = new Set();

    for (const request of requests) {
      const key = `alias_${request.alias}_${request.plugin}`;
      const cached = cache.get(key);

      if (cached !== undefined) {
        resolvedByKey.set(key, cached);
      } else if (!uncachedKeys.has(key)) {
        uncachedKeys.add(key);
        uncachedRequests.push(request);
      }
    }

    if (uncachedRequests.length > 0) {
      const matches = await retryOperation(() => DeviceAlias.find({
        $or: uncachedRequests.map(({ alias, plugin }) => ({ alias, plugin }))
      }).lean());

      const matchesByKey = new Map(
        matches.map((deviceAlias) => [
          `alias_${deviceAlias.alias}_${deviceAlias.plugin}`,
          deviceAlias
        ])
      );

      for (const request of uncachedRequests) {
        const key = `alias_${request.alias}_${request.plugin}`;
        const deviceAlias = matchesByKey.get(key) || null;
        resolvedByKey.set(key, deviceAlias);
        cache.set(key, deviceAlias);
      }
    }

    const results = requests.map(({ alias, plugin }) => {
      const deviceAlias = resolvedByKey.get(`alias_${alias}_${plugin}`);

      if (!deviceAlias) {
        return {
          alias,
          plugin,
          found: false,
          deviceName: null,
          deviceId: null,
          usageCount: 0,
          lastUsed: null,
          usage: {
            usageCount: 0,
            lastUsed: null
          }
        };
      }

      return {
        alias,
        plugin,
        found: true,
        deviceName: deviceAlias.deviceName,
        deviceId: deviceAlias.deviceId ?? null,
        usageCount: deviceAlias.usageCount ?? 0,
        lastUsed: deviceAlias.lastUsed ?? null,
        usage: {
          usageCount: deviceAlias.usageCount ?? 0,
          lastUsed: deviceAlias.lastUsed ?? null
        }
      };
    });

    res.json({
      success: true,
      results
    });
  } catch (error) {
    if (error.message.startsWith('Alias entry at index')) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    logger.error('Failed to batch resolve device aliases:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resolve aliases',
      message: error.message
    });
  }
});

// List all aliases with advanced search capabilities
router.get('/', async (req, res) => {
  try {
    const { plugin, deviceName, userId, sortBy = 'usageCount', sortOrder = 'desc' } = req.query;
    const query = {};
    if (plugin) query.plugin = plugin;
    if (deviceName) query.deviceName = deviceName;
    if (userId) query.userId = userId;

    const sortOptions = {};
    if (sortBy) {
      sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }

    const cacheKey = `aliases_${JSON.stringify(query)}_${sortBy}_${sortOrder}`;
    const aliases = await getCachedData(cacheKey, async () => {
      return await retryOperation(() => DeviceAlias.find(query).sort(sortOptions).lean());
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
    const alias = normalizeAlias(req.params.alias);
    const { plugin = 'govee' } = req.query;

    const deviceAlias = await getCachedData(`alias_${alias}_${plugin}`, async () => {
      return await retryOperation(() => DeviceAlias.findOne({
        alias,
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

    const normalizedAlias = normalizeAlias(alias);
    const userId = req.user?.userId || req.apiKey?.name || 'system';

    const deviceAlias = await retryOperation(() => DeviceAlias.setAlias(
      normalizedAlias,
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
    cache.del(`alias_${normalizedAlias}_${plugin}`);

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
    const alias = normalizeAlias(req.params.alias);
    const { plugin = 'govee' } = req.query;

    const result = await retryOperation(() => DeviceAlias.deleteOne({
      alias,
      plugin
    }));

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Alias not found'
      });
    }

    // Invalidate cache for deleted alias
    cache.del(`alias_${alias}_${plugin}`);

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
        const normalizedAlias = normalizeAlias(alias);
        const deviceAlias = await retryOperation(() => DeviceAlias.setAlias(
          normalizedAlias,
          deviceName,
          plugin,
          userId
        ));

        if (deviceId) {
          deviceAlias.deviceId = deviceId;
          await deviceAlias.save();
        }

        // Invalidate cache for updated alias
        cache.del(`alias_${normalizedAlias}_${plugin}`);

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

/**
 * Largest page of aliases the popularity endpoint will return per plugin.
 * Bounded so a caller cannot ask Mongo to materialise an unbounded array.
 */
export const MAX_POPULAR_LIMIT = 100;

/** Supported `timeframe` values, mapped to a lookback in milliseconds. */
const TIMEFRAME_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000
};

/**
 * Raised for caller error so the route can answer 400 rather than 500.
 */
class PopularAliasesInputError extends Error {}

/**
 * Build the aggregation pipeline behind GET /analytics/popular.
 *
 * Ranking is done with a `$sort` stage BEFORE `$group` rather than `$sortArray`
 * inside `$project`: `$push` preserves input order, so this yields the same
 * top-N-per-group while still running on MongoDB below 5.2, where `$sortArray`
 * does not exist and the whole aggregation would fail.
 *
 * Grouping is by `plugin` only. DeviceAlias has no `deviceType` path, so a
 * second grouping key on it would be null for every document — a dimension that
 * looks like analysis but can never separate anything.
 *
 * @param {Object} [opts]
 * @param {number|string} [opts.limit=10] - Aliases returned per plugin, 1..MAX_POPULAR_LIMIT.
 * @param {string} [opts.timeframe] - One of hour|day|week|month; restricts to aliases used since.
 * @param {string} [opts.plugin] - Restrict to a single plugin.
 * @param {Date} [opts.now=new Date()] - Injectable clock, so the window is testable.
 * @returns {Array<Object>} Aggregation pipeline stages.
 * @throws {PopularAliasesInputError} On an out-of-range limit or unknown timeframe.
 */
export function buildPopularAliasesPipeline({ limit = 10, timeframe, plugin, now = new Date() } = {}) {
  // parseInt('abc') is NaN, and a NaN reaching $slice makes Mongo throw — which
  // would surface as a 500 for what is really a bad query string.
  const limitNum = Number(limit);
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > MAX_POPULAR_LIMIT) {
    throw new PopularAliasesInputError(
      `limit must be an integer between 1 and ${MAX_POPULAR_LIMIT}`
    );
  }

  const matchCriteria = {};
  if (plugin) matchCriteria.plugin = plugin;

  if (timeframe !== undefined && timeframe !== '') {
    const windowMs = TIMEFRAME_MS[String(timeframe).toLowerCase()];
    if (!windowMs) {
      throw new PopularAliasesInputError(
        `timeframe must be one of: ${Object.keys(TIMEFRAME_MS).join(', ')}`
      );
    }
    // lastUsed defaults to null for aliases that have never been resolved, and
    // null fails $gte — so an unused alias is correctly absent from a windowed
    // "popular" list rather than appearing with a zero count.
    matchCriteria.lastUsed = { $gte: new Date(now.getTime() - windowMs) };
  }

  return [
    { $match: matchCriteria },
    // alias is the tiebreaker so equal usage counts rank deterministically
    // instead of shifting between calls.
    { $sort: { usageCount: -1, alias: 1 } },
    {
      $group: {
        _id: '$plugin',
        aliasCount: { $sum: 1 },
        totalUsage: { $sum: { $ifNull: ['$usageCount', 0] } },
        aliases: {
          $push: {
            alias: '$alias',
            deviceName: '$deviceName',
            usageCount: { $ifNull: ['$usageCount', 0] },
            lastUsed: '$lastUsed'
          }
        }
      }
    },
    {
      $project: {
        _id: 0,
        plugin: '$_id',
        aliasCount: 1,
        totalUsage: 1,
        aliases: { $slice: ['$aliases', limitNum] }
      }
    },
    { $sort: { plugin: 1 } }
  ];
}

/**
 * GET /analytics/popular — aliases ranked by usageCount, grouped by plugin.
 *
 * Deliberately not served from the module cache: a five-minute-stale copy of a
 * usage ranking is indistinguishable from a fresh one to the caller, and the
 * write paths that bump usageCount do not invalidate that cache.
 */
export async function popularAliasesHandler(req, res) {
  let pipeline;
  try {
    pipeline = buildPopularAliasesPipeline(req.query || {});
  } catch (error) {
    if (error instanceof PopularAliasesInputError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    throw error;
  }

  try {
    const results = await retryOperation(
      () => DeviceAlias.aggregate(pipeline).exec(),
      { retries: 3 }
    );

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('Failed to get popular aliases:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get popular aliases',
      message: error.message
    });
  }
}

router.get('/analytics/popular', popularAliasesHandler);

export default router;
