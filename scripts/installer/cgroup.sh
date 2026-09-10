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
