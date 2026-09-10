# Headless two-account deployment

The shipped recipe is `profiles/examples/two-account.recipe.json`. It runs one
mock provider, separate Alice and Bob environments with separate writable spaces,
and a CLI service for each person. Visual gateway assets are deferred. The
WebSocket gateway implementation is available separately; this recipe needs no
browser, network or model key.

## Installation inputs

Use Node 24.18 or a compatible Node 24 release, bubblewrap with working user
namespaces, and a dedicated delegated cgroup v2 subtree. See
`docs/platform-dependencies.md`. Every writable mount must be on a filesystem
whose enforced capacity is no larger than its declared `maximumBytes`; the
example declares 512 MiB. A large unrestricted host directory does not qualify.
The kernel refuses it instead of dropping the sandbox or quota.

An installation needs the reviewed kernel, the reviewed registry seed deployment,
and the exact package sources and hashes named by that seed. The registry is the
deployment's bare git repository. A recipe is an assembly input, not a substitute
for the verified seed. Never put invented hashes or placeholder commit ids in an
installation profile. The final profile and installation seed must be generated
from the same frozen source revision.

Copy the recipe to the installation directory. Change `/var/lib/thetis` and
`/sys/fs/cgroup/thetis` consistently for the actual bounded filesystem and delegated
subtree. Create empty `initial`, `spaces/alice`, and `spaces/bob` directories before
assembly. For separate development repositories, mount the runtime checkout at
`/sources/repository` and the package checkout at `/sources/packages`, both
read-only in the registry seed's sandbox. The catalog discovers that sibling
package directory. An already assembled source distribution may instead contain
its own `/sources/repository/packages` directory. Neither case uses host symlinks
as package grants.
Set the seed configuration's `bootstrap` object to:

```json
{
  "recipe": "/var/lib/thetis/two-account.recipe.json",
  "registry": "registry",
  "cache": "/var/lib/thetis/cache",
  "output": "/var/lib/thetis/deployment.json",
  "profile": "/var/lib/thetis/profile",
  "discoveryRoot": "/var/lib/thetis/discovery"
}
```

The seed's registry target must have that id and access to those registry/cache
mounts. Bootstrap publishes exact registry releases, verifies installation hashes,
starts discovery inside its own generation, captures spawn declarations, and then
starts the two-account targets. The `bootstrap` configuration remains the startup
entry so the registry remains available; `deployment.json` records the assembled
targets. Start it from the reviewed installation:

```sh
node --max-old-space-size=32 --max-semi-space-size=1 \
  --no-experimental-strip-types --import ./lib/artifacts/register.mjs \
  kernel/main.ts /var/lib/thetis/seed.json
```

The command acquires the deployment lock, reaps orphan writers in its dedicated
cgroup subtree, replays observed generation records and probes recovered targets
before printing `ready`. Do not share that subtree with a second kernel. Stop with
SIGTERM and restart with the same configuration and state. SIGKILL recovery is
covered by the interrupted-default test.

Use Node 24.18.0 and run `scripts/build.ts` before launching from a source
checkout. The preload rejects missing or stale artifacts instead of interpreting
TypeScript. These are the same V8 heap settings used by the sandbox runner and
the actual-kernel memory measurement; they do not raise its acceptance limit.
See [execution artifacts](execution-artifacts.md) for the release checks.

## Offline package release

`profiles/default/profile.lock.json` and `registry.bundle` contain real immutable
versions from the current normalized source closure. `registry.json` records the
bundle checksum. This artifact has an offline reconstruction test that verifies
every pin and rejects a changed tree hash. It does not include a provisioned
deployment or make the unaccepted kernel a production installation.

Regenerate after reviewing changes in both repositories:

```sh
"$THETIS_NODE" scripts/release.ts
"$THETIS_NODE" scripts/test.ts test/release-artifact.test.ts
```

Generation runs inside bubblewrap with no network or install scripts. Review the
profile, checksum and bundle together; never replace one without the others.

## Chat through the person-scoped CLI socket

The public socket for target `alice-cli` is
`<seed-root>/targets/<SHA256-base64url("alice-cli")>/runs/public/current.sock`;
Bob uses `bob-cli`. The seed root is the initial deployment configuration's `root`,
not the recipe's temporary discovery root. The kernel prints metadata only;
provider text travels directly from the environment to the scoped CLI service.

An operator with filesystem access can use a Unix socket client such as `socat`:

```sh
printf '%s\n' '{"args":["new"]}' | socat - UNIX-CONNECT:"$ALICE_SOCKET"
printf '%s\n' '{"args":["send","CONVERSATION_ID","Hello"]}' | socat - UNIX-CONNECT:"$ALICE_SOCKET"
printf '%s\n' '{"args":["send","CONVERSATION_ID","Second turn"]}' | socat - UNIX-CONNECT:"$ALICE_SOCKET"
printf '%s\n' '{"args":["list"]}' | socat - UNIX-CONNECT:"$BOB_SOCKET"
```

Replace the conversation id with `value.id` from `new`. Streaming calls emit
bounded JSON batches and a final typed result. Use a new connection per command.
`status`, `logs`, `reset`, `profile`, `health`, `cancel <id>` and
`subscribe <id> [cursor]` are also available. These are scoped service sockets;
only the matching principal's trusted client should have access to each socket.
They are not anonymous public network listeners.

## Chat through the browser

ADR 0038 has no deployment-scope front. Each person's `gateway-web` target
serves the lifted web surface itself, over its own public unix socket path
under the seed root — the same `runs/public/current.sock` mechanism the
person-scoped CLI targets already use. `gateway-login`'s target does the same
for the sign-in page. The operator's reviewed TLS endpoint maps to those
paths by static rule, one per account, stripping the matched prefix before
the request reaches the target:

```
/login  → gateway-login's public socket
/alice/ → alice's gateway-web public socket
/bob/   → bob's gateway-web public socket
```

The exact paths follow the same formula as the person-scoped CLI sockets
above, keyed by each target's own id:

```
<seed-root>/targets/<SHA256-base64url("alice-web")>/runs/public/current.sock
<seed-root>/targets/<SHA256-base64url("bob-web")>/runs/public/current.sock
<seed-root>/targets/<SHA256-base64url("login")>/runs/public/current.sock
```

`alice-web` and `bob-web` are person-scope targets, owned by `alice` and `bob`
respectively, each granted only its own person's environment endpoint
(`services: [{"id":"alice","mount":"/services/environment"}]`, mirroring
`alice-cli`); `login` is a deployment-scope target (`owner: ""`) with no
service grants of its own. As with the CLI sockets, the seed root is the
initial deployment configuration's `root`, not the recipe's temporary
discovery root.

Sign in at `GET /login`; a successful `POST /login` sets `thetis_session`
with `Path=/` and redirects to `/<person>/`, where `<person>` is the value
the kernel returned for the asserted identity, never a value the gateway or
the browser supplied. Because the same cookie reaches every account's prefix,
each `gateway-web` target still calls the kernel's `session.whois({
sessionToken }) → { person, role }` on every HTTP request and at WebSocket
upgrade, and trusts the answer, not the URL: a person-scope run is refused a
token naming another person. Adding an account is a proxy-configuration edit
and a new target, not something discovered at runtime.

The kernel origin stays a separate origin with its own `__Host-thetis`
cookie, reached directly by the browser only for the act
(`default.prepare`/`default.set`) and secrets; no package reads or sets it,
and neither `gateway-web` nor `gateway-login` ever shares its origin.

## Password authority and trusted kernel origin

The minimal recipe intentionally has no password authority or privileged origin.
To enable them, include `gateway-login` as a deployment target with spawn `login`,
and initialize its state with `accounts.json` containing `{ "version": 1, "accounts": [...] }` with
salted scrypt records from `packages/gateway-login/password.ts:credential`.
Only those derived records belong in its state. Read password input from a private
terminal or descriptor; never put it in package settings or a command argument.

Bind an external account id to a principal in the kernel configuration:

```json
{
  "bindings": [{"kind":"password","id":"operator-login","person":"operator"}],
  "authorities": {"password":"login"}
}
```

The principal must also exist in `identity.people` with the appropriate role.
The gateway verifies the password and submits evidence; the kernel resolves the
person. `POST /login` to the login Unix socket accepts `{ "id": "operator-login",
"password": "..." }` and returns a session token. Exchange that token through
`POST /session` on the separate trusted kernel origin. Its cookie is
`__Host-thetis`, with Secure, HttpOnly and SameSite=Strict attributes. Serve that
origin through the operator's reviewed TLS endpoint. Gateway pages must never
share its origin.

The trusted kernel configuration names its own `origin`, private Unix `socket`,
`administrator`, baseline/digest, reviewed releases and authorized evaluator plans.
It also names `keyFd`, normally 3. Supply exactly 32 bytes of master key through
that inherited descriptor from the operator's key store at every startup. Reuse
the same key for the same encrypted secret store. Never put the master key in the
configuration, environment, repository or an environment directory.

## Bind OpenRouter and promote a reviewed release

An operator-authorized live check completed two turns for each of two separately
sandboxed accounts using `openai/gpt-5.6-sol`, with a combined configured ceiling
of USD 0.04. This demonstrates live answers, not real-vendor prefix cache hits.
It is deliberately excluded from `scripts/test.ts`. To repeat this paid check:

```sh
"$THETIS_NODE" scripts/live.ts /opt/thetis/thetis.local.toml
```

The launcher requires Python 3's standard-library TOML reader, uses only
`llm.api_key`, and sends its bytes through inherited descriptors. It creates an
ephemeral encrypted secret store with a random master key, keeps raw secrets out
of configuration and logs, and removes the temporary deployment afterward. It
does not modify the operator's TOML. Each invocation can spend up to USD 0.04;
model availability and reviewed prices must be rechecked before future use.

Start with the working mock deployment so the trusted origin is available before
requiring a provider secret. With an authenticated administrator session, send
`POST /secret.set` to the kernel origin with:

```json
{"scope":"deployment","name":"llm-key","value":"the value supplied privately"}
```

Transmit the JSON over standard input (`curl --data-binary @-`, for example) or a
private client descriptor. Do not paste the value into shell history, settings or
command arguments. The provider requests `secret/llm-key`; the kernel delivers it
at the approved spawn. A failed personal scope lookup never uses deployment's
value as a fallback.

Assemble a reviewed candidate in which target `provider` uses
`provider-openai-compatible`, `service.ts`, spawn `provider`, and its declared
network egress capability. Its settings need an HTTPS endpoint (the default is
`https://openrouter.ai/api/v1/chat/completions`) and a reviewed `models` declaration
matching the provider contract. Supply the exact model id, context window, maximum
output, capabilities and prices in USD per million tokens; cached read/write
prices are required for explicit caching. When preparing an installation for a specific real model, set mock `settings.modelId`
and both environment `runtime.model` values to that reviewed model id at initial
bootstrap. The mock then advertises the same id; promoting the compatible provider
can preserve both person environments unchanged. Each environment's ordinary
runtime model must match a declared id. A default
act offers the change to person environments; it does not silently replace
their individual model settings. Adopt the reviewed person profile before its
first request to the new provider. Keep the inherited cost rule separate
from adapter settings. The adapter reserves its conservative maximum before HTTP.
Egress requires the configured Linux network adapter; there is no unsandboxed
fallback.

Run the configured evaluator against the candidate digest. Its authorized source
submits evidence through `results.submit`; reported model scores cannot satisfy
the gate. Once observed evidence passes, the reviewer uses the trusted origin:

```sh
curl --unix-socket "$KERNEL_SOCKET" -H 'Origin: https://kernel.example' \
  -H 'Content-Type: application/json' -H "Cookie: __Host-thetis=$SESSION" \
  --data-binary '{"digest":"REVIEWED_DIGEST","baseline":1}' \
  http://localhost/default.prepare
```

Read the returned confirmation line. Submit its exact code, the same digest and
the same baseline to `/default.set`. A changed baseline needs fresh preparation
and evaluation. A package-origin request cannot perform this act, even with an
administrator's run token. Every deployment target freezes before any promotion;
a failed member restores the captured default, including members already switched.
Never emulate a passing evaluator submission or replace active pins by hand to
make the command succeed.
