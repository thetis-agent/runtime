# --- cgroup ------------------------------------------------------------------------------------
resolve_cgroup() {
  case "$service" in
    system) cgroup_path="/sys/fs/cgroup/system.slice/$service_name.service" ;;
    user) cgroup_path="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$service_name.service" ;;
    none)
      suffix=$(sed -n 's/^0::\(.*\)$/\1/p' /proc/self/cgroup 2>/dev/null | head -n1)
      if [ -d /cgroup ]; then cgroup_path=/cgroup
      elif [ -n "$suffix" ] && [ -d "/sys/fs/cgroup${suffix}" ]; then cgroup_path="/sys/fs/cgroup${suffix}"
      else die 'A foreground install needs a delegated cgroup at /cgroup or its own cgroup v2 path.'
      fi ;;
  esac
}

print_next_steps() {
  display_complete
  say "Thetis $release is installed at $prefix."
  say "Its state volume is $state and its control socket is $state/supervisor.sock."
  say "Chat now: $([ "$service" = system ] && printf 'sudo ')$prefix/bin/thetis chat --message \"Hello\""
  say "For browser access, configure your TLS proxy using the stable socket paths from $prefix/bin/thetis status."
  say "Trusted kernel origin: $kernel_origin (keep it separate from package pages)."
  [ "$service" = none ] && say "Its master key is $credential_path; pass it to the supervisor as --credential."

  say "After configuring the proxy, sign in at $origin/login as $operator_id"
  if [ "$demo" = 1 ]; then say 'Demo mode: replies are scripted. No real model is connected.'; fi
}
