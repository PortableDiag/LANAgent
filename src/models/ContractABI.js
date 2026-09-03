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
  },
  securityAudit: {
    auditStatus: {
      type: String,
      enum: ['pending', 'passed', 'failed', 'in_progress'],
      default: 'pending'
    },
    vulnerabilities: [{
      id: String,
      severity: {
        type: String,
        // Must match every severity the contractAudit plugin actually emits.
        // It produces critical/high/medium/low via runPatterns AND 'info' for its
        // informational checks; omitting 'info' would throw a ValidationError on
        // save the first time an audit surfaced one, i.e. on most real contracts.
        enum: ['info', 'low', 'medium', 'high', 'critical']
      },
      title: String,
      description: String,
      recommendation: String,
      detectedAt: Date
    }],
    lastScanDate: Date
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

/**
 * Aggregates known vulnerabilities from integrated security services.
 * @param {string} address - The contract address.
 * @param {string} network - The network name.
 * @returns {Promise<Object>} - The security report containing vulnerabilities and audit status.
 */
contractABISchema.statics.getSecurityReport = async function(address, network) {
  try {
    const contract = await retryOperation(() => this.findOne({ address, network }), { retries: 3 });
    
    if (!contract) {
      throw new Error(`Contract not found for address ${address} on network ${network}`);
    }

    // If there's no security audit data, initialize it
    if (!contract.securityAudit) {
      contract.securityAudit = {
        auditStatus: 'pending',
        vulnerabilities: [],
        lastScanDate: null
      };
    }

    return {
      address: contract.address,
      network: contract.network,
      auditStatus: contract.securityAudit.auditStatus,
      vulnerabilities: contract.securityAudit.vulnerabilities || [],
      lastScanDate: contract.securityAudit.lastScanDate
    };
  } catch (error) {
    logger.error('Error in getSecurityReport:', error);
    throw error;
  }
};

/**
 * Updates the security audit information for a contract.
 * @param {string} address - The contract address.
 * @param {string} network - The network name.
 * @param {Object} auditData - The audit data to update.
 * @returns {Promise<Object>} - The updated contract document.
 */
contractABISchema.statics.updateSecurityAudit = async function(address, network, auditData) {
  try {
    // Build $set from the fields actually supplied. Setting every key
    // unconditionally means a caller updating only the status would also write
    // `undefined` over an existing vulnerability list, silently discarding the
    // findings from the previous scan.
    const $set = { 'securityAudit.lastScanDate': auditData.lastScanDate || new Date() };
    if (auditData.auditStatus !== undefined) {
      $set['securityAudit.auditStatus'] = auditData.auditStatus;
    }
    if (auditData.vulnerabilities !== undefined) {
      $set['securityAudit.vulnerabilities'] = auditData.vulnerabilities;
    }

    const updatedContract = await retryOperation(() =>
      this.findOneAndUpdate({ address, network }, { $set }, { new: true, runValidators: true }),
      { retries: 3 }
    );
    
    if (!updatedContract) {
      throw new Error(`Failed to update security audit for contract ${address} on network ${network}`);
    }
    
    // Invalidate cache
    const cacheKey = `${address}-${network}`;
    cache.del(cacheKey);
    
    return updatedContract;
  } catch (error) {
    logger.error('Error in updateSecurityAudit:', error);
    throw error;
  }
};

export const ContractABI = mongoose.model('ContractABI', contractABISchema);
