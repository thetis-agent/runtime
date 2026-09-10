#!/usr/bin/env bash
# ADR 0005, ADR 0012, ADR 0029: provision an ephemeral VM, never weaken the runner.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
sudo apt-get update
sudo apt-get install --yes --no-install-recommends bubblewrap slirp4netns util-linux dbus-user-session jq tar gzip

# Ubuntu's host policy otherwise denies nested unprivileged namespaces. This VM
# is discarded after the job; bubblewrap's grants and isolation remain mandatory.
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
if [[ -f /proc/sys/kernel/unprivileged_userns_clone ]]; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi
sudo modprobe tun
[[ -c /dev/net/tun ]]
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/thetis-ci.conf
sudo systemctl daemon-reload
sudo loginctl enable-linger "$(id -un)"
runner_uid=$(id -u)
sudo systemctl start "user@$runner_uid.service"
export XDG_RUNTIME_DIR="/run/user/$runner_uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
printf 'XDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]]
systemd-run --user --scope --quiet -p Delegate=yes /usr/bin/true
bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev -- /bin/true
mkdir -p reports
{
  node --version
  npm --version
  uname -srmo
  dpkg-query -W bubblewrap slirp4netns util-linux systemd tar gzip
  sha256sum /usr/bin/bwrap /usr/bin/slirp4netns /usr/bin/unshare /usr/bin/systemd-run /usr/bin/tar /usr/bin/gzip
} > reports/platform.txt
