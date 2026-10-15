#!/usr/bin/env bash
# Read-only survey of the WSL host before deploying something new.
#
#   host-probe.sh [SUBDOMAIN]
#
# Prints the sites Caddy serves (and which port each proxies to), the apps under
# ~/apps, listening ports, runtimes, and a free port suggestion. With SUBDOMAIN
# it also says whether <SUBDOMAIN>.contzo.lol is already taken. Changes nothing
# and never needs sudo.
set -uo pipefail

SUB="${1:-}"
BASE="contzo.lol"
RANGE_LO=7710
RANGE_HI=7799
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

sec() { printf '\n== %s\n' "$*"; }

sec "host"
. /etc/os-release 2>/dev/null && printf '%s, systemd %s, user %s\n' "$PRETTY_NAME" "$(systemctl --version | awk 'NR==1{print $2}')" "$(id -un)"
printf 'linger: %s\n' "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo '?')"

sec "Caddy sites (address -> upstream)"
caddy_files=(/etc/caddy/Caddyfile /etc/caddy/sites/*.caddy)
for f in "${caddy_files[@]}"; do
  [ -f "$f" ] || continue
  awk -v file="$f" '
    /^[^#[:space:]][^{]*\{[[:space:]]*$/ { site=$1; sub(/\{$/, "", site); up=""; next }
    site && /reverse_proxy/ { for (i=1;i<=NF;i++) if ($i ~ /:[0-9]+$/) up=$i }
    site && /redir/ { up="redirect" }
    site && /file_server/ { if (up=="") up="static files" }
    /^\}/ && site { printf "  %-34s %-22s %s\n", site, (up==""?"?":up), file; site="" }
  ' "$f"
done
grep -qxF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile 2>/dev/null \
  && echo "  (main Caddyfile imports /etc/caddy/sites/*.caddy)" \
  || echo "  (main Caddyfile does NOT import /etc/caddy/sites/*.caddy yet; deploy.sh --setup adds it)"

sec "apps in ~/apps"
for d in "$HOME"/apps/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  if [ -f "$d/.contzo-deploy" ]; then
    conf="$d/app.conf"
    sub="$(sed -n 's/^SUBDOMAIN="\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$conf" 2>/dev/null | head -n 1)"
    port="$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$conf" 2>/dev/null | head -n 1)"
    kind="$(sed -n 's/^KIND="\{0,1\}\([a-z]*\)"\{0,1\}.*/\1/p' "$conf" 2>/dev/null | head -n 1)"
    state="$(systemctl --user is-active "$name.service" 2>/dev/null || true)"
    printf '  %-14s contzo-deploy  %-26s %-7s port %-5s %s\n' "$name" "${sub:-?}.$BASE" "${kind:-?}" "${port:--}" "$state"
  else
    printf '  %-14s hand-made (do not touch; not managed by contzo-deploy)\n' "$name"
  fi
done
echo "  known hand-made: efacturi = contzo.lol (user units efacturi, efacturi-scheduler, :3333);"
echo "                   buildyboy = buildyboy.contzo.lol (system unit buildyboy, :7700)"

sec "listening TCP ports"
ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -n | uniq | tr '\n' ' '
echo

sec "free port suggestion (range $RANGE_LO-$RANGE_HI)"
used="$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/')"
used="$used $(cat /etc/caddy/Caddyfile /etc/caddy/sites/*.caddy 2>/dev/null | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2)"
used="$used $(cat "$HOME"/apps/*/app.conf 2>/dev/null | sed -n 's/^PORT=\([0-9]*\).*/\1/p')"
for ((p = RANGE_LO; p <= RANGE_HI; p++)); do
  if ! printf '%s\n' $used | grep -qx "$p"; then echo "  $p"; break; fi
done

if [ -n "$SUB" ]; then
  sec "is $SUB.$BASE free?"
  hit="$(grep -lE "^[[:space:]]*(https?://)?$SUB\.contzo\.lol([:, ]|\{|$)" "${caddy_files[@]}" 2>/dev/null || true)"
  if [ -n "$hit" ]; then echo "  TAKEN: served by $hit"; else echo "  free in Caddy"; fi
  [ -d "$HOME/apps/$SUB" ] && echo "  note: ~/apps/$SUB already exists"
  ip="$(getent ahostsv4 "$SUB.$BASE" | awk 'NR==1{print $1}')"
  case "$ip" in
    109.99.176.213) echo "  DNS from WSL: $ip (points here)" ;;
    86.35.3.*) echo "  DNS from WSL: no record ($ip is the ISP's answer for names that don't exist)" ;;
    "") echo "  DNS from WSL: does not resolve" ;;
    *) echo "  DNS from WSL: $ip (NOT this host)" ;;
  esac
fi

sec "runtimes"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u; . "$HOME/.nvm/nvm.sh"; set -u
  printf '  node %s (nvm default; installed: %s)\n' "$(node -v 2>/dev/null)" "$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tr '\n' ' ')"
fi
for b in pnpm yarn bun deno python3 uv pip3 go java php docker; do
  if command -v "$b" >/dev/null 2>&1; then printf '  %-8s %s\n' "$b" "$(command -v "$b")"; else printf '  %-8s -\n' "$b"; fi
done
python3 -c 'import ensurepip' 2>/dev/null && echo "  python3 venv: available" || echo "  python3 venv: missing (sudo apt install python3-venv, or install uv)"

sec "shared services"
for s in postgresql redis-server caddy; do printf '  %-14s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done
printf '  %-14s %s\n' "postgres" "$(psql --version 2>/dev/null | awk '{print $3}') on 127.0.0.1:5432"
echo "  redis          127.0.0.1:6379 (shared: use a key prefix or a separate db index)"

sec "disk"
df -h / | awk 'NR==2{print "  / " $4 " free"}'
