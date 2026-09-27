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

/** Throws unless `value` is an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(value, label = 'url') {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error(`${label} is not a valid URL`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${label} must be http(s)`);
  if (u.username || u.password) throw new Error(`${label} must not carry credentials`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`${label}: cannot resolve ${host}`);
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error(`${label} points at a private or local address`);
  return u.toString();
}
