import { creditAuth } from './creditAuth.js';
import { creditDebit } from './creditDebit.js';
import { externalAuthMiddleware } from './externalAuth.js';
import { paymentMiddleware } from './payment.js';

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
 * Generate a middleware chain that supports both credit-based and legacy payment auth.
 *
 * Credit flow: X-API-Key or Bearer JWT -> creditDebit (debit credits)
 * Legacy flow: X-Agent-Id -> externalAuthMiddleware -> X-Payment-Tx -> paymentMiddleware
 *
 * @param {string} serviceId - Service ID for legacy payment lookup
 * @param {number} creditCost - Number of credits to charge
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
      creditDebit(creditCost)
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
    creditDebit(creditCost),
    // Step 3: If credits not used, fall back to legacy auth + payment
    (req, res, next) => {
      if (req.creditsPaid) return next(); // Credits already debited — skip legacy
      runLegacyPayment(serviceId, req, res, next);
    }
  ];
}
