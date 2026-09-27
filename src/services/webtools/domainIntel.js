import axios from 'axios';
import tls from 'tls';
import { assertPublicUrl } from '../../utils/publicUrl.js';

/**
 * Passive domain reconnaissance from public records only — nothing here probes the target
 * beyond one ordinary TLS handshake:
 *   subdomains   — Certificate Transparency logs (crt.sh, CertSpotter as the fallback)
 *   dns          — DNS-over-HTTPS (Cloudflare, Google as the fallback), not the host's own
 *                  resolver, so local pins and split-horizon entries do not leak into the
 *                  answer; plain DNS to public resolvers is blocked on some of the agent's
 *                  networks (ECONNREFUSED from the dev box, 2026-09-26), HTTPS is not
 *   certificate  — the live certificate the site presents
 *   registration — RDAP, the keyless successor to WHOIS
 */

const UA = `LANAgent/${process.env.npm_package_version || '2'} (+https://lanagent.net)`;

export function normaliseDomain(v) {
  let d = String(v || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(d)) throw new Error(`"${v}" is not a domain name`);
  return d;
}

/** Hostnames under `domain` seen in certificates, deduplicated, wildcards noted separately. */
export function collectNames(domain, names) {
  const hosts = new Set(), wildcards = new Set();
  for (const raw of names) {
    for (const n of String(raw).toLowerCase().split(/\s+/)) {
      if (!n || !(n === domain || n.endsWith(`.${domain}`))) continue;
      if (n.startsWith('*.')) wildcards.add(n); else hosts.add(n);
    }
  }
  return { subdomains: [...hosts].sort(), wildcards: [...wildcards].sort() };
}

export async function subdomains(domainIn) {
  const domain = normaliseDomain(domainIn);
  try {
    const res = await axios.get('https://crt.sh/', { params: { q: `%.${domain}`, output: 'json' }, headers: { 'User-Agent': UA }, timeout: 45000 });
    if (!Array.isArray(res.data)) throw new Error('unexpected reply');
    return { domain, source: 'crt.sh', certificates: res.data.length, ...collectNames(domain, res.data.flatMap(r => [r.common_name, r.name_value])) };
  } catch (err) {
    const res = await axios.get('https://api.certspotter.com/v1/issuances', {
      params: { domain, include_subdomains: 'true', expand: 'dns_names' }, headers: { 'User-Agent': UA }, timeout: 30000
    });
    return { domain, source: 'certspotter', note: `crt.sh failed (${err.message})`, certificates: res.data.length, ...collectNames(domain, res.data.flatMap(r => r.dns_names || [])) };
  }
}

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];
const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

/** One DNS question over HTTPS → answer strings of that type ([] when none). */
async function doh(name, type) {
  let lastErr;
  for (const url of DOH) {
    try {
      const res = await axios.get(url, { params: { name, type }, headers: { Accept: 'application/dns-json', 'User-Agent': UA }, timeout: 8000 });
      const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      if (d.Status === 3) return []; // NXDOMAIN
      if (d.Status !== 0) throw new Error(`DNS status ${d.Status}`);
      const want = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257 }[type];
      return (d.Answer || []).filter(a => a.type === want).map(a => String(a.data));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** DoH presentation format → readable values */
export function formatRecord(type, data) {
  const unq = s => (s.match(/"((?:[^"\\]|\\.)*)"/g) || [s]).map(x => x.replace(/^"|"$/g, '')).join('');
  const host = s => s.replace(/\.$/, '');
  if (type === 'TXT') return unq(data);
  if (type === 'MX') { const [pri, ex] = data.split(/\s+/); return `${pri} ${host(ex || '')}`; }
  if (type === 'NS' || type === 'CNAME') return host(data);
  if (type === 'SOA') { const [ns, hm, serial] = data.split(/\s+/); return `${host(ns)} ${host(hm)} serial ${serial}`; }
  if (type === 'CAA') return data.replace(/"/g, '');
  return data;
}

export async function dnsRecords(domainIn, types = TYPES) {
  const domain = normaliseDomain(domainIn);
  const out = {};
  await Promise.all([].concat(types).map(String).map(t => t.toUpperCase()).filter(t => TYPES.includes(t)).map(async t => {
    try {
      const v = (await doh(domain, t)).map(d => formatRecord(t, d));
      if (v.length) out[t] = t === 'MX' ? v.sort((a, b) => parseInt(a, 10) - parseInt(b, 10)) : v;
    } catch (e) {
      out[t] = [`(lookup failed: ${e.message})`];
    }
  }));
  const txt = out.TXT || [];
  const email = { spf: txt.find(x => /^v=spf1/i.test(x)) || null, dmarc: null };
  try { email.dmarc = (await doh(`_dmarc.${domain}`, 'TXT')).map(d => formatRecord('TXT', d)).find(x => /^v=DMARC1/i.test(x)) || null; } catch { /* none */ }
  return { domain, records: out, email };
}

export async function certificate(domainIn, port = 443) {
  const domain = normaliseDomain(domainIn);
  await assertPublicUrl(`https://${domain}/`, domain);
  const cert = await new Promise((resolve, reject) => {
    const sock = tls.connect({ host: domain, port: Number(port) || 443, servername: domain, rejectUnauthorized: false, timeout: 10000 }, () => {
      const c = sock.getPeerCertificate();
      const authorized = sock.authorized, authError = sock.authorizationError;
      sock.end();
      resolve({ c, authorized, authError });
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS handshake timed out')); });
    sock.on('error', reject);
  });
  const { c } = cert;
  if (!c || !c.subject) throw new Error('no certificate presented');
  const validTo = new Date(c.valid_to);
  return {
    domain, subject: c.subject?.CN || null, issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' — '),
    validFrom: new Date(c.valid_from).toISOString(), validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo - Date.now()) / 86400000),
    names: (c.subjectaltname || '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean),
    trusted: cert.authorized, trustError: cert.authorized ? null : String(cert.authError || ''),
    fingerprint256: c.fingerprint256
  };
}

export async function registration(domainIn) {
  const domain = normaliseDomain(domainIn);
  const res = await axios.get(`https://rdap.org/domain/${domain}`, { headers: { 'User-Agent': UA, Accept: 'application/rdap+json' }, timeout: 20000, maxRedirects: 5, validateStatus: () => true });
  if (res.status === 404) return { domain, registered: false };
  if (res.status !== 200) throw new Error(`RDAP HTTP ${res.status}`);
  const d = res.data;
  const ev = a => (d.events || []).find(e => e.eventAction === a)?.eventDate || null;
  const registrar = (d.entities || []).find(e => (e.roles || []).includes('registrar'));
  const vcardName = e => (e?.vcardArray?.[1] || []).find(x => x[0] === 'fn')?.[3] || null;
  return {
    domain, registered: true, registrar: vcardName(registrar), created: ev('registration'), expires: ev('expiration'),
    updated: ev('last changed'), status: d.status || [], nameservers: (d.nameservers || []).map(n => String(n.ldhName).toLowerCase()),
    dnssec: d.secureDNS?.delegationSigned ?? null
  };
}

export async function report(domainIn) {
  const domain = normaliseDomain(domainIn);
  const settle = p => p.then(v => v, e => ({ error: e.message }));
  const [reg, dns, subs, cert] = await Promise.all([settle(registration(domain)), settle(dnsRecords(domain)), settle(subdomains(domain)), settle(certificate(domain))]);
  return { domain, registration: reg, dns, subdomains: subs, certificate: cert };
}
