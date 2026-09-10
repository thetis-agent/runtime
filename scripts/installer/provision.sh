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
