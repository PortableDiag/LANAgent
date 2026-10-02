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

/**
 * Assess the negotiated TLS connection posture, including protocol, cipher,
 * key exchange, certificate chain, and ALPN negotiation.
 */
export async function tlsPosture(domainIn, options = {}) {
  const domain = normaliseDomain(domainIn);
  await assertPublicUrl(`https://${domain}/`, domain);

  const port = Number(options.port) || 443;
  const timeout = Number(options.timeout) || 10000;
  // Offer h2 and http/1.1 like a browser does; with nothing offered the server can
  // never select a protocol, and every site would be reported as missing ALPN.
  const alpnProtocols = Array.isArray(options.alpnProtocols) && options.alpnProtocols.length
    ? options.alpnProtocols
    : ['h2', 'http/1.1'];

  const handshake = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const connectOptions = {
      host: domain,
      port,
      servername: domain,
      rejectUnauthorized: false,
      timeout
    };
    connectOptions.ALPNProtocols = alpnProtocols;

    const socket = tls.connect(connectOptions, () => {
      let peer;
      try {
        peer = socket.getPeerCertificate(true);
      } catch {
        peer = socket.getPeerCertificate();
      }

      const protocol = typeof socket.getProtocol === 'function' ? socket.getProtocol() : null;
      const cipher = typeof socket.getCipher === 'function' ? socket.getCipher() : null;
      const keyInfo = typeof socket.getEphemeralKeyInfo === 'function' ? socket.getEphemeralKeyInfo() : null;
      const alpn = socket.alpnProtocol || null;
      const authorized = socket.authorized === true;
      const authorizationError = socket.authorizationError || null;

      socket.end();
      finish(resolve, { peer, protocol, cipher, keyInfo, alpn, authorized, authorizationError });
    });

    socket.on('timeout', () => {
      socket.destroy();
      finish(reject, new Error('TLS handshake timed out'));
    });
    socket.on('error', error => finish(reject, error));
  });

  const first = handshake.peer;
  if (!first || !first.subject) throw new Error('no certificate presented');

  const chain = [];
  const seen = new Set();
  let current = first;
  while (current && typeof current === 'object' && !seen.has(current.fingerprint256 || current.serialNumber || current.subject?.CN)) {
    const identity = current.fingerprint256 || current.serialNumber || current.subject?.CN;
    seen.add(identity);
    chain.push({
      subject: current.subject || {},
      issuer: current.issuer || {},
      subjectCommonName: current.subject?.CN || null,
      issuerCommonName: current.issuer?.CN || null,
      validFrom: current.valid_from ? new Date(current.valid_from).toISOString() : null,
      validTo: current.valid_to ? new Date(current.valid_to).toISOString() : null,
      fingerprint256: current.fingerprint256 || null,
      serialNumber: current.serialNumber || null,
      selfSigned: Boolean(current.subject && current.issuer && JSON.stringify(current.subject) === JSON.stringify(current.issuer))
    });
    current = current.issuerCertificate;
  }

  const protocol = handshake.protocol || null;
  const cipher = handshake.cipher ? {
    name: handshake.cipher.name || null,
    standardName: handshake.cipher.standardName || null,
    version: handshake.cipher.version || null,
    bits: Number.isFinite(Number(handshake.cipher.bits)) ? Number(handshake.cipher.bits) : null
  } : null;
  const keyExchange = handshake.keyInfo ? {
    type: handshake.keyInfo.type || null,
    name: handshake.keyInfo.name || null,
    size: Number.isFinite(Number(handshake.keyInfo.size)) ? Number(handshake.keyInfo.size) : null
  } : null;

  const findings = [];
  const addFinding = (id, title, severity, recommendation) => findings.push({ id, title, severity, recommendation });

  if (protocol === 'SSLv3' || protocol === 'TLSv1' || protocol === 'TLSv1.1') {
    addFinding(
      'obsolete-protocol',
      `The negotiated protocol is obsolete (${protocol})`,
      'high',
      'Disable SSLv3, TLS 1.0, and TLS 1.1 and require TLS 1.2 or newer.'
    );
  }

  const cipherName = String(cipher?.name || '').toUpperCase();
  if (
    !cipherName ||
    /(?:RC4|RC2|3DES|DES|NULL|EXPORT|ANON|MD5|CBC)/.test(cipherName) ||
    (cipher?.bits != null && cipher.bits < 128)
  ) {
    addFinding(
      'weak-cipher',
      cipherName ? `The negotiated cipher is weak (${cipher.name})` : 'No usable cipher information was reported',
      'high',
      'Use an authenticated, forward-secret cipher with at least 128-bit security, such as an AES-GCM or ChaCha20-Poly1305 suite.'
    );
  }

  // Trust is not a finding here: certificate() already reports it, and
  // securityPosture() scores it once as certificate-untrusted.

  const leafIssuer = first.issuer?.CN || first.issuer?.O || null;
  const secondSubject = chain[1]?.subjectCommonName || chain[1]?.subject?.O || null;
  const appearsIncomplete = chain.length === 1 && !chain[0].selfSigned && leafIssuer && leafIssuer !== secondSubject;
  if (appearsIncomplete) {
    addFinding(
      'incomplete-chain',
      'The server did not provide a complete certificate chain',
      'high',
      'Configure the server to send the leaf certificate followed by all required intermediate certificates.'
    );
  }

  if (!handshake.alpn) {
    addFinding(
      'missing-alpn',
      'No ALPN protocol was negotiated',
      'low',
      'Advertise and negotiate an application protocol such as h2 or http/1.1.'
    );
  }

  return {
    domain,
    protocol,
    cipher,
    keyExchange,
    alpn: handshake.alpn,
    certificate: {
      subject: first.subject || {},
      issuer: first.issuer || {},
      validFrom: first.valid_from ? new Date(first.valid_from).toISOString() : null,
      validTo: first.valid_to ? new Date(first.valid_to).toISOString() : null,
      fingerprint256: first.fingerprint256 || null,
      serialNumber: first.serialNumber || null,
      trusted: handshake.authorized,
      trustError: handshake.authorized ? null : String(handshake.authorizationError || '')
    },
    chain,
    findings
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

export async function report(domainIn, options = {}) {
  const domain = normaliseDomain(domainIn);
  const settle = p => p.then(v => v, e => ({ error: e.message }));
  const includeTlsPosture = options?.includeTlsPosture === true;
  const tasks = [
    settle(registration(domain)),
    settle(dnsRecords(domain)),
    settle(subdomains(domain)),
    settle(certificate(domain))
  ];
  if (includeTlsPosture) tasks.push(settle(tlsPosture(domain, options.tlsPostureOptions || {})));

  const [reg, dns, subs, cert, posture] = await Promise.all(tasks);
  const result = { domain, registration: reg, dns, subdomains: subs, certificate: cert };
  if (includeTlsPosture) result.tlsPosture = posture;
  return result;
}

/**
 * Derive a deterministic security posture from an existing report.
 *
 * A report object may be supplied directly to avoid any additional third-party
 * calls. When a domain is supplied, this function obtains one report and only
 * evaluates the collected data.
 */
export async function securityPosture(domainIn, options = {}) {
  const supplied = domainIn && typeof domainIn === 'object' ? domainIn : null;
  const data = supplied || await report(domainIn, { includeTlsPosture: true });
  const domain = normaliseDomain(data.domain || domainIn);
  const includeEvidence = options?.includeEvidence === true;
  const findings = [];
  const evidence = [];
  let score = 100;

  const addFinding = (id, title, severity, deduction, recommendation, value) => {
    score -= deduction;
    findings.push({ id, title, severity, recommendation });
    if (includeEvidence) evidence.push({ id, value });
  };

  const cert = data.certificate && !data.certificate.error ? data.certificate : null;
  if (!cert) {
    addFinding('certificate-unavailable', 'HTTPS certificate could not be assessed', 'critical', 25, 'Serve the domain over HTTPS with a publicly trusted certificate.', data.certificate?.error || null);
  } else {
    const daysLeft = Number(cert.daysLeft);
    if (cert.trusted !== true) {
      addFinding('certificate-untrusted', 'The HTTPS certificate is not trusted by the TLS client', 'high', 15, 'Replace the certificate or correct the certificate chain and trust configuration.', { trusted: cert.trusted, trustError: cert.trustError || null });
    } else if (includeEvidence) {
      evidence.push({ id: 'certificate-trust', value: { trusted: true, issuer: cert.issuer || null } });
    }
    if (!Number.isFinite(daysLeft) || daysLeft < 0) {
      addFinding('certificate-expired', 'The HTTPS certificate is expired or has no usable expiry information', 'critical', 20, 'Renew the certificate immediately and automate renewal before expiry.', { daysLeft: cert.daysLeft ?? null, validTo: cert.validTo || null });
    } else if (daysLeft <= 30) {
      addFinding('certificate-near-expiry', 'The HTTPS certificate expires within 30 days', 'high', 10, 'Renew the certificate and configure expiry monitoring.', { daysLeft, validTo: cert.validTo || null });
    } else if (includeEvidence) {
      // No "within 90 days" tier: Let's Encrypt and Cloudflare issue 90-day
      // certificates (and lifetimes are shrinking), so it flagged every
      // well-run site. Under 30 days is the signal that renewal is failing.
      evidence.push({ id: 'certificate-lifetime', value: { daysLeft, validFrom: cert.validFrom || null, validTo: cert.validTo || null } });
    }
  }

  const tlsData = data.tlsPosture && !data.tlsPosture.error ? data.tlsPosture : null;
  if (tlsData) {
    for (const finding of tlsData.findings || []) {
      const deduction = finding.id === 'obsolete-protocol' || finding.id === 'weak-cipher' ? 15 : finding.id === 'incomplete-chain' ? 10 : 4;
      addFinding(`tls-${finding.id}`, finding.title, finding.severity, deduction, finding.recommendation, tlsData);
    }
  }

  const dns = data.dns && !data.dns.error ? data.dns : null;
  const records = dns?.records || {};
  const email = dns?.email || {};
  const txt = Array.isArray(records.TXT) ? records.TXT : [];
  const spf = email.spf || txt.find(value => /^v=spf1\b/i.test(String(value))) || null;
  if (!spf) {
    addFinding('spf-missing', 'No SPF policy was observed', 'high', 12, 'Publish an SPF TXT record listing authorized mail senders and keep it within DNS lookup limits.', null);
  } else if (includeEvidence) {
    evidence.push({ id: 'spf', value: spf });
  }

  const dmarc = email.dmarc || null;
  const policy = dmarc?.match(/(?:^|;)\s*p\s*=\s*([^;]+)/i)?.[1]?.trim().toLowerCase() || null;
  if (!dmarc) {
    addFinding('dmarc-missing', 'No DMARC policy was observed', 'high', 15, 'Publish a DMARC record at _dmarc with reporting and an enforcement policy.', null);
  } else if (policy === 'none') {
    addFinding('dmarc-monitoring-only', 'DMARC is present but has no enforcement policy', 'medium', 10, 'Move DMARC from p=none to p=quarantine or p=reject after reviewing aggregate reports.', { record: dmarc, policy });
  } else if (policy === 'quarantine') {
    addFinding('dmarc-quarantine', 'DMARC provides partial enforcement only', 'low', 4, 'Use p=reject when legitimate sending sources have been validated.', { record: dmarc, policy });
  } else if (policy !== 'reject') {
    addFinding('dmarc-policy-invalid', 'DMARC is present without a recognized enforcement policy', 'medium', 10, 'Set an explicit DMARC policy of quarantine or reject.', { record: dmarc, policy });
  } else if (includeEvidence) {
    evidence.push({ id: 'dmarc', value: { record: dmarc, policy } });
  }

  const caa = Array.isArray(records.CAA) ? records.CAA.filter(value => !/^\(lookup failed:/i.test(String(value))) : [];
  if (!caa.length) {
    addFinding('caa-missing', 'No CAA record was observed', 'medium', 8, 'Publish CAA records restricting which certificate authorities may issue for the domain.', null);
  } else if (includeEvidence) {
    evidence.push({ id: 'caa', value: caa });
  }

  const registrationData = data.registration && !data.registration.error ? data.registration : null;
  if (registrationData?.dnssec !== true) {
    addFinding('dnssec-not-confirmed', registrationData?.dnssec === false ? 'RDAP reports that DNSSEC is not enabled' : 'DNSSEC status could not be confirmed from RDAP', 'medium', registrationData?.dnssec === false ? 10 : 6, 'Enable DNSSEC at the registrar and publish a valid DS record at the parent zone.', registrationData?.dnssec ?? null);
  } else if (includeEvidence) {
    evidence.push({ id: 'dnssec', value: true });
  }

  const wildcards = data.subdomains && !data.subdomains.error
    ? [...new Set([...(data.subdomains.wildcards || []), ...(cert?.names || []).filter(name => String(name).startsWith('*.'))])].sort()
    : [];
  if (wildcards.length) {
    addFinding('wildcard-certificates', 'Wildcard certificate names were observed in certificate data', 'medium', 5, 'Review wildcard coverage, restrict wildcard use to necessary zones, and isolate sensitive services onto explicit names.', wildcards);
  } else if (includeEvidence) {
    evidence.push({ id: 'wildcard-certificates', value: [] });
  }

  const lookupFailures = [];
  for (const [type, values] of Object.entries(records)) {
    if (Array.isArray(values) && values.some(value => /^\(lookup failed:/i.test(String(value)))) lookupFailures.push(type);
  }
  const hasAddress = ['A', 'AAAA', 'CNAME'].some(type => Array.isArray(records[type]) && records[type].length && !records[type].some(value => /^\(lookup failed:/i.test(String(value))));
  if (!dns || lookupFailures.length || !hasAddress) {
    addFinding('dns-data-inconsistent', 'DNS data is incomplete or contains failed lookups', 'high', 10, 'Correct DNS resolution failures and verify that the zone has an address or CNAME for the assessed domain.', {
      lookupFailures: lookupFailures.sort(),
      addressRecordObserved: hasAddress
    });
  } else if (includeEvidence) {
    evidence.push({ id: 'dns-consistency', value: { lookupFailures: [], addressRecordObserved: true } });
  }

  score = Math.max(0, Math.min(100, score));
  const severity = score >= 85 ? 'low' : score >= 70 ? 'moderate' : score >= 45 ? 'high' : 'critical';

  return {
    domain,
    score,
    severity,
    findings,
    evidence: includeEvidence ? evidence : [],
    recommendations: [...new Set(findings.map(finding => finding.recommendation))]
  };
}
