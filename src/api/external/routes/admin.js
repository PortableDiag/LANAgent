import { Router } from 'express';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import ExternalPayment from '../../../models/ExternalPayment.js';
import { logger } from '../../../utils/logger.js';
import { adminKeyAuth } from '../middleware/adminKeyAuth.js';
import { retryOperation } from '../../../utils/retryUtils.js';

const router = Router();

// The admin key guards THIS router's paths only. As a blanket router.use it also caught every
// other /api/external/admin/* request — the dashboard's JWT routes (dashboard, payments, audit,
// services, kill-switch), mounted after this router — and refused them with "Invalid admin key",
// which logged the web UI out whenever External Services was opened (since 2026-05-09).
router.use(['/wallets', '/download-tokens', '/payments/recent', '/payments/summary'], adminKeyAuth);

router.get('/wallets', async (req, res) => {
  try {
    const docs = await ExternalCreditBalance
      .find({}, { wallet: 1, credits: 1, totalPurchased: 1, totalSpent: 1, totalRefunded: 1, lastPurchase: 1, lastUsed: 1, createdAt: 1, _id: 0 })
      .sort({ lastPurchase: -1 })
      .lean();

    const summary = docs.reduce((acc, w) => {
      acc.count++;
      acc.credits += w.credits || 0;
      acc.totalPurchased += w.totalPurchased || 0;
      acc.totalSpent += w.totalSpent || 0;
      acc.totalRefunded += w.totalRefunded || 0;
      return acc;
    }, { count: 0, credits: 0, totalPurchased: 0, totalSpent: 0, totalRefunded: 0 });

    res.json({ success: true, summary, wallets: docs });
  } catch (err) {
    logger.error('admin/wallets failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /wallets/:wallet/purchases — credit purchase history for one wallet.
 * Purchases are the only per-transaction ledger (ExternalPayment rows with
 * serviceId 'credit-purchase', keyed by callerAgentId = wallet); spends only
 * decrement lifetime counters, so the balance snapshot carries those totals.
 * Query: since/until (ISO, default last 30 days), page, limit (max 100)
 */
router.get('/wallets/:wallet/purchases', async (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').toLowerCase();
    const balance = await ExternalCreditBalance
      .findOne({ wallet }, { wallet: 1, credits: 1, totalPurchased: 1, totalSpent: 1, totalRefunded: 1, lastPurchase: 1, lastUsed: 1, _id: 0 })
      .lean();
    if (!balance) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const now = new Date();
    const since = req.query.since ? new Date(req.query.since) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until ? new Date(req.query.until) : now;
    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid since/until date. Use ISO date format.' });
    }
    if (since > until) {
      return res.status(400).json({ success: false, error: 'since must be before until' });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    // callerAgentId casing follows whatever the x402 middleware set at purchase
    // time — match case-insensitively (payment volume is small; regex is fine)
    const walletPattern = new RegExp(`^${wallet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const query = {
      serviceId: 'credit-purchase',
      callerAgentId: walletPattern,
      createdAt: { $gte: since, $lte: until }
    };

    const total = await ExternalPayment.countDocuments(query);
    const purchases = await ExternalPayment
      .find(query, { txHash: 1, chain: 1, amount: 1, currency: 1, creditsIssued: 1, bonusCredits: 1, promotion: 1, usdValue: 1, createdAt: 1, _id: 0 })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      success: true,
      wallet,
      balance,
      pagination: { page, limit, total, hasNext: page * limit < total, hasPrev: page > 1 },
      purchases
    });
  } catch (err) {
    logger.error('admin/wallets/:wallet/purchases failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /download-tokens/analytics — live snapshot of download-token usage
 * (totals, per-agent breakdown, generation rate). In-memory, resets on restart.
 */
router.get('/download-tokens/analytics', async (req, res) => {
  try {
    const { getTokenAnalytics } = await import('../services/downloadTokenService.js');
    res.json({ success: true, ...getTokenAnalytics() });
  } catch (err) {
    logger.error('admin/download-tokens/analytics failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /download-tokens/inspect — decode a download token's metadata without
 * consuming a download. Token travels in the body (never the URL — access
 * logs must not capture live bearer tokens). Admin-only: the response
 * includes server file paths.
 */
router.post('/download-tokens/inspect', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'token (string) is required in the request body' });
    }
    const { inspectDownloadToken } = await import('../services/downloadTokenService.js');
    res.json({ success: true, token: inspectDownloadToken(token) });
  } catch (err) {
    logger.error('admin/download-tokens/inspect failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /payments/recent — recent payments with optional filtering.
 * Query params:
 *   serviceId      (string)  filter by service identifier
 *   chain          (string)  filter by blockchain
 *   currency       (string)  filter by currency symbol
 *   callerAgentId  (string)  filter by caller agent ID
 *   since          (ISO date) lower bound on createdAt (inclusive)
 *   until          (ISO date) upper bound on createdAt (inclusive)
 *   limit          (number, default 20, max 100) maximum results
 * All filters are optional; when none are provided the endpoint returns the
 * most recent payments across all services.
 */
router.get('/payments/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    // Build MongoDB query from provided filters
    const query = {};

    // Only plain-string filters are used: Express parses `?chain[$ne]=x` into an object, which would
    // otherwise reach Mongo as an operator. Values are normalised to how writers store
    // them (chain 'bsc', currency upper-cased in credits.js), or a filter written the
    // other way round silently returns nothing.
    const q = (k) => (typeof req.query[k] === 'string' && req.query[k].trim() ? req.query[k].trim() : null);
    const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (q('serviceId')) query.serviceId = q('serviceId');
    if (q('chain')) query.chain = q('chain').toLowerCase();
    if (q('currency')) query.currency = q('currency').toUpperCase();
    // Caller ids include wallet addresses, whose stored case depends on the writer.
    if (q('callerAgentId')) query.callerAgentId = new RegExp(`^${escapeRe(q('callerAgentId'))}$`, 'i');

    // Date range validation
    if (req.query.since || req.query.until) {
      const since = req.query.since ? new Date(req.query.since) : null;
      const until = req.query.until ? new Date(req.query.until) : null;

      if (since && isNaN(since.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid since date. Use ISO date format.' });
      }
      if (until && isNaN(until.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid until date. Use ISO date format.' });
      }
      if (since && until && since > until) {
        return res.status(400).json({ success: false, error: 'since must be before until' });
      }

      if (since || until) {
        query.createdAt = {};
        if (since) query.createdAt.$gte = since;
        if (until) query.createdAt.$lte = until;
      }
    }

    logger.debug('Fetching recent payments with filters', { filters: query, limit });

    // Retry the database query up to 3 times on transient failures
    const payments = await retryOperation(
      () =>
        ExternalPayment
          .find(query, { txHash: 1, chain: 1, serviceId: 1, callerAgentId: 1, amount: 1, currency: 1, creditsIssued: 1, usdValue: 1, createdAt: 1, _id: 0 })
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean(),
      { retries: 3, context: 'admin/payments/recent' }
    );

    res.json({ success: true, payments });
  } catch (err) {
    logger.error('admin/payments/recent failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /payments/summary — aggregated payment totals over a date range.
 * Query params:
 *   since      ISO date (default: 30 days ago)
 *   until      ISO date (default: now)
 *   groupBy    'currency' | 'chain' | 'serviceId'  (default: 'currency')
 *   includeUsd boolean (default: true)
 * Response: { success, range:{since,until}, groupBy, results:[{key,count,totalAmount,totalUsd,totalCredits}] }
 */
const ALLOWED_GROUP_FIELDS = new Set(['currency', 'chain', 'serviceId']);

router.get('/payments/summary', async (req, res) => {
  try {
    const now = new Date();
    const since = req.query.since ? new Date(req.query.since) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until ? new Date(req.query.until) : now;
    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid since/until date. Use ISO date format.' });
    }
    if (since > until) {
      return res.status(400).json({ success: false, error: 'since must be before until' });
    }

    const groupBy = ALLOWED_GROUP_FIELDS.has(req.query.groupBy) ? req.query.groupBy : 'currency';
    const includeUsd = req.query.includeUsd === undefined
      ? true
      : String(req.query.includeUsd).toLowerCase() !== 'false';

    const project = {
      _id: 0,
      key: '$_id',
      count: 1,
      totalAmount: { $round: ['$totalAmount', 8] },
      totalCredits: { $round: ['$totalCredits', 4] }
    };
    if (includeUsd) project.totalUsd = { $round: ['$totalUsd', 4] };

    const results = await ExternalPayment.aggregate([
      { $match: { createdAt: { $gte: since, $lt: until } } },
      { $group: {
          _id: `$${groupBy}`,
          totalAmount: { $sum: '$amount' },
          totalUsd: { $sum: '$usdValue' },
          totalCredits: { $sum: '$creditsIssued' },
          count: { $sum: 1 }
      }},
      { $project: project },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      range: { since: since.toISOString(), until: until.toISOString() },
      groupBy,
      results
    });
  } catch (err) {
    logger.error('admin/payments/summary failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
