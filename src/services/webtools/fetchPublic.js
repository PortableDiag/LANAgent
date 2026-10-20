import axios from 'axios';
import { assertPublicUrl } from '../../utils/publicUrl.js';
import { isRetryableError } from '../../utils/retryUtils.js';

/**
 * GET a URL that someone else chose (a feed, a product page, a domain to investigate).
 * Every hop — the first request and each redirect — must resolve to a public address, so a
 * link cannot walk the agent onto its own LAN. Redirects are followed by hand for that reason.
 */
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

/**
 * Stop a request when its caller cancels it or its end-to-end deadline expires.
 *
 * @param {AbortSignal|undefined} signal
 * @param {number|null} deadlineAt
 */
function checkRequestLimits(signal, deadlineAt) {
  if (signal?.aborted) {
    const error = new Error('request aborted');
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    throw error;
  }

  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    const error = new Error('request deadline exceeded');
    error.name = 'TimeoutError';
    error.code = 'ETIMEDOUT';
    throw error;
  }
}

export async function fetchPublic(
  url,
  {
    headers = {},
    timeout = 20000,
    maxRedirects = 5,
    responseType = 'text',
    maxBytes = 8 * 1024 * 1024,
    signal,
    deadlineMs,
    totalTimeout,
    // Opt-in retry for transient failures (network errors, and the statuses below).
    // Off by default: a caller that wants it says how many times.
    maxRetries = 0,
    retryDelay = 1000,
    retryBackoff = 2,
    retryableStatuses = [500, 502, 503, 504]
  } = {}
) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('maxRetries must be a non-negative integer');
  }
  const configuredDeadline = deadlineMs ?? totalTimeout;
  if (configuredDeadline !== undefined && configuredDeadline !== null) {
    if (!Number.isFinite(configuredDeadline) || configuredDeadline < 0) {
      throw new RangeError('deadlineMs or totalTimeout must be a non-negative finite number');
    }
  }

  const deadlineAt = configuredDeadline === undefined || configuredDeadline === null
    ? null
    : Date.now() + configuredDeadline;

  checkRequestLimits(signal, deadlineAt);
  let current = await assertPublicUrl(url);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    checkRequestLimits(signal, deadlineAt);

    let res;
    for (let attempt = 0; ; attempt++) {
      // axios's `timeout` is a socket-inactivity timer, so a server that drips
      // bytes can outlive it. When a total deadline is set, also abort the hop
      // on a wall-clock timer for the remaining budget.
      const remaining = deadlineAt === null ? null : deadlineAt - Date.now();
      const signals = [signal, remaining === null ? null : AbortSignal.timeout(Math.max(1, remaining))].filter(Boolean);
      const hopSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      let error = null;
      try {
        res = await axios.get(current, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
          timeout: remaining === null ? timeout : Math.max(1, Math.min(timeout, remaining)),
          signal: hopSignal,
          responseType,
          maxRedirects: 0,
          maxContentLength: maxBytes,
          validateStatus: () => true
        });
      } catch (err) {
        // Report a cancelled or expired request the same way as the pre-flight checks.
        checkRequestLimits(signal, deadlineAt);
        error = err;
      }

      const transient = error
        ? isRetryableError(error)
        : retryableStatuses.includes(res.status);
      if (!transient || attempt >= maxRetries) {
        if (error) throw error;
        // Out of retries on a 5xx: hand back the response like any other status,
        // so a caller sees the same shape with or without retries.
        break;
      }

      // Never sleep past the deadline: if the wait would cross it, stop now.
      const wait = retryDelay * retryBackoff ** attempt;
      if (deadlineAt !== null && Date.now() + wait >= deadlineAt) {
        if (error) throw error;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      checkRequestLimits(signal, deadlineAt);
    }

    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      current = await assertPublicUrl(new URL(res.headers.location, current).toString());
      continue;
    }

    return { status: res.status, data: res.data, headers: res.headers || {}, url: current };
  }

  throw new Error(`too many redirects from ${url}`);
}
