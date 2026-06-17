import { Router } from 'express';
import ExternalServiceConfig from '../../../models/ExternalServiceConfig.js';
import { ALLOWED_PLUGINS, PLUGIN_CREDIT_COSTS } from './plugins.js';
import { logger } from '../../../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../../../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';

const router = Router();
// 20 min TTL (was 5 min). The gateway is the only caller and re-fetches every ~15 min,
// so a 5-min TTL meant every fetch hit an expired cache and paid a cold rebuild (~5-6s on
// a smaller box), which used to time out the gateway's registration catalog fetch. A TTL
// above the gateway's fetch interval keeps the catalog warm across fetches. Env-tunable.
const cache = new NodeCache({ stdTTL: Number(process.env.CATALOG_CACHE_TTL_SECONDS) || 1200, checkperiod: 120 });

// Credit costs per legacy service (1 credit = $0.01 USD)
const SERVICE_CREDIT_COSTS = {
  'web-scraping': { basic: 1, stealth: 2, full: 3, render: 3 },
  'youtube-download': 10,
  'youtube-audio': 8,
  'media-transcode': 20,
  'image-transcode': 2,
  'image-generation': 30,
  'document-processing': 10,
  'code-sandbox': 20,
  'pdf-toolkit': 5,
  'ai-content-detection': { text: 5, image: 5, audio: 8, video: 10 }
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

router.use(limiter);

/**
 * Get cached data or fetch and cache it
 * @param {string} key - Cache key
 * @param {Function} fetchFunc - Function to fetch data if not cached
 * @returns {Promise<any>} - Cached or fetched data
 */
async function getCachedData(key, fetchFunc) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const data = await fetchFunc();
  cache.set(key, data);
  return data;
}

router.get('/health', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    const count = await retryOperation(
      () => ExternalServiceConfig.countDocuments({ enabled: true }),
      { retries: 2 }
    );
    dbStatus = Number.isFinite(count) ? 'ok' : 'degraded';
  } catch (e) {
    dbStatus = 'error';
    logger.warn('Catalog health DB check failed:', e);
  }
  const stats = cache.getStats ? cache.getStats() : null;
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    status: dbStatus === 'error' ? 'degraded' : 'ok',
    db: dbStatus,
    cache: stats ? { keys: stats.keys, ksize: stats.ksize, vsize: stats.vsize } : 'na',
    uptime: process.uptime()
  });
});

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function parseSortSpec(sortParam, allowed) {
  if (!sortParam) return [];
  return String(sortParam)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(token => {
      const dir = token.startsWith('-') ? -1 : 1;
      const field = token.replace(/^-/, '');
      return allowed.includes(field) ? { field, dir } : null;
    })
    .filter(Boolean);
}

const CATALOG_ALLOWED_FIELDS = [
  'serviceId', 'name', 'description', 'creditCost', 'price', 'currency',
  'rateLimit', 'estimatedTime', 'inputFormat', 'outputFormat', 'endpoint', 'type'
];
const CATALOG_SORT_FIELDS = ['name', 'price', 'serviceId'];

router.get('/', async (req, res) => {
  try {
    const services = await getCachedData('enabledServices', async () => {
      return await retryOperation(() => ExternalServiceConfig.find({ enabled: true })
        .select('serviceId name description price currency rateLimit estimatedTime inputFormat outputFormat')
        .lean());
    });

    // Get recipient address for payment info
    let paymentAddress = null;
    try {
      const walletService = (await import('../../../services/crypto/walletService.js')).default;
      const info = await retryOperation(() => walletService.getWalletInfo());
      if (info.initialized && info.addresses) {
        const bscAddr = info.addresses.find(a => a.chain === 'bsc' || a.chain === 'eth');
        paymentAddress = bscAddr?.address || null;
      }
    } catch (e) {
      logger.error('Failed to get payment address for catalog:', e);
    }

    // Enrich legacy services with credit costs
    const enrichedServices = services.map(svc => ({
      ...svc,
      creditCost: SERVICE_CREDIT_COSTS[svc.serviceId] || null,
      type: 'legacy'
    }));

    // Add plugin services into the same services array.
    // Gateway reads catalogRes.data.services and maps s.serviceId into its DB.
    // Gateway uses "plugin-<name>" format for service IDs (hyphen, not colon).
    try {
      const apiManager = req.app.locals.agent?.apiManager || req.app.locals.agent?.services?.get('apiManager');
      if (apiManager?.apis) {
        for (const pluginName of ALLOWED_PLUGINS) {
          const pluginEntry = apiManager.apis.get(pluginName);
          if (!pluginEntry || pluginEntry.enabled === false) continue;

          const instance = pluginEntry.instance || pluginEntry;
          const creditCost = PLUGIN_CREDIT_COSTS[pluginName] || 1;

          enrichedServices.push({
            serviceId: `plugin-${pluginName}`,
            name: instance.description || pluginName,
            description: instance.description || '',
            creditCost,
            endpoint: `/api/external/service/${pluginName}/:action`,
            type: 'plugin'
          });
        }
      }
    } catch (e) {
      logger.error('Failed to add plugin services to catalog:', e.message);
    }

    const { q, type, sort, fields, limit, offset } = req.query;
    const hasQueryParams = q !== undefined || type !== undefined || sort !== undefined ||
                           fields !== undefined || limit !== undefined || offset !== undefined;

    let result = enrichedServices;
    let total = enrichedServices.length;
    let appliedOffset = 0;
    let appliedLimit = 0;

    if (hasQueryParams) {
      if (q) {
        const needle = String(q).toLowerCase();
        result = result.filter(item => {
          return [item?.name, item?.description, item?.serviceId]
            .filter(Boolean)
            .some(v => String(v).toLowerCase().includes(needle));
        });
      }

      if (type) {
        const typeNorm = String(type).toLowerCase();
        if (typeNorm === 'legacy' || typeNorm === 'plugin') {
          result = result.filter(s => String(s.type || 'legacy').toLowerCase() === typeNorm);
        } else {
          result = [];
        }
      }

      const sortSpec = parseSortSpec(sort, CATALOG_SORT_FIELDS);
      if (sortSpec.length > 0) {
        result = [...result].sort((a, b) => {
          for (const { field, dir } of sortSpec) {
            const av = getNestedValue(a, field);
            const bv = getNestedValue(b, field);
            if (av == null && bv == null) continue;
            if (av == null) return -1 * dir;
            if (bv == null) return 1 * dir;
            if (typeof av === 'string' && typeof bv === 'string') {
              const cmp = av.localeCompare(bv);
              if (cmp !== 0) return cmp * dir;
            } else if (av < bv) {
              return -1 * dir;
            } else if (av > bv) {
              return 1 * dir;
            }
          }
          return 0;
        });
      }

      total = result.length;

      const parsedLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 0;
      const parsedOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
      appliedLimit = Math.min(Math.max(parsedLimit, 0), 100);
      appliedOffset = parsedOffset;

      if (appliedLimit > 0) {
        result = result.slice(appliedOffset, appliedOffset + appliedLimit);
      }

      if (fields) {
        const requestedFields = String(fields)
          .split(',')
          .map(f => f.trim())
          .filter(f => CATALOG_ALLOWED_FIELDS.includes(f));
        if (requestedFields.length > 0) {
          result = result.map(item => {
            const out = {};
            for (const f of requestedFields) {
              if (Object.prototype.hasOwnProperty.call(item, f)) out[f] = item[f];
            }
            return out;
          });
        }
      }

      res.setHeader('X-Total-Count', String(total));
      res.setHeader('X-Offset', String(appliedOffset));
      res.setHeader('X-Limit', String(appliedLimit));
    }

    res.json({
      success: true,
      agent: {
        name: process.env.AGENT_NAME || 'LANAgent',
        agentId: req.app?.locals?.agent?.erc8004AgentId || null,
        chain: 'bsc',
        registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
      },
      payment: {
        address: paymentAddress,
        currency: 'BNB',
        chainId: 56,
        methods: ['X-Payment-Tx (legacy)', 'Credits (API key or JWT)']
      },
      credits: {
        priceEndpoint: '/api/external/credits/price',
        purchaseEndpoint: '/api/external/credits/purchase',
        balanceEndpoint: '/api/external/credits/balance',
        authEndpoint: '/api/external/auth/nonce',
        note: '1 credit = $0.01 USD'
      },
      services: result
    });
  } catch (error) {
    logger.error('Failed to load service catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load catalog' });
  }
});

export default router;