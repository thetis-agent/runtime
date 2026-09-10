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
