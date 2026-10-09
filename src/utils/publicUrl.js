import dns from 'dns/promises';
import net from 'net';

/**
 * Public-URL checks for anything fetched on behalf of someone else (paid API callers,
 * other agents). The agent runs on a LAN; "fetch http://192.168.0.1/" would be a stranger
 * reading its network.
 */

/** True for loopback, private, link-local, CGNAT and unspecified addresses. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = String(ip).toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    (v.startsWith('::ffff:') && isPrivateAddress(v.slice(7)));
}

// DNS goes through the VPN tunnel, so every exit switch (13-33 s) takes it down. Refusing a URL
// as "cannot resolve" during that gap turned 65 paid scrapes into 502s on 2026-10-08/09, each
// inside a switch. A transient failure (anything but NXDOMAIN) is retried for this long.
const DNS_WAIT_MS = Number(process.env.PUBLIC_URL_DNS_WAIT_MS) || 40000;

function urlError(message, kind, status) {
  return Object.assign(new Error(message), { errorKind: kind, httpStatus: status });
}

async function lookupAll(host, { waitMs = DNS_WAIT_MS, lookup = dns.lookup, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + waitMs;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 5000)) {
    try {
      return await lookup(host, { all: true });
    } catch (e) {
      if (e.code === 'ENOTFOUND') throw urlError(`cannot resolve ${host}`, 'nxdomain', 400);
      if (Date.now() + delay > deadline) throw urlError(`DNS temporarily unavailable for ${host}`, 'dns_temp', 503);
      await sleep(delay);
    }
  }
}

/**
 * Throws unless `value` is an http(s) URL whose host resolves only to public addresses.
 * The error carries `errorKind` (invalid_url | nxdomain | dns_temp | private_address) and
 * `httpStatus` (400, or 503 for dns_temp) so a route can answer with a classified status.
 */
export async function assertPublicUrl(value, label = 'url', opts = {}) {
  let u;
  try { u = new URL(String(value)); } catch { throw urlError(`${label} is not a valid URL`, 'invalid_url', 400); }
  if (!/^https?:$/.test(u.protocol)) throw urlError(`${label} must be http(s)`, 'invalid_url', 400);
  if (u.username || u.password) throw urlError(`${label} must not carry credentials`, 'invalid_url', 400);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await lookupAll(host, opts);
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  if (!addrs.length) throw urlError(`${label}: cannot resolve ${host}`, 'nxdomain', 400);
  if (addrs.some(a => isPrivateAddress(a.address))) throw urlError(`${label} points at a private or local address`, 'private_address', 400);
  return u.toString();
}

/** The JSON body a route answers with when assertPublicUrl refuses (gateway-classifiable). */
export function publicUrlErrorBody(e, error = e.message) {
  const httpStatus = e.httpStatus || 400;
  return { success: false, error, errorKind: e.errorKind || 'invalid_url', httpStatus, targetError: httpStatus < 500, retryable: httpStatus >= 500 };
}
