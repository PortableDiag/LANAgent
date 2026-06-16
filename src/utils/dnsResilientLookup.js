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
//   final, ETIMEDOUT, ESERVFAIL) up to 4 times with brief exponential backoff
//   (150ms, 300ms, 600ms, 1200ms — total ~2.25s worst case). Non-transient
//   errors propagate immediately so genuinely-bad hostnames still fail fast.
//
// What this does NOT do:
//   - Cache successful lookups (libc / resolved already do that).
//   - Replace DNS servers — we still use whatever /etc/resolv.conf points to.
//   - Help if DNS is fully broken for >2s — those failures still propagate.
//
// Idempotency:
//   `install()` is safe to call multiple times. Subsequent calls are no-ops.

import dns from 'dns';

const TRANSIENT_DNS_ERRORS = new Set([
  'EAI_AGAIN',     // resolver temporarily unavailable (most common during VPN switch)
  'EAI_NODATA',    // upstream returned no records (often transient)
  'ETIMEDOUT',     // resolver query timed out
  'ESERVFAIL',     // upstream resolver SERVFAIL
  'ECONNREFUSED'   // local resolver socket refused (e.g. systemd-resolved restarting)
]);

const MAX_ATTEMPTS = 4;
const BACKOFFS_MS = [150, 300, 600, 1200];

let installed = false;

function isTransient(err) {
  return err && TRANSIENT_DNS_ERRORS.has(err.code);
}

export function install() {
  if (installed) return;
  installed = true;

  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;

  // Callback-style (used by core http/https/net)
  dns.lookup = function patchedLookup(hostname, optionsOrCallback, maybeCallback) {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const opts = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    let attempt = 0;
    const tryOnce = () => {
      const innerCb = (err, ...args) => {
        if (err && isTransient(err) && attempt < MAX_ATTEMPTS - 1) {
          const delay = BACKOFFS_MS[attempt] || 1200;
          attempt++;
          setTimeout(tryOnce, delay);
          return;
        }
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
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return opts === undefined
          ? await originalPromiseLookup(hostname)
          : await originalPromiseLookup(hostname, opts);
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;
        await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt] || 1200));
      }
    }
    throw lastErr;
  };
}
