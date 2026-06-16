# dns-selfheal — autonomous DNS recovery for LANAgent agents

A systemd timer that lets an agent **repair its own DNS** without anyone reaching
in. Critical for agents whose only inbound path is a VPN tunnel: if name
resolution dies, you can't SSH in to fix it, so the box must self-heal.

## The problem it solves

Agents behind a VPN that hijacks port 53 (observed with **ExpressVPN**) end up
with only the VPN's own resolver (`100.64.100.1`) working, while the
systemd-resolved stub (`127.0.0.53`) is blackholed by the VPN's fwmark policy
routing. Every un-pinned hostname stops resolving — which silently breaks **web
scraping** (arbitrary domains → 90s timeouts / 504s) and **git auto-update**,
even though the agent looks healthy because the AI/gateway hosts are pinned in
`/etc/hosts`.

## What it does (only when resolution is actually broken)

1. Sets `/etc/nsswitch.conf` hosts line to `files dns` (bypass the dead stub).
2. Probes candidate resolvers — VPN DNS (`100.64.100.1`, tun0 peer) first, then
   the LAN gateway, then `1.1.1.1 / 8.8.8.8 / 9.9.9.9`.
3. Pins the first working resolver into `/etc/resolv.conf` and sets it immutable
   (`chattr +i`) so the VPN client can't clobber it.

On a healthy host it does nothing. It re-adapts automatically if the working
resolver changes (it only acts when resolution fails, then re-probes).

Logs to `/var/log/dns-selfheal.log`.

## Install (run as root on the agent)

```bash
# from a checkout of this repo on the agent, or scp these three files over:
install -m 0755 dns-selfheal.sh /usr/local/sbin/dns-selfheal.sh
install -m 0644 dns-selfheal.service /etc/systemd/system/dns-selfheal.service
install -m 0644 dns-selfheal.timer   /etc/systemd/system/dns-selfheal.timer
systemctl daemon-reload
systemctl enable --now dns-selfheal.timer

# verify
systemctl list-timers dns-selfheal.timer --no-pager
/usr/local/sbin/dns-selfheal.sh   # manual run; exits 0 silently if DNS is fine
```

Requires `dig` (dnsutils) or `nslookup` for probing — bundle in agent setup.

## Test the heal path safely

Reachability over a wg tunnel is IP-based, so breaking DNS will NOT lock you out:

```bash
chattr -i /etc/resolv.conf; echo 'nameserver 203.0.113.1' > /etc/resolv.conf  # blackhole
getent hosts cloudflare.com   # should FAIL now
/usr/local/sbin/dns-selfheal.sh
getent hosts cloudflare.com   # should resolve again; see /var/log/dns-selfheal.log
```
