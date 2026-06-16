import { creditAuth } from './creditAuth.js';
import { creditDebit } from './creditDebit.js';
import { externalAuthMiddleware } from './externalAuth.js';
import { paymentMiddleware } from './payment.js';

/**
 * Generate a middleware chain that supports both credit-based and legacy payment auth.
 *
 * Credit flow: X-API-Key or Bearer JWT -> creditDebit (debit credits)
 * Legacy flow: X-Agent-Id -> externalAuthMiddleware -> X-Payment-Tx -> paymentMiddleware
 *
 * @param {string} serviceId - Service ID for legacy payment lookup
 * @param {number} creditCost - Number of credits to charge
 * @returns {Function[]} Array of middleware functions
 */
export function hybridAuth(serviceId, creditCost) {
  return [
    // Step 1: Try credit auth (non-blocking — if no API key or JWT, passes through)
    creditAuth(false),
    // Step 2: If credit auth succeeded, debit credits
    creditDebit(creditCost),
    // Step 3: If credits not used, fall back to legacy auth + payment
    (req, res, next) => {
      if (req.creditsPaid) return next(); // Credits already debited — skip legacy
      externalAuthMiddleware(req, res, (err) => {
        if (err) return next(err);
        paymentMiddleware(serviceId)(req, res, next);
      });
    }
  ];
}
