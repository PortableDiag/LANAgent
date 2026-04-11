import { logger } from '../../utils/logger.js';
import abiManager from './abiManager.js';
import walletService from './walletService.js';

// Lazy load ethers to avoid WebSocket import issue
let ethersLib = null;

async function getEthers() {
  if (!ethersLib) {
    try {
      // Use dynamic import to avoid the ws module issue
      const ethers = await import('ethers');
      ethersLib = ethers;
    } catch (error) {
      logger.error('Failed to load ethers:', error);
      throw error;
    }
  }
  return ethersLib;
}

// Network configurations with RPC fallbacks
const NETWORKS = {
  ethereum: {
    chainId: 1,
    rpc: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://1rpc.io/eth'
    ],
    explorer: 'https://etherscan.io'
  },
  sepolia: {
    chainId: 11155111,
    rpc: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://rpc.sepolia.org',
      'https://rpc2.sepolia.org'
    ],
    explorer: 'https://sepolia.etherscan.io'
  },
  bsc: {
    chainId: 56,
    rpc: [
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.binance.org',
      'https://bsc-dataseed2.binance.org',
      'https://bsc-dataseed3.binance.org',
      'https://bsc-dataseed4.binance.org',
      'https://bsc.publicnode.com',
      'https://rpc.ankr.com/bsc'
    ],
    explorer: 'https://bscscan.com'
  },
  'bsc-testnet': {
    chainId: 97,
    rpc: [
      'https://data-seed-prebsc-1-s1.binance.org:8545',
      'https://data-seed-prebsc-2-s1.binance.org:8545',
      'https://data-seed-prebsc-1-s2.binance.org:8545'
    ],
    explorer: 'https://testnet.bscscan.com'
  },
  polygon: {
    chainId: 137,
    rpc: [
      'https://rpc.ankr.com/polygon',
      'https://polygon-bor-rpc.publicnode.com',
      'https://1rpc.io/matic'
    ],
    explorer: 'https://polygonscan.com'
  },
  mumbai: {
    chainId: 80001,
    rpc: [
      'https://rpc-mumbai.maticvigil.com',
      'https://polygon-mumbai-bor-rpc.publicnode.com'
    ],
    explorer: 'https://mumbai.polygonscan.com'
  },
  amoy: {
    chainId: 80002,
    rpc: [
      'https://rpc-amoy.polygon.technology',
      'https://polygon-amoy-bor-rpc.publicnode.com'
    ],
    explorer: 'https://amoy.polygonscan.com'
  },
  base: {
    chainId: 8453,
    rpc: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://1rpc.io/base',
      'https://base.publicnode.com'
    ],
    explorer: 'https://basescan.org'
  },
  'base-sepolia': {
    chainId: 84532,
    rpc: [
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com'
    ],
    explorer: 'https://sepolia.basescan.org'
  },
  arbitrum: {
    chainId: 42161,
    rpc: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.llamarpc.com',
      'https://rpc.ankr.com/arbitrum',
      'https://1rpc.io/arb'
    ],
    explorer: 'https://arbiscan.io'
  },
  optimism: {
    chainId: 10,
    rpc: [
      'https://mainnet.optimism.io',
      'https://optimism.llamarpc.com',
      'https://rpc.ankr.com/optimism',
      'https://1rpc.io/op'
    ],
    explorer: 'https://optimistic.etherscan.io'
  }
};

// Common testnet token addresses
const TESTNET_TOKENS = {
  sepolia: {
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    LINK: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
    WETH: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9'
  },
  mumbai: {
    USDC: '0x0FA8781a83E46826621b3BC094Ea2A0212e71B23',
    LINK: '0x326C977E6efc84E512bB9C30f76E30c160eD06FB',
    WMATIC: '0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889'
  },
  'bsc-testnet': {
    BUSD: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee',
    USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
    WBNB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
  }
};

class ContractService {
  constructor() {
    this.providers = {};
    this.providerIndex = {}; // Track which RPC index is currently active per network
    this.contracts = new Map();
    this.eventListeners = new Map();
  }

  /**
   * Get or create provider for network
   * @param {string} network - Network name
   * @param {boolean} forceNew - Force create a new provider (for fallback)
   */
  async getProvider(network, forceNew = false) {
    const config = NETWORKS[network];
    if (!config) {
      throw new Error(`Unknown network: ${network}`);
    }

    // Initialize provider index if not set
    if (this.providerIndex[network] === undefined) {
      this.providerIndex[network] = 0;
    }

    // Get RPC URLs (handle both array and legacy single string)
    const rpcUrls = Array.isArray(config.rpc) ? config.rpc : [config.rpc];

    if (forceNew || !this.providers[network]) {
      const ethers = await getEthers();
      const rpcUrl = rpcUrls[this.providerIndex[network]];

      // Create provider with explicit network to skip auto-detection (which retries forever)
      // This makes the provider fail fast if RPC is unavailable.
      // Disable JSON-RPC batching (batchMaxCount: 1) because public RPCs return
      // "id: null" in rate-limit error responses, which breaks ethers.js batch
      // response mapping and generates unhandled promise rejections.
      const staticNetwork = ethers.Network.from(config.chainId);
      this.providers[network] = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, {
        staticNetwork: true,
        batchMaxCount: 1
      });
      logger.debug(`Using RPC for ${network}: ${rpcUrl} (index ${this.providerIndex[network]})`);
    }
    return this.providers[network];
  }

  /**
   * Switch to next available RPC for a network
   * @returns {boolean} True if switched, false if no more fallbacks
   */
  async switchToNextRpc(network) {
    const config = NETWORKS[network];
    if (!config) return false;

    const rpcUrls = Array.isArray(config.rpc) ? config.rpc : [config.rpc];
    const currentIndex = this.providerIndex[network] || 0;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= rpcUrls.length) {
      // Reset to first RPC after trying all
      this.providerIndex[network] = 0;
      logger.warn(`All RPCs exhausted for ${network}, resetting to first`);
      return false;
    }

    this.providerIndex[network] = nextIndex;
    logger.info(`Switching ${network} RPC to fallback ${nextIndex}: ${rpcUrls[nextIndex]}`);

    // Clear cached provider to force recreation
    delete this.providers[network];

    // Clear cached contracts for this network
    for (const key of this.contracts.keys()) {
      if (key.startsWith(`${network}:`)) {
        this.contracts.delete(key);
      }
    }

    return true;
  }

  /**
   * Get a signer (wallet connected to provider) for write operations
   */
  async getSigner(network) {
    const ethers = await getEthers();
    const provider = await this.getProvider(network);

    const mongoose = (await import('mongoose')).default;
    const { decrypt } = await import('../../utils/encryption.js');
    const CryptoWallet = (await import('../../models/CryptoWallet.js')).default;

    const wallet = await CryptoWallet.findOne({});
    if (!wallet) throw new Error('No wallet configured');

    const mnemonic = decrypt(wallet.encryptedSeed);
    const hdWallet = ethers.Wallet.fromPhrase(mnemonic);
    return hdWallet.connect(provider);
  }

  /**
   * Execute an RPC call with automatic fallback on rate limiting or errors
   */
  async withRpcFallback(network, operation, maxRetries = 3) {
    let lastError;
    const config = NETWORKS[network];
    const rpcUrls = Array.isArray(config?.rpc) ? config.rpc : [config?.rpc];
    const totalRpcs = rpcUrls.length;

    for (let attempt = 0; attempt < Math.min(maxRetries, totalRpcs); attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error.message || '';

        // Check if it's a rate limit or connection error that warrants fallback
        const shouldFallback =
          errorMsg.includes('rate limit') ||
          errorMsg.includes('Too many requests') ||
          errorMsg.includes('429') ||
          errorMsg.includes('missing response') ||
          errorMsg.includes('ECONNREFUSED') ||
          errorMsg.includes('ETIMEDOUT') ||
          errorMsg.includes('failed to detect network') ||
          errorMsg.includes('could not coalesce');

        if (shouldFallback && attempt < maxRetries - 1) {
          logger.warn(`RPC error on ${network} (attempt ${attempt + 1}): ${errorMsg.substring(0, 100)}. Trying fallback...`);
          const switched = await this.switchToNextRpc(network);
          if (!switched) {
            // Wait a bit before retrying with reset RPCs
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * Get contract instance
   */
  async getContract(address, network, abi = null) {
    const key = `${network}:${address}`;
    
    if (this.contracts.has(key)) {
      return this.contracts.get(key);
    }

    // Get ABI if not provided
    if (!abi) {
      abi = await abiManager.getABI(address, network);
      if (!abi) {
        throw new Error(`No ABI found for ${address} on ${network}`);
      }
    }

    const ethers = await getEthers();
    const provider = await this.getProvider(network);
    const contract = new ethers.Contract(address, abi, provider);
    
    this.contracts.set(key, contract);
    return contract;
  }

  /**
   * Read contract state
   */
  async readContract(address, network, functionName, params = []) {
    try {
      const contract = await this.getContract(address, network);
      
      if (!contract[functionName]) {
        throw new Error(`Function ${functionName} not found in contract`);
      }

      const result = await contract[functionName](...params);
      
      // Format result based on type
      if (typeof result === 'bigint') {
        return result.toString();
      } else if (result?._isBigNumber) {
        return result.toString();
      } else if (Array.isArray(result)) {
        return result.map(item => 
          typeof item === 'bigint' || item?._isBigNumber
            ? item.toString() 
            : item
        );
      }
      
      return result;
    } catch (error) {
      logger.error(`Error reading contract ${address} on ${network}:`, error);
      throw error;
    }
  }

  /**
   * Get token information (ERC-20)
   */
  async getTokenInfo(tokenAddress, network) {
    try {
      // Try with standard ERC20 ABI first
      const abi = abiManager.getStandardABI('ERC20');
      const contract = await this.getContract(tokenAddress, network, abi);
      
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        contract.name().catch(() => 'Unknown'),
        contract.symbol().catch(() => 'UNKNOWN'),
        contract.decimals().catch(() => 18),
        contract.totalSupply().catch(() => '0')
      ]);

      return {
        address: tokenAddress,
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply: totalSupply.toString(),
        network
      };
    } catch (error) {
      logger.error(`Error getting token info for ${tokenAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get token balance (with RPC fallback)
   */
  async getTokenBalance(tokenAddress, holderAddress, network) {
    return this.withRpcFallback(network, async () => {
      const ethers = await getEthers();
      const abi = abiManager.getStandardABI('ERC20');
      const contract = await this.getContract(tokenAddress, network, abi);

      const [balance, decimals] = await Promise.all([
        contract.balanceOf(holderAddress),
        contract.decimals()
      ]);

      return {
        raw: balance.toString(),
        formatted: ethers.formatUnits(balance, decimals),
        decimals: Number(decimals)
      };
    });
  }

  /**
   * Get NFT info (ERC-721)
   */
  async getNFTInfo(nftAddress, network) {
    try {
      const abi = abiManager.getStandardABI('ERC721');
      const contract = await this.getContract(nftAddress, network, abi);
      
      const [name, symbol] = await Promise.all([
        contract.name().catch(() => 'Unknown NFT'),
        contract.symbol().catch(() => 'NFT')
      ]);

      return {
        address: nftAddress,
        name,
        symbol,
        type: 'ERC721',
        network
      };
    } catch (error) {
      logger.error(`Error getting NFT info:`, error);
      throw error;
    }
  }

  /**
   * Get NFT balance and token IDs
   */
  async getNFTBalance(nftAddress, ownerAddress, network) {
    try {
      const abi = abiManager.getStandardABI('ERC721');
      const contract = await this.getContract(nftAddress, network, abi);
      
      const balance = await contract.balanceOf(ownerAddress);
      
      // Note: Getting all token IDs requires enumerable extension
      // or event scanning, which we'll implement later
      
      return {
        balance: balance.toString(),
        tokenIds: [] // Will be populated in event scanning implementation
      };
    } catch (error) {
      logger.error(`Error getting NFT balance:`, error);
      throw error;
    }
  }

  /**
   * Get native token balance (ETH, BNB, MATIC)
   */
  async getNativeBalance(address, network) {
    return this.withRpcFallback(network, async () => {
      const ethers = await getEthers();
      const provider = await this.getProvider(network);
      const balance = await provider.getBalance(address);

      const symbols = {
        ethereum: 'ETH',
        sepolia: 'ETH',
        bsc: 'BNB',
        'bsc-testnet': 'BNB',
        polygon: 'MATIC',
        mumbai: 'MATIC',
        amoy: 'MATIC',
        base: 'ETH',
        'base-sepolia': 'ETH'
      };

      return {
        raw: balance.toString(),
        formatted: ethers.formatEther(balance),
        symbol: symbols[network] || 'NATIVE',
        network
      };
    });
  }

  /**
   * Get common testnet tokens for a network
   */
  getTestnetTokens(network) {
    return TESTNET_TOKENS[network] || {};
  }

  /**
   * Get network info
   */
  getNetworkInfo(network) {
    return NETWORKS[network] || null;
  }

  /**
   * List all supported networks
   */
  getSupportedNetworks() {
    return Object.keys(NETWORKS);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.contracts.clear();
  }

  /**
   * Subscribe to contract events
   */
  async subscribeToEvents(address, network, eventFilter = {}) {
    try {
      const { ContractEvent } = await import('../../models/ContractEvent.js');
      const contract = await this.getContract(address, network);
      const provider = await this.getProvider(network);
      
      // Create a unique subscription ID
      const subscriptionId = `${network}:${address}:${Date.now()}`;
      
      // Get the current block number
      const currentBlock = await provider.getBlockNumber();
      
      // Create event listener
      const listener = async (event) => {
        try {
          // Get block timestamp
          const block = await provider.getBlock(event.blockNumber);
          
          // Save event to database
          await ContractEvent.create({
            contractAddress: address.toLowerCase(),
            network,
            eventName: event.eventName || event.fragment?.name || 'Unknown',
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
            logIndex: event.logIndex,
            removed: event.removed || false,
            returnValues: event.args || {},
            topics: event.topics || [],
            rawData: event.data || '',
            timestamp: new Date(block.timestamp * 1000),
            subscription: {
              id: subscriptionId,
              active: true,
              filters: eventFilter
            }
          });
          
          logger.info(`Event recorded: ${event.eventName} from ${address} on ${network}`);
          
          // Emit event for real-time updates
          if (this.eventEmitter) {
            this.eventEmitter.emit('contractEvent', {
              subscription: subscriptionId,
              event: event
            });
          }
        } catch (error) {
          logger.error('Error processing event:', error);
        }
      };
      
      // Handle different event filter types
      if (eventFilter.eventName) {
        // Subscribe to specific event
        contract.on(eventFilter.eventName, listener);
      } else {
        // Subscribe to all events
        contract.on('*', listener);
      }
      
      // Store listener reference for cleanup
      if (!this.eventListeners.has(subscriptionId)) {
        this.eventListeners.set(subscriptionId, {
          contract,
          network,
          address,
          listener,
          eventFilter,
          startBlock: currentBlock
        });
      }
      
      logger.info(`Started event monitoring for ${address} on ${network}`);
      return subscriptionId;
      
    } catch (error) {
      logger.error('Error subscribing to events:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribeFromEvents(subscriptionId) {
    try {
      const subscription = this.eventListeners.get(subscriptionId);
      if (!subscription) {
        throw new Error(`Subscription ${subscriptionId} not found`);
      }
      
      const { contract, listener, eventFilter } = subscription;
      
      // Remove listener
      if (eventFilter.eventName) {
        contract.off(eventFilter.eventName, listener);
      } else {
        contract.off('*', listener);
      }
      
      // Update database
      const { ContractEvent } = await import('../../models/ContractEvent.js');
      await ContractEvent.updateMany(
        { 'subscription.id': subscriptionId },
        { 'subscription.active': false }
      );
      
      // Remove from map
      this.eventListeners.delete(subscriptionId);
      
      logger.info(`Stopped event monitoring for subscription ${subscriptionId}`);
      return true;
      
    } catch (error) {
      logger.error('Error unsubscribing from events:', error);
      throw error;
    }
  }

  /**
   * Get past events
   */
  async getPastEvents(address, network, options = {}) {
    try {
      const {
        eventName,
        fromBlock = 0,
        toBlock = 'latest',
        filters = {}
      } = options;
      
      const contract = await this.getContract(address, network);
      const ethers = await getEthers();
      
      // Create event filter
      let eventFilter;
      if (eventName && contract.filters[eventName]) {
        eventFilter = contract.filters[eventName](...Object.values(filters));
      } else {
        eventFilter = contract.filters['*']();
      }
      
      // Query events
      const events = await contract.queryFilter(
        eventFilter,
        fromBlock,
        toBlock
      );
      
      // Get provider for block timestamps
      const provider = await this.getProvider(network);
      
      // Process events
      const processedEvents = await Promise.all(
        events.map(async (event) => {
          const block = await provider.getBlock(event.blockNumber);
          return {
            eventName: event.eventName || event.fragment?.name || 'Unknown',
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
            logIndex: event.logIndex,
            removed: event.removed || false,
            args: event.args || {},
            topics: event.topics || [],
            data: event.data || '',
            timestamp: new Date(block.timestamp * 1000),
            address: event.address,
            network
          };
        })
      );
      
      return processedEvents;
      
    } catch (error) {
      logger.error('Error getting past events:', error);
      throw error;
    }
  }

  /**
   * Get stored events from database
   */
  async getStoredEvents(address, network, options = {}) {
    try {
      const { ContractEvent } = await import('../../models/ContractEvent.js');
      
      const {
        eventName,
        fromDate,
        toDate,
        limit = 100,
        skip = 0
      } = options;
      
      // Build query
      const query = {
        contractAddress: address.toLowerCase(),
        network
      };
      
      if (eventName) {
        query.eventName = eventName;
      }
      
      if (fromDate || toDate) {
        query.timestamp = {};
        if (fromDate) query.timestamp.$gte = new Date(fromDate);
        if (toDate) query.timestamp.$lte = new Date(toDate);
      }
      
      // Execute query
      const events = await ContractEvent
        .find(query)
        .sort({ blockNumber: -1, logIndex: -1 })
        .skip(skip)
        .limit(limit)
        .exec();
      
      return events.map(event => event.toDisplay());
      
    } catch (error) {
      logger.error('Error getting stored events:', error);
      throw error;
    }
  }

  /**
   * Get active subscriptions
   */
  getActiveSubscriptions() {
    const subscriptions = [];
    
    for (const [id, subscription] of this.eventListeners) {
      subscriptions.push({
        id,
        address: subscription.address,
        network: subscription.network,
        eventFilter: subscription.eventFilter,
        startBlock: subscription.startBlock
      });
    }
    
    return subscriptions;
  }

  /**
   * Clear all event subscriptions
   */
  async clearAllSubscriptions() {
    for (const subscriptionId of this.eventListeners.keys()) {
      await this.unsubscribeFromEvents(subscriptionId);
    }
  }

  /**
   * Set event emitter for real-time updates
   */
  setEventEmitter(emitter) {
    this.eventEmitter = emitter;
  }
}

export default new ContractService();