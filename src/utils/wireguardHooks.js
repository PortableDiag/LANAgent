import { readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ExpressVPN rebuilds its killswitch chain (evpn.r.100.blockAll) on every
// reconnect, which deletes the UDP/51820 ACCEPT that wg0.conf's PostUp inserted.
// wg-quick only runs PostUp on `up`, so after a VPN reconnect the tunnel stays
// blackholed until something re-applies it. On 2026-09-30 that lasted three
// hours: the watchdog's two bounces ran before the reconnect finished, then it
// held and never touched the rules again.
//
// Only lines that are safe to run twice are re-applied: an iptables check
// (`-C`) guarding its insert, and `ip route add`, which fails harmlessly when
// the route exists. Anything else (e.g. a bare `iptables -A`) would stack
// duplicates on every tick, so it is left to wg-quick.
export function idempotentPostUp(confText, iface = 'wg0') {
  const lines = [];
  for (const raw of confText.split('\n')) {
    const m = raw.match(/^\s*PostUp\s*=\s*(.+?)\s*$/i);
    if (!m) continue;
    const cmd = m[1].replace(/%i/g, iface);
    const guardedIptables = /^ip6?tables\s+(.*\s)?-C\s.*\|\|/.test(cmd);
    const routeAdd = /^ip\s+(-\d\s+)?route\s+add\s/.test(cmd);
    if (guardedIptables || routeAdd) {
      // For a guarded rule, the part before the first || is the presence check.
      const check = guardedIptables ? cmd.split('||')[0].trim().replace(/\s*2>\/dev\/null\s*$/, '') : null;
      lines.push({ cmd, check });
    }
  }
  return lines;
}

// Re-apply the idempotent PostUp hooks without touching the interface, so a
// handshake already in flight is not dropped. Returns the checked rules that
// were missing and have been put back.
export async function reassertPostUp({ confPath = `/etc/wireguard/wg0.conf`, iface = 'wg0', run = execAsync } = {}) {
  const hooks = idempotentPostUp(await readFile(confPath, 'utf8'), iface);
  const restored = [];
  for (const { cmd, check } of hooks) {
    if (check) {
      try { await run(`${check} 2>/dev/null`); continue; } catch { /* missing */ }
      restored.push(check.replace(/\s-C\s/, ' '));
    }
    await run(cmd).catch(() => {});
  }
  return restored;
}
