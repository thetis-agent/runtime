# --- installation changes the destination only after complete verification (ADR 0048) -----------
existing_install() {
  if [ -f "$prefix/etc/install.json" ]; then
    [ -f "$prefix/releases/$release/.installed" ] || die 'This prefix already has an installation; use thetis update to change its release.'
    say "Thetis $release is already installed at $prefix."
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
    say 'write recipe.json, seed.json and thetis launcher'
    say 'write accounts.json (1 account)'
  else
    state_dirs
    quota_bytes=$(state_capacity)
    [ "$quota_bytes" -le "${state_size:-$DEFAULT_STATE_SIZE}" ] || die 'The existing state filesystem exceeds the declared state size.'
    layout_release "$extracted"
    install_node
    write_bin_thetis
    write_installation "$prefix/releases/$release"
    write_accounts "$prefix/releases/$release"
    password_value=''
  fi
  provision_key
  seal_provider
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
  if [ "$service" != none ]; then
    for unit in "$service_name.service" "$service_name-update.service" "$service_name-update.timer"; do
      [ ! -e "$unit_directory/$unit" ] && [ ! -L "$unit_directory/$unit" ] || die "An existing unit $unit_directory/$unit will not be overwritten."
    done
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/thetis-install.XXXXXX")
  if [ -n "$allowed_signers" ]; then
    signers=$(realpath "$allowed_signers")
  else
    signers="$tmp/allowed_signers"; printf '%s\n' "$THETIS_ALLOWED_SIGNERS" > "$signers"
  fi
  staging="$tmp/staging"; extracted="$tmp/extracted"
  mkdir -p "$staging" "$extracted"
  progress "Downloading Thetis $release"
  fetch_release "$staging"
  progress 'Checking the release signature and checksums'
  verify_asset_list "$staging"
  verify_signature "$staging"
  verify_hashes "$staging"
  verify_commit "$staging"
  progress 'Installing the verified Node runtime'
  resolve_node "$staging"
  progress 'Verifying the extracted application'
  tar -xpzf "$staging/thetis-distribution.tar.gz" --no-same-owner -C "$extracted"
  verify_pins "$staging" "$extracted"
  resolve_provider
  resolve_password
  progress 'Creating your environment'
  provision_install
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  parse_args "$@"
  if [ -n "$print_unit" ]; then unit_text "$print_unit"; exit 0; fi
  init_display
  banner
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
