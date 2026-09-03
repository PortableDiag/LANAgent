import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { retryOperation } from '../utils/retryUtils.js';

/**
 * SkynetPayment - Tracks SKYNET token payments between Skynet peers.
 *
 * Follows the ExternalPayment pattern but for BEP-20 SKYNET token transfers
 * instead of native BNB transfers.
 */
const skynetPaymentSchema = new mongoose.Schema({
  txHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  chain: {
    type: String,
    required: true,
    default: 'bsc'
  },
  serviceId: {
    type: String,
    required: true
  },
  fromFingerprint: {
    type: String,
    required: true
  },
  fromAddress: {
    type: String,
    required: true
  },
  toAddress: {
    type: String,
    required: true
  },
  amount: {
    type: String,
    required: true
  },
  tokenAddress: {
    type: String,
    required: true
  },
  blockNumber: {
    type: Number,
    default: 0
  },
  confirmations: {
    type: Number,
    default: 0
  },
  verifiedAt: {
    type: Date,
    default: null
  },
  consumed: {
    type: Boolean,
    default: false
  },
  consumedAt: {
    type: Date,
    default: null
  },
  // Dispute record: a peer (or the operator) flags a payment whose stored data
  // they believe is wrong. Purely record-keeping — resolution is a human action
  // (status flipped via DB/API), no automated resolution machinery exists.
  dispute: {
    evidence: { type: mongoose.Schema.Types.Mixed, default: null },
    submittedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['none', 'pending', 'resolved', 'rejected'],
      default: 'none'
    },
    resolvedAt: { type: Date, default: null }
  }
}, {
  timestamps: true
});

skynetPaymentSchema.index({ fromFingerprint: 1, createdAt: -1 });
skynetPaymentSchema.index({ serviceId: 1, createdAt: -1 });
skynetPaymentSchema.index({ 'dispute.status': 1 });

/**
 * Re-verify a stored payment against the chain (audit / reorg / tamper check).
 *
 * The record was BORN from on-chain data (skynetServiceExecutor.verifyPayment
 * parses the Transfer event before creating it), so a mismatch here means the DB
 * row was altered, the chain reorged, or the original parse had a bug — all worth
 * surfacing. Comparison is done the same way the record was created: re-fetch the
 * receipt, re-parse the SKYNET Transfer event log, compare like-for-like. The
 * naive version of this compared the stored TOKEN amount against the transaction's
 * native `value` field — which is 0 on every ERC-20 transfer — and would have
 * reported a discrepancy on every legitimate payment.
 *
 * Uses the project's contractService provider + ethers via dynamic import so the
 * model stays dependency-light at boot (this file is imported by core/agent.js).
 *
 * @param {string} txHash
 * @returns {Promise<Object>} { txHash, match, discrepancies[], localRecord, onChainData }
 */
skynetPaymentSchema.statics.reconcilePayment = async function(txHash) {
  const localRecord = await this.findOne({ txHash });
  if (!localRecord) {
    throw new Error(`Payment record not found for txHash: ${txHash}`);
  }

  const contractService = (await import('../services/crypto/contractServiceWrapper.js')).default;
  const provider = await contractService.getProvider(localRecord.chain || 'bsc');
  const { ethers } = await import('ethers');

  const receipt = await retryOperation(
    () => provider.getTransactionReceipt(txHash),
    { retries: 2, context: `reconcile.getReceipt(${txHash})` }
  );
  if (!receipt) {
    throw new Error(`Transaction receipt not found on-chain for txHash: ${txHash}`);
  }

  const currentBlock = await retryOperation(
    () => provider.getBlockNumber(),
    { retries: 2, context: 'reconcile.getBlockNumber' }
  );
  const confirmations = Math.max(0, currentBlock - receipt.blockNumber);

  // Re-parse the Transfer event for the recorded token + recipient, exactly as
  // verifyPayment did at creation time: Transfer(from, to, value) — topics[1]=from,
  // topics[2]=to, data=value (18 decimals).
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const tokenAddr = (localRecord.tokenAddress || '').toLowerCase();
  const toAddr = (localRecord.toAddress || '').toLowerCase();
  let onChainTransfer = null;
  for (const log of receipt.logs || []) {
    if ((log.address || '').toLowerCase() !== tokenAddr) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const logTo = '0x' + log.topics[2].slice(26).toLowerCase();
    if (logTo !== toAddr) continue;
    onChainTransfer = {
      fromAddress: '0x' + log.topics[1].slice(26).toLowerCase(),
      toAddress: logTo,
      amount: parseFloat(ethers.formatUnits(ethers.toBigInt(log.data), 18)).toString()
    };
    break;
  }

  const onChainData = {
    txHash: receipt.hash || txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    confirmations,
    transfer: onChainTransfer
  };

  const discrepancies = [];
  if (receipt.status !== 1) {
    discrepancies.push({ field: 'status', local: 'recorded as paid', onChain: 'transaction failed' });
  }
  if (!onChainTransfer) {
    discrepancies.push({
      field: 'transfer',
      local: `${localRecord.amount} to ${localRecord.toAddress}`,
      onChain: 'no matching Transfer event for the recorded token/recipient'
    });
  } else {
    if ((localRecord.fromAddress || '').toLowerCase() !== onChainTransfer.fromAddress) {
      discrepancies.push({ field: 'fromAddress', local: localRecord.fromAddress, onChain: onChainTransfer.fromAddress });
    }
    // Amounts were stored via the identical formatUnits→parseFloat path, so an
    // honest record compares exactly; tolerate float noise anyway.
    const localAmt = parseFloat(localRecord.amount);
    const chainAmt = parseFloat(onChainTransfer.amount);
    if (!(Math.abs(localAmt - chainAmt) <= Math.max(1e-9, chainAmt * 1e-9))) {
      discrepancies.push({ field: 'amount', local: localRecord.amount, onChain: onChainTransfer.amount });
    }
  }
  if (localRecord.blockNumber && localRecord.blockNumber !== receipt.blockNumber) {
    discrepancies.push({ field: 'blockNumber', local: localRecord.blockNumber, onChain: receipt.blockNumber });
  }

  await this.updateOne({ txHash }, { verifiedAt: new Date(), confirmations });

  const result = { txHash, match: discrepancies.length === 0, discrepancies, localRecord, onChainData };
  if (!result.match) {
    logger.warn(`SkynetPayment reconciliation mismatch for ${txHash}: ${discrepancies.map(d => d.field).join(', ')}`);
  }
  return result;
};

/**
 * Flag a payment as disputed, with free-form evidence. Record-keeping only:
 * the dispute shows up on the payment row (dispute.status='pending') and in the
 * dispute-status index; resolution is a human decision.
 *
 * @param {string} txHash
 * @param {Object} evidence
 * @returns {Promise<Object>}
 */
skynetPaymentSchema.statics.submitDispute = async function(txHash, evidence) {
  const localRecord = await this.findOne({ txHash });
  if (!localRecord) {
    throw new Error(`Payment record not found for txHash: ${txHash}`);
  }
  if (localRecord.dispute?.status === 'pending') {
    return { success: false, txHash, message: 'A dispute is already pending for this payment' };
  }

  await this.updateOne({ txHash }, {
    $set: {
      'dispute.evidence': evidence ?? null,
      'dispute.submittedAt': new Date(),
      'dispute.status': 'pending',
      'dispute.resolvedAt': null
    }
  });

  logger.info(`SkynetPayment dispute submitted for ${txHash}`);
  return { success: true, txHash, message: 'Dispute submitted' };
};

const SkynetPayment = mongoose.model('SkynetPayment', skynetPaymentSchema);

export default SkynetPayment;
