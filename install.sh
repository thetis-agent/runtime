#!/bin/sh
# Stand up a supervised Zero kernel service from a signed release, verifying every byte before
# anything is written and printing every privileged step; ADR 0048, ADR 0049, ADR 0050.
# POSIX sh (dash): no pipefail, so every pipe writes to a file and its status is checked.
set -eu

ZERO_REPO='https://github.com/thetis-agent/runtime'
ZERO_TAG='v0.1.0'
ZERO_SIGNER='release@thetis-agent'
ZERO_NAMESPACE='zero-release'
# The one-liner's trust root is this script and its pins. Rotation ships a new line here,
# in a release signed with the key being retired (docs/ci-delivery.md).
ZERO_ALLOWED_SIGNERS='release@thetis-agent namespaces="zero-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderUntilTheFirstReleaseIsCut'
STATE_ROOT_LIMIT=18
PASSWORD_MINIMUM=12
SYSTEMD_MINIMUM=252
DEFAULT_STATE_SIZE=4294967296
ASSETS='thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json SHA256SUMS SHA256SUMS.sig'
SIGNED_ASSETS=8

prefix='/opt/zero'
state='/var/lib/z'
state_size=''
state_layout='one'
no_mount=0
service='system'
service_user='zero'
operator=''
password_fd=''
origin=''
auto_update='none'
key_store='file'
release=''
release_url=''
remote=''
allowed_signers=''
assume_yes=0
dry_run=0
do_uninstall=0
purge_state=0
allow_root=0
print_unit=''

die() { printf '%s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

usage() {
  cat <<'EOF'
Usage: install.sh [flags]

  --prefix <dir>             Code prefix (default /opt/zero)
  --state <dir>              State volume root (default /var/lib/z)
  --state-size <bytes>       Size of the provisioned state volume (default 4294967296)
  --state-layout one|split   One volume, or a second small volume for the seed root
  --no-mount                 Use an existing bounded mountpoint instead of provisioning one
  --service system|user|none Run as a system service, a user service, or in the foreground
  --user <name>              Service account for --service system (default zero)
  --operator <id>            Administrator account id (default admin, or prompted)
  --password-fd <n>          Read the administrator password from this open descriptor
  --origin <url>             Public origin for the sign-in line and the proxy rules
  --auto-update none         Update policy; only none is accepted (ADR 0049)
  --key-store file|tpm2      Where the kernel master key is held
  --release <tag>            Release tag to install (default the tag this script pins)
  --release-url <url>        Base assets are read from at <url>/<tag>/<asset>
  --remote <url>             Git remote release tags are read from (https:// or file://)
  --allowed-signers <path>   allowed_signers file trusted for the release signature
  --yes                      Do not prompt; a password source is then required
  --dry-run                  Print every privileged step and write nothing
  --uninstall                Remove the installed prefix
  --purge-state              With --uninstall, also remove the state volume's contents
  --allow-root               Permit running as root under sudo from a login shell
  --print-unit <name>        Print one embedded unit template and exit
  --help                     Show this text
EOF
}

# --- embedded units: the authoritative text, copied for review under units/ (ADR 0048) --------
unit_zero_service() {
  cat <<'EOF'
# ADR 0048: the service runs the supervisor, never kernel/main.ts, so every later kernel start
# is a GN-007 transaction rather than a restart outside the generation machine.
[Unit]
Description=Zero kernel supervisor
RequiresMountsFor=@STATE@
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=@USER@
Group=@USER@
Delegate=yes
LoadCredential=master:/etc/zero/master.key
ExecStart=/bin/sh -c 'exec @PREFIX@/node/current/bin/node --max-old-space-size=32 --max-semi-space-size=1 --no-experimental-strip-types --import @PREFIX@/current/lib/artifacts/register.mjs @PREFIX@/current/kernel/supervisor-main.ts @PREFIX@/etc/seed.json --release @PREFIX@/current --state @STATE@ --credential "$CREDENTIALS_DIRECTORY/master" --delegate'
KillMode=mixed
TimeoutStopSec=90
MemoryMax=2G
TasksMax=512
DeviceAllow=/dev/net/tun rw
ProtectSystem=strict
ReadWritePaths=@STATE@
ProtectHome=yes
NoNewPrivileges=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF
}

unit_zero_update_service() {
  cat <<'EOF'
# ADR 0048: the timer only checks, stages and verifies; an administrator applies. ADR 0049 holds
# every update policy but none refused, so this unit never changes the kernel.
[Unit]
Description=Zero update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=@USER@
Group=@USER@
ExecStart=@PREFIX@/bin/zero update --check
ProtectSystem=strict
ReadWritePaths=@PREFIX@/releases @STATE@/updates
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
PrivateDevices=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M
TimeoutStartSec=15min
EOF
}

unit_zero_update_timer() {
  cat <<'EOF'
[Unit]
Description=Zero update check

[Timer]
OnCalendar=hourly
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

unit_state_mount() {
  cat <<'EOF'
# ADR 0048 D7: the state volume's enforced capacity is the deployment's declared quota, which is
# what lib/sandbox-runner/index.ts compares against statfs.
[Unit]
Description=Zero state volume

[Mount]
What=@STATE@.img
Where=@STATE@
Type=ext4
Options=loop,nosuid,nodev,noexec

[Install]
WantedBy=multi-user.target
EOF
}

unit_text() {
  case "$1" in
    zero.service) unit_zero_service ;;
    zero-update.service) unit_zero_update_service ;;
    zero-update.timer) unit_zero_update_timer ;;
    state.mount) unit_state_mount ;;
    *) die "There is no embedded unit named $1." ;;
  esac
}

# --- arguments ---------------------------------------------------------------------------------
need_value() { [ $# -ge 2 ] || die "The flag $1 needs a value."; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --help) usage; exit 0 ;;
      --no-mount) no_mount=1; shift ;;
      --yes) assume_yes=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      --uninstall) do_uninstall=1; shift ;;
      --purge-state) purge_state=1; shift ;;
      --allow-root) allow_root=1; shift ;;
      --prefix) need_value "$@"; prefix=$2; shift 2 ;;
      --state) need_value "$@"; state=$2; shift 2 ;;
      --state-size) need_value "$@"; state_size=$2; shift 2 ;;
      --state-layout) need_value "$@"; state_layout=$2; shift 2 ;;
      --service) need_value "$@"; service=$2; shift 2 ;;
      --user) need_value "$@"; service_user=$2; shift 2 ;;
      --operator) need_value "$@"; operator=$2; shift 2 ;;
      --password-fd) need_value "$@"; password_fd=$2; shift 2 ;;
      --origin) need_value "$@"; origin=$2; shift 2 ;;
      --auto-update) need_value "$@"; auto_update=$2; shift 2 ;;
      --key-store) need_value "$@"; key_store=$2; shift 2 ;;
      --release) need_value "$@"; release=$2; shift 2 ;;
      --release-url) need_value "$@"; release_url=$2; shift 2 ;;
      --remote) need_value "$@"; remote=$2; shift 2 ;;
      --allowed-signers) need_value "$@"; allowed_signers=$2; shift 2 ;;
      --print-unit) need_value "$@"; print_unit=$2; shift 2 ;;
      *) die "Unknown flag $1." ;;
    esac
  done
}

validate_args() {
  [ -n "$release" ] || release=$ZERO_TAG
  [ -n "$release_url" ] || release_url="${ZERO_REPO}/releases/download"
  [ -n "$remote" ] || remote="${ZERO_REPO}.git"
  case "$state_layout" in one|split) ;; *) die 'The --state-layout value is one or split.' ;; esac
  case "$service" in system|user|none) ;; *) die 'The --service value is system, user or none.' ;; esac
  case "$key_store" in file|tpm2) ;; *) die 'The --key-store value is file or tpm2.' ;; esac
  case "$auto_update" in
    none) ;;
    fixes|improvements) die "An update policy of $auto_update pre-authorises the kernel maintenance command and stays refused until the operator accepts ADR 0049." ;;
    *) die "The --auto-update value $auto_update is not a policy; ADR 0049 accepts only none." ;;
  esac
  case "$remote" in https://*|file://*) ;; *) die 'The --remote value starts with https:// or file://.' ;; esac
  case "$release_url" in https://*|file://*) ;; *) die 'The --release-url value starts with https:// or file://.' ;; esac
  case "$release" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die 'The --release value is a vMAJOR.MINOR.PATCH tag.' ;; esac
  case "$password_fd" in ''|[0-9]|[0-9][0-9]) ;; *) die 'The --password-fd value is a small non-negative descriptor number.' ;; esac
  [ "$do_uninstall" = 1 ] && return 0
  [ -z "$allowed_signers" ] || [ -f "$allowed_signers" ] || die 'The --allowed-signers path does not name a file.'
  [ -n "$origin" ] || die 'A fresh install needs --origin <url>.'
  return 0
}

validate_state_root() {
  bytes=$(printf '%s/g' "$state" | wc -c)
  [ "$bytes" -le "$STATE_ROOT_LIMIT" ] || \
    die "A state root whose generation store path exceeds ${STATE_ROOT_LIMIT} bytes pushes a supervised target endpoint past the Linux socket path limit."
}

# --- preflight ---------------------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "This installer needs $1 on PATH."; }

preflight_root() {
  [ "$allow_root" = 1 ] && return 0
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die 'Do not run this installer with sudo from a login shell; pass --allow-root if you meant to.'
  fi
  return 0
}

preflight_host() {
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "This installer supports x86_64 and aarch64, not $(uname -m)." ;; esac
  for tool in sh tar gzip sha256sum ssh-keygen git flock; do need "$tool"; done
  [ "$no_mount" = 1 ] || { need fallocate; need mkfs.ext4; }
  [ "$service" = none ] || need systemctl
  hierarchy=$( [ "$service" = none ] && printf '%s' "$cgroup_path" || printf '/sys/fs/cgroup' )
  [ "$(stat -f -c %T "$hierarchy" 2>/dev/null || echo none)" = cgroup2fs ] || die "This installer needs a cgroup v2 unified hierarchy at $hierarchy."
  need bwrap
  bwrap --unshare-user --ro-bind / / -- /bin/true >/dev/null 2>&1 || die 'This installer needs bubblewrap with working unprivileged user namespaces.'
  [ -c /dev/net/tun ] || die 'This installer needs /dev/net/tun for any target with network egress.'
  if [ "$service" != none ]; then
    version=$(systemctl --version 2>/dev/null | head -n1 | cut -d' ' -f2)
    case "$version" in ''|*[!0-9]*) die 'The installed systemd version could not be read.' ;; esac
    [ "$version" -ge "$SYSTEMD_MINIMUM" ] || die "This installer needs systemd ${SYSTEMD_MINIMUM} or newer for service credentials."
  fi
}

# --- administrator credential (never on argv, in the environment, or in any log) ---------------
operator_id='admin'
password_value=''

resolve_operator() {
  if [ -n "$operator" ]; then operator_id=$operator
  elif [ "$assume_yes" = 0 ] && [ -c /dev/tty ]; then
    printf 'Administrator account id [admin]: ' > /dev/tty
    IFS= read -r answer < /dev/tty || answer=''
    [ -n "$answer" ] && operator_id=$answer
  fi
  case "$operator_id" in *[!A-Za-z0-9_-]*|'') die 'An administrator account id is letters, digits, underscores and dashes.' ;; esac
}

read_password_twice() {
  [ -c /dev/tty ] || die 'A password needs --password-fd when no terminal is attached.'
  stty -F /dev/tty -echo 2>/dev/null || true
  printf 'Administrator password: ' > /dev/tty
  IFS= read -r first < /dev/tty || first=''
  printf '\nConfirm password: ' > /dev/tty
  IFS= read -r second < /dev/tty || second=''
  printf '\n' > /dev/tty
  stty -F /dev/tty echo 2>/dev/null || true
  [ "$first" = "$second" ] || die 'The two password entries did not match.'
  password_value=$first
}

resolve_password() {
  if [ -n "$password_fd" ]; then
    # dash cannot expand a variable in a redirection target, so the read is built and evaluated.
    eval "IFS= read -r password_value <&$password_fd" || die 'The administrator password descriptor could not be read.'
  elif [ "$assume_yes" = 1 ]; then
    die 'With --yes an administrator password source is required; pass --password-fd. There is no default password.'
  else
    read_password_twice
  fi
  bytes=$(printf '%s' "$password_value" | wc -c)
  [ "$bytes" -ge "$PASSWORD_MINIMUM" ] || die "An administrator password is at least ${PASSWORD_MINIMUM} characters."
}

# --- privileged steps: --dry-run prints them, in order, and writes nothing ---------------------
step() {
  if [ "$dry_run" = 1 ]; then printf '%s\n' "$1"; else eval "$1"; fi
}

privileged_plan() {
  say "useradd --system --home-dir $state --shell /usr/sbin/nologin $service_user"
  if [ "$no_mount" = 0 ]; then
    say "fallocate -l ${state_size:-$DEFAULT_STATE_SIZE} ${state}.img"
    say "mkfs.ext4 -q -m 0 -L zero-state ${state}.img"
    say "install -d -m 0700 $state"
    say "systemctl enable --now $(mount_unit_name)"
  fi
  say "install -d -o root -g $service_user -m 0750 $prefix"
  say "install -d -o root -g root -m 0700 /etc/zero"
  say "head -c 32 /dev/urandom > /etc/zero/master.key"
  say "chmod 0400 /etc/zero/master.key"
  say 'write accounts.json (1 account)'
  say "write /etc/systemd/system/zero.service"
  say "write /etc/systemd/system/zero-update.service"
  say "write /etc/systemd/system/zero-update.timer"
  say 'systemctl daemon-reload'
  say 'systemctl enable --now zero.service'
  say 'systemctl enable --now zero-update.timer'
}

mount_unit_name() { printf '%s' "$(printf '%s' "${state#/}" | tr '/' '-').mount"; }

# --- fetch and verify: nothing is written under the prefix until every check passes ------------
fetch_one() {
  case "$1" in
    file://*) [ -f "${1#file://}" ] || die "The release asset $(basename "$2") is missing at its remote."; cp "${1#file://}" "$2" ;;
    https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --connect-timeout 10 --max-time 300 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
      else die 'This installer needs curl or wget to read an https release.'
      fi ;;
    *) die "The release asset URL $1 has an unsupported scheme." ;;
  esac
}

fetch_release() {
  for name in $ASSETS; do fetch_one "${release_url%/}/${release}/${name}" "$1/$name"; done
}

verify_asset_list() {
  count=$(wc -l < "$1/SHA256SUMS")
  [ "$count" -eq "$SIGNED_ASSETS" ] || die "SHA256SUMS does not list exactly the ${SIGNED_ASSETS} expected release assets."
  grep -Evq '^[a-f0-9]{64} [ *][A-Za-z0-9._-]+$' "$1/SHA256SUMS" && die 'SHA256SUMS carries a line that is not a lowercase 64-hex digest and an asset name.'
  return 0
}

verify_signature() {
  ( cd "$1" && ssh-keygen -Y verify -f "$signers" -I "$ZERO_SIGNER" -n "$ZERO_NAMESPACE" -s SHA256SUMS.sig < SHA256SUMS >/dev/null 2>&1 ) \
    || die 'The release SHA256SUMS signature could not be verified against the allowed signer.'
}

verify_hashes() {
  ( cd "$1" && sha256sum --check --strict --status SHA256SUMS ) \
    || die 'The release assets do not match their signed SHA256SUMS checksums.'
}

verify_commit() {
  commit=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{40\}\)".*/\1/p' "$1/provenance.json" | head -n1)
  [ -n "$commit" ] || die 'The release provenance carries no runtime commit.'
  refs="$1/refs.txt"
  git ls-remote --tags "$remote" "refs/tags/$release" "refs/tags/$release^{}" > "$refs" 2>/dev/null \
    || die "The release tag $release could not be resolved at $remote, so its provenance cannot be bound to it."
  peeled=$(sed -n 's/^\([a-f0-9]\{40\}\)[[:space:]].*\^{}$/\1/p' "$refs" | head -n1)
  [ -n "$peeled" ] || peeled=$(sed -n 's/^\([a-f0-9]\{40\}\)[[:space:]].*/\1/p' "$refs" | head -n1)
  [ -n "$peeled" ] || die "The release tag $release does not exist at $remote."
  [ "$peeled" = "$commit" ] || die "The release provenance names a different commit than tag $release at $remote."
}

verify_pins() {
  "$node_bin" --no-experimental-strip-types --import "file://$2/lib/artifacts/register.mjs" --input-type=module \
    -e 'const [module, pins, root] = process.argv.slice(1);
const { verifyPins } = await import(module);
const { readFileSync } = await import("node:fs");
const result = await verifyPins(root, JSON.parse(readFileSync(`${pins}/kernel-pins.json`, "utf8")).pins);
if (!result.ok) { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; }' \
    "file://$2/lib/update/verify.ts" "$1" "$2" \
    || die 'The extracted release does not match the kernel pin hashes it published.'
}

# --- node: the release names its own runtime, and the artifacts refuse any other ---------------
resolve_node() {
  want=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\(v[0-9.]*\)".*/\1/p' "$1/provenance.json" | head -n1)
  [ -n "$want" ] || die 'The release provenance names no Node version.'
  node_bin=$(command -v node 2>/dev/null || true)
  [ -n "$node_bin" ] || die "This installer needs Node $want on PATH; the release's execution artifacts refuse any other runtime."
  have=$("$node_bin" --version)
  [ "$have" = "$want" ] || die "This release needs Node $want and $have is on PATH; the release's execution artifacts refuse any other runtime."
  node_version=$want
  node_root=$(dirname "$(dirname "$node_bin")")
}

install_node() {
  mkdir -p "$prefix/node"
  [ -d "$prefix/node/$node_version" ] || cp -R "$node_root" "$prefix/node/$node_version"
  ln -sfn "$node_version" "$prefix/node/current"
  say "Node $node_version was copied from $node_root; this release's own tarball hash was not downloaded and checked."
}

# --- layout and configuration ------------------------------------------------------------------
already_installed() { [ -f "$prefix/releases/$release/.installed" ]; }

write_bin_zero() {
  mkdir -p "$prefix/bin"
  cat > "$prefix/bin/zero" <<SH
#!/bin/sh
exec "$prefix/node/current/bin/node" --no-experimental-strip-types \\
  --import "$prefix/current/lib/artifacts/register.mjs" \\
  "$prefix/current/lib/update/main.ts" --prefix "$prefix" "\$@"
SH
  chmod 0755 "$prefix/bin/zero"
}

state_capacity() {
  blocks=$(stat -f -c %b "$state"); size=$(stat -f -c %S "$state")
  printf '%s' "$((blocks * size))"
}

state_dirs() {
  for name in kernel supervisor g registry cache profile discovery initial "spaces/$operator_id" login-state updates; do
    mkdir -p "$state/$name"
  done
  chmod 0700 "$state"; chmod 0755 "$state/updates"
  [ -d "$state/registry/objects" ] || ( cd "$state/registry" && git init --bare -q . )
}

write_installation() {
  "$node_bin" --no-experimental-strip-types --import "file://$1/lib/artifacts/register.mjs" \
    "$1/lib/update/seed.ts" --release "$1" --state "$state" --prefix "$prefix" --cgroup "$cgroup_path" \
    --operator "$operator_id" --origin "$origin" --quota "$quota_bytes" >/dev/null \
    || die 'The installation recipe and seed could not be written from the release sources.'
}

write_accounts() {
  printf '%s' "$password_value" | "$node_bin" --no-experimental-strip-types \
    --import "file://$1/lib/artifacts/register.mjs" --input-type=module \
    -e 'const [module, id] = process.argv.slice(1);
const { credential } = await import(module);
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const record = await credential(id, Buffer.concat(chunks).toString("utf8"));
if (!record.ok) { process.stderr.write(`${record.error.message}\n`); process.exit(1); }
process.stdout.write(`${JSON.stringify({ version: 1, accounts: [record.value] })}\n`);' \
    "file://$1/packages/gateway-login/password.ts" "$operator_id" > "$state/login-state/accounts.json" \
    || die 'The administrator account record could not be derived.'
  chmod 0600 "$state/login-state/accounts.json"
}

write_install_json() {
  cat > "$prefix/etc/install.json" <<JSON
{"version":1,"prefix":"$prefix","state":"$state","release":"$release","remote":"$remote","releaseUrl":"$release_url","allowedSigners":"$prefix/etc/allowed_signers","signer":"$ZERO_SIGNER","policy":"$auto_update","origin":"$origin","operator":"$operator_id","login":"login","service":"$service"}
JSON
  chmod 0644 "$prefix/etc/install.json"
}

layout_release() {
  mkdir -p "$prefix/releases" "$prefix/etc"
  rm -rf "$prefix/releases/$release"
  cp -R "$1" "$prefix/releases/$release"
  ln -sfn "releases/$release" "$prefix/current"
  cp "$signers" "$prefix/etc/allowed_signers"
}

# --- provisioning: the volume first, so nothing is written under a mountpoint later ------------
provision_volume() {
  if [ "$no_mount" = 1 ]; then
    [ -d "$state" ] || step "install -d -m 0700 $state"
    return 0
  fi
  step "fallocate -l ${state_size:-$DEFAULT_STATE_SIZE} ${state}.img"
  step "mkfs.ext4 -q -m 0 -L zero-state ${state}.img"
  step "install -d -m 0700 $state"
  write_unit "state.mount" "/etc/systemd/system/$(mount_unit_name)"
  step 'systemctl daemon-reload'
  step "systemctl enable --now $(mount_unit_name)"
}

provision_user() {
  [ "$service" = system ] || return 0
  id "$service_user" >/dev/null 2>&1 && return 0
  step "useradd --system --home-dir $state --shell /usr/sbin/nologin $service_user"
}

provision_key() {
  if [ "$service" = none ]; then
    # A foreground install has no separate service account, so the separation a root-only key
    # buys is absent; the key sits beside the code for tests and containers only (ADR 0048).
    credential_path="$prefix/etc/master.key"
    head -c 32 /dev/urandom > "$credential_path"; chmod 0600 "$credential_path"
    return 0
  fi
  credential_path=/etc/zero/master.key
  step 'install -d -o root -g root -m 0700 /etc/zero'
  if [ "$key_store" = tpm2 ]; then
    step 'head -c 32 /dev/urandom | systemd-creds encrypt --with-key=tpm2 - /etc/zero/master.key'
  else
    step 'head -c 32 /dev/urandom > /etc/zero/master.key'
  fi
  step 'chmod 0400 /etc/zero/master.key'
  say 'Back up /etc/zero/master.key; without it the sealed secrets are unrecoverable.'
}

write_unit() {
  target=$2
  if [ "$dry_run" = 1 ]; then printf 'write %s\n' "$target"; return 0; fi
  unit_text "$1" | sed -e "s#@PREFIX@#$prefix#g" -e "s#@STATE@#$state#g" -e "s#@USER@#$service_user#g" > "$target"
  chmod 0644 "$target"
}

install_units() {
  case "$service" in
    none) return 0 ;;
    system)
      write_unit zero.service /etc/systemd/system/zero.service
      write_unit zero-update.service /etc/systemd/system/zero-update.service
      write_unit zero-update.timer /etc/systemd/system/zero-update.timer
      step 'systemctl daemon-reload'
      step 'systemctl enable --now zero.service'
      step 'systemctl enable --now zero-update.timer'
      ;;
    user)
      mkdir -p "$HOME/.config/systemd/user"
      write_unit zero.service "$HOME/.config/systemd/user/zero.service"
      write_unit zero-update.service "$HOME/.config/systemd/user/zero-update.service"
      write_unit zero-update.timer "$HOME/.config/systemd/user/zero-update.timer"
      step "loginctl enable-linger $(id -un)"
      step 'systemctl --user daemon-reload'
      step 'systemctl --user enable --now zero.service'
      ;;
  esac
}

# --- cgroup ------------------------------------------------------------------------------------
resolve_cgroup() {
  case "$service" in
    system) cgroup_path="/sys/fs/cgroup/system.slice/zero.service" ;;
    user) cgroup_path="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/zero.service" ;;
    none)
      suffix=$(sed -n 's/^0::\(.*\)$/\1/p' /proc/self/cgroup 2>/dev/null | head -n1)
      if [ -d /cgroup ]; then cgroup_path=/cgroup
      elif [ -n "$suffix" ] && [ -d "/sys/fs/cgroup${suffix}" ]; then cgroup_path="/sys/fs/cgroup${suffix}"
      else die 'A foreground install needs a delegated cgroup at /cgroup or its own cgroup v2 path.'
      fi ;;
  esac
}

print_next_steps() {
  say "Zero $release is installed at $prefix."
  say "Its state volume is $state and its control socket is $state/supervisor.sock."
  say "Point your reviewed TLS endpoint at the socket paths zero status prints; they move with each kernel update."
  [ "$service" = none ] && say "Its master key is $credential_path; pass it to the supervisor as --credential."

  say "Sign in at $origin/login as $operator_id"
}

# --- uninstall ---------------------------------------------------------------------------------
run_uninstall() {
  [ -f "$prefix/etc/install.json" ] || die "There is no Zero installation at $prefix."
  if [ "$service" != none ]; then
    step 'systemctl disable --now zero.service zero-update.timer'
    step 'rm -f /etc/systemd/system/zero.service /etc/systemd/system/zero-update.service /etc/systemd/system/zero-update.timer'
    step 'systemctl daemon-reload'
  fi
  rm -rf "$prefix"
  if [ "$purge_state" = 1 ]; then
    [ "$no_mount" = 1 ] || step "umount $state"
    rm -rf "$state"
    [ "$no_mount" = 1 ] || step "rm -f ${state}.img"
    [ "$service" = none ] || step 'rm -f /etc/zero/master.key'
  fi
  say "Zero is uninstalled from $prefix."
}

# --- install -----------------------------------------------------------------------------------
run_install() {
  if already_installed; then
    say "Zero $release is already installed at $prefix."
    return 0
  fi
  resolve_operator
  if [ "$dry_run" = 1 ]; then privileged_plan; return 0; fi
  resolve_password

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/zero-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM
  if [ -n "$allowed_signers" ]; then
    signers=$(cd "$(dirname "$allowed_signers")" && printf '%s/%s' "$(pwd -P)" "$(basename "$allowed_signers")")
  else
    signers="$tmp/allowed_signers"; printf '%s\n' "$ZERO_ALLOWED_SIGNERS" > "$signers"
  fi
  staging="$tmp/staging"; extracted="$tmp/extracted"
  mkdir -p "$staging" "$extracted"

  mkdir -p "$(dirname "$prefix")"
  exec 9>"$tmp/install.lock"
  flock -n 9 || die 'Another install is already running against this prefix.'

  fetch_release "$staging"
  verify_asset_list "$staging"
  verify_signature "$staging"
  verify_hashes "$staging"
  verify_commit "$staging"
  ( cd "$extracted" && tar -xzf "$staging/thetis-distribution.tar.gz" )
  resolve_node "$staging"
  verify_pins "$staging" "$extracted"

  provision_volume
  provision_user
  state_dirs
  quota_bytes=$(state_capacity)
  layout_release "$extracted"
  install_node
  write_bin_zero
  write_installation "$extracted"
  write_accounts "$extracted"
  write_install_json
  provision_key
  install_units
  : > "$prefix/releases/$release/.installed"
  print_next_steps
}

main() {
  parse_args "$@"
  if [ -n "$print_unit" ]; then unit_text "$print_unit"; exit 0; fi
  validate_args
  validate_state_root
  preflight_root
  if [ "$do_uninstall" = 1 ]; then run_uninstall; return 0; fi
  resolve_cgroup
  [ "$dry_run" = 1 ] || preflight_host
  run_install
}

main "$@"
