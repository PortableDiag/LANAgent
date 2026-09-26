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

// Single source of truth: the schema's own network enum.
const supportedNetworks = new Set(contractABISchema.path('network').enumValues);

const normalizeType = (input) => {
  if (!input || typeof input !== 'object') return '';
  return String(input.type || '').trim();
};

const normalizeParameter = (input) => ({
  name: typeof input?.name === 'string' ? input.name : '',
  type: normalizeType(input),
  components: Array.isArray(input?.components)
    ? input.components.map(normalizeParameter)
    : undefined,
  indexed: input?.indexed === true
});

const parameterSignature = (input) => {
  if (!input || typeof input !== 'object') return '';
  const type = normalizeType(input);
  if (!type.startsWith('tuple')) return type;
  const components = Array.isArray(input.components)
    ? input.components.map(parameterSignature).join(',')
    : '';
  // Keep any array suffix: tuple -> (..), tuple[] -> (..)[], tuple[2][] -> (..)[2][]
  return `(${components})${type.slice('tuple'.length)}`;
};

const normalizeABIEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;

  const type = entry.type || 'function';
  const inputs = Array.isArray(entry.inputs) ? entry.inputs.map(normalizeParameter) : [];
  const outputs = Array.isArray(entry.outputs) ? entry.outputs.map(normalizeParameter) : [];
  const inputTypes = inputs.map(parameterSignature);
  const outputTypes = outputs.map(parameterSignature);

  return {
    type,
    name: typeof entry.name === 'string' ? entry.name : '',
    inputs,
    outputs,
    inputTypes,
    outputTypes,
    mutability: entry.stateMutability || (entry.constant ? 'view' : 'nonpayable'),
    indexed: type === 'event' ? inputs.map((input) => input.indexed === true) : []
  };
};

const entryKey = (entry) => {
  if (entry.type === 'constructor' || entry.type === 'fallback' || entry.type === 'receive') {
    return `${entry.type}(${entry.inputTypes.join(',')})`;
  }
  return `${entry.type}:${entry.name}(${entry.inputTypes.join(',')})`;
};

const entryDescription = (entry) => ({
  type: entry.type,
  name: entry.name,
  inputTypes: entry.inputTypes,
  outputTypes: entry.outputTypes,
  mutability: entry.mutability,
  indexed: entry.indexed
});

// A mutability change breaks existing callers when a payable function stops accepting
// value (calls sending ETH now revert), or a read-only function starts writing state
// (eth_call/staticcall callers get no persisted effect or revert). pure<->view, and
// relaxing nonpayable -> payable or -> view/pure, are safe for existing callers.
const isBreakingMutabilityChange = (previous, next) => {
  const readOnly = (m) => m === 'view' || m === 'pure';
  if (previous === 'payable' && next !== 'payable') return true;
  if (readOnly(previous) && !readOnly(next)) return true;
  return false;
};

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
 * Compares two contract ABIs and classifies compatible and potentially breaking changes.
 * @param {Array<Object>} previousABI - ABI used by the currently deployed contract.
 * @param {Array<Object>} nextABI - ABI proposed for the upgrade or redeployment.
 * @returns {Object} Structured ABI compatibility analysis.
 */
contractABISchema.statics.compareABIs = function(previousABI, nextABI) {
  if (!Array.isArray(previousABI) || !Array.isArray(nextABI)) {
    throw new TypeError('Both previousABI and nextABI must be arrays');
  }

  const normalize = (abi) => abi.map(normalizeABIEntry).filter(Boolean);
  const previous = normalize(previousABI);
  const next = normalize(nextABI);
  const previousMap = new Map(previous.map((entry) => [entryKey(entry), entry]));
  const nextMap = new Map(next.map((entry) => [entryKey(entry), entry]));

  const breakingChanges = [];
  const nonBreakingChanges = [];
  const addedFunctions = [];
  const removedFunctions = [];
  const changedEvents = [];

  for (const [key, entry] of nextMap) {
    if (!previousMap.has(key)) {
      if (entry.type === 'function') {
        addedFunctions.push(entryDescription(entry));
        nonBreakingChanges.push({
          category: 'addition',
          item: entryDescription(entry),
          reason: 'A new function was added'
        });
      } else if (entry.type === 'event') {
        changedEvents.push({
          change: 'added',
          event: entryDescription(entry)
        });
        nonBreakingChanges.push({
          category: 'event',
          item: entryDescription(entry),
          reason: 'A new event was added'
        });
      } else {
        nonBreakingChanges.push({
          category: 'addition',
          item: entryDescription(entry),
          reason: `A new ${entry.type} entry was added`
        });
      }
      continue;
    }

    const previousEntry = previousMap.get(key);
    if (entry.type === 'event') {
      if (
        JSON.stringify(previousEntry.outputTypes) !== JSON.stringify(entry.outputTypes) ||
        JSON.stringify(previousEntry.indexed) !== JSON.stringify(entry.indexed)
      ) {
        const change = {
          change: 'modified',
          previous: entryDescription(previousEntry),
          next: entryDescription(entry)
        };
        changedEvents.push(change);
        breakingChanges.push({
          category: 'event',
          ...change,
          reason: 'Event parameter types or indexed status changed'
        });
      }
      continue;
    }

    if (previousEntry.mutability !== entry.mutability) {
      const change = {
        category: 'mutability',
        previous: entryDescription(previousEntry),
        next: entryDescription(entry),
        reason: 'Function mutability changed'
      };
      (isBreakingMutabilityChange(previousEntry.mutability, entry.mutability)
        ? breakingChanges
        : nonBreakingChanges).push(change);
    }

    if (JSON.stringify(previousEntry.outputTypes) !== JSON.stringify(entry.outputTypes)) {
      breakingChanges.push({
        category: 'signature',
        previous: entryDescription(previousEntry),
        next: entryDescription(entry),
        reason: 'Function output types changed'
      });
    }
  }

  for (const [key, entry] of previousMap) {
    if (nextMap.has(key)) continue;

    if (entry.type === 'function') {
      removedFunctions.push(entryDescription(entry));
      breakingChanges.push({
        category: 'removal',
        item: entryDescription(entry),
        reason: 'An existing function was removed'
      });
    } else if (entry.type === 'event') {
      const change = { change: 'removed', event: entryDescription(entry) };
      changedEvents.push(change);
      breakingChanges.push({
        category: 'event',
        ...change,
        reason: 'An existing event was removed'
      });
    } else {
      breakingChanges.push({
        category: 'removal',
        item: entryDescription(entry),
        reason: `An existing ${entry.type} entry was removed`
      });
    }
  }

  return {
    compatible: breakingChanges.length === 0,
    status: breakingChanges.length === 0 ? 'compatible' : 'breaking',
    breakingChanges,
    nonBreakingChanges,
    addedFunctions,
    removedFunctions,
    changedEvents
  };
};

/**
 * Compares a candidate ABI with the ABI stored for a contract address and network.
 * @param {string} address - The contract address.
 * @param {string} network - The network name.
 * @param {Array<Object>} candidateABI - ABI proposed for the contract.
 * @returns {Promise<Object>} Structured ABI compatibility analysis.
 */
contractABISchema.statics.compareStoredABIs = async function(address, network, candidateABI) {
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new TypeError('address must be a valid EVM contract address');
  }
  if (typeof network !== 'string' || !supportedNetworks.has(network)) {
    throw new TypeError(`network must be one of: ${Array.from(supportedNetworks).join(', ')}`);
  }
  if (!Array.isArray(candidateABI)) {
    throw new TypeError('candidateABI must be an array');
  }

  try {
    const stored = await retryOperation(
      () => this.findOne({ address: address.toLowerCase(), network }),
      { retries: 3 }
    );

    if (!stored) {
      throw new Error(`Contract ABI not found for address ${address} on network ${network}`);
    }

    return this.compareABIs(stored.abi, candidateABI);
  } catch (error) {
    logger.error('Error in compareStoredABIs:', error);
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
