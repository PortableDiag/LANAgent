import NodeCache from 'node-cache';
import { ContractABI } from '../../models/ContractABI.js';
import { logger } from '../../utils/logger.js';
import { retryOperation, isRetryableError } from '../../utils/retryUtils.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import { decrypt } from '../../utils/encryption.js';
import axios from 'axios';

// Common ABIs for standard interfaces
const STANDARD_ABIS = {
  ERC20: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)"
  ],
  ERC721: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function balanceOf(address owner) view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function safeTransferFrom(address from, address to, uint256 tokenId)",
    "function transferFrom(address from, address to, uint256 tokenId)",
    "function approve(address to, uint256 tokenId)",
    "function getApproved(uint256 tokenId) view returns (address)",
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address owner, address operator) view returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
    "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)"
  ]
};

// Etherscan API endpoints — keys loaded from DB on first use
const EXPLORER_APIS = {
  ethereum: {
    url: 'https://api.etherscan.io/api',
    key: process.env.ETHERSCAN_API_KEY || null
  },
  sepolia: {
    url: 'https://api-sepolia.etherscan.io/api',
    key: process.env.ETHERSCAN_API_KEY || null
  },
  bsc: {
    url: 'https://api.bscscan.com/api',
    key: process.env.BSCSCAN_API_KEY || null
  },
  'bsc-testnet': {
    url: 'https://api-testnet.bscscan.com/api',
    key: process.env.BSCSCAN_API_KEY || null
  },
  polygon: {
    url: 'https://api.polygonscan.com/api',
    key: process.env.POLYGONSCAN_API_KEY || null
  },
  mumbai: {
    url: 'https://api-mumbai.polygonscan.com/api',
    key: process.env.POLYGONSCAN_API_KEY || null
  },
  avalanche: {
    url: 'https://api.snowtrace.io/api',
    key: process.env.SNOWTRACE_API_KEY || null
  },
  fantom: {
    url: 'https://api.ftmscan.com/api',
    key: process.env.FTMSCAN_API_KEY || null
  },
  arbitrum: {
    url: 'https://api.arbiscan.io/api',
    key: process.env.ARBISCAN_API_KEY || null
  },
  optimism: {
    url: 'https://api-optimistic.etherscan.io/api',
    key: process.env.OPTIMISM_API_KEY || null
  }
};

// Map network names to DB key names
const NETWORK_TO_DB_KEY = {
  ethereum: 'ethereum', sepolia: 'ethereum',
  bsc: 'bsc', 'bsc-testnet': 'bsc',
  polygon: 'polygon', mumbai: 'polygon'
};

let explorerKeysLoaded = false;

class ABIManager {
  constructor() {
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min TTL
  }

  /**
   * Load explorer API keys from encrypted DB storage (once).
   * Populates EXPLORER_APIS[network].key for any network that has a stored key.
   */
  async loadExplorerKeys() {
    if (explorerKeysLoaded) return;
    try {
      const stored = await PluginSettings.getCached('crypto', 'explorer_api_keys');
      if (stored) {
        for (const [dbKey, encryptedVal] of Object.entries(stored)) {
          try {
            const apiKey = decrypt(encryptedVal);
            // Apply to all networks that map to this DB key
            for (const [network, mappedKey] of Object.entries(NETWORK_TO_DB_KEY)) {
              if (mappedKey === dbKey && EXPLORER_APIS[network] && !EXPLORER_APIS[network].key) {
                EXPLORER_APIS[network].key = apiKey;
              }
            }
          } catch (err) {
            logger.warn(`Failed to decrypt explorer key for ${dbKey}`);
          }
        }
        logger.info(`ABIManager: loaded explorer API keys from DB`);
      }
    } catch (err) {
      logger.debug(`ABIManager: could not load explorer keys from DB: ${err.message}`);
    }
    explorerKeysLoaded = true;
  }

  /**
   * Get ABI for a contract
   */
  async getABI(address, network) {
    const cacheKey = `${network}:${address.toLowerCase()}`;

    // Check memory cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Check database
    try {
      const stored = await retryOperation(
        () => ContractABI.findOne({
          address: address.toLowerCase(),
          network
        }),
        { retries: 3, shouldRetry: isRetryableError }
      );

      if (stored) {
        this.cache.set(cacheKey, stored.abi);
        return stored.abi;
      }
    } catch (error) {
      logger.error('Error retrieving ABI from database:', error);
      throw error;
    }

    // Try to fetch from explorer
    const fetched = await this.fetchABIFromExplorer(address, network);
    if (fetched) {
      await this.saveABI(address, network, fetched, 'etherscan');
      return fetched;
    }

    return null;
  }

  /**
   * Save ABI to database
   */
  async saveABI(address, network, abi, source = 'manual', metadata = {}) {
    try {
      const doc = await retryOperation(
        () => ContractABI.findOneAndUpdate(
          { address: address.toLowerCase(), network },
          {
            address: address.toLowerCase(),
            network,
            abi,
            source,
            verified: source === 'etherscan',
            ...metadata
          },
          { upsert: true, new: true }
        ),
        { retries: 3, shouldRetry: isRetryableError }
      );

      const cacheKey = `${network}:${address.toLowerCase()}`;
      this.cache.set(cacheKey, abi);

      logger.info(`ABI saved for ${address} on ${network}`);
      return doc;
    } catch (error) {
      logger.error('Error saving ABI:', error);
      throw error;
    }
  }

  /**
   * Fetch ABI from block explorer
   */
  async fetchABIFromExplorer(address, network) {
    await this.loadExplorerKeys();
    const explorer = EXPLORER_APIS[network];
    if (!explorer || !explorer.key) {
      logger.debug(`No explorer API configured for ${network}`);
      return null;
    }

    try {
      const response = await retryOperation(
        () => axios.get(explorer.url, {
          params: {
            module: 'contract',
            action: 'getabi',
            address,
            apikey: explorer.key
          },
          timeout: 10000
        }),
        { retries: 3, shouldRetry: isRetryableError }
      );

      if (response.data.status === '1' && response.data.result) {
        const abi = JSON.parse(response.data.result);
        return abi;
      }
    } catch (error) {
      logger.debug(`Failed to fetch ABI from explorer: ${error.message}`);
    }

    return null;
  }

  /**
   * Get standard ABI by type
   */
  getStandardABI(type) {
    return STANDARD_ABIS[type] || null;
  }

  /**
   * List all stored ABIs
   */
  async listABIs(network = null) {
    const query = network ? { network } : {};
    return await ContractABI.find(query).select('-abi');
  }

  /**
   * Delete ABI
   */
  async deleteABI(address, network) {
    const cacheKey = `${network}:${address.toLowerCase()}`;
    this.cache.del(cacheKey);

    return await ContractABI.findOneAndDelete({
      address: address.toLowerCase(),
      network
    });
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.flushAll();
  }
}

export default new ABIManager();