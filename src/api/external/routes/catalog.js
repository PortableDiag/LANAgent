import { Router } from 'express';
import ExternalServiceConfig from '../../../models/ExternalServiceConfig.js';
import { ALLOWED_PLUGINS, PLUGIN_CREDIT_COSTS } from './plugins.js';
import { logger } from '../../../utils/logger.js';
import NodeCache from 'node-cache';
import { retryOperation } from '../../../utils/retryUtils.js';
import rateLimit from 'express-rate-limit';

const router = Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL

// Credit costs per legacy service (1 credit = $0.01 USD)
const SERVICE_CREDIT_COSTS = {
  'web-scraping': { basic: 1, full: 3, render: 5 },
  'youtube-download': 10,
  'youtube-audio': 8,
  'media-transcode': 20,
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
      creditCost: SERVICE_CREDIT_COSTS[svc.serviceId] || null
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
            endpoint: `/api/external/service/${pluginName}/:action`
          });
        }
      }
    } catch (e) {
      logger.error('Failed to add plugin services to catalog:', e.message);
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
      services: enrichedServices
    });
  } catch (error) {
    logger.error('Failed to load service catalog:', error);
    res.status(500).json({ success: false, error: 'Failed to load catalog' });
  }
});

export default router;