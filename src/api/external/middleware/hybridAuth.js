import { creditAuth } from './creditAuth.js';
import { creditDebit } from './creditDebit.js';
import { externalAuthMiddleware } from './externalAuth.js';
import { paymentMiddleware } from './payment.js';
import { logger } from '../../../utils/logger.js';

/**
 * Run legacy authentication and payment middleware.
 *
 * @param {string} serviceId - Service ID for legacy payment lookup
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next callback
 * @returns {void}
 */
function runLegacyPayment(serviceId, req, res, next) {
  externalAuthMiddleware(req, res, (authError) => {
    if (authError) return next(authError);
    return paymentMiddleware(serviceId)(req, res, next);
  });
}

/**
 * Create a credit-debit middleware that supports dynamic cost calculation.
 *
 * If `cost` is a function, it will be called with the request object to obtain
 * the actual credit cost before debiting.  The function may return a Promise.
 * If `cost` is a number, the standard static-cost middleware is returned.
 *
 * @param {number|function} cost - Fixed credit cost or a function (req) => cost
 * @returns {Function} Express middleware
 */
function createCreditDebitMiddleware(cost) {
  if (typeof cost === 'function') {
    return async (req, res, next) => {
      // No wallet = no credit auth: creditDebit would pass through anyway, so do not
      // evaluate the pricing function for requests headed to the legacy flow.
      if (!req.wallet) return next();
      let actualCost;
      try {
        actualCost = await cost(req);
      } catch (err) {
        logger.error('Failed to compute dynamic credit cost', { error: err.message });
        return res.status(500).json({ success: false, error: 'Internal server error' });
      }
      // A cost <= 0 must never reach debitCredits(): a negative amount would ADD
      // credits ($inc: -amount), and 0 leaves req.creditsPaid falsy. Fail closed.
      if (typeof actualCost !== 'number' || !Number.isFinite(actualCost) || actualCost <= 0) {
        logger.warn('Dynamic credit cost rejected (must be a finite number > 0)', {
          costType: typeof actualCost
        });
        return res.status(500).json({ success: false, error: 'Internal server error' });
      }
      return creditDebit(actualCost)(req, res, next);
    };
  }
  return creditDebit(cost);
}

/**
 * Generate a middleware chain that supports both credit-based and legacy payment auth.
 *
 * Credit flow: X-API-Key or Bearer JWT -> creditDebit (debit credits)
 * Legacy flow: X-Agent-Id -> externalAuthMiddleware -> X-Payment-Tx -> paymentMiddleware
 *
 * @param {string} serviceId - Service ID for legacy payment lookup
 * @param {number|function} creditCost - Number of credits to charge, or a function
 *   that receives the request object and returns the credit cost (may be async).
 * @param {Object} [options] - Authentication policy options
 * @param {'either'|'credit-only'|'legacy-only'} [options.policy='either'] - Required authentication policy.
 *   'either' (default): credits if an API key/JWT is present, else legacy auth + payment.
 *   'credit-only': API key/JWT required; legacy payment is not accepted.
 *   'legacy-only': X-Agent-Id + on-chain payment required; credits are not accepted.
 * @returns {Function[]} Array of middleware functions
 */
export function hybridAuth(serviceId, creditCost, options = {}) {
  const policy = options.policy || 'either';
  const supportedPolicies = new Set([
    'either',
    'credit-only',
    'legacy-only'
  ]);

  if (!supportedPolicies.has(policy)) {
    throw new TypeError(
      `Unsupported hybrid authentication policy: ${policy}`
    );
  }

  if (policy === 'credit-only') {
    return [
      // Credit authentication is mandatory for credit-only routes.
      creditAuth(true),
      // Debit credits only after successful authentication.
      createCreditDebitMiddleware(creditCost)
    ];
  }

  if (policy === 'legacy-only') {
    return [
      (req, res, next) => {
        runLegacyPayment(serviceId, req, res, next);
      }
    ];
  }

  return [
    // Step 1: Try credit auth (non-blocking — if no API key or JWT, passes through)
    creditAuth(false),
    // Step 2: If credit auth succeeded, debit credits
    createCreditDebitMiddleware(creditCost),
    // Step 3: If credits not used, fall back to legacy auth + payment
    (req, res, next) => {
      if (req.creditsPaid) return next(); // Credits already debited — skip legacy
      runLegacyPayment(serviceId, req, res, next);
    }
  ];
}
