#!/bin/sh
# The agent's router access (LANAgent router plugin): the only commands the agent sends to the router run through this
# script. Reads: clients, leases, reservations, security, backups. Writes: DHCP reservations (nvram dhcp_staticlist,
# each value checked, then dnsmasq restarted); and, on the owner's confirmed request, a settings restore, the
# firmware's own upgrade, a reboot. Every write is logged to /jffs/agent/changes.log.
set -u
CMD="${SSH_ORIGINAL_COMMAND:-${*:-}}"
set -- $CMD
op="${1:-help}"; shift 2>/dev/null || true
LAN="$(nvram get lan_ipaddr | cut -d. -f1-3)"
LANRE="$(echo "$LAN" | sed 's/\./\\./g')"
LOG=/jffs/agent/changes.log
up() { echo "$1" | tr 'a-f' 'A-F'; }
mac_ok() { echo "$1" | grep -Eq '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$'; }
ip_ok() { echo "$1" | grep -Eq "^${LANRE}\.([2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$"; }
name_ok() { echo "$1" | grep -Eq '^[A-Za-z0-9._-]{0,32}$'; }
list() { nvram get dhcp_staticlist | tr '<' '\n' | grep -v '^$'; }
lock() { mkdir /tmp/agent-router.lock 2>/dev/null || { echo "ERR busy"; exit 1; }; trap 'rmdir /tmp/agent-router.lock' EXIT; }
save() {  # $1 = new list (one entry per line, no '<')
  new="$(echo "$1" | grep -v '^$' | sed 's/^/</' | tr -d '\n')"
  nvram set dhcp_staticlist="$new"; nvram commit
  service restart_dnsmasq >/dev/null 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') $op $*" >> "$LOG"
}
case "$op" in
  reservations) list | awk -F'>' '{print $1, $2, $4}' ;;
  leases) cat /var/lib/misc/dnsmasq.leases 2>/dev/null | awk '{print $2, $3, $4}' ;;
  clients)
    for i in $(nvram get wl_ifnames) $(nvram get wl0_vifs) $(nvram get wl1_vifs); do
      for m in $(wl -i "$i" assoclist 2>/dev/null | awk '{print $2}'); do
        echo "wifi $i $m rssi=$(wl -i "$i" rssi "$m" 2>/dev/null)"; done; done
    cat /proc/net/arp | awk 'NR>1 && $3!="0x0" {print "arp", $6, $4, $1}' ;;
  security)
    for k in firmver buildno extendno wl0_auth_mode_x wl1_auth_mode_x wl0_crypto wl1_crypto wl0_mfp wl1_mfp wps_enable \
      wl0.1_bss_enabled wl1.1_bss_enabled misc_http_x misc_httpsport_x http_enable sshd_enable sshd_pass telnetd_enable \
      upnp_enable vts_enable_x ddns_enable_x fw_enable_x fw_dos_x wan_dns ipv6_service; do echo "$k=$(nvram get $k)"; done
    echo "port_forwards=$(nvram get vts_rulelist | tr '<' '\n' | grep -vc '^$')" ;;
  add)   # add MAC IP [NAME]
    m="$(up "${1:-}")"; ip="${2:-}"; n="${3:-}"
    mac_ok "$m" && ip_ok "$ip" && name_ok "$n" || { echo "ERR bad mac, ip or name"; exit 2; }
    lock; L="$(list)"
    echo "$L" | grep -qi "^$m>" && { echo "ERR mac already reserved"; exit 3; }
    echo "$L" | grep -q ">$ip>" && { echo "ERR ip already reserved"; exit 3; }
    save "$L
$m>$ip>>$n" "$m $ip $n"; echo "OK added $m $ip $n" ;;
  remove)  # remove MAC
    m="$(up "${1:-}")"; mac_ok "$m" || { echo "ERR bad mac"; exit 2; }
    lock; L="$(list)"; echo "$L" | grep -qi "^$m>" || { echo "ERR not reserved"; exit 3; }
    save "$(echo "$L" | grep -vi "^$m>")" "$m"; echo "OK removed $m" ;;
  replace)  # replace OLDMAC NEWMAC: the new device takes the old one's IP and name
    o="$(up "${1:-}")"; m="$(up "${2:-}")"
    mac_ok "$o" && mac_ok "$m" || { echo "ERR bad mac"; exit 2; }
    lock; L="$(list)"; row="$(echo "$L" | grep -i "^$o>")"
    [ -n "$row" ] || { echo "ERR old mac not reserved"; exit 3; }
    echo "$L" | grep -qi "^$m>" && { echo "ERR new mac already reserved"; exit 3; }
    rest="${row#*>}"
    save "$(echo "$L" | grep -vi "^$o>")
$m>$rest" "$o $m"; echo "OK replaced $o with $m at ${rest%%>*}" ;;
  changes) tail -n 50 "$LOG" 2>/dev/null ;;
  backup-nvram)  # the settings, as the web UI's Save setting file (restorable on this model)
    nvram save /tmp/agent-backup.cfg >/dev/null 2>&1 && cat /tmp/agent-backup.cfg; rm -f /tmp/agent-backup.cfg
    echo "$(date '+%Y-%m-%d %H:%M:%S') backup-nvram" >> "$LOG" ;;
  backup-jffs) tar -czf - -C /jffs . 2>/dev/null ;;
  restore)  # a settings file on stdin, then the router restarts
    lock; cat > /tmp/agent-restore.cfg; [ -s /tmp/agent-restore.cfg ] || { echo "ERR empty settings file"; exit 2; }
    nvram restore /tmp/agent-restore.cfg >/dev/null 2>&1 || { echo "ERR restore failed"; exit 3; }
    echo "$(date '+%Y-%m-%d %H:%M:%S') restore (then reboot)" >> "$LOG"
    (sleep 3; service reboot) >/dev/null 2>&1 &
    echo "OK restored, rebooting" ;;
  fw-check)
    webs_update.sh >/dev/null 2>&1
    echo "flag=$(nvram get webs_state_flag) available=$(nvram get webs_state_info) current=$(nvram get buildno)_$(nvram get extendno)" ;;
  fw-upgrade)  # the firmware's own upgrade (downloads and checks the signed image, flashes, restarts)
    f="$(nvram get webs_state_flag)"; [ "$f" = "1" ] || [ "$f" = "2" ] || { echo "ERR no update available (flag $f)"; exit 3; }
    echo "$(date '+%Y-%m-%d %H:%M:%S') fw-upgrade to $(nvram get webs_state_info)" >> "$LOG"
    service start_webs_upgrade >/dev/null 2>&1
    echo "OK upgrade started to $(nvram get webs_state_info)" ;;
  reboot)
    echo "$(date '+%Y-%m-%d %H:%M:%S') reboot" >> "$LOG"
    (sleep 3; service reboot) >/dev/null 2>&1 &
    echo "OK rebooting" ;;
  *) echo "commands: reservations | leases | clients | security | changes | add MAC IP [NAME] | remove MAC | replace OLDMAC NEWMAC | backup-nvram | backup-jffs | restore (file on stdin) | fw-check | fw-upgrade | reboot" ;;
esac
