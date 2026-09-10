# --- bootstrap the exact signed Node archive, never a host executable (ADR 0037, implementation note 0052) ------
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
  tar -xpJf "$tmp/$archive" --no-same-owner -C "$tmp/node"
  node_root="$tmp/node/node-$node_version-$node_platform"
  node_bin="$node_root/bin/node"
  [ -x "$node_bin" ] && [ "$("$node_bin" --version)" = "$node_version" ] || die 'The verified Node archive does not supply the release runtime.'
}

install_node() {
  step "install -d -m 0755 $prefix/node"
  if [ "$dry_run" = 1 ]; then say 'install verified Node archive'; return 0; fi
  [ ! -e "$prefix/node/$node_version" ] || die 'A Node installation already occupies the destination.'
  cp -pR "$node_root" "$prefix/node/$node_version"
  ln -s "$node_version" "$prefix/node/current"
}
