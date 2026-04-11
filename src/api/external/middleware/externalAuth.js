import NodeCache from 'node-cache';
import { logger } from '../../../utils/logger.js';
import { retryOperation } from '../../../utils/retryUtils.js';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const OWNER_OF_ABI = ['function ownerOf(uint256 tokenId) view returns (address)'];

// Cache verified agents for 10 minutes
const verifiedAgents = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Adaptive circuit breaker for identity verification
const circuitBreaker = {
  state: 'CLOSED',       // CLOSED (normal), OPEN (failing), HALF_OPEN (testing)
  failures: 0,
  threshold: 5,          // Initial threshold
  resetTimeout: 30000,   // Try again after 30 seconds
  lastFailureTime: 0,
  failureHistory: [],    // Store timestamps of failures
  adjustThreshold() {
    const now = Date.now();
    // Remove failures older than 5 minutes
    this.failureHistory = this.failureHistory.filter(time => now - time <= 300000);
    const failureRate = this.failureHistory.length / 5; // Failures per minute
    // Adjust threshold based on failure rate
    if (failureRate > 1) {
      this.threshold = Math.max(3, this.threshold - 1); // Be more strict
    } else if (failureRate < 0.5) {
      this.threshold = Math.min(10, this.threshold + 1); // Be more lenient
    }
  }
};

function checkCircuitBreaker() {
  if (circuitBreaker.state === 'OPEN') {
    if (Date.now() - circuitBreaker.lastFailureTime >= circuitBreaker.resetTimeout) {
      circuitBreaker.state = 'HALF_OPEN';
      return true; // Allow one test request
    }
    return false; // Still open, reject
  }
  return true; // CLOSED or HALF_OPEN, allow
}

function recordSuccess() {
  circuitBreaker.failures = 0;
  circuitBreaker.state = 'CLOSED';
}

function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailureTime = Date.now();
  circuitBreaker.failureHistory.push(circuitBreaker.lastFailureTime);
  circuitBreaker.adjustThreshold();
  if (circuitBreaker.failures >= circuitBreaker.threshold) {
    circuitBreaker.state = 'OPEN';
    logger.warn(`Identity verification circuit breaker OPEN after ${circuitBreaker.failures} failures`);
  }
}

export async function externalAuthMiddleware(req, res, next) {
  const agentId = req.headers['x-agent-id'];
  const chain = req.headers['x-agent-chain'] || 'bsc';

  if (!agentId) {
    return res.status(401).json({
      success: false,
      error: 'Missing X-Agent-Id header'
    });
  }

  const cacheKey = `${chain}:${agentId}`;
  const cached = verifiedAgents.get(cacheKey);
  if (cached) {
    req.externalAgentId = agentId;
    req.externalAgentOwner = cached.owner;
    req.externalAgentChain = chain;
    return next();
  }

  if (!checkCircuitBreaker()) {
    return res.status(503).json({
      success: false,
      error: 'Identity verification temporarily unavailable (circuit breaker open)'
    });
  }

  try {
    const contractService = (await import('../../../services/crypto/contractServiceWrapper.js')).default;
    const provider = await contractService.getProvider(chain);
    const { ethers } = await import('ethers');

    const registry = new ethers.Contract(IDENTITY_REGISTRY, OWNER_OF_ABI, provider);

    const owner = await retryOperation(
      () => registry.ownerOf(agentId),
      { retries: 2, context: `ownerOf(${agentId})` }
    );

    if (!owner || owner === ethers.ZeroAddress) {
      return res.status(403).json({
        success: false,
        error: 'Agent ID not registered in ERC-8004 Identity Registry'
      });
    }

    recordSuccess();
    verifiedAgents.set(cacheKey, { owner });
    req.externalAgentId = agentId;
    req.externalAgentOwner = owner;
    req.externalAgentChain = chain;
    next();
  } catch (error) {
    logger.error(`ERC-8004 identity verification failed for agent ${agentId}:`, error);

    if (error.message?.includes('nonexistent token') || error.reason?.includes('nonexistent token')) {
      return res.status(403).json({
        success: false,
        error: 'Agent ID not registered in ERC-8004 Identity Registry'
      });
    }

    recordFailure();
    return res.status(500).json({
      success: false,
      error: 'Identity verification temporarily unavailable'
    });
  }
}
