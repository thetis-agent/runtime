#!/bin/sh
# Generated from scripts/installer/*.sh by scripts/installer.ts; edit those sources (ADR 0052).
# Stand up a supervised Zero kernel service from a signed release, verifying every byte before
# anything is written and printing every privileged step; ADR 0048, ADR 0049, ADR 0050.
# POSIX sh (dash): no pipefail, so every pipe writes to a file and its status is checked.
set -eu

ZERO_REPO='https://github.com/thetis-agent/runtime'
ZERO_TAG='v0.1.0'
ZERO_RELEASE_URL='https://github.com/thetis-agent/runtime/releases/download'
ZERO_SIGNER='release@thetis-agent'
ZERO_NAMESPACE='zero-release'
# The one-liner's trust root is this script and its pins. Rotation ships a new line here,
# in a release signed with the key being retired (docs/ci-delivery.md).
ZERO_ALLOWED_SIGNERS='release@thetis-agent namespaces="zero-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderUntilTheFirstReleaseIsCut'
STATE_ROOT_LIMIT=18
PASSWORD_MINIMUM=12
SYSTEMD_MINIMUM=252
DEFAULT_STATE_SIZE=4294967296
ASSETS='thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json install.sh SHA256SUMS SHA256SUMS.sig'
SIGNED_ASSETS=9

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
node_url='https://nodejs.org/dist'
remote=''
allowed_signers=''
assume_yes=0
dry_run=0
do_uninstall=0
purge_state=0
allow_root=0
print_unit=''
prefix_set=0
state_set=0
service_set=0
unit_directory=''
credential_path=''
linger_created=0
user_created=0
tmp=''
terminal_hidden=0
umask 077

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
  --node-url <url>           Node archive mirror (default https://nodejs.org/dist)
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
ExecStart=/bin/sh -c 'exec @PREFIX@/node/current/bin/node --max-old-space-size=32 --max-semi-space-size=1 --no-experimental-strip-types --import @PREFIX@/current/lib/artifacts/register.mjs @PREFIX@/current/kernel/supervisor-main.ts @PREFIX@/etc/seed.json --release @PREFIX@/current --state @STATE@ --installation @PREFIX@ --credential "$CREDENTIALS_DIRECTORY/master" --delegate'
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
      --prefix) need_value "$@"; prefix=$2; prefix_set=1; shift 2 ;;
      --state) need_value "$@"; state=$2; state_set=1; shift 2 ;;
      --state-size) need_value "$@"; state_size=$2; shift 2 ;;
      --state-layout) need_value "$@"; state_layout=$2; shift 2 ;;
      --service) need_value "$@"; service=$2; service_set=1; shift 2 ;;
      --user) need_value "$@"; service_user=$2; shift 2 ;;
      --operator) need_value "$@"; operator=$2; shift 2 ;;
      --password-fd) need_value "$@"; password_fd=$2; shift 2 ;;
      --origin) need_value "$@"; origin=$2; shift 2 ;;
      --auto-update) need_value "$@"; auto_update=$2; shift 2 ;;
      --key-store) need_value "$@"; key_store=$2; shift 2 ;;
      --release) need_value "$@"; release=$2; shift 2 ;;
      --release-url) need_value "$@"; release_url=$2; shift 2 ;;
      --node-url) need_value "$@"; node_url=$2; shift 2 ;;
      --remote) need_value "$@"; remote=$2; shift 2 ;;
      --allowed-signers) need_value "$@"; allowed_signers=$2; shift 2 ;;
      --print-unit) need_value "$@"; print_unit=$2; shift 2 ;;
      *) die "Unknown flag $1." ;;
    esac
  done
}

validate_args() {
  [ -n "$release" ] || release=$ZERO_TAG
  [ -n "$release_url" ] || release_url=$ZERO_RELEASE_URL
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
  case "$node_url" in https://*|file://*) ;; *) die 'The --node-url value starts with https:// or file://.' ;; esac
  printf '%s\n' "$release" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || die 'The --release value is a vMAJOR.MINOR.PATCH tag.'
  case "$password_fd" in ''|[0-9]|[0-9][0-9]) ;; *) die 'The --password-fd value is a small non-negative descriptor number.' ;; esac
  [ "$do_uninstall" = 1 ] && return 0
  [ -z "$allowed_signers" ] || [ -f "$allowed_signers" ] || die 'The --allowed-signers path does not name a file.'
  [ -n "$origin" ] || die 'A fresh install needs --origin <url>.'
  printf '%s\n' "$origin" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || die 'The public origin is an https origin without a path.'
  printf '%s\n' "$service_user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die 'The service account name is not valid.'
  case "$state_size" in ''|*[!0-9]*) [ -z "$state_size" ] || die 'The state size is a positive number of bytes.' ;; esac
  [ "${state_size:-$DEFAULT_STATE_SIZE}" -ge 67108864 ] || die 'The state volume must be at least 67108864 bytes.'
  if [ "$state_layout" = split ] && [ "$no_mount" = 0 ]; then
    [ "${state_size:-$DEFAULT_STATE_SIZE}" -ge 4294967296 ] || die 'Split storage requires at least 4294967296 bytes for reserved volumes and shared state.'
  fi
  [ "$service" = system ] || [ "$key_store" = file ] || die 'TPM2 credentials require --service system.'
  [ "$service" != user ] || [ "$no_mount" = 1 ] || die 'A user service needs an existing bounded volume and --no-mount.'
  return 0
}

validate_paths() {
  for path in "$prefix" "$state"; do
    case "$path" in /*/*) ;; *) die 'Install paths must be absolute directories below a parent directory.' ;; esac
    case "$path" in *[!A-Za-z0-9_./-]*) die 'Install paths use letters, digits, slash, dot, dash and underscore.' ;; esac
    [ "$(realpath -m "$path")" = "$path" ] || die 'Install paths must be canonical, with no symlink or dot segments.'
  done
  case "$prefix/" in "$state/"*) die 'Code and state paths must not contain one another.' ;; esac
  case "$state/" in "$prefix/"*) die 'Code and state paths must not contain one another.' ;; esac
}

prompt_choices() {
  [ "$assume_yes" = 0 ] && [ "$dry_run" = 0 ] && [ "$do_uninstall" = 0 ] || return 0
  if ! ( : < /dev/tty ) 2>/dev/null; then die 'An unattended install needs --yes and --password-fd.'; fi
  if [ "$prefix_set" = 0 ]; then printf 'Install directory [%s]: ' "$prefix" > /dev/tty; IFS= read -r answer < /dev/tty; prefix=${answer:-$prefix}; fi
  if [ "$state_set" = 0 ]; then printf 'State directory [%s]: ' "$state" > /dev/tty; IFS= read -r answer < /dev/tty; state=${answer:-$state}; fi
  if [ "$service_set" = 0 ]; then printf 'Service (system/user/none) [%s]: ' "$service" > /dev/tty; IFS= read -r answer < /dev/tty; service=${answer:-$service}; fi
  if [ -z "$origin" ]; then printf 'Public https origin: ' > /dev/tty; IFS= read -r origin < /dev/tty; fi
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
  [ "$(uname -s)" = Linux ] || die 'This installer requires Linux.'
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "This installer supports x86_64 and aarch64, not $(uname -m)." ;; esac
  for tool in sh tar gzip xz sha256sum ssh-keygen git flock realpath stat timeout find mountpoint slirp4netns unshare; do need "$tool"; done
  [ "$no_mount" = 1 ] || { need fallocate; need mkfs.ext4; }
  [ "$service" = none ] || need systemctl
  [ "$service" != system ] || [ "$(id -u)" = 0 ] || die 'Installing a system service requires root; run the reviewed script with sudo sh install.sh --allow-root.'
  [ "$no_mount" = 1 ] || [ "$(id -u)" = 0 ] || die 'Provisioning a bounded volume requires root.'
  [ "$key_store" != tpm2 ] || { need systemd-creds; systemd-creds has-tpm2 >/dev/null || die 'No usable TPM2 is available.'; }
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
  stty -F /dev/tty -echo 2>/dev/null || die 'The administrator password cannot be read with terminal echo disabled.'
  terminal_hidden=1
  printf 'Administrator password: ' > /dev/tty
  IFS= read -r first < /dev/tty || first=''
  printf '\nConfirm password: ' > /dev/tty
  IFS= read -r second < /dev/tty || second=''
  printf '\n' > /dev/tty
  stty -F /dev/tty echo; terminal_hidden=0
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
  [ "$bytes" -le 1024 ] || die 'An administrator password is at most 1024 bytes.'
  [ "$bytes" -ge "$PASSWORD_MINIMUM" ] || die "An administrator password is at least ${PASSWORD_MINIMUM} characters."
}
# --- provisioning commands share the same call sites in dry-run and execution (ADR 0052) ---------
step() {
  if [ "$dry_run" = 1 ]; then printf '%s\n' "$1"; else eval "$1"; fi
}

mount_unit_name() { systemd-escape --path --suffix=mount "$1"; }

cleanup() {
  [ "$terminal_hidden" = 0 ] || stty -F /dev/tty echo 2>/dev/null || true
  [ -z "$tmp" ] || rm -rf "$tmp"
}

claim_install() {
  # Lock the same canonical parent inode in every invocation; a lock in mktemp cannot exclude a peer.
  parent=$(dirname "$prefix")
  [ -d "$parent" ] || die 'Create the code prefix parent directory before installing.'
  exec 9<"$parent"
  flock -n 9 || die 'Another installer holds this code prefix parent directory.'
}
# --- fetch and verify: nothing is written under the prefix until every check passes ------------
fetch_one() {
  # Limit every download, including local mirrors, before verification or extraction.
  (ulimit -f 262144; fetch_bounded "$1" "$2") || die "The release asset $(basename "$2") could not be downloaded within its 128 MiB limit."
}

fetch_bounded() {
  case "$1" in
    file://*) [ -f "${1#file://}" ] || die "The release asset $(basename "$2") is missing at its remote."; cp "${1#file://}" "$2" ;;
    https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 300 --max-filesize 134217728 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then timeout 300 wget --https-only --timeout=30 --tries=2 -q -O "$2" "$1"
      else die 'This installer needs curl or wget to read an https release.'
      fi ;;
    *) die "The release asset URL $1 has an unsupported scheme." ;;
  esac
}

fetch_release() {
  total=0
  for name in $ASSETS; do
    fetch_one "${release_url%/}/${release}/${name}" "$1/$name"
    bytes=$(stat -c %s "$1/$name"); total=$((total + bytes))
    [ "$total" -le 536870912 ] || die 'The release exceeds its 512 MiB total download limit.'
    case "$name" in
      thetis-distribution.tar.gz|registry.bundle) ;;
      *) [ "$bytes" -le 65536 ] || die 'Release metadata exceeds its 64 KiB limit.' ;;
    esac
  done
}

verify_asset_list() {
  count=$(wc -l < "$1/SHA256SUMS")
  [ "$count" -eq "$SIGNED_ASSETS" ] || die "SHA256SUMS does not list exactly the ${SIGNED_ASSETS} expected release assets."
  grep -Evq '^[a-f0-9]{64} [ *][A-Za-z0-9._-]+$' "$1/SHA256SUMS" && die 'SHA256SUMS carries a line that is not a lowercase 64-hex digest and an asset name.'
  for name in $ASSETS; do
    case "$name" in SHA256SUMS|SHA256SUMS.sig) continue ;; esac
    [ "$(cut -c67- "$1/SHA256SUMS" | grep -Fxc "$name")" = 1 ] || die 'SHA256SUMS lists a missing, duplicate or unexpected release asset.'
  done
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
  metadata=$(tr -d '\n\r' < "$1/provenance.json")
  commit=$(printf '%s' "$metadata" | sed -n 's/.*"runtime"[[:space:]]*:[[:space:]]*{[^}]*"commit"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{40\}\)".*/\1/p')
  [ -n "$commit" ] || die 'The release provenance carries no runtime commit.'
  refs="$1/refs.txt"
  timeout 60 git ls-remote --tags "$remote" "refs/tags/$release" "refs/tags/$release^{}" > "$refs" 2>/dev/null \
    || die "The release tag $release could not be resolved at $remote, so its provenance cannot be bound to it."
  peeled=$(sed -n 's/^\([a-f0-9]\{40\}\)[[:space:]].*\^{}$/\1/p' "$refs" | head -n1)
  [ -n "$peeled" ] || die "The release tag $release must be an annotated tag at $remote."
  [ "$peeled" = "$commit" ] || die "The release provenance names a different commit than tag $release at $remote."
}

verify_pins() {
  "$node_bin" --no-experimental-strip-types --import "file://$2/lib/artifacts/register.mjs" --input-type=module \
    -e 'const [module, pins, root] = process.argv.slice(1);
const { verifyPins, verifyRelease } = await import(module);
const { Schemas } = await import(`file://${root}/lib/schema/index.ts`);
const schemas = new Schemas(); await schemas.load();
const [allowedSigners, signer, tag, commit] = process.argv.slice(4);
const verified = await verifyRelease(pins, { allowedSigners, signer, tag: { tag, commit } }, schemas);
const result = verified.ok ? await verifyPins(root, verified.value.pins) : verified;
if (!result.ok) { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; }' \
    "file://$2/lib/update/verify.ts" "$1" "$2" "$signers" "$ZERO_SIGNER" "$release" "$commit" \
    || die 'The extracted release does not match the kernel pin hashes it published.'
}
# --- bootstrap the exact signed Node archive, never a host executable (ADR 0037, ADR 0052) ------
resolve_node() {
  metadata=$(tr -d '\n\r' < "$1/provenance.json")
  node_version=$(printf '%s' "$metadata" | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*{[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(v[0-9.]*\)".*/\1/p')
  printf '%s\n' "$node_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die 'The release provenance names no Node version.'
  case "$(uname -m)" in x86_64) node_platform=linux-x64 ;; aarch64) node_platform=linux-arm64 ;; *) die 'The release does not support this architecture.' ;; esac
  digest=$(printf '%s' "$metadata" | sed -n "s/.*\"$node_platform\"[[:space:]]*:[[:space:]]*\"\([a-f0-9]\{64\}\)\".*/\1/p")
  [ -n "$digest" ] || die "The signed release has no Node archive digest for $node_platform."
  archive="node-$node_version-$node_platform.tar.xz"
  fetch_one "${node_url%/}/$node_version/$archive" "$tmp/$archive"
  printf '%s  %s\n' "$digest" "$archive" > "$tmp/node.sum"
  (cd "$tmp" && sha256sum --check --strict --status node.sum) || die 'The Node archive does not match its signed provenance digest.'
  mkdir "$tmp/node"
  tar -xJf "$tmp/$archive" --no-same-owner -C "$tmp/node"
  node_root="$tmp/node/node-$node_version-$node_platform"
  node_bin="$node_root/bin/node"
  [ -x "$node_bin" ] && [ "$("$node_bin" --version)" = "$node_version" ] || die 'The verified Node archive does not supply the release runtime.'
}

install_node() {
  step "install -d -m 0755 $prefix/node"
  if [ "$dry_run" = 1 ]; then say 'install verified Node archive'; return 0; fi
  [ ! -e "$prefix/node/$node_version" ] || die 'A Node installation already occupies the destination.'
  cp -R "$node_root" "$prefix/node/$node_version"
  ln -s "$node_version" "$prefix/node/current"
}
# --- retain every path used by the installed bootstrap (ADR 0052) -------------------------------

write_bin_zero() {
  mkdir -p "$prefix/bin"
  cat > "$prefix/bin/zero" <<SH
#!/bin/sh
exec "$prefix/node/current/bin/node" --no-experimental-strip-types \\
  --import "$prefix/current/lib/artifacts/register.mjs" \\
  "$prefix/current/lib/update/main.ts" "\$@" --prefix "$prefix"
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
  chmod 0644 "$prefix/etc/seed.json" "$prefix/etc/recipe.json"
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
  "$node_bin" --input-type=module -e '
const [prefix,state,release,remote,releaseUrl,signer,policy,origin,operator,service,serviceUser,stateLayout,noMount,keyStore,credential,unitDirectory,lingerCreated,userCreated] = process.argv.slice(1);
const { writeFileSync } = await import("node:fs");
writeFileSync(`${prefix}/etc/install.json`, JSON.stringify({version:1,prefix,state,release,remote,releaseUrl,signer,policy,origin,operator,service,serviceUser,stateLayout,noMount:noMount==="1",keyStore,credential,unitDirectory,lingerCreated:lingerCreated==="1",userCreated:userCreated==="1",allowedSigners:`${prefix}/etc/allowed_signers`,login:"login"})+"\n");' \
    "$prefix" "$state" "$release" "$remote" "$release_url" "$ZERO_SIGNER" "$auto_update" "$origin" "$operator_id" "$service" \
    "$service_user" "$state_layout" "$no_mount" "$key_store" "$credential_path" "$unit_directory" "$linger_created" "$user_created"
  chmod 0644 "$prefix/etc/install.json"
}

layout_release() {
  mkdir -p "$prefix/releases" "$prefix/etc"
  cp -pR "$1" "$prefix/releases/$release"
  chmod 0755 "$prefix/releases/$release"
  mkdir "$prefix/releases/$release/.release"
  chmod 0755 "$prefix/releases/$release/.release"
  for name in $ASSETS; do cp -p "$staging/$name" "$prefix/releases/$release/.release/$name"; chmod 0644 "$prefix/releases/$release/.release/$name"; done
  cp -p "$staging/kernel-pins.json" "$prefix/releases/$release/kernel-pins.json"
  chmod 0644 "$prefix/releases/$release/kernel-pins.json"
  ln -sfn "releases/$release" "$prefix/current"
  cp "$signers" "$prefix/etc/allowed_signers"
  chmod 0644 "$prefix/etc/allowed_signers"
}
# --- provision only selected resources; dry-run follows these same functions (ADR 0052) ---------
provision_mount() {
  mount_path=$1; volume_size=$2; mount_name=$(mount_unit_name "$mount_path")
  [ ! -e "$mount_path.img" ] || die "The existing volume $mount_path.img will not be overwritten."
  [ -d "$(dirname "$mount_path")" ] || step "install -d -m 0755 $(dirname "$mount_path")"
  step "fallocate -l $volume_size $mount_path.img"
  step "chmod 0600 $mount_path.img"
  step "mkfs.ext4 -q -m 0 -L zero-state $mount_path.img"
  step "install -d -m 0700 $mount_path"
  write_unit state.mount "/etc/systemd/system/$mount_name"
  step 'systemctl daemon-reload'
  step "systemctl enable --now $mount_name"
}

provision_volume() {
  if [ "$no_mount" = 1 ]; then
    [ "$dry_run" = 1 ] || [ -d "$state" ] || die 'The --no-mount state directory must already exist on a bounded filesystem.'
  else
    provision_mount "$state" "${state_size:-$DEFAULT_STATE_SIZE}"
    if [ "$state_layout" = split ]; then
      provision_mount "$state/kernel" 268435456
      provision_mount "$state/supervisor" 1073741824
      provision_mount "$state/g" 2147483648
    fi
  fi
}

provision_user() {
  [ "$service" = system ] || return 0
  id "$service_user" >/dev/null 2>&1 && return 0
  step "useradd --system --home-dir $state --shell /usr/sbin/nologin $service_user"
  user_created=1
}

resolve_service() {
  case "$service" in
    system) unit_directory=/etc/systemd/system; credential_path=/etc/zero/master.key ;;
    user)
      case "$HOME" in *[!A-Za-z0-9_./-]*|'') die 'The user home must be a canonical absolute path.' ;; esac
      [ "$(realpath -m "$HOME")" = "$HOME" ] || die 'The user home must be canonical.'
      unit_directory="$HOME/.config/systemd/user"; credential_path="$prefix/etc/master.key"
      ;;
    none) unit_directory=''; credential_path="$prefix/etc/master.key" ;;
  esac
}

provision_key() {
  [ ! -e "$credential_path" ] || die 'An existing master key will not be overwritten.'
  if [ "$service" = system ]; then step 'install -d -o root -g root -m 0700 /etc/zero'; fi
  if [ "$key_store" = tpm2 ]; then
    step "head -c 32 /dev/urandom | systemd-creds encrypt --with-key=tpm2 --name=master - $credential_path"
  else
    step "head -c 32 /dev/urandom > $credential_path"
  fi
  step "chmod $([ "$service" = system ] && printf 0400 || printf 0600) $credential_path"
  say "Back up $credential_path; without it the sealed secrets are unrecoverable."
}

write_unit() {
  target=$2
  if [ "$dry_run" = 1 ]; then printf 'write %s\n' "$target"; return 0; fi
  unit_state=${mount_path:-$state}
  unit_text "$1" | sed -e "s#@PREFIX@#$prefix#g" -e "s#@STATE@#$unit_state#g" -e "s#@USER@#$service_user#g" > "$target"
  if [ "$1" = zero.service ]; then
    if [ "$service" = system ] && [ "$state_layout" = split ] && [ "$no_mount" = 0 ]; then
      sed -i "s#^RequiresMountsFor=.*#RequiresMountsFor=$state $state/kernel $state/supervisor $state/g#" "$target"
    fi
    sed -i "s#LoadCredential=master:/etc/zero/master.key#LoadCredential=master:$credential_path#" "$target"
    if [ "$key_store" = tpm2 ]; then sed -i 's/^LoadCredential=/LoadCredentialEncrypted=/' "$target"; fi
  fi
  if [ "$service" = user ] && [ "$1" != state.mount ]; then
    sed -i '/^User=/d; /^Group=/d; /^ProtectHome=/d; /^ProtectSystem=/d; /^DeviceAllow=/d; /^ReadWritePaths=/d; s/^WantedBy=multi-user.target$/WantedBy=default.target/' "$target"
  fi
  chmod 0644 "$target"
}

install_units() {
  [ "$service" != none ] || return 0
  step "install -d -m 0755 $unit_directory"
  mount_path=$state
  for unit in zero.service zero-update.service zero-update.timer; do write_unit "$unit" "$unit_directory/$unit"; done
  manager='systemctl'
  if [ "$service" = user ]; then
    manager='systemctl --user'
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
      step "loginctl enable-linger $(id -un)"; linger_created=1
    fi
  fi
  step "$manager daemon-reload"
}

start_units() {
  [ "$service" != none ] || return 0
  step "$manager enable --now zero.service"
  step "$manager enable --now zero-update.timer"
  [ "$dry_run" = 1 ] && return 0
  attempt=0
  until "$prefix/bin/zero" status >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 120 ] || die 'The service did not become ready; inspect zero.service in the journal before rerunning installation.'
    sleep 1
  done
}
# --- cgroup ------------------------------------------------------------------------------------
resolve_cgroup() {
  case "$service" in
    system) cgroup_path="/sys/fs/cgroup/system.slice/zero.service" ;;
    user) cgroup_path="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/zero.service" ;;
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
  say "Point your reviewed TLS endpoint at the stable socket paths zero status prints under $state/live."
  [ "$service" = none ] && say "Its master key is $credential_path; pass it to the supervisor as --credential."

  say "Sign in at $origin/login as $operator_id"
}
# --- uninstall uses recorded resources, preserving state and keys unless purged (ADR 0052) ------
recorded_uninstall() {
  [ -f "$prefix/etc/install.json" ] || die "There is no Zero installation at $prefix."
  node_bin="$prefix/node/current/bin/node"
  [ -x "$node_bin" ] || die 'The installed Node is missing; inspect this incomplete installation before removing it.'
  # JSON is decoded as data. Each shell-bound field is validated before it reaches a command.
  recorded=$("$node_bin" --input-type=module -e '
const {readFileSync} = await import("node:fs"); const prefix = process.argv[1];
const value = JSON.parse(readFileSync(`${prefix}/etc/install.json`, "utf8"));
if (value.prefix !== prefix || !["system","user","none"].includes(value.service)) process.exit(1);
for (const key of ["state","service","serviceUser","stateLayout","noMount","keyStore","credential","unitDirectory","lingerCreated","userCreated"]) {
 const item = value[key]; if (item === undefined || !/^[A-Za-z0-9_./-]*$/.test(String(item))) process.exit(1);
 process.stdout.write(String(item)+"\n");
}' "$prefix") || die 'The installation lacks valid recorded provisioning choices; inspect its units and volumes before uninstalling.'
  state=$(printf '%s\n' "$recorded" | sed -n '1p')
  service=$(printf '%s\n' "$recorded" | sed -n '2p')
  service_user=$(printf '%s\n' "$recorded" | sed -n '3p')
  state_layout=$(printf '%s\n' "$recorded" | sed -n '4p')
  no_mount=$(printf '%s\n' "$recorded" | sed -n '5p')
  key_store=$(printf '%s\n' "$recorded" | sed -n '6p')
  credential_path=$(printf '%s\n' "$recorded" | sed -n '7p')
  unit_directory=$(printf '%s\n' "$recorded" | sed -n '8p')
  linger_created=$(printf '%s\n' "$recorded" | sed -n '9p')
  user_created=$(printf '%s\n' "$recorded" | sed -n '10p')
  validate_paths
  case "$state_layout" in one|split) ;; *) die 'The recorded state layout is invalid.' ;; esac
  case "$no_mount" in true|false) ;; *) die 'The recorded mount choice is invalid.' ;; esac
  expected_units=$unit_directory; expected_key=$credential_path
  resolve_service
  [ "$expected_units" = "$unit_directory" ] && [ "$expected_key" = "$credential_path" ] || die 'Uninstall must use the account and unit directory that installed this service.'
}

remove_mount() {
  mount_name=$(mount_unit_name "$1")
  step "systemctl disable --now $mount_name"
  step "rm -f /etc/systemd/system/$mount_name $1.img"
}

run_uninstall() {
  recorded_uninstall
  if [ "$service" != none ]; then
    manager='systemctl'; [ "$service" != user ] || manager='systemctl --user'
    step "$manager disable --now zero-update.timer zero.service"
    step "$manager stop zero-update.service"
    for unit in zero.service zero-update.service zero-update.timer; do step "rm -f $unit_directory/$unit"; done
    step "$manager daemon-reload"
    if [ "$service" = user ] && [ "$linger_created" = true ]; then step "loginctl disable-linger $(id -un)"; fi
  elif [ "$dry_run" = 0 ]; then
    "$prefix/bin/zero" status >/dev/null 2>&1 && die 'Stop the foreground supervisor before uninstalling.'
  fi
  if [ "$purge_state" = 0 ] && [ "$service" != system ]; then
    step "cp -p $credential_path $state/retained-master.key"
    say "The retained state key is $state/retained-master.key."
  fi
  if [ "$purge_state" = 1 ]; then
    if [ "$no_mount" = false ]; then
      if [ "$state_layout" = split ]; then for reserved in g supervisor kernel; do remove_mount "$state/$reserved"; done; fi
      remove_mount "$state"
      step 'systemctl daemon-reload'
    fi
    if [ "$no_mount" = true ] && mountpoint -q "$state"; then
      step "find $state -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} +"
    else
      step "rm -rf --one-file-system $state"
    fi
    if [ "$service" = system ]; then step 'rm -f /etc/zero/master.key'; fi
    if [ "$user_created" = true ]; then step "userdel $service_user"; fi
  fi
  step "rm -rf $prefix"
  say "Zero is uninstalled from $prefix."
}
# --- installation changes the destination only after complete verification (ADR 0048) -----------
existing_install() {
  if [ -f "$prefix/etc/install.json" ]; then
    [ -f "$prefix/releases/$release/.installed" ] || die 'This prefix already has an installation; use zero update to change its release.'
    say "Zero $release is already installed at $prefix."
    return 0
  fi
  if [ -e "$prefix" ]; then die 'The code prefix already exists without a completed installation; inspect it before continuing.'; fi
  if [ -d "$state" ] && [ -n "$(ls -A "$state")" ]; then die 'The state directory is not empty; existing deployment data will not be overwritten.'; fi
  return 1
}

provision_install() {
  provision_user
  provision_volume
  step "install -d -m 0755 $prefix $prefix/releases $prefix/etc"
  if [ "$dry_run" = 1 ]; then
    say 'install verified release and retained seed sources'
    install_node
    say 'write recipe.json, seed.json and zero launcher'
    say 'write accounts.json (1 account)'
  else
    state_dirs
    quota_bytes=$(state_capacity)
    [ "$quota_bytes" -le "${state_size:-$DEFAULT_STATE_SIZE}" ] || die 'The existing state filesystem exceeds the declared state size.'
    layout_release "$extracted"
    install_node
    write_bin_zero
    write_installation "$prefix/releases/$release"
    write_accounts "$prefix/releases/$release"
    password_value=''
  fi
  provision_key
  install_units
  if [ "$service" = system ]; then
    step "chown -R $service_user:$service_user $state"
    step "chown root:$service_user $prefix/releases"
    step "chmod 1775 $prefix/releases"
  fi
  if [ "$dry_run" = 1 ]; then say 'write install.json'; else write_install_json; fi
  start_units
  if [ "$dry_run" = 0 ]; then : > "$prefix/releases/$release/.installed"; print_next_steps; fi
}

run_install() {
  if existing_install; then return 0; fi
  resolve_operator
  resolve_service
  if [ "$dry_run" = 1 ]; then provision_install; return 0; fi
  [ ! -e "$credential_path" ] || die 'An existing master key will not be overwritten.'
  resolve_password
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/zero-install.XXXXXX")
  if [ -n "$allowed_signers" ]; then
    signers=$(realpath "$allowed_signers")
  else
    signers="$tmp/allowed_signers"; printf '%s\n' "$ZERO_ALLOWED_SIGNERS" > "$signers"
  fi
  staging="$tmp/staging"; extracted="$tmp/extracted"
  mkdir -p "$staging" "$extracted"
  fetch_release "$staging"
  verify_asset_list "$staging"
  verify_signature "$staging"
  verify_hashes "$staging"
  verify_commit "$staging"
  resolve_node "$staging"
  tar -xpzf "$staging/thetis-distribution.tar.gz" --no-same-owner -C "$extracted"
  verify_pins "$staging" "$extracted"
  provision_install
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  parse_args "$@"
  if [ -n "$print_unit" ]; then unit_text "$print_unit"; exit 0; fi
  prompt_choices
  validate_args
  validate_paths
  preflight_root
  [ "$dry_run" = 1 ] || claim_install
  if [ "$do_uninstall" = 1 ]; then run_uninstall; return 0; fi
  validate_state_root
  resolve_cgroup
  [ "$dry_run" = 1 ] || preflight_host
  run_install
}

main "$@"
