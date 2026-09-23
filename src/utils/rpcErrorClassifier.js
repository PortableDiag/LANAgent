/**
 * Hex-safe classification of RPC / swap error messages.
 *
 * Why this exists: bare `msg.includes('429')` (and '403', '502', …) matches the
 * digits wherever they appear, including inside a hex address. On 2026-09-15 an
 * airdropped spam token whose contract address happened to end in `…429` made
 * "No viable swap path found for 0x…429 → …" classify as an RPC rate limit,
 * so the residual sweep retried a permanently unsellable token every ~34s for
 * eleven hours instead of blacklisting it on the first failure.
 *
 * Two defences, both cheap:
 *   1. strip 0x-prefixed hex runs before matching, and
 *   2. match status codes on a word boundary, so they cannot be read out of the
 *      middle of a longer number.
 */

/** Replace 0x-prefixed hex runs (addresses, tx hashes, calldata) with a placeholder. */
export function stripHexLiterals(msg) {
  return String(msg ?? '').replace(/0x[0-9a-fA-F]+/g, '0x…');
}

/** True when `code` appears in `msg` as a standalone number, not inside an address or a longer figure. */
export function hasStatusCode(msg, code) {
  return new RegExp(`\\b${code}\\b`).test(stripHexLiterals(msg));
}

/** HTTP 429 / JSON-RPC throttling, however the provider phrases it. */
export function isRateLimitError(msg) {
  const clean = stripHexLiterals(msg).toLowerCase();
  return clean.includes('rate limit')
    || clean.includes('rate-limit')
    || clean.includes('too many requests')
    || clean.includes('too many connections')
    || clean.includes('limit exceeded')
    || clean.includes('-32005')
    || /\b429\b/.test(clean);
}

/**
 * Errors worth retrying against a different RPC endpoint: throttling, an
 * upstream refusal, or a socket-level failure. Takes an Error or a string.
 */
export function isTransientRpcError(err) {
  const code = err?.code;
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'SERVER_ERROR') return true;

  const raw = typeof err === 'string' ? err : (err?.message || '');
  const clean = stripHexLiterals(raw).toLowerCase();
  if (isRateLimitError(raw)) return true;
  if (clean.includes('forbidden') || clean.includes('unauthorized')) return true;
  if (clean.includes('etimedout') || clean.includes('econnreset')
    || clean.includes('econnrefused') || clean.includes('eai_again')) return true;
  if (clean.includes('missing response') || clean.includes('failed to detect network')
    || clean.includes('could not coalesce') || clean.includes('bad gateway')
    || clean.includes('service unavailable') || clean.includes('gateway timeout')) return true;
  return [403, 500, 502, 503, 504].some(c => hasStatusCode(clean, c));
}

/** A definitive "this pair cannot be routed" — never transient, never worth retrying. */
export function isNoSwapPathError(msg) {
  const clean = stripHexLiterals(msg);
  return clean.includes('No viable swap path') || clean.includes('No route found')
    || clean.includes('no route found') || clean.includes('no real liquidity');
}
