import express from 'express';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { authenticateToken as authMiddleware } from '../interfaces/web/auth.js';
import contractService from '../services/crypto/contractServiceWrapper.js';
import abiManager from '../services/crypto/abiManager.js';
import walletService from '../services/crypto/walletService.js';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
router.use(limiter);

// Apply compression middleware
router.use(compression());

/**
 * Get cached data or fetch if not present
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

/**
 * Get supported networks
 */
router.get('/networks', async (req, res) => {
  try {
    const networks = await getCachedData('supportedNetworks', async () => {
      return contractService.getSupportedNetworks();
    });
    const detailed = await Promise.all(networks.map(async network => ({
      id: network,
      ...await getCachedData(`networkInfo_${network}`, async () => {
        return contractService.getNetworkInfo(network);
      })
    })));
    res.json(detailed);
  } catch (error) {
    logger.error('Networks error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get testnet tokens for a network
 */
router.get('/networks/:network/tokens', async (req, res) => {
  try {
    const { network } = req.params;
    const tokens = await getCachedData(`testnetTokens_${network}`, async () => {
      return contractService.getTestnetTokens(network);
    });
    res.json(tokens);
  } catch (error) {
    logger.error('Tokens error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Read contract function
 */
router.post('/read', async (req, res) => {
  try {
    const { address, network, functionName, params = [] } = req.body;
    
    if (!address || !network || !functionName) {
      return res.status(400).json({ 
        error: 'Missing required fields: address, network, functionName' 
      });
    }

    const result = await retryOperation(() => contractService.readContract(
      address,
      network,
      functionName,
      params
    ));

    res.json({ 
      success: true, 
      result,
      network,
      address,
      function: functionName
    });
  } catch (error) {
    logger.error('Contract read error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get token info
 */
router.get('/token/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { network = 'ethereum' } = req.query;
    
    const info = await getCachedData(`tokenInfo_${address}_${network}`, async () => {
      return contractService.getTokenInfo(address, network);
    });
    res.json(info);
  } catch (error) {
    logger.error('Token info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get token balance
 */
router.get('/token/:address/balance/:holder', async (req, res) => {
  try {
    const { address, holder } = req.params;
    const { network = 'ethereum' } = req.query;
    
    const balance = await getCachedData(`tokenBalance_${address}_${holder}_${network}`, async () => {
      return contractService.getTokenBalance(address, holder, network);
    });
    
    res.json(balance);
  } catch (error) {
    logger.error('Token balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get NFT info
 */
router.get('/nft/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { network = 'ethereum' } = req.query;
    
    const info = await getCachedData(`nftInfo_${address}_${network}`, async () => {
      return contractService.getNFTInfo(address, network);
    });
    res.json(info);
  } catch (error) {
    logger.error('NFT info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get native balance
 */
router.get('/balance/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { network = 'ethereum' } = req.query;
    
    const balance = await getCachedData(`nativeBalance_${address}_${network}`, async () => {
      return contractService.getNativeBalance(address, network);
    });
    res.json(balance);
  } catch (error) {
    logger.error('Native balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * ABI Management
 */

// List stored ABIs
router.get('/abi', async (req, res) => {
  try {
    const { network } = req.query;
    const abis = await abiManager.listABIs(network);
    res.json(abis);
  } catch (error) {
    logger.error('ABI list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save ABI
router.post('/abi', async (req, res) => {
  try {
    const { address, network, abi, name, source = 'manual' } = req.body;
    
    if (!address || !network || !abi) {
      return res.status(400).json({ 
        error: 'Missing required fields: address, network, abi' 
      });
    }

    const saved = await abiManager.saveABI(
      address,
      network,
      abi,
      source,
      { name }
    );

    res.json({ 
      success: true,
      contract: saved
    });
  } catch (error) {
    logger.error('ABI save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get ABI
router.get('/abi/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { network = 'ethereum' } = req.query;
    
    const abi = await abiManager.getABI(address, network);
    
    if (!abi) {
      return res.status(404).json({ error: 'ABI not found' });
    }

    res.json({ abi, address, network });
  } catch (error) {
    logger.error('ABI get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete ABI
router.delete('/abi/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { network = 'ethereum' } = req.query;
    
    await abiManager.deleteABI(address, network);
    res.json({ 
      success: true,
      message: 'ABI deleted'
    });
  } catch (error) {
    logger.error('ABI delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get wallet balances across all networks
 */
router.get('/wallet/balances', async (req, res) => {
  try {
    const wallet = await walletService.getWallet();
    const networks = await getCachedData('supportedNetworks', async () => {
      return contractService.getSupportedNetworks();
    });
    const balances = {};

    // Get ETH/BNB/MATIC balances
    for (const network of networks) {
      try {
        const address = wallet.addresses.find(a => {
          if (network.includes('bsc')) return a.network === 'bsc';
          if (network.includes('polygon') || network.includes('mumbai')) return a.network === 'polygon';
          return a.network === 'ethereum';
        })?.address;

        if (address) {
          const balance = await getCachedData(`nativeBalance_${address}_${network}`, async () => {
            return contractService.getNativeBalance(address, network);
          });
          balances[network] = balance;
        }
      } catch (error) {
        logger.debug(`Failed to get balance for ${network}:`, error.message);
      }
    }

    res.json(balances);
  } catch (error) {
    logger.error('Wallet balances error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Event Monitoring Endpoints
 */

// Subscribe to events
router.post('/events/subscribe', async (req, res) => {
  try {
    const { address, network, eventFilter = {} } = req.body;
    
    if (!address || !network) {
      return res.status(400).json({ 
        error: 'Missing required fields: address, network' 
      });
    }

    const subscriptionId = await contractService.subscribeToEvents(
      address,
      network,
      eventFilter
    );

    res.json({ 
      success: true, 
      subscriptionId,
      message: 'Event monitoring started'
    });
  } catch (error) {
    logger.error('Event subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unsubscribe from events
router.delete('/events/subscribe/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    
    const success = await contractService.unsubscribeFromEvents(subscriptionId);

    res.json({ 
      success,
      message: 'Event monitoring stopped'
    });
  } catch (error) {
    logger.error('Event unsubscribe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get active subscriptions
router.get('/events/subscriptions', async (req, res) => {
  try {
    const subscriptions = contractService.getActiveSubscriptions();
    res.json(subscriptions);
  } catch (error) {
    logger.error('Get subscriptions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get past events
router.post('/events/past', async (req, res) => {
  try {
    const { address, network, options = {} } = req.body;
    
    if (!address || !network) {
      return res.status(400).json({ 
        error: 'Missing required fields: address, network' 
      });
    }

    const events = await contractService.getPastEvents(
      address,
      network,
      options
    );

    res.json({ 
      success: true,
      count: events.length,
      events
    });
  } catch (error) {
    logger.error('Get past events error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get stored events
router.get('/events', async (req, res) => {
  try {
    const { 
      address, 
      network,
      eventName,
      fromDate,
      toDate,
      limit = 100,
      skip = 0
    } = req.query;
    
    if (!address || !network) {
      return res.status(400).json({ 
        error: 'Missing required parameters: address, network' 
      });
    }

    const events = await contractService.getStoredEvents(
      address,
      network,
      {
        eventName,
        fromDate,
        toDate,
        limit: parseInt(limit),
        skip: parseInt(skip)
      }
    );

    res.json({ 
      success: true,
      count: events.length,
      events
    });
  } catch (error) {
    logger.error('Get stored events error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear all subscriptions
router.post('/events/clear', async (req, res) => {
  try {
    await contractService.clearAllSubscriptions();
    res.json({ 
      success: true,
      message: 'All event subscriptions cleared'
    });
  } catch (error) {
    logger.error('Clear subscriptions error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;