/**
 * Is this Node.js runtime missing a security release? Node 20 is end-of-life, and 22/24/26
 * releases older than the 2026-10-21 one lack its TLS hostname, Brotli and keep-alive fixes.
 * Most hosts ran Node 20 that day, so an instance now says so at startup instead of running
 * unpatched without a word.
 */
const PATCHED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

/** A warning for an unpatched or end-of-life Node.js version, or null when it is current. */
export function unpatchedNodeWarning(version = process.version) {
  const [major, minor, patch] = String(version).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const floor = PATCHED[major];
  if (!floor) {
    return `Node.js ${version} is end-of-life or not a supported line and gets no security fixes; ` +
      'upgrade to Node.js 24.22.1 (or 22.23.4) or newer.';
  }
  const behind = minor < floor[1] || (minor === floor[1] && patch < floor[2]);
  return behind
    ? `Node.js ${version} predates the 2026-10-21 security release; upgrade to ${floor.join('.')} or newer.`
    : null;
}
