#!/bin/sh
# Moves this installation's data directory to a new home and switches the daemon to it. Run as root:
#
#     sudo deploy/relocate-zero.sh [/opt/zero/data]
#
# Before this runs, copy the bulk of the old directory to the new one while the daemon is up
# (`rsync -a --exclude thetis.sock <old>/ <new>/`), so the stop here only has the delta to copy.
# The daemon is down for the copy of that delta and the record migration: about a minute.
# The old directory is left untouched; `.env.bak` holds the previous THETIS_HOME line for a rollback.
set -eu

UNIT=thetis-runtime.service
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NEW=${1:-/opt/zero/data}
OWNER=$(stat -c %U "$ROOT/.env")
# Root's PATH has no node; the unit's ExecStart names the one the daemon runs, so use that one.
NODE=$(systemctl show -p ExecStart --value "$UNIT" 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
[ -x "$NODE" ] || NODE=$(sudo -u "$OWNER" sh -lc 'command -v node')
[ -x "$NODE" ] || { echo "no node binary found; set ExecStart or the owner's PATH"; exit 1; }
thetis() { (cd "$ROOT" && sudo -u "$OWNER" "$NODE" bin/thetis.js "$@"); }
OLD=$(cd "$ROOT" && sudo -u "$OWNER" sh -c '. ./.env >/dev/null 2>&1; printf %s "${THETIS_HOME:-.thetis}"')
case "$OLD" in /*) ;; *) OLD="$ROOT/$OLD" ;; esac

echo "stopping $UNIT"
systemctl stop "$UNIT"
# A run after a partial one finds .env already switched: skip the copy, still migrate and start.
if [ "$OLD" = "$NEW" ]; then
  echo "THETIS_HOME is already $NEW; migrating what is there"
else
  [ -d "$OLD" ] || { echo "no data directory at $OLD"; exit 1; }
  mkdir -p "$NEW"; chown "$OWNER":"$OWNER" "$NEW"
  echo "copying $OLD -> $NEW (delta)"
  rsync -a --delete --exclude thetis.sock "$OLD/" "$NEW/"
  chown -R "$OWNER":"$OWNER" "$NEW"
  echo "switching .env"
  cp "$ROOT/.env" "$ROOT/.env.bak"
  if grep -q '^THETIS_HOME=' "$ROOT/.env"; then sed -i "s|^THETIS_HOME=.*|THETIS_HOME=$NEW|" "$ROOT/.env"; else printf 'THETIS_HOME=%s\n' "$NEW" >> "$ROOT/.env"; fi
  chown "$OWNER":"$OWNER" "$ROOT/.env" "$ROOT/.env.bak"
fi
echo "migrating records"
thetis migrate
echo "starting $UNIT"
systemctl start "$UNIT"
sleep 3
thetis status || true
echo "login page:"
curl -s -o /dev/null -w '%{http_code}\n' --resolve zero.bitmuse.me:443:10.10.10.1 https://zero.bitmuse.me/login || true
echo "done: data at $NEW; rollback = restore .env.bak and restart $UNIT"
