import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { getGlobalAgent } from '../core/agentAccessor.js';
import { retryOperation } from '../utils/retryUtils.js';

const renewalPaymentSchema = new mongoose.Schema({
  txHash: { type: String, required: true },
  amount: { type: String, required: true },
  paidAt: { type: Date, default: Date.now },
  extendsTo: { type: Date, required: true }
}, { _id: false });

const emailLeaseSchema = new mongoose.Schema({
  leaseId: {
    type: String,
    unique: true,
    default: () => uuidv4()
  },

  // Email address (e.g., "forkname@lanagent.net")
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },

  // Requesting peer info
  peerFingerprint: {
    type: String,
    required: true,
    index: true
  },
  peerDisplayName: {
    type: String,
    default: ''
  },
  peerWallet: {
    type: String,
    default: ''
  },

  // Lease status
  status: {
    type: String,
    enum: ['pending', 'active', 'expired', 'revoked'],
    default: 'pending',
    index: true
  },

  // Dates
  leasedAt: { type: Date },
  expiresAt: { type: Date, index: true },
  renewedAt: { type: Date },
  revokedAt: { type: Date },
  revokeReason: { type: String },

  // Payment
  paymentTxHash: { type: String },
  paymentAmount: { type: String },
  renewalPayments: [renewalPaymentSchema],

  // Mail config
  quotaMB: { type: Number, default: 500 },
  passwordLastSet: { type: Date }
}, {
  timestamps: true
});

// Indexes
emailLeaseSchema.index({ status: 1, expiresAt: 1 });
emailLeaseSchema.index({ peerFingerprint: 1, status: 1 });

/**
 * Find active lease by email
 */
emailLeaseSchema.statics.findActiveLease = function(email) {
  return this.findOne({ email: email.toLowerCase(), status: 'active' });
};

/**
 * Find all leases for a peer
 */
emailLeaseSchema.statics.findByPeer = function(fingerprint) {
  return this.find({ peerFingerprint: fingerprint }).sort({ createdAt: -1 });
};

/**
 * Find leases expiring within N days
 */
emailLeaseSchema.statics.findExpiring = function(daysAhead = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  return this.find({
    status: 'active',
    expiresAt: { $lte: cutoff, $gte: new Date() }
  }).sort({ expiresAt: 1 });
};

/**
 * Get stats for admin dashboard
 */
emailLeaseSchema.statics.getStats = async function() {
  const [active, total, expiringSoon] = await Promise.all([
    this.countDocuments({ status: 'active' }),
    this.countDocuments({}),
    this.countDocuments({
      status: 'active',
      expiresAt: {
        $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        $gte: new Date()
      }
    })
  ]);

  // Total revenue from payments
  const leases = await this.find({ paymentAmount: { $exists: true, $ne: null } });
  let totalRevenue = 0;
  for (const lease of leases) {
    totalRevenue += parseFloat(lease.paymentAmount) || 0;
    for (const renewal of lease.renewalPayments || []) {
      totalRevenue += parseFloat(renewal.amount) || 0;
    }
  }

  return { active, total, expiringSoon, totalRevenue };
};

/**
 * Send expiration warning emails for leases expiring within `daysAhead` days.
 * Driven by an Agenda job in scheduler.js (`email-lease-expiration-warnings`).
 * Uses the existing email plugin via the global agent (no nodemailer hardcode).
 * @param {Number} daysAhead - Warn about leases expiring within this many days.
 * @returns {Promise<{sent: number, skipped: number}>}
 */
emailLeaseSchema.statics.sendExpirationNotifications = async function(daysAhead = 7) {
  const expiringLeases = await this.findExpiring(daysAhead);
  if (!expiringLeases.length) {
    return { sent: 0, skipped: 0 };
  }

  const agent = getGlobalAgent();
  const emailPlugin = agent?.apiManager?.getPlugin?.('email');
  if (!emailPlugin?.instance) {
    logger.warn(`EmailLease: ${expiringLeases.length} leases expiring soon, but email plugin is not available — skipping notifications.`);
    return { sent: 0, skipped: expiringLeases.length };
  }

  let sent = 0;
  let skipped = 0;
  for (const lease of expiringLeases) {
    try {
      await retryOperation(() => emailPlugin.instance.execute({
        action: 'send',
        to: lease.email,
        subject: 'LANAgent — Email lease expiration warning',
        message: `Hi ${lease.peerDisplayName || 'there'},\n\nYour LANAgent email lease for ${lease.email} expires on ${lease.expiresAt.toISOString().slice(0, 10)}. Renew it before then to avoid service interruption.\n\n— LANAgent`
      }), { retries: 3 });
      sent++;
    } catch (err) {
      skipped++;
      logger.warn(`EmailLease: failed to send expiration warning to ${lease.email}: ${err.message}`);
    }
  }
  logger.info(`EmailLease expiration warnings: ${sent} sent, ${skipped} skipped (of ${expiringLeases.length} expiring within ${daysAhead} days).`);
  return { sent, skipped };
};

/**
 * Bulk-manage email leases — revoke or extend many leases in one call.
 *
 * Each operation is `{ action: 'revoke', leaseIds: [...], reason }` or
 * `{ action: 'extend', leaseIds: [...], days }`. Operations are applied
 * independently and partial success is returned: a bad operation is recorded
 * in `errors` without discarding the ones that succeeded.
 *
 * NOTE: deliberately no multi-document transaction — production runs a
 * standalone mongod (no replica set), where `session.withTransaction()` throws.
 * Each `updateMany` is already atomic on its own, which is all this needs.
 * Bulk revoke updates the model directly and does NOT emit the per-peer P2P
 * `email_lease_revoke` notification the single-lease admin route sends; it is an
 * administrative batch op.
 *
 * @param {Array<{action:string, leaseIds:string[], reason?:string, days?:number}>} operations
 * @returns {Promise<{success: boolean, processed: number, errors: Array}>}
 */
emailLeaseSchema.statics.bulkManage = async function(operations) {
  let processed = 0;
  const errors = [];

  if (!Array.isArray(operations) || operations.length === 0) {
    return { success: false, processed: 0, errors: [{ error: 'operations must be a non-empty array' }] };
  }

  for (const op of operations) {
    try {
      if (!op || !Array.isArray(op.leaseIds) || op.leaseIds.length === 0) {
        errors.push({ operation: op, error: 'leaseIds must be a non-empty array' });
        continue;
      }

      if (op.action === 'revoke') {
        const result = await this.updateMany(
          { leaseId: { $in: op.leaseIds }, status: { $in: ['active', 'pending'] } },
          { $set: { status: 'revoked', revokedAt: new Date(), revokeReason: op.reason || 'Bulk operation' } }
        );
        processed += result.modifiedCount;
      } else if (op.action === 'extend') {
        const days = Number(op.days) || 30;
        const extensionDate = new Date();
        extensionDate.setDate(extensionDate.getDate() + days);

        const result = await this.updateMany(
          { leaseId: { $in: op.leaseIds }, status: 'active' },
          { $set: { expiresAt: extensionDate, renewedAt: new Date() } }
        );
        processed += result.modifiedCount;
      } else {
        errors.push({ operation: op, error: `Invalid action specified: ${op.action}` });
      }
    } catch (err) {
      errors.push({ operation: op, error: err.message });
    }
  }

  return { success: errors.length === 0, processed, errors };
};

export const EmailLease = mongoose.model('EmailLease', emailLeaseSchema);
export default EmailLease;
