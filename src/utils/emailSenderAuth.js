/**
 * Decide whether an inbound email genuinely came from a trusted sender.
 *
 * WHY THIS EXISTS. The auto-reply path hands a raw email body to the AI
 * ("You are ALICE, a personal assistant agent. Someone sent you an email…") and
 * that text reaches the intent detector, which can dispatch plugins. The gate in
 * front of it compared `From:` to the master address as a plain string. `From:` is
 * chosen by whoever sends the mail, so that gate could be walked through by typing
 * an address. On 2026-01-18 a phishing mail impersonating "GitHub Developer
 * Support" reached exactly that AI path and was answered.
 *
 * So the question this module answers is not "what does From say" but "did our own
 * mail server verify that From". Only the server's verdict counts.
 *
 * WHAT WE TRUST, AND WHY ONLY THAT. mail.lanagent.net stamps its findings as
 * `Authentication-Results` headers with its own authserv-id. An attacker can put
 * identical-looking headers in the message they send; ours are prepended on
 * delivery, theirs stay down in the original message. Observed real layout:
 *
 *     0 Return-Path        3 Received                6 Received-SPF
 *     1 Delivered-To       4 Authentication-Results  7 Received     <- upstream
 *     2 Received           5 Authentication-Results  8 DKIM-Signature
 *
 * Note our verdicts sit BELOW our own Received lines, so "everything above the
 * first Received" would discard them. Nor is "the topmost contiguous run of
 * Authentication-Results" enough — an attacker's forged pair is contiguous too.
 *
 * The boundary that actually holds is the INGRESS HOP: the first `Received` whose
 * `from` is not our own infrastructure. Real hops on this server look like
 *
 *     2  Received: from mail.lanagent.net by mail.lanagent.net with LMTP ...
 *     3  Received: from localhost (localhost [127.0.0.1]) by mail.lanagent.net ...
 *     7  Received: from out-37.smtp.github.com (...) by mail.lanagent.net ...   <- ingress
 *
 * Hops 2-3 are internal; hop 7 is where the message arrived from outside. Anything
 * at or below the ingress hop came with the message and is attacker-controlled, so
 * only headers above it are read. There are two verdict headers (dmarc and dkim are
 * reported separately), which is why a single-value header lookup reads half a
 * verdict and would accept dmarc=pass while ignoring dkim=fail.
 *
 * FAILS CLOSED. Anything unparseable, absent, misaligned or merely not-a-pass is
 * untrusted. A silent `true` here is a remote-controlled agent.
 */

const AR = 'authentication-results';

/** Domain of an address, lowercased. `"A B" <x@Y.com>` → `y.com`. */
export function domainOf(address) {
  const s = String(address || '');
  const angled = s.match(/<([^>]+)>/);
  const addr = (angled ? angled[1] : s).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 0 || at === addr.length - 1) return null;
  const d = addr.slice(at + 1).replace(/[>\s;,]+$/, '');
  return d || null;
}

/** Bare address, lowercased, angle brackets and display name removed. */
export function addressOf(value) {
  const s = String(value || '');
  const angled = s.match(/<([^>]+)>/);
  return (angled ? angled[1] : s).trim().toLowerCase();
}

/**
 * DMARC-style relaxed alignment: equal, or a subdomain of the organisational
 * domain. `mail.github.com` aligns with `github.com`; `github.com.evil.net` does
 * not (the suffix check requires a dot boundary).
 */
export function domainsAlign(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Was this `Received:` hop handed the message by our own infrastructure?
 *
 * Reads the `from` token. Our internal hops name our own host or loopback; the
 * ingress hop names the outside world. Unparseable counts as EXTERNAL, so a
 * malformed hop closes the trusted zone rather than extending it.
 */
export function isInternalHop(receivedLine, trustedHost) {
  const host = String(trustedHost || '').trim().toLowerCase();
  if (!host) return false;
  const line = String(receivedLine || '').replace(/\s+/g, ' ');
  const m = line.match(/\bfrom\s+([^\s;(]+)/i);
  if (!m) return false;
  const src = m[1].toLowerCase().replace(/[.,;]+$/, '');
  if (src === 'localhost' || src === '127.0.0.1' || src === '[127.0.0.1]' || src === '::1') return true;
  return src === host || src.endsWith(`.${host}`);
}

/**
 * Authentication-Results stamped by `trustedAuthservId` ABOVE the ingress hop.
 *
 * Order is the whole security property, so this takes `headerLines` (ordered, as
 * mailparser yields them) rather than a map. Scanning stops at the first external
 * `Received`: everything from there down arrived with the message.
 */
export function trustedAuthResults(headerLines, trustedAuthservId, trustedHost) {
  const want = String(trustedAuthservId || '').trim().toLowerCase();
  if (!want) return [];
  const host = String(trustedHost || trustedAuthservId || '').trim().toLowerCase();
  const lines = Array.isArray(headerLines) ? headerLines : [];

  const out = [];
  for (const h of lines) {
    const key = String(h?.key || '').toLowerCase();
    const raw = String(h?.line || '');

    if (key === 'received') {
      if (!isInternalHop(raw, host)) break;   // ingress reached — stop trusting
      continue;
    }
    if (key !== AR) continue;

    const value = raw.slice(raw.indexOf(':') + 1).trim();
    const authserv = value.split(';')[0].trim().toLowerCase();
    if (authserv === want) out.push(value);
  }
  return out;
}

/** `dkim=pass ... header.d=github.com` → { result:'pass', props:{'header.d':'github.com'} } */
function readMethod(value, method) {
  const re = new RegExp(`(?:^|;|\\s)${method}\\s*=\\s*([a-z]+)`, 'i');
  const m = value.match(re);
  if (!m) return null;
  const result = m[1].toLowerCase();
  const tail = value.slice(m.index + m[0].length);
  const props = {};
  for (const p of tail.matchAll(/(header\.(?:from|d|i)|smtp\.mailfrom)\s*=\s*([^\s;()]+)/gi)) {
    props[p[1].toLowerCase()] = p[2].toLowerCase().replace(/^@/, '');
  }
  return { result, props };
}

/**
 * Is this message genuinely from `expectedAddress`, per our own mail server?
 *
 * Requires BOTH a DMARC pass whose header.from aligns with the From domain AND a
 * DKIM pass whose signing domain aligns with it. DMARC alone would accept an
 * SPF-only pass, which authenticates the envelope rather than the visible From.
 *
 * @returns {{trusted: boolean, reason: string}}
 */
export function verifyTrustedSender(headerLines, fromHeader, options = {}) {
  const { trustedAuthservId, expectedAddress } = options;

  const expected = addressOf(expectedAddress);
  if (!expected) return { trusted: false, reason: 'no expected address configured' };
  if (!trustedAuthservId) return { trusted: false, reason: 'no trusted authserv-id configured' };

  const from = addressOf(fromHeader);
  if (!from) return { trusted: false, reason: 'unparseable From' };
  if (from !== expected) return { trusted: false, reason: `From ${from} is not the expected sender` };

  const fromDomain = domainOf(from);
  if (!fromDomain) return { trusted: false, reason: 'unparseable From domain' };

  const results = trustedAuthResults(headerLines, trustedAuthservId, options.trustedHost);
  if (!results.length) {
    return { trusted: false, reason: `no Authentication-Results from ${trustedAuthservId} — cannot verify, refusing` };
  }

  let dmarc = null, dkim = null;
  for (const value of results) {
    dmarc = dmarc || readMethod(value, 'dmarc');
    dkim = dkim || readMethod(value, 'dkim');
  }

  if (!dmarc) return { trusted: false, reason: 'no dmarc verdict' };
  if (dmarc.result !== 'pass') return { trusted: false, reason: `dmarc=${dmarc.result}` };
  const dmarcFrom = dmarc.props['header.from'];
  if (!dmarcFrom) return { trusted: false, reason: 'dmarc pass without header.from' };
  if (!domainsAlign(dmarcFrom, fromDomain)) {
    return { trusted: false, reason: `dmarc header.from ${dmarcFrom} does not align with ${fromDomain}` };
  }

  if (!dkim) return { trusted: false, reason: 'no dkim verdict' };
  if (dkim.result !== 'pass') return { trusted: false, reason: `dkim=${dkim.result}` };
  const signing = dkim.props['header.d'] || dkim.props['header.i'];
  if (!signing) return { trusted: false, reason: 'dkim pass without a signing domain' };
  if (!domainsAlign(signing, fromDomain)) {
    return { trusted: false, reason: `dkim header.d ${signing} does not align with ${fromDomain}` };
  }

  return { trusted: true, reason: `dmarc=pass dkim=pass aligned to ${fromDomain} per ${trustedAuthservId}` };
}

export default { verifyTrustedSender, trustedAuthResults, isInternalHop, domainOf, addressOf, domainsAlign };
