/**
 * Operator-only gate for endpoints on the external gateway.
 *
 * Distinct from creditAuth/hybridAuth, which authenticate *customers* (portal
 * `lsk_` keys and customer-wallet JWTs). Anything that exposes how the service
 * behaves internally — failure rates, recovery outcomes, wallet listings —
 * must use this instead, or every paying customer can read it.
 *
 * Fails closed: with no AGENT_ADMIN_KEY configured the route reports 503 rather
 * than falling open.
 */
export function adminKeyAuth(req, res, next) {
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

export default adminKeyAuth;
