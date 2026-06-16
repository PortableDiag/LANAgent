import mongoose from 'mongoose';
import NodeCache from 'node-cache';
import { retryOperation } from '../utils/retryUtils.js';
import { logger } from '../utils/logger.js';

const contractABISchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    index: true
  },
  address: {
    type: String,
    required: true,
    lowercase: true
  },
  network: {
    type: String,
    required: true,
    enum: ['ethereum', 'sepolia', 'bsc', 'bsc-testnet', 'polygon', 'mumbai', 'base', 'base-sepolia', 'avalanche', 'fantom', 'arbitrum']
  },
  abi: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  verified: {
    type: Boolean,
    default: false
  },
  source: {
    type: String,
    enum: ['manual', 'etherscan', 'deployed', 'imported'],
    default: 'manual'
  },
  deploymentTx: String,
  deployer: String,
  blockNumber: Number,
  metadata: {
    compiler: String,
    optimizer: Boolean,
    runs: Number,
    evmVersion: String
  }
}, {
  timestamps: true
});

// Compound index for unique contract per network
contractABISchema.index({ address: 1, network: 1 }, { unique: true });

/**
 * Advanced query capabilities for ContractABI model.
 * Allows filtering by metadata properties such as compiler version, optimizer settings, EVM version,
 * deployment transaction hash, deployer address, and block number.
 */
contractABISchema.statics.findByMetadata = async function(filters) {
  try {
    const query = {};
    if (filters.compiler) {
      query['metadata.compiler'] = filters.compiler;
    }
    if (filters.optimizer !== undefined) {
      query['metadata.optimizer'] = filters.optimizer;
    }
    if (filters.evmVersion) {
      query['metadata.evmVersion'] = filters.evmVersion;
    }
    if (filters.deploymentTx) {
      query.deploymentTx = filters.deploymentTx;
    }
    if (filters.deployer) {
      query.deployer = filters.deployer;
    }
    if (filters.blockNumber !== undefined) {
      query.blockNumber = filters.blockNumber;
    }
    return await retryOperation(() => this.find(query), { retries: 3 });
  } catch (error) {
    logger.error('Error in findByMetadata:', error);
    throw error;
  }
};

// Initialize cache
const cache = new NodeCache({ stdTTL: 100, checkperiod: 120 });

/**
 * Retrieves a ContractABI by address and network, with caching.
 * @param {string} address - The contract address.
 * @param {string} network - The network name.
 * @returns {Promise<Object>} - The ContractABI document.
 */
contractABISchema.statics.getByAddressAndNetwork = async function(address, network) {
  const cacheKey = `${address}-${network}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  try {
    const result = await retryOperation(() => this.findOne({ address, network }), { retries: 3 });
    if (result) {
      cache.set(cacheKey, result);
    }
    return result;
  } catch (error) {
    logger.error('Error in getByAddressAndNetwork:', error);
    throw error;
  }
};

export const ContractABI = mongoose.model('ContractABI', contractABISchema);
