# --- uninstall uses recorded resources, preserving state and keys unless purged (implementation note 0052) ------
recorded_uninstall() {
  [ -f "$prefix/etc/install.json" ] || die "There is no Thetis installation at $prefix."
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
}
const name = value.serviceName ?? "thetis";
if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) process.exit(1);
process.stdout.write(name+"\n");' "$prefix") || die 'The installation lacks valid recorded provisioning choices; inspect its units and volumes before uninstalling.'
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
  service_name=$(printf '%s\n' "$recorded" | sed -n '11p')
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
    step "$manager disable --now $service_name-update.timer $service_name.service"
    step "$manager stop $service_name-update.service"
    for unit in "$service_name.service" "$service_name-update.service" "$service_name-update.timer"; do step "rm -f $unit_directory/$unit"; done
    step "$manager daemon-reload"
    if [ "$service" = user ] && [ "$linger_created" = true ]; then step "loginctl disable-linger $(id -un)"; fi
  elif [ "$dry_run" = 0 ]; then
    "$prefix/bin/thetis" status >/dev/null 2>&1 && die 'Stop the foreground supervisor before uninstalling.'
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
    if [ "$service" = system ]; then step "rm -f $credential_path"; fi
    if [ "$user_created" = true ]; then step "userdel $service_user"; fi
  fi
  step "rm -rf $prefix"
  say "Thetis is uninstalled from $prefix."
}
