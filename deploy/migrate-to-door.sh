#!/bin/sh
# HISTORICAL: this ran once on 2026-09-14 and is kept for the record. Line 7 copies the unit template with
# its placeholder paths over the deployed unit, which breaks a current installation on its next restart;
# deploy/install.sh is what installs or updates a unit now.
# One-time migration of a running deployment to the door: the unit gains Delegate=yes, the login target
# moves into the system userspace, and each person gets their own web gateway. Run from the runtime
# directory as the operator. The config must already name the door and the login target (09-configuration.md).
set -eu
sudo cp deploy/thetis-runtime.service /etc/systemd/system/thetis-runtime.service
sudo systemctl daemon-reload
sudo systemctl restart thetis-runtime.service
sleep 5
node bin/thetis.js packages uninstall @thetis/gateway-web || true          # the old gateway in the system userspace
node bin/thetis.js packages install @thetis/gateway-login                   # into the system userspace
for user in $(node bin/thetis.js users list | awk '$2 != "system" { print $1 }'); do
  node bin/thetis.js packages install @thetis/gateway-web --user "$user"   # one gateway per existing person
done
sudo journalctl -u thetis-runtime.service --since "1 min ago" --no-pager | grep -E "fence\]|serving|login on|door on|resource limits"
