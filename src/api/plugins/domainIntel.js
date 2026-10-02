import { BasePlugin } from '../core/basePlugin.js';
import { extractParams } from '../../services/webtools/extractParams.js';
import { subdomains, dnsRecords, certificate, tlsPosture, registration, report, securityPosture } from '../../services/webtools/domainIntel.js';

/** Passive domain intelligence from public records: subdomains, DNS, certificate, registration. */
export default class DomainIntelPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'domainIntel';
    this.version = '1.0.0';
    this.description = 'Passive domain intelligence: subdomains from certificate logs, DNS records, the live TLS certificate, and registration (RDAP) — no key needed';
    this.commands = [
      { command: 'subdomains', description: 'List a domain\'s subdomains found in public Certificate Transparency logs',
        usage: 'subdomains({ domain: "example.com" })', examples: ['find the subdomains of example.com', 'what subdomains does this company have', 'enumerate subdomains for lanagent.net'] },
      { command: 'dns', description: 'A domain\'s DNS records (A, AAAA, CNAME, MX, NS, TXT, SOA, CAA) plus its SPF and DMARC policy, from public resolvers',
        usage: 'dns({ domain: "example.com" })  // add types: ["MX"] only when the request names specific record types', examples: ['what are the mx records for example.com', 'show the dns records of this domain', 'does this domain have dmarc and spf'] },
      { command: 'certificate', description: 'The TLS certificate a site presents: issuer, names, expiry and whether it is trusted',
        usage: 'certificate({ domain: "example.com" })', examples: ['when does the ssl certificate for example.com expire', 'who issued this site\'s certificate', 'check the https certificate on this domain'] },
      { command: 'tlsPosture', description: 'Assess a site\'s live TLS connection: negotiated protocol version, cipher suite, key exchange, certificate chain and ALPN, with findings',
        usage: 'tlsPosture({ domain: "example.com" })', examples: ['what tls version does example.com use', 'check the cipher suite of this site', 'is the certificate chain complete on example.com'] },
      { command: 'registration', description: 'Domain registration from RDAP: registrar, created and expiry dates, status, nameservers, DNSSEC',
        usage: 'registration({ domain: "example.com" })', examples: ['who is the registrar of example.com', 'when does this domain expire', 'is this domain registered'] },
      { command: 'report', description: 'Everything at once: registration, DNS, subdomains and certificate for a domain',
        usage: 'report({ domain: "example.com" })', examples: ['give me a full report on example.com', 'investigate this domain', 'domain intel on this website'] },
      { command: 'securityPosture', description: 'Score a domain\'s public security posture (0-100): certificate trust and expiry, TLS protocol and cipher, certificate chain, SPF, DMARC policy, CAA, DNSSEC, wildcard certificates, DNS health — with fixes',
        usage: 'securityPosture({ domain: "example.com", includeEvidence: false })', examples: ['how secure is example.com', 'security posture of this domain', 'check the email and certificate security of lanagent.net', 'score the domain security of example.com'] }
    ];
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    const domain = p.domain || p.url || p.host || p.target;
    try {
      switch (action) {
        case 'subdomains': {
          const r = await subdomains(domain);
          return { success: true, ...r, result: `${r.subdomains.length} subdomain(s) of ${r.domain} in certificate logs (${r.source}):\n${r.subdomains.slice(0, 100).join('\n')}${r.subdomains.length > 100 ? `\n…and ${r.subdomains.length - 100} more` : ''}${r.wildcards.length ? `\nWildcards: ${r.wildcards.join(', ')}` : ''}` };
        }
        case 'dns': {
          const r = await dnsRecords(domain, p.types || p.type ? [].concat(p.types || p.type) : undefined);
          const lines = Object.entries(r.records).map(([t, v]) => `${t}: ${v.join(' | ')}`);
          return { success: true, ...r, result: `${r.domain}\n${lines.join('\n') || 'No records.'}\nSPF: ${r.email.spf || 'none'}\nDMARC: ${r.email.dmarc || 'none'}` };
        }
        case 'certificate': {
          const r = await certificate(domain, p.port);
          return { success: true, ...r, result: `${r.domain}: issued by ${r.issuer}, valid until ${r.validTo.slice(0, 10)} (${r.daysLeft} days)${r.trusted ? '' : ` — NOT trusted: ${r.trustError}`}\nNames: ${r.names.slice(0, 20).join(', ')}` };
        }
        case 'tlsPosture': {
          const r = await tlsPosture(domain, { port: p.port });
          const kx = r.keyExchange ? `; key exchange ${r.keyExchange.name || r.keyExchange.type}${r.keyExchange.size ? ` (${r.keyExchange.size} bits)` : ''}` : '';
          const lines = r.findings.map(f => `- [${f.severity}] ${f.title} → ${f.recommendation}`);
          return { success: true, ...r, result: `${r.domain}: ${r.protocol || 'unknown protocol'}, cipher ${r.cipher?.standardName || r.cipher?.name || 'unknown'}${kx}; ALPN ${r.alpn || 'none'}; chain of ${r.chain.length} certificate(s)${r.certificate.trusted ? '' : ` — NOT trusted: ${r.certificate.trustError}`}\n${lines.join('\n') || 'No TLS findings.'}` };
        }
        case 'registration': {
          const r = await registration(domain);
          return { success: true, ...r, result: r.registered ? `${r.domain}: registrar ${r.registrar || 'unknown'}, created ${r.created?.slice(0, 10) || '?'}, expires ${r.expires?.slice(0, 10) || '?'}\nStatus: ${r.status.join(', ')}\nNameservers: ${r.nameservers.join(', ')}${r.dnssec != null ? `\nDNSSEC: ${r.dnssec ? 'signed' : 'unsigned'}` : ''}` : `${r.domain} is not registered (RDAP has no record).` };
        }
        case 'report': {
          const r = await report(domain);
          const reg = r.registration.error ? `Registration: ${r.registration.error}` : r.registration.registered ? `Registrar ${r.registration.registrar || '?'}; expires ${r.registration.expires?.slice(0, 10) || '?'}` : 'Not registered';
          const dns = r.dns.error ? `DNS: ${r.dns.error}` : `A: ${(r.dns.records.A || []).join(', ') || '—'}; MX: ${(r.dns.records.MX || []).join(', ') || '—'}; SPF ${r.dns.email.spf ? 'yes' : 'no'}, DMARC ${r.dns.email.dmarc ? 'yes' : 'no'}`;
          const subs = r.subdomains.error ? `Subdomains: ${r.subdomains.error}` : `${r.subdomains.subdomains.length} subdomains: ${r.subdomains.subdomains.slice(0, 25).join(', ')}${r.subdomains.subdomains.length > 25 ? ' …' : ''}`;
          const cert = r.certificate.error ? `Certificate: ${r.certificate.error}` : `Certificate by ${r.certificate.issuer}, ${r.certificate.daysLeft} days left${r.certificate.trusted ? '' : ' (untrusted)'}`;
          return { success: true, ...r, result: `${r.domain}\n${reg}\n${dns}\n${cert}\n${subs}` };
        }
        case 'securityPosture': {
          const r = await securityPosture(domain, { includeEvidence: p.includeEvidence === true });
          const lines = r.findings.map(f => `- [${f.severity}] ${f.title} → ${f.recommendation}`);
          return { success: true, ...r, result: `${r.domain}: security score ${r.score}/100 (risk ${r.severity})\n${lines.join('\n') || 'No findings: every checked control is in place.'}` };
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Use: subdomains, dns, certificate, tlsPosture, registration, report, securityPosture` };
      }
    } catch (error) {
      this.logger.warn(`domainIntel ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
