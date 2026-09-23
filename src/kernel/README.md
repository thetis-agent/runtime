# Runtime module: kernel

The daemon's authority: who may do what, and the fixed seams everything else crosses. It runs in the host process, is loaded once, and is held for the process's life.

## What the daemon is, and is not

The daemon is identity, package authority, the fence, the pipe, the record, the port, the latch:

| Part | What it holds |
|---|---|
| Identity | Users, roles, passwords, tokens; every call is authorized against a user. |
| Package authority | Which packages a userspace has, who may install what, promotion, forks and un-forks. |
| The fence | One sandbox per userspace, opened and closed by the kernel, never entered by it. |
| The pipe | The steps of a turn, sent into the caller's fence in order, their results validated and applied, their events relayed. |
| The record | Sessions, configuration layers, grants, the journal. |
| The port | The door for browsers and the control socket for the command line. |
| The latch | The daemon's own quiet-wait restart, `thetis restart`, under systemd, without sudo. |

It runs steps and relays their events. It never makes a model call, never runs a tool, validates content envelopes and asset ownership without interpreting modality payloads, and never knows a package by name: the model-call loop is the `call` step of `@thetis/harness-core` in the `execute` phase, a tool runs inside that step, a provider request goes through the fence-to-kernel method `providers.call` and is routed by `call.model` to the provider's fence, and every per-package default is declared in that package's manifest. `defaultConfig().packages` is `{}`.

Seams have stable envelopes and opaque package payloads. Contract revisions are deliberate: runtime 0.2 introduces ordered content, explicit structured completion and scoped asset access. Further content kinds extend the payload without changing these seams:

| Seam | The list |
|---|---|
| Fence operations, kernel to agent | `ping`, `exec`, `step`, `enumerate`, `service.start`, `service.stop`, `shutdown`, `provider.models`, `provider.call`. |
| Fence-to-kernel methods | The cases of `createRpcHandler` in `rpc.ts`: `packages.*`, `sessions.*` (`complete`, `askText` and `delete` included), `assets.put`, `assets.read`, `models`, `providers.call`, `store.*` under the fence's own namespace, `config.*` at the fence's own layer, `auth.*`. |
| Control methods | The cases of `createControlHandler` in `control.ts`: `users.*`, `packages.*`, `config.*`, `sessions.*`, `fence.reload`, `restart.*`, `status`, `journal.tail`, `models`, `ping`, and the `default` branch, which dispatches `host.<package>.<export>` to a host package. |
| The door's routes | `/`, `/login*`, `/logout`, `/<user>/*`. |
| The shapes | `StepContext`, `StepResult`, `ProviderCall`, `ToolSpec`, `TurnEvent`. |

`test/kernel/seams.test.ts` snapshots these lists, so a change to any of them is a deliberate edit of a list and never a side effect.

How a new need is met:

- A capability (a tool, a step, a provider, a service, a page) is a package. The next call has it; a service's module graph or a provider needs `thetis reload --user <id>`.
- A setting is a manifest declaration under `thetis.config`, read live; a change to `thetis.config.json` is `thetis config reload`.
- An admin feature that needs the host itself (its filesystem, its key store, the grant records) is a package of type `host`, such as `@thetis/host-grants`, which the host loads by `thetis.host.name` from the checkout or the promoted packages and re-imports whenever its entry changes; it answers `host.<name>.<export>` over the operator channel, and an edit to it is live on its next call.
- A new daemon process is for the daemon's own bugs only, and the daemon does it itself: `thetis restart`.

Modality handling belongs in packages. Changes to ownership or cross-fence authority require an explicit runtime contract revision.

## What it provides

An internal runtime module, not an installable extension. The kernel must stay under the line count its guard sets, stated in `test/kernel/loc.test.ts`. The 0.2 revision raises that budget to 1,420 for scoped asset authority and structured completion; content conversion and binary file mechanics remain in packages and `lib`.

The kernel imports the internal `contracts` and `lib` modules through relative paths. It depends on the `Fences` interface; the host binds a sandbox implementation. It never imports the host or sandbox. `test/architecture.test.mjs` enforces these boundaries.

| Class or export | Responsibility |
|---|---|
| `AssetAccess` | Per-owner binary access and provider grants scoped to one invocation; depends on the injected `AssetStore` interface. |
| `UserStore` | User records in the store namespace `users`, and `authorize`. |
| `AuthService` | Passwords (scrypt) and login tokens in the private store namespaces `auth/credentials` and `auth/tokens`. `forget(id)` drops both for one id: `setPassword` uses it, and the host calls it when a user is removed, because an id that comes back must come back with nothing. A suspension revokes nothing -- `authorize` refuses the tokens while it lasts, and lifting it gives the person back what they had. |
| `ConfigService`, `Settings` | Per-package configuration: the four layers along the fork chain, who may set what, secrets, the journal rows, and which fences a change reaches. `Settings` is the one method a dispatch site needs, `effective`. |
| `ServiceSupervisor` | Starts, stops, and restarts in place the services that packages declare, and remembers the ones it could not start: `notRunning` is, per userspace, the services whose last start threw, each with the moment and the reason. It is the only place that ever tried to start anything, so it is where `status` gets the truth from; an entry goes the moment that service does start. |
| `PackageRegistry`, `PackageManager`, `readManifest`, `validateManifest` | Package records, ownership and peer checks, seeding, promotion, install and uninstall, forks and the way back out of one. |
| `ProviderRegistry` | Provider discovery and model resolution: which fence serves `call.model`. |
| `SessionApi` | The session API for gateways. Every call is authorized against a user. |
| `Enumerator`, `PipelineRunner` | The step list, and one turn: each step into the caller's fence, its result validated and applied, its events relayed. The step's `phase` goes into the fence with it -- an optional field on the operation, as every seam is extended -- because the fence bounds a step by what kind of step it is: `execute` runs the model loop and is legitimately long, and a step that builds a prompt or records the call is not, so the agent gives the second kind an allowance and fails it by name. A step's events reach the person as they arrive, but its result reaches the *record* only when the request resolves: a step that rejects never sees `apply`, and the turn's `finally` then saves a conversation holding only what was typed. The wire and the record do not agree by themselves, which is why a fence that has to be stopped is asked to stop and its answer waited for, rather than settled where it stands. |
| `createRpcHandler` | The methods a fence can call on the kernel, `providers.call`, `store.*` under the fence's own namespace and `config.*` at the fence's own layer included. |
| `createControlHandler`, `redact` | The operator methods of the control socket, also reachable from an admin's fence as `operator.<method>`, and the dispatch of `host.<package>.<export>` to a host package. |
| `KernelError` | `CodedError` from `@thetis/runtime/lib/error`, with a `code` such as `invalid`, `unauthorized`, `not-found`, `busy`, `cancelled`, `fence`, `package`, `provider`, `step`, `tool`, `rpc`, `storage`. |

## Configuration

`KernelConfig` is loaded by `loadConfig(home, projectRoot)`: the defaults from `defaultConfig`, then `$THETIS_HOME/thetis.config.json` over them, then every `${NAME}` in a string replaced from the environment, except under `packages`, which keeps its references for the config service to resolve at read time. The fields are `model`, `phases` (default `["history", "prompt", "tools", "call", "execute", "after"]`), `enumerator`, `systemPackages`, `packages` (the file layer of per-package configuration; the defaults are `{}`), `storage` (`{ driver }`), `fence`, `door`, `control`, and `requestTimeoutMs`, plus the derived paths `home`, `systemPackagesDir`, `promotedPackagesDir`, `sharedDir`, `agentPath`, and `envFile`. `packagesLayer(home)` reads the `packages` layer again for `config.reload`. `saveConfig` writes the file without the derived paths; only `thetis init` calls it. `envFile` is the one derived path a data directory may override, because it decides which secrets the whole installation runs on: the default is the checkout's `.env`, which is where `deploy/install.sh` puts the provider key, so a second data directory under the same checkout inherits that key without being told. Setting `envFile` in the data directory's configuration opts out; a relative value is resolved against the home, and it is written back relative so a moved checkout still works. `thetis serve` prints the file it read, because a daemon quietly running on someone else's key is exactly what nobody notices.

`CONFIG_TIERS` declares per key what a change takes: `dispatch` keys are live on `thetis config reload`, `fence` keys reopen every fence, `boot` keys (`door`, `storage`) want a new process. `config.reload` asks the config service what changed **before** `applyInPlace` rewrites the kernel's configuration object, and with the newly read file rather than that object: the service was constructed from it, so asking afterwards was asking it to compare a thing with itself, and no package ever counted as changed and no service ever restarted on a configuration change. `ConfigService.reload` keeps a copy of the layer for the same reason. The `RestartLatch` reads `control` through the configuration reference on each use, so `control.*` is live too.

A package's code receives `ConfigService.effective(userspace, name)`: the declared defaults from the manifest, the file layer, the system layer and the person's layer merged along the fork chain, secrets included, `${NAME}` references resolved from the process environment and the `.env` file as they are now. Plain-object values merge one level deep across layers, so a file layer `embeddings: { baseUrl }` keeps a declared `embeddings.apiKey`; arrays and scalars replace. The layers live in the store (`config/*`, `secrets/*`); `LayeredConfig` in `@thetis/runtime/lib/config` is the mechanism and this package decides who may write which layer. The declaration fields are in `contracts/config.ts`.

## Use

A host process builds a kernel through `@thetis/runtime` and reaches this package's classes on it:

```ts
import { createKernel } from "@thetis/runtime";
import { loadConfig } from "@thetis/runtime/kernel";

const kernel = await createKernel(loadConfig(home, projectRoot));
const ref = kernel.sessions.create("alice");
for await (const event of kernel.sessions.send("alice", ref.id, "hello")) {
  if (event.type === "text") process.stdout.write(event.delta);
}
await kernel.shutdown();
```

`SessionApi`: `create(userId, { parent? })`, `send(userId, sessionId, input)` as an `AsyncIterable<TurnEvent>`, `ask` for the final text, `cancel`, `delete`, `inspect`, `list`. A session runs one turn at a time; a second `send` fails with the code `busy`. A session is found only in the caller's own userspace.

The rules the kernel enforces on every call: an unknown or suspended user is rejected; RPC from a fence acts as the fence's own user and no argument can name another; `auth.login` is answered only for the system userspace; a user installs only into `@<own id>/*` and only admins install `@thetis/*`; an operator method from a fence needs an admin, except `fence.reload` naming the caller's own id, which anyone may ask for; a `host.*` call needs an admin or the control socket and is journalled without its arguments.

A fork is measured against the package it was copied from, and `packages.list` is where that happens. The manifest records only what the origin was at the time of the copy, which is a fact that never changes and so never says anything; `PackageInfo.fork` adds the two that do -- `shipped`, the version of that origin on disk here now, and `identical`, true when the two directories hold the same files apart from the name and version a fork rewrites (`samePackage` in `@thetis/runtime/lib/pkg-fs`). Reading two package trees costs a few milliseconds, so it is done on the way out to a person and not in the internal `installed` list. `packages.unfork(userspace, name, deleteFiles?)` is the way back: it finds the origin before it removes anything, refuses when the origin is not on disk here, then swaps -- the fork's service and link go, the origin's come -- and deletes the fork's files last and only if asked. The ordering is the safety: the package a person is most likely to fork is their own web gateway, and they are looking at the fork through it.

The fork rule runs in both directions, and they are not the same rule. A fork whose manifest names an origin installed here displaces it: the origin stops and is unlinked before the fork's link and service come, and the registry records what was displaced so an uninstall puts it back. A package whose fork is already installed here is *refused*, with the code `fork` and a message naming the fork. The asymmetry is the point. A displaced origin is recoverable -- it is shipped or promoted, `restore` puts it back by name, `unfork` exists to ask for that. A displaced fork is the person's own work and nothing here could put it back: the registry holds one document per package name with the userspaces it is in, so recording that `@thetis/gateway-web` had displaced one person's fork would claim it in every userspace holding the shipped gateway. Leaving both installed, which is what happened before, is worse than either: two gateways bind the same `run/web.sock` and the second to start takes it from the first. `seedSystem` skips a forked package for the same reason; it is the one path that installs a system package without going through `install`.

The fleet-wide paths in `control.ts` -- `packages.installEveryone`, `packages.promote` -- ask `forkOf` before each install instead of catching the refusal, so a sweep does not stop halfway through the fleet on one person's private decision. They answer `{ name, userspaces, forks }` and journal the same pair: an admin acting on people who are not at the keyboard must not read "installed for everyone" and walk away believing it. The people themselves are told on their own listing, where `PackageInfo.fork.everyone` says the package they forked is the house default.

`status` answers `{ daemon, restart, workspaces }`. A workspace entry is `{ user, openedAt, codeAt, stale, services, down, changed }`.

`services` and `down` are one answer split in two, from `serviceState`: the installed packages that declare a service, divided by whether the last start of each worked. `down` is `[{ name, since, error }]`. This used to be a single list of every installed package that declares a service -- a list of declarations presented as running state -- and `@thetis/marketplace` failing to start at boot with `ERR_MODULE_NOT_FOUND` therefore read as perfectly healthy for seventeen minutes while the marketplace index went stale and nobody was told. A service that is not running is now never folded into the ones that are; it is named, with since when and what it said, on the row and again in full at the foot of `thetis status`, with the reload that starts it. `fence.reload` answers the same pair, so a reload that brought everything back except one thing says so while someone is watching.

`changed` is `[{ name, loaded, onDisk }]`: every installed package whose open fence read a version other than the one on disk now. It is empty when none differ and when no fence is open. The same fact rides on each package a caller is listed (`packages.list`, from the control socket or from a fence) as `PackageInfo.loadedVersion`, which the pool records when a fence opens and forgets when it closes, and which is never set on the system-wide registry record. This is what makes a change to a package shipped with the service visible: its files are installed the moment they land, so nothing is behind a registry, and what puts the new version into service is a workspace reload.

## Files

| File | Content |
|---|---|
| `kernel.ts` | `KernelServices`, the interface of one running kernel. |
| `config.ts` | `KernelConfig`, `defaultConfig`, `loadConfig`, `saveConfig`, `configPath`, `packagesLayer`, `CONFIG_TIERS`. |
| `settings.ts` | `ConfigService`, `Settings`, `ConfigChange`, `Affected`, `ConfigTarget`. |
| `users.ts`, `auth.ts` | `UserStore`, `AuthService`, over `StoreMirror` namespaces. |
| `services.ts` | `ServiceSupervisor`. |
| `packages/manifest.ts`, `registry.ts`, `manager.ts` | Manifest validation, the package records, the package manager. |
| `providers.ts` | `ProviderRegistry`. |
| `sessions/api.ts` | `SessionApi`, `SESSION_ID`. |
| `pipeline/enumerator.ts`, `runner.ts` | `Enumerator`, `PipelineRunner`. |
| `rpc.ts`, `control.ts` | `createRpcHandler`, `createControlHandler`, `redact`. |
| `index.ts` | The public API. |

## Tests

`npm test` from the runtime root builds and runs every suite. The kernel suites live under `test/kernel/`: `loc.test.ts` counts the lines of code and fails at the `LIMIT` in that file, not counting imports, re-exports, blank lines, comment-only lines or tests; `seams.test.ts` snapshots the seams above, the runtime exports of `@thetis/runtime/contracts`, the keys of `CONFIG_TIERS`, and that `defaultConfig().packages` is empty; `unit.test.ts` covers the user store, the auth service, manifest validation, the enumerator, the configuration, redaction, the service restart, a service whose start fails being left out of `status`'s running list and reported under `down` with the moment and the reason until it starts, the config service, the `store.*` and `config.*` RPC handling, the refusal of a storage driver at install, and the fork round trip: what a listing says about a fork whose origin has moved on, that un-forking puts the origin back whether or not the registry recorded anything as displaced, and that a package whose fork is already installed here is refused by name and skipped by the seed. The model-call loop's tests (cancel mid-stream, dangling tool calls closed, unknown tool refused, withheld honoured, partial text kept) live with `@thetis/harness-core`. To run one alone after `npm run build`: `node --test dist/test/kernel/loc.test.js`.
