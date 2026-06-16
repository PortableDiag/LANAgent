#!/usr/bin/env bash
#
# dns-selfheal.sh — autonomous DNS recovery for LANAgent agents.
#
# Some agents run behind a VPN (e.g. ExpressVPN) that HIJACKS all port-53
# traffic: only the VPN's own resolver (classically 100.64.100.1) answers, and
# the systemd-resolved stub (127.0.0.53) gets blackholed by the VPN's fwmark
# policy routing. Net effect: every un-pinned hostname stops resolving, which
# silently breaks web scraping (arbitrary domains) and git auto-update — while
# the agent looks "up" because the AI/gateway hosts are pinned in /etc/hosts.
#
# Because the box's only inbound path may itself be a VPN tunnel, we CANNOT rely
# on reaching in to run a fix. This script runs from a systemd timer on the box
# so the agent repairs its own DNS. When external resolution is broken it:
#   1. ensures NSS bypasses the (possibly dead) resolved stub  -> `files dns`
#   2. probes candidate resolvers (VPN DNS first, then public fallbacks)
#   3. pins the first working one into /etc/resolv.conf (immutable)
# When resolution already works it does NOTHING (non-invasive on healthy hosts).
#
# Install: see README.md in this directory. Runs as root (edits /etc).
set -u

PROBE_HOSTS=(cloudflare.com wikipedia.org)
FALLBACK_DNS=(1.1.1.1 8.8.8.8 9.9.9.9)
LOG="${DNS_SELFHEAL_LOG:-/var/log/dns-selfheal.log}"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG" 2>/dev/null; }

# Resolve HOST via a specific SERVER; prints an IP on success, nothing on fail.
query() {
  local server="$1" host="$2"
  if command -v dig >/dev/null 2>&1; then
    timeout 3 dig +short +time=2 +tries=1 "@$server" "$host" 2>/dev/null | grep -m1 -E '^[0-9]+\.'
  elif command -v nslookup >/dev/null 2>&1; then
    timeout 3 nslookup "$host" "$server" 2>/dev/null | awk '/^Address: /{print $2; exit}'
  fi
}

# Does normal (NSS / glibc) resolution work for any probe host? This is the same
# path git/node/curl/the scraper use — so it's the real health signal.
nss_ok() {
  local h
  for h in "${PROBE_HOSTS[@]}"; do
    getent hosts "$h" >/dev/null 2>&1 && return 0
  done
  return 1
}

# --- 1. already healthy? leave everything alone ---
if nss_ok; then exit 0; fi
log "external DNS resolution FAILED — starting self-heal"

# --- 2. NSS must not route through a dead systemd-resolved stub ---
if ! grep -qE '^hosts:[[:space:]]+files dns' /etc/nsswitch.conf 2>/dev/null; then
  sed -i.bak-dnsselfheal 's/^hosts:.*/hosts:          files dns/' /etc/nsswitch.conf \
    && log "nsswitch hosts line -> 'files dns'"
fi

# --- 3. build candidate resolver list (VPN DNS first, then fallbacks) ---
cands=()
# ExpressVPN tunnel DNS — the .1 of its 100.64.x tunnel, classically 100.64.100.1
ip -4 addr show 2>/dev/null | grep -qE '100\.64\.' && cands+=(100.64.100.1)
# tun0 peer (the tunnel gateway), if a tun0 exists
tunpeer=$(ip -4 addr show tun0 2>/dev/null | grep -oE 'peer [0-9.]+' | awk '{print $2}' | head -1)
[ -n "${tunpeer:-}" ] && cands+=("$tunpeer")
# primary LAN gateway (for agents not on a DNS-hijacking VPN)
langw=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
[ -n "${langw:-}" ] && cands+=("$langw")
cands+=("${FALLBACK_DNS[@]}")

# --- 4. find a resolver that actually answers ---
working=""
for s in "${cands[@]}"; do
  if [ -n "$(query "$s" "${PROBE_HOSTS[0]}")" ]; then working="$s"; break; fi
done
if [ -z "$working" ]; then
  log "no working resolver among: ${cands[*]} — will retry next cycle"
  exit 1
fi

# --- 5. pin it into /etc/resolv.conf (handle the immutable flag) ---
chattr -i /etc/resolv.conf 2>/dev/null
{
  echo "# managed by dns-selfheal ($(date '+%F %T'))"
  echo "nameserver $working"
  for f in "${FALLBACK_DNS[@]}"; do [ "$f" != "$working" ] && echo "nameserver $f"; done
  echo "options timeout:2 attempts:2"
} > /etc/resolv.conf
chattr +i /etc/resolv.conf 2>/dev/null
log "pinned resolver $working into /etc/resolv.conf (immutable)"

# --- 6. verify ---
if nss_ok; then
  log "self-heal SUCCESS — external resolution restored via $working"
else
  log "self-heal applied ($working) but resolution still failing — will retry"
  exit 1
fi
