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

// EIP-1967 implementation storage slot
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

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
   * Provider for proxy resolution. Reuses contractServiceWrapper's provider (its
   * NETWORKS table, RPC failover and keys) instead of a second RPC config. Imported
   * lazily: the wrapper imports this module, so a static import would be circular.
   * Returns null for a network the wrapper does not know, so resolution is skipped.
   */
  async getProvider(network) {
    try {
      const { default: contractService } = await import('./contractServiceWrapper.js');
      return await contractService.getProvider(network);
    } catch (err) {
      logger.debug(`ABIManager: no provider for ${network}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get ABI for a contract, optionally resolving proxy implementation.
   * @param {string} address - contract address
   * @param {string} network - network name
   * @param {Object} [options] - options
   * @param {boolean} [options.resolveProxy=true] - whether to resolve proxy implementation ABI
   * @param {number} [options.maxDepth=3] - maximum recursion depth for proxy resolution
   * @returns {Array|null} ABI array or null
   */
  async getABI(address, network, options = {}) {
    const { resolveProxy = true, maxDepth = 3 } = options;
    const cacheKey = `${network}:${address.toLowerCase()}`;

    // Check memory cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Check database
    let abi = null;
    try {
      const stored = await retryOperation(
        () => ContractABI.findOne({
          address: address.toLowerCase(),
          network
        }),
        { retries: 3, shouldRetry: isRetryableError }
      );

      if (stored) {
        abi = stored.abi;
      }
    } catch (error) {
      logger.error('Error retrieving ABI from database:', error);
      throw error;
    }

    // Try to fetch from explorer if not in DB
    if (!abi) {
      const fetched = await this.fetchABIFromExplorer(address, network);
      if (fetched) {
        await this.saveABI(address, network, fetched, 'etherscan');
        abi = fetched;
      }
    }

    // Resolve proxy if requested and ABI exists
    if (abi && resolveProxy && maxDepth > 0) {
      try {
        const mergedABI = await this.resolveProxy(address, network, abi, { maxDepth });
        if (mergedABI) {
          // Memory cache only. The stored row stays the proxy's own ABI: a proxy can be
          // upgraded to a new implementation, so the merge is re-derived after the TTL
          // rather than frozen into the database.
          this.cache.set(cacheKey, mergedABI);
          return mergedABI;
        }
      } catch (err) {
        logger.warn(`Proxy resolution failed for ${address} on ${network}: ${err.message}`);
        // Fall back to the base ABI
      }
    }

    // Cache the base ABI if we didn't resolve
    if (abi) {
      this.cache.set(cacheKey, abi);
    }
    return abi;
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

  /**
   * Resolve proxy contract to its implementation ABI.
   * Checks EIP-1967 storage slot and `implementation()` method.
   * Recursively fetches implementation ABI and merges with proxy ABI.
   * @param {string} address - proxy contract address
   * @param {string} network - network name
   * @param {Array} proxyABI - ABI of the proxy contract
   * @param {Object} [options] - options
   * @param {number} [options.maxDepth=3] - maximum recursion depth
   * @returns {Array|null} merged ABI or null if resolution fails
   */
  async resolveProxy(address, network, proxyABI, options = {}) {
    const { maxDepth = 3 } = options;
    if (maxDepth <= 0) return null;

    const provider = await this.getProvider(network);
    if (!provider) {
      logger.debug(`Cannot resolve proxy for ${address} on ${network}: no provider`);
      return null;
    }
    const { ethers } = await import('ethers');

    let implementationAddress = null;

    // Try to get implementation address from known storage slots or method call
    try {
      implementationAddress = await this.getImplementationAddress(provider, address, proxyABI);
    } catch (err) {
      logger.warn(`Failed to read implementation address for ${address} on ${network}: ${err.message}`);
      return null;
    }

    if (!implementationAddress || implementationAddress === ethers.ZeroAddress ||
        implementationAddress.toLowerCase() === address.toLowerCase()) {
      logger.debug(`No implementation found for proxy ${address} on ${network}`);
      return null;
    }

    logger.info(`Resolved proxy ${address} -> implementation ${implementationAddress} on ${network}`);

    // Fetch implementation ABI (do not resolve proxy again for the implementation to avoid loops,
    // but allow further proxy resolution if maxDepth > 1)
    const implABI = await this.getABI(implementationAddress, network, {
      resolveProxy: maxDepth > 1,
      maxDepth: maxDepth - 1
    });

    if (!implABI) {
      logger.warn(`Could not fetch ABI for implementation ${implementationAddress}`);
      return null;
    }

    // Merge proxy ABI with implementation ABI
    return this.mergeABIs(proxyABI, implABI);
  }

  /**
   * Retrieve the implementation address for a proxy contract.
   * Checks EIP-1967 storage slot first, then tries calling `implementation()` if present in ABI.
   * @param {ethers.JsonRpcProvider} provider - ethers provider
   * @param {string} address - proxy address
   * @param {Array} abi - proxy ABI
   * @returns {string|null} implementation address or null
   */
  async getImplementationAddress(provider, address, abi) {
    const { ethers } = await import('ethers');
    // 1. Try EIP-1967 storage slot
    try {
      const storage = await retryOperation(
        () => provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT),
        { retries: 2, shouldRetry: isRetryableError }
      );
      if (storage && BigInt(storage) !== 0n) {
        // Convert bytes32 to address (last 20 bytes)
        const addr = '0x' + storage.slice(-40);
        if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) {
          return ethers.getAddress(addr);
        }
      }
    } catch (err) {
      logger.debug(`EIP-1967 storage read failed for ${address}: ${err.message}`);
    }

    // 2. Try calling implementation() if present in ABI
    const hasImplementationMethod = abi.some(
      item => item.type === 'function' && item.name === 'implementation' && (item.inputs || []).length === 0
    );
    if (hasImplementationMethod) {
      try {
        const contract = new ethers.Contract(address, abi, provider);
        const impl = await retryOperation(
          () => contract.implementation(),
          { retries: 2, shouldRetry: isRetryableError }
        );
        if (impl && ethers.isAddress(impl) && impl !== ethers.ZeroAddress) {
          return ethers.getAddress(impl);
        }
      } catch (err) {
        logger.debug(`implementation() call failed for ${address}: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Merge two ABIs, avoiding duplicate entries.
   * Proxy ABI entries take precedence; implementation entries are added only if not already present.
   * @param {Array} proxyABI
   * @param {Array} implementationABI
   * @returns {Array} merged ABI
   */
  mergeABIs(proxyABI, implementationABI) {
    const seen = new Set();
    const merged = [];

    // Helper to generate a unique key for an ABI item
    const itemKey = (item) => {
      if (item.type === 'function' || item.type === 'event') {
        const inputs = (item.inputs || []).map(i => i.type).join(',');
        return `${item.type}:${item.name}:${inputs}`;
      }
      // For constructors, fallbacks, etc., use type and stateMutability if available
      return `${item.type}:${item.stateMutability || ''}`;
    };

    // Add proxy ABI items first
    for (const item of proxyABI) {
      const key = itemKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }

    // Add implementation ABI items not already present
    for (const item of implementationABI) {
      const key = itemKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }

    return merged;
  }
}

export default new ABIManager();
