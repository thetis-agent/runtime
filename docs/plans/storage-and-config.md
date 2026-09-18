# Plan: storage drivers and a live configuration service

**Date:** 2026-09-18. **Status:** implemented 2026-09-18 (relocation pending the user's `sudo deploy/relocate-zero.sh`). **Scope:** a storage contract with a swappable host-plane driver (`@thetis/store-toml` first, sqlite next), the kernel records on it, a configuration service with declared keys, layers, fork inheritance, secrets and live changes, `env.storage()` for packages, and the move of the production data directory to `/opt/zero/data`.

---

## Context

Two production incidents on 2026-09-17/18, both by construction:

1. **A fork loses its config, globally.** Per-package config is `packages[<name>]` in `thetis.config.json`, read by exact name at four kernel sites (`runner.ts:78`, `provider-call.ts:106`, `services.ts:85`, `providers.ts:83`) with `?? {}`. A fork has a new name, so `@bitmuse/notion-read` got `{}` and every Notion tool said "no token configured" for 2½ hours. The registry record already carries `forkedFrom`; nothing reads it for config. Promote has the same hole (`@alice/foo` → `@thetis/foo` orphans `packages["@alice/foo"]`).
2. **Any config change needs `sudo systemctl restart`.** The CLI reads `.env` once, `loadConfig` interpolates `${VAR}` once into literals, and `createKernel` holds that object for the daemon's life. `thetis reload` replaces a fence's code, not the config the kernel holds. A missing variable silently becomes `""`. Two restarts on 2026-09-17 needed the user.

Facts that shape the plan:

- Production ("zero", zero.bitmuse.me) runs from the checkout `/tank/data/Dev/thetis-agent/runtime` with data in `runtime/.thetis` (566 MB) on NFS (`10.10.5.1:/tank/data`, 96% full). `/opt/zero` is the disabled v2 install (root-owned, 184 MB; `/opt` itself is bitmuse-owned). The local pool has 7.3 TB free.
- The kernel counts 1231/1400 lines; mechanism must go to `@thetis/lib`. The boundary test allows host to import contracts/lib/sandbox/kernel only. No third-party runtime dependency anywhere. Node 24.
- There is no storage abstraction: every writer is `readJson/writeJson` over a path it composed (kernel: users/auth/registry/mounts/sessions/journal; packages: `plans/`, `projects/`, `skills-hybrid/vectors.json`, `gateway-web/state.json`, all under the person's home, namespaced by convention). Uninstall and delete never clean any of it. `PackageListener` is single-slot (the supervisor). The kernel's record stores (`UserStore`, `AuthService`, `PackageRegistry`, `MountStore`) are read synchronously everywhere (`rpc.ts:31`, `control.ts:20`, `SessionApi.create`, `seedSystem`).
- Manifests declare nothing about config; the only key registry is a prose table in `docs/09-configuration.md`. `UiCommandEnv` has no `config` (a UI command sees gateway-web's `ServiceEnv` spread in). `StepEnv.store` is already the package-store *path* (`guest.ts:24`, used by gateway-web).
- v2 (`/tank/data/Dev/thetis-agent.v2/runtime`) has the precedent: ADR 0040 (storage behind a contract; the kernel imports a fixed default, never a discovered package), ADR 0016 (packages declare settings with kinds incl. `secret`, validated before init), ADR 0009 (scoped secrets, no silent fallback).

**Decisions taken with the user (2026-09-18):** production data relocates to `/opt/zero`; the on-disk format is the driver's business and the first driver writes **TOML flat files**; the model may set config from a conversation, **secrets included**; sqlite is a follow-up, this round ships the TOML driver plus a conformance suite that makes the next driver safe.

Outcome: a fork inherits its origin's config and says so; a config change (file, CLI, panel, or tool) is live without a restart; secrets can be set at runtime and never print; deleting a package clears what it owned; the kernel holds authority over config and nothing about how it is stored; packages get a namespaced `env.storage()` instead of ad-hoc files.

## Design

### 1. The `Store` contract (`packages/contracts/src/storage.ts`)

```ts
export interface StoreOpenOptions { private?: boolean }            // unreadable to other host users: 0700/0600 in the TOML driver
export interface Store {
  get<T extends object = Record<string, unknown>>(key: string): Promise<T | undefined>;
  set(key: string, doc: object): Promise<void>;                     // whole-document replace, atomic
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;                                           // this namespace and every one beneath it
}
export interface StoreDriver { open(namespace: string, opts?: StoreOpenOptions): Store; close?(): Promise<void>; }
export type StoreFactory = (opts: { root: string; log: (line: string) => void }) => StoreDriver | Promise<StoreDriver>;
```

Namespaces nest by `/`. Ids: segments `^[a-z0-9@_][a-z0-9._@-]{0,127}$` (case-insensitive), at most 16, never `.`, `..` or empty, checked by `assertStoreId` in lib before anything becomes a path; package names (`@thetis/exa`) and hex tokens are legal. Documents are JSON objects (not arrays) with string, number, boolean, array and object values; `null` anywhere is refused (TOML has no null). Also `packages/contracts/src/config.ts`: `ConfigDecl` (`{ type: "string"|"number"|"boolean"|"object"|"array"; secret?; required?; default?; scope?: "system"|"user"; help? }`), `ConfigLayer`, `ConfigKeyState` (`key, state: "set"|"missing"|"unset", value? (never for a secret; a pure ${VAR} ref is shown as the ref), source?, inheritedFrom?, missing?: string[], secret, declared, type?, required?, scope?, help?`). `ThetisField.config?: Record<string, ConfigDecl>`. `StepEnv.storage(namespace?: string): Store`. `KernelClient.config = { show(name), set(name, key, value), unset(name, key) }`.

### 2. `@thetis/store-toml` (new, `packages/store-toml`)

A host-plane package like `@thetis/door`: `thetis: { type: "storage", export: "createStore" }`; description ends "Runs on the host; chosen in thetis.config.json, not installed." `PackageManager.install` refuses type `storage` (code `invalid`, message names `storage.driver`); the marketplace mirror skips type `storage`.

- `src/toml.ts`: TOML 1.0 reader and writer, no dependency. Reader: tables, arrays of tables, dotted keys, basic/literal/multi-line strings with escapes, integers (`_`, hex/oct/bin), floats (inf/nan), booleans, arrays, inline tables; datetimes kept as strings. Writer: deterministic key order, scalars before tables, `[a.b]` for nested objects, `[[x]]` for arrays of objects, multi-line basic strings for text with newlines. Fixtures per construct plus round-trips of every kernel record shape and a session-record-shaped document.
- `src/index.ts`: `createStore({ root, log })`. Layout `<root>/<namespace>/<key>.toml` (a `/` in a key is a directory); tmp + rename, directory on demand; `private` namespaces 0700 with files 0600; `list` reads the directory and strips `.toml`; `clear` removes the directory tree.
- `test/`: its own cases plus the shared conformance suite; `README.md`.

### 3. Conformance suite (`packages/lib/src/store-conformance.ts`)

`storeConformance(name, open: () => Promise<StoreDriver>)` registers `node:test` cases: nested-doc round-trip, unicode, large arrays, list with prefix, delete idempotence, clear removes the subtree, id rejection, private mode, concurrent sets to one key end with one of them, a crash-safe write (a leftover tmp file is never a document). A driver passes this or it is not a driver. Sqlite later runs the same suite.

### 4. Lib mechanism (`packages/lib`, uncounted)

- `src/store.ts` (`@thetis/lib/store`): `assertStoreId`, `assertStoreDoc(doc, maxBytes = 256 KiB)`, `memoryStore()` (Map-backed, for tests and the bench), and `StoreMirror<T>`: `static open(store)` lists and loads every doc once, sync `get/keys/all/set/delete`, writes queued to the driver in order, `flush()` awaited on shutdown. This is what keeps `users.authorize` and friends synchronous; the semantics equal today's read-once `JsonFile`.
- `src/config.ts` (`@thetis/lib/config`): `validateDecls`, `forkChain(name, thetisOf)` (origin first, cycle-guarded, limit 8), `mergedDecls`, `defaultsOf`, `isSecretKey` (decl, else `/key|secret|token|password/i` for undeclared keys), `checkValue`, `mergeDocs` (top-level keys, later wins, records the source layer and package per key), `findRefs`/`resolveRefs` (an unresolved leaf is dropped and reported under its top-level key, never `""`), `describe(chain, docs, env): ConfigKeyState[]`, `changedPackages(before, after)`, `parseDotEnv` (moved from gateway-cli), `EnvFile` (re-parses on mtime change; a name the shell set wins over the file, a name that came from the file follows the file), and `LayeredConfig(driver, filePackages)` with `docs(chain, user?)` in **layer-major order** (`default(O), default(P), file(O), file(P), system(O), system(P), user(O), user(P)`, so a user override on the origin still beats a file entry on the fork, and a fork's own key beats its origin's at every layer), `write/remove/forgetPackage/forgetUser/copySystem/invalidate`. Namespaces: `config/system`, `config/users/<U>`, `secrets/system`, `secrets/users/<U>` (private), one doc per package name.
- `src/mounts.ts`: `MountStore` takes a `StoreMirror<{ mounts }>`; `parseMountList` moves here from `control.ts:201-209`.

### 5. Kernel (`packages/kernel`, counted; estimate 1231 → ~1365 of 1400)

| File | Change |
|---|---|
| `src/config.ts` (92→~102) | `KernelConfig.storage: { driver }` (default `@thetis/store-toml`) and derived `envFile` (`<root>/.env`, stripped by `saveConfig`). `DEFAULT_PACKAGES` extracted; `packagesLayer(home)` = defaults under the file's `packages`, re-read by `config.reload`. `loadConfig` interpolates everything **except** `packages`, which keeps its `${VAR}` references. |
| `src/settings.ts` (new, ~65) | `ConfigService`: `effective(us, name)` (every layer along the fork chain, refs resolved from `EnvFile.snapshot()`, unresolved leaves left out); `show(target)` (secrets never carried); `set(target, key, value, actor, fromFence?)` (a fence writes only its own user's layer and never a key declared `scope: "system"`; the operator writes either layer; refuses `null` and a declared-type mismatch); `unset`; `reload(next)` returns the changed packages; `forgetPackage/forgetUser/copySystem`; `onChange(listener)` with `affected` = the package and every fork descending from it in the userspaces that hold them. Journal `config.set`/`config.unset` with `package`, `key`, layer, `secret` flag, never the value. Fork chain resolved through a new `PackageManager.manifestOf(us, name)` (store link, else shipped/promoted dir) because `displace` uninstalls the origin when a fork installs. |
| `src/pipeline/runner.ts:78`, `src/pipeline/provider-call.ts:106`, `src/providers.ts:83`, `src/services.ts:85` | `await this.settings.effective(us, pkg)` at dispatch; `Settings = Pick<ConfigService, "effective">` is the dependency. |
| `src/services.ts` (+9) | `restart(user, name)`: `service.stop` then `service.start` with the new config, fence stays open, nothing else touched. |
| `src/packages/manager.ts` (234→~248) | `observe` becomes a list, listener methods optional plus `deleted(us, name)` and `promoted(from, to)`; `delete` notifies after `uninstall`; `promote` becomes async and notifies; `manifestOf`; refuse type `storage`. |
| `src/packages/manifest.ts` (+1) | `validateDecls` on `thetis.config`. |
| `src/users.ts`, `src/auth.ts`, `src/packages/registry.ts` | Onto `StoreMirror` namespaces `users`, `auth/credentials` + `auth/tokens` (private), `registry`; net −2 lines. |
| `src/rpc.ts` (65→~85) | `store.get/set/delete/list/clear` on `userspaces/<fence user>/<package>[/<namespace>]` (the kernel builds the id, the fence names only the tail; docs capped at 256 KiB); `config.show/set/unset` for the fence's own user on a package installed there (`not-found` otherwise). |
| `src/control.ts` (190→~193) | `config.show { name, user? }`, `config.set`, `config.unset`, `config.reload`; `config.get` unchanged (the redacted file layer, refs unresolved). `parseMountList` from lib. |
| `src/kernel.ts` (+2) | `settings`, `store` on `KernelServices`. |

Fallback trims if the count lands high: `status()` (20 lines) to `@thetis/lib/freshness`, `redact` (5) to lib.

### 6. Host and CLI (uncounted)

- `packages/host/src/store.ts`: `loadStoreDriver(config)` dynamic-imports the package named by `storage.driver` (shipped dir, then promoted dir) and calls its export with `root: <home>/store`; refuses to start with one sentence when the driver is missing or fails a smoke `open/set/get`. `openRecords(driver)` opens the five mirrors. The kernel never imports a driver; it depends on `StoreDriver` bound as `T.store`, as it depends on `Fences`. The boundary test sees static imports only; `store-toml` is added to `ALLOWED` as `["contracts","lib"]`.
- `packages/host/src/migrate.ts`: `assertMigrated(home)` (a legacy `users.json`/`auth.json`/`registry.json`/`mounts.json` present → refuse to boot with "run thetis migrate"); `migrateStore(config)` imports each file into its namespace and renames it `<file>.migrated`; idempotent (`set` overwrites, a second run imports nothing).
- `packages/host/src/kernel.ts`: `createKernel` becomes **async** (loads the driver, opens the mirrors); tokens `store`, `records`, `env`, `settings`; wires `packages.observe(services)`, `packages.observe({ deleted: forgetPackage + clear userspaces/<U>/<P>, promoted: copySystem })`, `settings.onChange(providers.forget + services.restart per affected)`; `removeUser` also `forgetUser` and clears `userspaces/<U>`; `shutdown` flushes the mirrors and closes the driver. Callers gaining one `await`: `gateway-cli/src/index.ts:110,120`, `host/test/e2e.test.ts:50`, `gateway-web/test/{gateway,ui}.test.ts`, `bench/src/arena.ts:156` (tests bind `memoryStore()` to `T.store`).
- `packages/gateway-cli/src/index.ts`: `loadDotEnv` uses `parseDotEnv`; `thetis config` alone prints as today; `thetis config show <pkg> [--user <id>]` (table: key, state, value or `•••`, source, inherited-from, missing vars), `thetis config set <pkg> <key> [<value>] [--user <id>] [--json] [--stdin]` (a secret without a value is read from stdin so it never lands in `ps`), `thetis config unset`, `thetis config reload` (prints the changed packages and the services restarted); `thetis migrate [--home <dir>]` refuses while a daemon answers the socket. `HELP` updated.

### 7. Userspace agent, gateway-web, tool-exec, panels

- `packages/userspace-agent/src/agent.ts`: `kernel.config.{show,set,unset}` RPC; `storageClient(pkg, ns?)` over `store.*` (`null` → `undefined`); `envFor(pkg)` gives `step`, `tool` and `service.start` an env whose `storage()` is bound to the package being run; the bare `env.storage` throws "no package" so a stray use is loud.
- `packages/gateway-web`: `UiCommandEnv.config` filled by `config.effective`-shaped RPC for the package whose command runs (the kernel answers only for a package installed in that fence's userspace), so a UI command sees its own config, not gateway-web's.
- `@thetis/tool-exec`: `configure_package { name, key, value?, unset? }` sets the caller's own layer for a package installed in their userspace, secrets included; the reply names the key and the new state and whether a service restarted, never the value; its description says a secret pasted in the transcript stays in the transcript. `package_config { name }` returns the describe output so the model can diagnose instead of guessing.
- `@thetis/ui-admin`: a **Configuration** section (system layer): one card per installed package that declares config or has any, a form from the declarations (secret fields write-only with "set" / "not set"), undeclared keys as a JSON textarea, the source of each value, a section-level sentence when any required key is missing anywhere. `@thetis/ui-marketplace`: **Configure** in the package row (the person's own layer, same form) and a row sentence naming a missing required key ("token is required and not set") so a person sees it before an agent does.
- Declarations added: `provider-openrouter` (apiKey secret required, baseUrl, headers, defaults, cache), `exa` (apiKey secret required, baseUrl, timeoutMs, defaults), `skills-hybrid` (embeddings object, fusionWeight, pinLimit, pinBodies), `gateway-login` (secure, `scope: "system"`), `marketplace` (registries, refreshMinutes, `scope: "system"`), `terminal` (`sessions`, `bufferBytes`, `idleMinutes` declared `scope: "system"` so a person cannot raise an admin's limits; `shell`, `waitMs` user-settable), `prompt-cache`. `@bitmuse/notion` in bitmuse's home gets `config: { token: { type: "string", secret: true, required: true } }` and its error text drops the restart line. Marketplace mirror skips type `storage`.

### 8. What changes live, and what still needs a restart

`packages[*]` (file after `config.reload`, or any `config.set`) and `model` are live: steps and tools on their next call, providers via a new instance (the agent memoises by `JSON(config)`) plus `providers.forget`, services via `services.restart`. `fence`, `door`, `systemPackages`, `control`, `storage` stay restart-tier; the docs say so in one table (`docs/25` and `docs/10` section 4.1 get a "configuration" row).

### 9. Documented guarantees this touches (fix in the same docs pass)

- `docs/12-security.md` §6 "the kernel does not manage user secrets" → it does now: private store namespaces, reach only the fence they are for inside that package's effective config, never returned by `config.show`, key names only in the journal, the tool-and-transcript hazard. §6 `auth.json` → `store/auth/*` private (e2e asserts every file under `store/auth` and `store/secrets` is 0600). §2 "only its own `config.packages[<name>]`" → the layered effective config, and a fork receives its origin's. §3 disk → a 256 KiB per-doc cap, no total quota. §4 "no argument can name another user" → `store.*`/`config.*` take a package name; the kernel prefixes the fence's own user. §9 journal rows `config.set`/`config.unset`.
- `docs/12` §2 already drifts: `defaultConfig` sends `${OPENROUTER_API_KEY}` to every person's fence through `@thetis/skills-hybrid`. Pre-existing; state it plainly in the rewrite rather than hide it.
- `docs/02-kernel.md` §2 says 1,200; the test says 1,400. Fix.
- `host/test/e2e.test.ts:356` isolation probe reads `users.json`, vacuous after migration → probe `store/`.

## Steps

Subagents with disjoint file ownership; I write the contracts (sections 1, 4 signatures, 7 RPC names) first so every agent implements against one fixed thing, and treat every report as a claim to verify.

1. **Contracts + lib** (`contracts/src/{storage,config,guest,packages,index}.ts`; `lib/src/{store,config,store-conformance,mounts}.ts` + tests). Build green, no behaviour change.
2. **`@thetis/store-toml`** (codec, driver, conformance, README).
3. **Records onto mirrors + host + migrate** (`kernel/src/{users,auth,packages/registry}.ts`, `host/src/{store,migrate,kernel}.ts`, async `createKernel` and its callers, `thetis migrate`). Build and e2e green before any config feature.
4. **Config service** (`kernel/src/settings.ts`, `manager.ts` listeners + `manifestOf` + type refusal, the four dispatch sites, `services.restart`, `rpc.ts`, `control.ts`, host wiring, CLI `config` subcommands). LOC test passes.
5. **Agent + gateway-web** (`env.storage`, `kernel.config`, `UiCommandEnv.config`).
6. **tool-exec** (`configure_package`, `package_config`).
7. **Panels** (ui-admin Configuration, ui-marketplace Configure + row sentence).
8. **Declarations** in the packages of section 7, marketplace skip.
9. **Docs**: rewrite `docs/09-configuration.md` (layers, declarations, `${VAR}` at read time, live tiers, CLI); new `docs/26-storage.md` (contract, driver, conformance, `env.storage`, what lives where, sqlite next); `05-packages.md` (the `config` field, type `storage`, delete/promote and config, fork inheritance in §16, the service-restart row in §13); `02-kernel.md` (modules, `T.store`, the count); `03-fence.md` (`storage()`, `config.*`/`store.*` rows); `06-sessions-and-users.md` and `09` §1 (files → `store/<namespace>`); `12-security.md` (section 9 above); `13-limitations-and-roadmap.md` (drop the two solved gaps; add sqlite and the journal on the store); `25-restart.md` + `10-development.md` (config tiers); `17`, `18`, `08-cli.md`; `docs/plans/storage-and-config.md`. Also correct the `sudo cp deploy/thetis-runtime.service` lines in `15` and `25` to "diff, then adapt the four paths" (the known trap).
10. **Tests**: `npm test` under bubblewrap and unfenced (see Verification).
11. **Commits**: `packages` first, then the submodule pointer in `runtime`; push both, packages first.
12. **Production**: below.

## Migrating zero to /opt/zero

Target, owned by bitmuse (the unit's user):

```
/opt/zero/data/            THETIS_HOME: thetis.config.json, store/, userspaces/, shared/, packages/, journal.jsonl, thetis.sock
/opt/zero.v2-20260918/     the v2 install that was at /opt/zero (root-owned, untouched)
```

Code stays in the checkout; the unit's `WorkingDirectory` and `ExecStart` do not change. `runtime/.env` sets `THETIS_HOME=/opt/zero/data` (absolute; `resolve(PROJECT_ROOT, …)` keeps it). Sockets, the store and the journal move off NFS.

Done by me while the daemon runs:

1. `mv /opt/zero /opt/zero.v2-20260918` (`/opt` is bitmuse-owned; no sudo), `mkdir -p /opt/zero/data`.
2. Build, full test suite, commit, push.
3. Bulk `rsync -a runtime/.thetis/ /opt/zero/data/` while live.
4. Write `deploy/relocate-zero.sh`: stop the unit, `rsync -a --delete` the delta, `thetis migrate --home /opt/zero/data`, switch `.env` to `THETIS_HOME=/opt/zero/data` keeping `.env.bak`, start the unit, `thetis status`, `curl --resolve zero.bitmuse.me:443:10.10.10.1 https://zero.bitmuse.me/login`.

The user's one step (root, about a minute of downtime): `sudo deploy/relocate-zero.sh`.

After it, by me: `thetis config set @bitmuse/notion token --stdin` and `@thetis/exa apiKey` from the `.env` values; `thetis config show @bitmuse/notion-read` must say `token: set, inherited from @bitmuse/notion, secret`; drop `NOTION_TOKEN` and `EXA_API_KEY` from `.env`; `OPENROUTER_API_KEY` stays in `.env` because the shipped defaults and `packages/bench/src/cli.ts:83` read it. Browser pass on production: the Configuration section green, Configure in a package row, a `configure_package` call from a conversation changes a key and the next tool call sees it, a `config.set` on `@thetis/gateway-login secure` restarts only that service.

Rollback: `.env.bak` back and `systemctl restart`; the old `.thetis` stays untouched until the user deletes it.

## Verification

- `npm test` green under bubblewrap and unfenced; the LOC table prints under 1400; boundaries pass.
- lib: config layering (layer-major order, chain through two forks, own key beats origin, user override on the origin beats a file entry on the fork), `${VAR}` set / missing / mtime change / shell precedence, secrets never in `describe().value`, `checkValue` rejections, `StoreMirror` ordering and flush, id and doc validation, `LayeredConfig` over `memoryStore()`.
- kernel unit: `ConfigService.set` from a fence refuses `scope: "system"` and `null`; journal rows carry names only; `changed` fans out to a fork's userspaces; `services.restart` journals stop then start and never closes the fence; `validateManifest` rejects a bad `thetis.config`; `store.get` with `namespace: "../x"` refused; `config.show` of a package not installed here is `not-found`; type `storage` refused at install.
- host e2e (real fence): a system-level `config.set` changes the next reply with no restart; a fixture service restarts on `config.set` with `openedAt` unchanged; a fixture tool writes through `env.storage()` and a later turn reads it, another user's fence reads nothing, `delete_package` clears it, `removeUser` leaves no namespace; a user-layer secret reaches the tool's `env.config` and neither the RPC reply nor `config.show` echo it; a fork reports `inheritedFrom` and its tool gets the origin's key; every file under `store/auth` and `store/secrets` is 0600; migrate imports the four legacy files, renames them, and a second run imports nothing; the isolation probe cannot list `store/`.
- store-toml: conformance plus codec fixtures; a session-record-shaped document round-trips.
- Browser pass on the dev home (`THETIS_HOME=.devhome` recipe), then production after the relocation as listed above; `thetis status`, the login curl, a Notion tool call through the fork in a conversation.

## What changed against the plan

- The accessor is `env.storage()`, not `env.store`: `StepEnv.store` was already the package-store path (`guest.ts`), used by gateway-web, so the name was taken.
- `createKernel` is `async`. Loading the driver is an import and opening the records reads every document; the callers (`gateway-cli`, the host e2e, the gateway-web tests, the bench arena) each gained one `await`.
- The kernel records (`users`, `auth/credentials`, `auth/tokens`, `registry`, `mounts`) sit on a synchronous `StoreMirror` in `@thetis/lib/store`: reads from memory, writes queued in order, `flush()` on shutdown. `users.authorize` and friends stay synchronous.
- `config.reload` diffs the file layer only and restarts the services of the packages whose entry changed. A change to `.env` is live on the next call that resolves it (the `EnvFile` re-reads on mtime) but restarts no service; a service sees a new variable after `config reload` or a workspace reload.
- `manifestOf` finds a displaced origin through the fork's `replacedSource` in the registry, so the fork chain reads the origin's manifest after the origin's link is gone.
- `config.effective` exists as a fifth `config.*` RPC, for the web gateway to fill `UiCommandEnv.config` per call; it answers for any package installed in the same fence. `config.list` exists on the control table for the panel's per-package cards and `thetis config show` without a package.
- The two panels share the form by an identical copy (`ui/config-form.js` in ui-admin and ui-marketplace), held together by a test, because a package's page may import only its own files.
- A UI command's `env.storage()` is the gateway's namespace, not the command package's (recorded in `docs/13`).
- `thetis migrate` takes no `--home`; it reads `THETIS_HOME` like every command.
- The kernel counts 1,386 of 1,400 lines; the fallback trims (`status()` and `redact` to lib) were not needed.
