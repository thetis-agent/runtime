# --- fetch and verify: nothing is written under the prefix until every check passes ------------
fetch_one() {
  # Limit every download, including local mirrors, before verification or extraction.
  (ulimit -f 262144; fetch_bounded "$1" "$2") || die "The release asset $(basename "$2") could not be downloaded within its 128 MiB limit."
}

fetch_bounded() {
  case "$1" in
    file://*) [ -f "${1#file://}" ] || die "The release asset $(basename "$2") is missing at its remote."; cp "${1#file://}" "$2" ;;
    https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 300 --max-filesize 134217728 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then timeout 300 wget --https-only --timeout=30 --tries=2 -q -O "$2" "$1"
      else die 'This installer needs curl or wget to read an https release.'
      fi ;;
    *) die "The release asset URL $1 has an unsupported scheme." ;;
  esac
}

fetch_release() {
  total=0
  for name in $ASSETS; do
    progress "  $name"
    fetch_one "${release_url%/}/${release}/${name}" "$1/$name"
    bytes=$(stat -c %s "$1/$name"); total=$((total + bytes))
    [ "$total" -le 536870912 ] || die 'The release exceeds its 512 MiB total download limit.'
    case "$name" in
      thetis-distribution.tar.gz|registry.bundle) ;;
      *) [ "$bytes" -le 65536 ] || die 'Release metadata exceeds its 64 KiB limit.' ;;
    esac
  done
}

verify_asset_list() {
  count=$(wc -l < "$1/SHA256SUMS")
  [ "$count" -eq "$SIGNED_ASSETS" ] || die "SHA256SUMS does not list exactly the ${SIGNED_ASSETS} expected release assets."
  grep -Evq '^[a-f0-9]{64} [ *][A-Za-z0-9._-]+$' "$1/SHA256SUMS" && die 'SHA256SUMS carries a line that is not a lowercase 64-hex digest and an asset name.'
  for name in $ASSETS; do
    case "$name" in SHA256SUMS|SHA256SUMS.sig) continue ;; esac
    [ "$(cut -c67- "$1/SHA256SUMS" | grep -Fxc "$name")" = 1 ] || die 'SHA256SUMS lists a missing, duplicate or unexpected release asset.'
  done
  return 0
}

verify_signature() {
  ( cd "$1" && ssh-keygen -Y verify -f "$signers" -I "$THETIS_SIGNER" -n "$THETIS_NAMESPACE" -s SHA256SUMS.sig < SHA256SUMS >/dev/null 2>&1 ) \
    || die 'The release SHA256SUMS signature could not be verified against the allowed signer.'
}

verify_hashes() {
  ( cd "$1" && sha256sum --check --strict --status SHA256SUMS ) \
    || die 'The release assets do not match their signed SHA256SUMS checksums.'
}

verify_commit() {
  metadata=$(tr -d '\n\r' < "$1/provenance.json")
  commit=$(printf '%s' "$metadata" | sed -n 's/.*"runtime"[[:space:]]*:[[:space:]]*{[^}]*"commit"[[:space:]]*:[[:space:]]*"\([a-f0-9]\{40\}\)".*/\1/p')
  [ -n "$commit" ] || die 'The release provenance carries no runtime commit.'
  refs="$1/refs.txt"
  timeout 60 git ls-remote --tags "$remote" "refs/tags/$release" "refs/tags/$release^{}" > "$refs" 2>/dev/null \
    || die "The release tag $release could not be resolved at $remote, so its provenance cannot be bound to it."
  peeled=$(sed -n 's/^\([a-f0-9]\{40\}\)[[:space:]].*\^{}$/\1/p' "$refs" | head -n1)
  [ -n "$peeled" ] || die "The release tag $release must be an annotated tag at $remote."
  [ "$peeled" = "$commit" ] || die "The release provenance names a different commit than tag $release at $remote."
}

verify_pins() {
  "$node_bin" --no-experimental-strip-types --import "file://$2/lib/artifacts/register.mjs" --input-type=module \
    -e 'const [module, pins, root] = process.argv.slice(1);
const { verifyPins, verifyRelease } = await import(module);
const { Schemas } = await import(`file://${root}/lib/schema/index.ts`);
const schemas = new Schemas(); await schemas.load();
const [allowedSigners, signer, tag, commit] = process.argv.slice(4);
const verified = await verifyRelease(pins, { allowedSigners, signer, tag: { tag, commit } }, schemas);
const result = verified.ok ? await verifyPins(root, verified.value.pins) : verified;
if (!result.ok) { process.stderr.write(`${result.error.message}\n`); process.exitCode = 1; }' \
    "file://$2/lib/update/verify.ts" "$1" "$2" "$signers" "$THETIS_SIGNER" "$release" "$commit" \
    || die 'The extracted release does not match the kernel pin hashes it published.'
}
