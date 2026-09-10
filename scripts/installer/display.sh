# Terminal presentation is optional; redirected logs and NO_COLOR stay plain.
color=''; reset=''; strong=''
init_display() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ] && [ -z "${NO_COLOR+x}" ]; then
    color=$(printf '\033[36m'); strong=$(printf '\033[1m'); reset=$(printf '\033[0m')
  fi
}

banner() {
  [ "$dry_run" = 0 ] || return 0
  printf '\n%s%s  t h e t i s%s\n' "$strong" "$color" "$reset"
  printf '  Your agent. Your environment.\n\n'
}

progress() {
  [ "$dry_run" = 0 ] || return 0
  printf '%s  →%s %s\n' "$color" "$reset" "$1"
}

display_complete() {
  printf '\n%s%s  ✓ Thetis is ready%s\n\n' "$strong" "$color" "$reset"
}
