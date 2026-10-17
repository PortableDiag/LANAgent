// Resilient DNS lookup — monkey-patches `dns.lookup` to absorb transient
// resolver failures.
//
// Why this exists:
//   ExpressVPN region rotation (used by the paid /scrape pipeline) tears down
//   and re-establishes DNS resolvers on every connect. There's a 1-3 second
//   window per switch where libc getaddrinfo() returns EAI_AGAIN. With the new
//   33-region random rotation pool we are switching multiple times per minute,
//   so the window is frequent.
//
//   ANY outbound HTTP/WS call that lands in that window dies. We observed
//   this taking down concurrent calls to api.openai.com, api.telegram.org,
//   mindswarm.net, registry.lanagent.net all in the same second — and one
//   of those (registry.lanagent.net via the ws library) propagated through
//   an unguarded `emit('error')` and crashed the process.
//
//   Per-call retry inside each plugin doesn't scale. There are dozens of
//   outbound call sites across plugins, providers, and the p2p stack. They
//   all bottom out on `dns.lookup` (or `dns.promises.lookup`) because that's
//   what the http/https/ws stacks use under the hood. Patching the lookup
//   function once fixes every caller transparently.
//
// What this does:
//   Wraps both the callback-style and promise-style `dns.lookup` to retry
//   transient resolver errors (EAI_AGAIN, EAI_NODATA, ENOTFOUND when not
//   final, ETIMEDOUT, ESERVFAIL) up to a configurable number of times with
//   configurable backoff delays. Non-transient errors propagate immediately
//   so genuinely-bad hostnames still fail fast.
//
//   Emits operational events (`dns:retry`, `dns:success`, `dns:finalFailure`)
//   and exposes aggregate statistics via `getStats()` so operators can monitor
//   DNS resilience and adapt the retry policy to their environment.
//
// What this does NOT do:
//   - Cache successful lookups (libc / resolved already do that).
//   - Replace DNS servers — we still use whatever /etc/resolv.conf points to.
//   - Help if DNS is fully broken for >2s — those failures still propagate.
//
// Idempotency:
//   `install()` is safe to call multiple times. Subsequent calls are no-ops.

import dns from 'dns';
import EventEmitter from 'events';
import { logger } from './logger.js';

const TRANSIENT_DNS_ERRORS = new Set([
  'EAI_AGAIN',     // resolver temporarily unavailable (most common during VPN switch)
  'EAI_NODATA',    // upstream returned no records (often transient)
  'ETIMEDOUT',     // resolver query timed out
  'ESERVFAIL',     // upstream resolver SERVFAIL
  'ECONNREFUSED'   // local resolver socket refused (e.g. systemd-resolved restarting)
]);

// Defaults: 3 retries after the first attempt (4 attempts in total), backoff
// 150ms, 300ms, 600ms — ~1s worst case before the error propagates.
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFFS_MS = [150, 300, 600, 1200];

let installed = false;

// Aggregate counters. `finalFailures` counts only TRANSIENT errors that
// exhausted every retry — a non-transient error (a hostname that genuinely
// does not exist) is not a resilience failure and is neither counted nor
// logged here; the scraper resolves dead domains all day.
const stats = {
  totalLookups: 0,
  retries: 0,
  successesAfterRetry: 0,
  finalFailures: 0,
  lastErrorTimestamp: null
};

// Events fire here unless install({ emitter }) supplies another emitter.
export const dnsEvents = new EventEmitter();

function isTransient(err) {
  return err && TRANSIENT_DNS_ERRORS.has(err.code);
}

// Explicit option > env var > default. A non-integer or negative value falls
// through to the next source; 0 is a legitimate "do not retry".
function resolveRetries(optionValue) {
  if (Number.isInteger(optionValue) && optionValue >= 0) return optionValue;
  const env = process.env.DNS_RETRIES;
  if (env !== undefined && env.trim() !== '') {
    const parsed = Number(env);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_RETRIES;
}

function resolveBackoffs(optionValue) {
  const valid = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every(n => Number.isFinite(n) && n >= 0);
  if (valid(optionValue)) return optionValue;
  if (process.env.DNS_BACKOFF_MS) {
    const parts = process.env.DNS_BACKOFF_MS.split(',').map(s => Number(s.trim()));
    if (valid(parts)) return parts;
  }
  return DEFAULT_BACKOFFS_MS;
}

/**
 * Install the resilient DNS lookup wrapper.
 *
 * @param {Object} [options]
 * @param {number} [options.retries] - Retries after the first attempt (env DNS_RETRIES; default 3).
 * @param {number[]} [options.backoffDelays] - Delay before each retry in ms; the last value repeats
 *   (env DNS_BACKOFF_MS as a comma list; default 150,300,600,1200).
 * @param {EventEmitter} [options.emitter] - Receives the events below (default: exported `dnsEvents`).
 *
 * Events:
 *   - `dns:retry`        (hostname, error, attempt) — before each retry.
 *   - `dns:success`      (hostname)                 — a lookup succeeded after at least one retry.
 *   - `dns:finalFailure` (hostname, error)          — a transient error outlasted every retry.
 */
export function install(options = {}) {
  if (installed) return;
  installed = true;

  const retries = resolveRetries(options.retries);
  const backoffDelays = resolveBackoffs(options.backoffDelays);
  const emitter = options.emitter || dnsEvents;
  const delayFor = (attempt) => backoffDelays[Math.min(attempt, backoffDelays.length - 1)];

  const onRetry = (hostname, err, attempt) => {
    stats.retries++;
    logger.debug(`DNS retry ${attempt}/${retries} for ${hostname}: ${err.code}`);
    emitter.emit('dns:retry', hostname, err, attempt);
  };
  const onDone = (hostname, err, didRetry) => {
    if (err) {
      if (!isTransient(err)) return;
      stats.finalFailures++;
      stats.lastErrorTimestamp = Date.now();
      logger.warn(`DNS lookup for ${hostname} still failing after ${retries} retries: ${err.code}`);
      emitter.emit('dns:finalFailure', hostname, err);
    } else if (didRetry) {
      stats.successesAfterRetry++;
      emitter.emit('dns:success', hostname);
    }
  };

  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;

  // Callback-style (used by http/https/net/ws under the hood)
  dns.lookup = function patchedLookup(hostname, optionsOrCallback, maybeCallback) {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const opts = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    let attempt = 0;
    stats.totalLookups++;
    const tryOnce = () => {
      const innerCb = (err, ...args) => {
        if (err && isTransient(err) && attempt < retries) {
          const delay = delayFor(attempt);
          attempt++;
          onRetry(hostname, err, attempt);
          setTimeout(tryOnce, delay);
          return;
        }
        onDone(hostname, err, attempt > 0);
        cb(err, ...args);
      };
      if (opts === undefined) {
        originalLookup(hostname, innerCb);
      } else {
        originalLookup(hostname, opts, innerCb);
      }
    };
    tryOnce();
  };

  // Promise-style (used by some libraries that prefer dns.promises)
  dns.promises.lookup = async function patchedPromiseLookup(hostname, opts) {
    stats.totalLookups++;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = opts === undefined
          ? await originalPromiseLookup(hostname)
          : await originalPromiseLookup(hostname, opts);
        onDone(hostname, null, attempt > 0);
        return result;
      } catch (err) {
        if (!isTransient(err) || attempt >= retries) {
          onDone(hostname, err, attempt > 0);
          throw err;
        }
        onRetry(hostname, err, attempt + 1);
        await new Promise(r => setTimeout(r, delayFor(attempt)));
      }
    }
  };
}

/**
 * Snapshot of the aggregate DNS resilience counters since install().
 * @returns {{ totalLookups: number, retries: number, successesAfterRetry: number, finalFailures: number, lastErrorTimestamp: number|null }}
 */
export function getStats() {
  return { ...stats };
}
