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
OLD=$(cd "$ROOT" && sudo -u "$OWNER" sh -c '. ./.env >/dev/null 2>&1; printf %s "${THETIS_HOME:-.thetis}"')
case "$OLD" in /*) ;; *) OLD="$ROOT/$OLD" ;; esac

if [ "$OLD" = "$NEW" ]; then echo "THETIS_HOME is already $NEW"; exit 0; fi
[ -d "$OLD" ] || { echo "no data directory at $OLD"; exit 1; }
mkdir -p "$NEW"; chown "$OWNER":"$OWNER" "$NEW"

echo "stopping $UNIT"
systemctl stop "$UNIT"
echo "copying $OLD -> $NEW (delta)"
rsync -a --delete --exclude thetis.sock "$OLD/" "$NEW/"
chown -R "$OWNER":"$OWNER" "$NEW"
echo "switching .env"
cp "$ROOT/.env" "$ROOT/.env.bak"
if grep -q '^THETIS_HOME=' "$ROOT/.env"; then sed -i "s|^THETIS_HOME=.*|THETIS_HOME=$NEW|" "$ROOT/.env"; else printf 'THETIS_HOME=%s\n' "$NEW" >> "$ROOT/.env"; fi
chown "$OWNER":"$OWNER" "$ROOT/.env" "$ROOT/.env.bak"
echo "migrating records"
(cd "$ROOT" && sudo -u "$OWNER" node bin/thetis.js migrate)
echo "starting $UNIT"
systemctl start "$UNIT"
sleep 3
(cd "$ROOT" && sudo -u "$OWNER" node bin/thetis.js status) || true
echo "login page:"
curl -s -o /dev/null -w '%{http_code}\n' --resolve zero.bitmuse.me:443:10.10.10.1 https://zero.bitmuse.me/login || true
echo "done: data at $NEW; rollback = restore .env.bak and restart $UNIT"
