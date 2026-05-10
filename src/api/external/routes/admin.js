import { Router } from 'express';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import ExternalPayment from '../../../models/ExternalPayment.js';
import { logger } from '../../../utils/logger.js';

const router = Router();

function adminKeyAuth(req, res, next) {
  const expected = process.env.AGENT_ADMIN_KEY;
  if (!expected) {
    return res.status(503).json({ success: false, error: 'AGENT_ADMIN_KEY not configured on this agent' });
  }
  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid admin key' });
  }
  next();
}

router.use(adminKeyAuth);

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

router.get('/payments/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const payments = await ExternalPayment
      .find({}, { txHash: 1, chain: 1, serviceId: 1, callerAgentId: 1, amount: 1, currency: 1, creditsIssued: 1, usdValue: 1, createdAt: 1, _id: 0 })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, payments });
  } catch (err) {
    logger.error('admin/payments/recent failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
