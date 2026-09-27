---
name: domain-recon-report
description: Produce a passive intelligence report on a domain or website - registration, DNS and email security, TLS certificate, subdomains from certificate logs - use when asked to investigate a domain, check who owns a site, audit a domain's DNS or email setup, list its subdomains, or check whether a link or sender domain looks legitimate.
source: lanagent
inspired_by: hermes-agent domain-intel
---

## Procedure
1. Normalise the target to a bare domain (strip scheme, path, port; use the registrable domain for ownership questions).
2. domainIntel.report({ domain }) for the overview. Drill down only where needed: domainIntel.registration, .dns, .certificate, .subdomains.
3. Read the results for what they mean:
   - Registration: age (a domain created days ago that claims to be an established company is a red flag), expiry soon, registrar, clientHold/serverHold status.
   - Email: SPF present and ending in -all or ~all; DMARC policy (none = monitoring only, quarantine/reject = enforced). No MX means the domain cannot receive mail.
   - Certificate: issuer, days left (under 14 = renewal problem), untrusted = misconfigured or impersonation.
   - Subdomains: group by purpose (mail, api, admin, staging/dev, vpn). Staging/dev/admin hosts in public logs are worth mentioning to an owner.
4. Write the report: one-line verdict first, then Registration, DNS & email, Certificate, Subdomains, Notable findings, each finding tied to the record that shows it.
5. For a suspicious-link question, also compare the domain to the brand it imitates (lookalike spelling, extra words, unusual TLD) and say plainly whether it looks legitimate.

## Rules
- Passive only: public records and one normal TLS connection. Never scan ports, brute-force subdomains or probe hosts found in the logs.
- Certificate logs show names that ever had a certificate, not hosts that are up; say so.
- For a domain the operator does not own, report facts; do not suggest attacking or testing it.
