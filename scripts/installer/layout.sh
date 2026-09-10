# --- retain every path used by the installed bootstrap (ADR 0052) -------------------------------

write_bin_zero() {
  mkdir -p "$prefix/bin"
  cat > "$prefix/bin/zero" <<SH
#!/bin/sh
exec "$prefix/node/current/bin/node" --no-experimental-strip-types \\
  --import "$prefix/current/lib/artifacts/register.mjs" \\
  "$prefix/current/lib/update/main.ts" "\$@" --prefix "$prefix"
SH
  chmod 0755 "$prefix/bin/zero"
}

state_capacity() {
  blocks=$(stat -f -c %b "$state"); size=$(stat -f -c %S "$state")
  printf '%s' "$((blocks * size))"
}

state_dirs() {
  for name in kernel supervisor g registry cache profile discovery initial "spaces/$operator_id" login-state updates; do
    mkdir -p "$state/$name"
  done
  chmod 0700 "$state"; chmod 0755 "$state/updates"
  [ -d "$state/registry/objects" ] || ( cd "$state/registry" && git init --bare -q . )
}

write_installation() {
  "$node_bin" --no-experimental-strip-types --import "file://$1/lib/artifacts/register.mjs" \
    "$1/lib/update/seed.ts" --release "$1" --state "$state" --prefix "$prefix" --cgroup "$cgroup_path" \
    --operator "$operator_id" --origin "$origin" --quota "$quota_bytes" >/dev/null \
    || die 'The installation recipe and seed could not be written from the release sources.'
  chmod 0644 "$prefix/etc/seed.json" "$prefix/etc/recipe.json"
}

write_accounts() {
  printf '%s' "$password_value" | "$node_bin" --no-experimental-strip-types \
    --import "file://$1/lib/artifacts/register.mjs" --input-type=module \
    -e 'const [module, id] = process.argv.slice(1);
const { credential } = await import(module);
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const record = await credential(id, Buffer.concat(chunks).toString("utf8"));
if (!record.ok) { process.stderr.write(`${record.error.message}\n`); process.exit(1); }
process.stdout.write(`${JSON.stringify({ version: 1, accounts: [record.value] })}\n`);' \
    "file://$1/packages/gateway-login/password.ts" "$operator_id" > "$state/login-state/accounts.json" \
    || die 'The administrator account record could not be derived.'
  chmod 0600 "$state/login-state/accounts.json"
}

write_install_json() {
  "$node_bin" --input-type=module -e '
const [prefix,state,release,remote,releaseUrl,signer,policy,origin,operator,service,serviceUser,stateLayout,noMount,keyStore,credential,unitDirectory,lingerCreated,userCreated] = process.argv.slice(1);
const { writeFileSync } = await import("node:fs");
writeFileSync(`${prefix}/etc/install.json`, JSON.stringify({version:1,prefix,state,release,remote,releaseUrl,signer,policy,origin,operator,service,serviceUser,stateLayout,noMount:noMount==="1",keyStore,credential,unitDirectory,lingerCreated:lingerCreated==="1",userCreated:userCreated==="1",allowedSigners:`${prefix}/etc/allowed_signers`,login:"login"})+"\n");' \
    "$prefix" "$state" "$release" "$remote" "$release_url" "$ZERO_SIGNER" "$auto_update" "$origin" "$operator_id" "$service" \
    "$service_user" "$state_layout" "$no_mount" "$key_store" "$credential_path" "$unit_directory" "$linger_created" "$user_created"
  chmod 0644 "$prefix/etc/install.json"
}

layout_release() {
  mkdir -p "$prefix/releases" "$prefix/etc"
  cp -pR "$1" "$prefix/releases/$release"
  chmod 0755 "$prefix/releases/$release"
  mkdir "$prefix/releases/$release/.release"
  chmod 0755 "$prefix/releases/$release/.release"
  for name in $ASSETS; do cp -p "$staging/$name" "$prefix/releases/$release/.release/$name"; chmod 0644 "$prefix/releases/$release/.release/$name"; done
  cp -p "$staging/kernel-pins.json" "$prefix/releases/$release/kernel-pins.json"
  chmod 0644 "$prefix/releases/$release/kernel-pins.json"
  ln -sfn "releases/$release" "$prefix/current"
  cp "$signers" "$prefix/etc/allowed_signers"
  chmod 0644 "$prefix/etc/allowed_signers"
}
