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
      --allow-root) shift ;;
      --demo) demo=1; shift ;;
      --prefix) need_value "$@"; prefix=$2; prefix_set=1; shift 2 ;;
      --state) need_value "$@"; state=$2; state_set=1; shift 2 ;;
      --state-size) need_value "$@"; state_size=$2; shift 2 ;;
      --state-layout) need_value "$@"; state_layout=$2; shift 2 ;;
      --service) need_value "$@"; service=$2; service_set=1; shift 2 ;;
      --service-name) need_value "$@"; service_name=$2; shift 2 ;;
      --user) need_value "$@"; service_user=$2; shift 2 ;;
      --operator) need_value "$@"; operator=$2; shift 2 ;;
      --password-fd) need_value "$@"; password_fd=$2; shift 2 ;;
      --api-key-fd) need_value "$@"; api_key_fd=$2; shift 2 ;;
      --model) need_value "$@"; model=$2; shift 2 ;;
      --daily-budget) need_value "$@"; daily_budget=$2; shift 2 ;;
      --provider-config) need_value "$@"; provider_config=$2; shift 2 ;;
      --origin) need_value "$@"; origin=$2; shift 2 ;;
      --kernel-origin) need_value "$@"; kernel_origin=$2; shift 2 ;;
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
  [ -n "$release" ] || release=$THETIS_TAG
  [ -n "$release_url" ] || release_url=$THETIS_RELEASE_URL
  [ -n "$remote" ] || remote="${THETIS_REPO}.git"
  case "$state_layout" in one|split) ;; *) die 'The --state-layout value is one or split.' ;; esac
  case "$service" in system|user|none) ;; *) die 'The --service value is system, user or none.' ;; esac
  printf '%s\n' "$service_name" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$' || die 'The service name must start with a lowercase letter and contain only lowercase letters, digits, underscores and dashes.'
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
  case "$api_key_fd" in ''|[0-9]|[0-9][0-9]) ;; *) die 'The --api-key-fd value is a small non-negative descriptor number.' ;; esac
  [ "$do_uninstall" = 1 ] && return 0
  if [ "$demo" = 1 ] && { [ -n "$provider_config" ] || [ -n "$model" ] || [ -n "$api_key_fd" ]; }; then
    die 'Choose --demo or a real provider, not both.'
  fi
  [ -z "$provider_config" ] || [ -f "$provider_config" ] || die 'The provider configuration file does not exist.'
  [ -z "$allowed_signers" ] || [ -f "$allowed_signers" ] || die 'The --allowed-signers path does not name a file.'
  [ -n "$origin" ] || die 'A fresh install needs --origin <url>.'
  printf '%s\n' "$origin" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || die 'The public origin is an https origin without a path.'
  [ -n "$kernel_origin" ] || kernel_origin="https://kernel.${origin#https://}"
  printf '%s\n' "$kernel_origin" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || die 'The kernel origin is an https origin without a path.'
  [ "$kernel_origin" != "$origin" ] || die 'The trusted kernel must have a separate origin from package pages.'
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
  if [ "$demo" = 0 ] && [ -z "$provider_config" ] && [ -z "$model" ]; then
    printf 'OpenRouter model id: ' > /dev/tty; IFS= read -r model < /dev/tty
  fi
}

validate_state_root() {
  bytes=$(printf '%s/g' "$state" | wc -c)
  [ "$bytes" -le "$STATE_ROOT_LIMIT" ] || \
    die "A state root whose generation store path exceeds ${STATE_ROOT_LIMIT} bytes pushes a supervised target endpoint past the Linux socket path limit."
}
