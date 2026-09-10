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
