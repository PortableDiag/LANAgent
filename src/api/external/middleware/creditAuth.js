import jwt from 'jsonwebtoken';
import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import { JWT_SECRET } from '../routes/auth.js';

/**
 * Authenticate requests via API key (X-API-Key header) or JWT (Authorization: Bearer).
 * Sets req.wallet and req.creditBalance on success.
 *
 * @param {boolean} required - If true, returns 401 when no valid auth found.
 *                             If false, passes through to allow legacy payment flow.
 */
export function creditAuth(required = true) {
  return async (req, res, next) => {
    // Check X-API-Key header first
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey.startsWith('lsk_')) {
      try {
        const account = await ExternalCreditBalance.findByApiKey(apiKey);
        if (account) {
          req.wallet = account.wallet;
          req.creditBalance = account.credits;

          // Update lastUsed on the matching key (fire-and-forget)
          ExternalCreditBalance.findOneAndUpdate(
            { wallet: account.wallet, 'apiKeys.key': apiKey },
            { $set: { 'apiKeys.$.lastUsed': new Date() } }
          ).catch(() => {});

          return next();
        }
      } catch {
        // Fall through to JWT check
      }
    }

    // Check JWT Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        req.wallet = decoded.wallet;

        // Optionally load balance
        const account = await ExternalCreditBalance.findByWallet(decoded.wallet);
        req.creditBalance = account?.credits || 0;

        return next();
      } catch {
        // Invalid token — fall through
      }
    }

    if (required) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Provide X-API-Key header or Authorization: Bearer <jwt>'
      });
    }

    // Not required — pass through (allows legacy X-Payment-Tx flow)
    next();
  };
}
