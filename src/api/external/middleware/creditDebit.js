import ExternalCreditBalance from '../../../models/ExternalCreditBalance.js';
import { logger } from '../../../utils/logger.js';

/**
 * Middleware that debits credits for a service call.
 * Credits are deducted upfront. If the service response indicates a target error
 * (data.success === false && data.targetError), credits are refunded.
 *
 * If req.wallet is not set (no credit auth), falls through to legacy payment flow.
 *
 * @param {number} creditCost - Number of credits to charge for this service call.
 */
export function creditDebit(creditCost) {
  return async (req, res, next) => {
    // No wallet = no credit auth = fall through to legacy payment middleware
    if (!req.wallet) {
      return next();
    }

    // Check balance
    const account = await ExternalCreditBalance.findByWallet(req.wallet);
    if (!account || account.credits < creditCost) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        required: creditCost,
        balance: account?.credits || 0
      });
    }

    // Reserve credits (debit upfront)
    const debited = await ExternalCreditBalance.debitCredits(req.wallet, creditCost);
    if (!debited) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits (race condition)',
        required: creditCost
      });
    }

    // Mark that credits were used (skip legacy payment middleware)
    req.creditsPaid = creditCost;

    // Intercept res.json to handle refunds and add credit info
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      // If service failed due to target error, refund
      if (data && data.success === false && data.targetError) {
        ExternalCreditBalance.refundCredits(req.wallet, creditCost)
          .then(() => {
            logger.info(`Refunded ${creditCost} credits to ${req.wallet} (target error)`);
          })
          .catch((err) => {
            logger.error(`Credit refund failed for ${req.wallet}:`, err);
          });
        data.credited = true;
        data.creditsRefunded = creditCost;
      }

      // Add remaining credits to response
      ExternalCreditBalance.findByWallet(req.wallet)
        .then((acc) => {
          data.creditsRemaining = acc?.credits || 0;
          originalJson(data);
        })
        .catch(() => {
          originalJson(data);
        });
    };

    next();
  };
}
