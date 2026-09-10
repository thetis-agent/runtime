#!/usr/bin/env bash
# Exercise actual root provisioning, credential delivery and a different service uid on an ephemeral runner.
# Reports intentionally remain owned by the invoking runner, not by sudo.
# shellcheck disable=SC2024
set -euo pipefail
reports=$(realpath "${1:?Provide the reports directory}")
prefix=/opt/thetis-ci
state=/var/lib/tci
for target in "$prefix" "$state" "$state.img" /etc/thetis-ci /etc/systemd/system/thetis-ci.service /etc/systemd/system/thetis-ci-update.service /etc/systemd/system/thetis-ci-update.timer /etc/systemd/system/var-lib-tci.mount; do
  if sudo -n test -e "$target" || sudo -n test -L "$target"; then
    printf 'Refusing to overwrite smoke-test resource: %s\n' "$target" >&2
    exit 1
  fi
done
if id thetis-ci >/dev/null 2>&1; then printf 'The smoke-test account already exists.\n' >&2; exit 1; fi
fixture=$(mktemp -d "${RUNNER_TEMP:-/tmp}/thetis-install-smoke.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT
  sudo -n journalctl -u thetis-ci.service --no-pager -n 150 > "$reports/install-service.log" || true
  if sudo -n test -f "$prefix/etc/install.json"; then
    if ! sudo -n sh install.sh --prefix "$prefix" --uninstall --purge-state > "$reports/install-uninstall.log" 2>&1; then status=1; fi
  fi
  sudo -n rmdir /etc/thetis-ci 2>/dev/null || true
  rm -rf -- "$fixture"
  exit "$status"
}
trap cleanup EXIT
node --import ./lib/artifacts/source.mjs scripts/installer-fixture.ts "$fixture"
printf 'smoke-test-password\n' > "$fixture/password"
chmod 0600 "$fixture/password"
# sudo normally closes inherited descriptors; open the password only inside its root shell.
sudo -n sh -c 'exec 3<"$1/password"; exec sh install.sh --prefix /opt/thetis-ci --state /var/lib/tci --service-name thetis-ci --user thetis-ci --operator smoke --origin https://thetis-ci.invalid --password-fd 3 --yes --demo --release v0.1.0 --release-url "file://$1/published" --remote "file://$1/runtime.git" --node-url "file://$1/published/node" --allowed-signers "$1/published/allowed_signers"' sh "$fixture" > "$reports/install-provision.log" 2>&1
sudo -n "$prefix/bin/thetis" status | tee "$reports/install-status.log"
sudo -n "$prefix/bin/thetis" chat --message 'Hello from the system service' | tee "$reports/install-chat.log"
grep -q 'Hello\.' "$reports/install-chat.log"
sudo -n systemctl restart thetis-ci.service
ready=0
for ((attempt=0; attempt<120; attempt++)); do
  if sudo -n "$prefix/bin/thetis" status > "$reports/install-restart.log" 2>&1; then ready=1; break; fi
  if sudo -n systemctl is-failed --quiet thetis-ci.service; then break; fi
  sleep 1
done
[[ "$ready" == 1 ]]
sudo -n "$prefix/bin/thetis" chat --message 'Hello after restart' | tee "$reports/install-chat-restart.log"
grep -q 'Hello\.' "$reports/install-chat-restart.log"
