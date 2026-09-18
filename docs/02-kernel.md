# 02 Kernel

The kernel is the package `@thetis/kernel` in `packages/kernel`. It is the only code that decides who may do what. It runs in the host process. It holds authority, not mechanism.

## 1. The layering rule

Mechanism goes to a library. The decision about who may use the mechanism stays in the kernel. A part stays in the kernel only when delegating it would lose a guarantee that rests on the kernel being the one that does it.

The service plane is five packages. Each package imports only from the packages below it.

| Package | Directory | Holds | Imports from |
|---|---|---|---|
| `@thetis/contracts` | `packages/contracts` | Types and five constants. No code. | nothing |
| `@thetis/lib` | `packages/lib` | Mechanism with no policy: ids, JSON files, queues, the container, the journal, the RPC framing, the socket server and client, the userspace layout, package file operations, scrypt, the store checks and mirror, the configuration layers. | `contracts` |
| `@thetis/sandbox` | `packages/sandbox` | The fence implementation: bubblewrap, cgroups, slirp4netns, the agent process, the fence pool. | `contracts`, `lib` |
| `@thetis/kernel` | `packages/kernel` | Authority: users, passwords and tokens, sessions, the pipeline, package ownership, providers, the RPC table, the operator table. | `contracts`, `lib` |
| `@thetis/host` | `packages/host` | The composition root: `createKernel`, the token table `T`, the control socket. | `contracts`, `lib`, `sandbox`, `kernel` |

The kernel never imports the sandbox or the host. It depends on the interface `Fences` in `@thetis/contracts`. The host binds the sandbox's `FencePool` to that interface. The kernel depends the same way on `StoreDriver`: the host loads the storage driver named by `storage.driver` and binds it. The driver `@thetis/store-toml` is a host-plane package outside the five; the boundary test allows it `contracts` and `lib`. See [26-storage.md](26-storage.md). The test `packages/kernel/test/boundaries.test.ts` enforces the table. See [11-testing.md](11-testing.md) section 1.

Every other package imports `@thetis/contracts` for its types. Only `@thetis/host` and `@thetis/gateway-cli` import `@thetis/kernel`. The kernel does not re-export the contracts.

## 2. Rules for the kernel

- The kernel must stay under 1,400 lines of code. The test `packages/kernel/test/loc.test.ts` enforces the limit. See section 7.
- The kernel must not contain domain behavior. Prompts, tools, memory, and providers are packages.
- The kernel must not run package code in the host process. The kernel sends package code into a fence.
- The kernel must not know how the fence is built. It calls `Fences.request` and `Fences.handle`.
- Each class receives its dependencies through its constructor. The composition root in `packages/host/src/kernel.ts` wires all classes.

## 3. Source modules

### 3.1 `@thetis/kernel`

| File | Class or export | Responsibility |
|---|---|---|
| `src/kernel.ts` | `KernelServices` | The interface of one running kernel. The operator table and the gateways type against it. |
| `src/config.ts` | `KernelConfig`, `defaultConfig`, `loadConfig`, `saveConfig`, `configPath`, `packagesLayer` | The configuration file. `packages` keeps its `${VAR}` references; `packagesLayer` reads that layer again for `config.reload`. See [09-configuration.md](09-configuration.md). |
| `src/settings.ts` | `ConfigService`, `Settings` | Per-package configuration: who may set what at which layer, the fork chain, the journal rows, and which fences a change reaches. `Settings` is the one method a dispatch site needs, `effective`. See [09-configuration.md](09-configuration.md) section 4. |
| `src/users.ts` | `UserStore` | User records and authorization, over the store namespace `users`. |
| `src/auth.ts` | `AuthService` | Passwords and login tokens for network gateways, over the private namespaces `auth/credentials` and `auth/tokens`. The timing-safe compare stays here. |
| `src/services.ts` | `ServiceSupervisor` | Starts, stops and restarts in place the services that packages declare. |
| `src/packages/manifest.ts` | `readManifest`, `validateManifest`, `scopeOf`, `toInfo`, `declaresStep` | Manifest validation. |
| `src/packages/registry.ts` | `PackageRegistry` | The service-plane record of packages. |
| `src/packages/manager.ts` | `PackageManager` | Ownership and peer checks, seeding, promotion, install and uninstall orchestration, the fork replace and restore rules, delete, registry recording, `manifestOf` for the fork chain, the refusal of type `storage`, and the listeners. |
| `src/providers.ts` | `ProviderRegistry` | Provider discovery, model resolution, provider calls. |
| `src/sessions/api.ts` | `SessionApi`, `SESSION_ID` | The session API for gateways. Every call is authorized against a user. |
| `src/pipeline/enumerator.ts` | `Enumerator`, `BUILTIN_CALL`, `isBuiltin` | Builds and validates the step list. |
| `src/pipeline/provider-call.ts` | `ProviderCallStep` | The built-in call step and the tool loop. |
| `src/pipeline/runner.ts` | `PipelineRunner` | Runs one turn. Applies and validates mutations. Persists. |
| `src/rpc.ts` | `createRpcHandler` | The methods a fence can call on the kernel, the `store.*` namespace prefix and the `config.*` target included. |
| `src/control.ts` | `createControlHandler`, `redact` | The operator methods, `config.show`, `config.set`, `config.unset`, `config.reload` and `config.list` included. |
| `src/index.ts` | Re-exports | The public API. `KernelError` is `CodedError` from `@thetis/lib/error`. |

### 3.2 `@thetis/contracts`

| File | Content |
|---|---|
| `src/messages.ts` | `Message`, `ToolCall`, `ToolSpec`, `ProviderCall`, `ProviderEvent`, `ModelDescriptor`, `ModelChoices`. |
| `src/pipeline.ts` | `StepRef`, `StepContext`, `StepResult`, `TurnEvent`, `TurnOptions`, `KERNEL_PACKAGE`, `PROVIDER_CALL_STEP`. |
| `src/packages.ts` | `Manifest`, `ThetisField` (with `config`), `ForkOrigin`, `PackageSource`, `PackageInfo`, `PackageRecord`, `DeletedPackage`, `SYSTEM_SCOPE`. |
| `src/identity.ts` | `UserRecord`, `AuthUser`, `Userspace`, `SessionRecord`, `SessionSummaryRef`, `SYSTEM_USER`. |
| `src/storage.ts` | `Store`, `StoreDriver`, `StoreOpenOptions`, `StoreFactory`, `STORAGE_TYPE`. See [26-storage.md](26-storage.md). |
| `src/config.ts` | `ConfigDecl`, `ConfigType`, `ConfigLayer`, `ConfigKeyState`, `ConfigReport`. See [09-configuration.md](09-configuration.md) section 4. |
| `src/guest.ts` | What package code sees: `KernelClient` (with `config` and `storage`), `PackageQuery`, `StepEnv`, `Step`, `Tool`, `ToolEnv`, `Service`, `ServiceEnv`, `UiCommandEnv`, `UiStreamEnv`, `Provider`, `EnumeratorContext`. |
| `src/fence.ts` | `Fence`, `FenceHandle`, `Fences`, `KernelRpc`, `EventSink`, `ExecResult`. |

### 3.3 `@thetis/lib`

Each module is a subpath export: `import { newId } from "@thetis/lib/ids"`.

| Subpath | Content |
|---|---|
| `ids` | `newId`, `now`. |
| `json` | `readJson`, `writeJson` (atomic), `JsonFile`. |
| `async` | `AsyncQueue`. |
| `error` | `CodedError`, `assert`, `errorMessage`, `errorCode`. |
| `container` | `Container`, `token`. See section 4. |
| `journal` | `Journal`, `JournalRow`. The caller decides what to write. |
| `json-store` | `JsonDirStore`: one JSON file per record, ids checked before they become paths. |
| `rpc-frames` | `PendingCalls`, `callHandler`, `readFrames`, `encodeFrame`. The `{ id, method, args }` framing. |
| `ndjson-socket` | `RpcSocketServer`, `connectRpcSocket`. The framing over a Unix socket. |
| `userspace-layout` | `UserspaceLayout`: `pathFor`, `exists`, `ensure`, `remove`. |
| `mounts` | `MountStore` over a `StoreMirror`, `parseMountList` (the socket-side check of a mount list), `withPresence`, `browseDirectories`, `statOf`. |
| `store` | `assertStoreId`, `storeId`, `assertStoreDoc`, `assertJsonValue`, `memoryStore`, `StoreMirror`. See [26-storage.md](26-storage.md). |
| `store-conformance` | `storeConformance`: the test cases every storage driver passes. |
| `config` | `validateDecls`, `forkChain`, `mergedDecls`, `defaultsOf`, `isSecretKey`, `checkValue`, `mergeDocs`, `findRefs`, `resolveRefs`, `describe`, `changedPackages`, `parseDotEnv`, `EnvFile`, `LayeredConfig`. See [09-configuration.md](09-configuration.md) section 4. |
| `freshness` | `newestMtime`: what `status` compares against. |
| `restart` | `RestartLatch`, `isSupervised`. See [25-restart.md](25-restart.md). |
| `pkg-fs` | `splitSource`, `isGitSource`, `cloneCommand`, `buildCommand`, `isInside`, `linkDir`, `removeLink`, `copyPackageAs`, `findDependency`, `forkVersion`, `forkPackage`. |
| `crypto` | `randomHex`, `scryptHex`. |

### 3.4 `@thetis/sandbox`

| File | Content |
|---|---|
| `src/process-fence.ts` | `ProcessFence`. Resolves the sandbox and network modes. Writes the resolver file. Opens the launch gate. |
| `src/bwrap.ts` | The bubblewrap arguments and the launcher command. |
| `src/handle.ts` | `ProcessHandle`. One agent process; requests out, RPC in. |
| `src/pool.ts` | `FencePool`. Implements `Fences`. One open fence per userspace. |
| `src/cgroup.ts` | `Cgroups`. Per-fence limits. |
| `src/network.ts` | `startEgress`. The slirp4netns helper. |

### 3.5 `@thetis/host`

| File | Content |
|---|---|
| `src/kernel.ts` | `createKernel` (asynchronous: it loads the driver and opens the records), `T`, `Kernel`. |
| `src/store.ts` | `loadStoreDriver` (finds, imports and probes the driver named by `storage.driver`), `openRecords` (the five mirrors), `flushRecords`, `Records`. |
| `src/migrate.ts` | `assertMigrated`, `migrateStore`, `LEGACY_FILES`: the four JSON files into the store. |
| `src/control.ts` | `controlSocketPath`. |
| `src/index.ts` | Re-exports, and `ControlServer` (the lib `RpcSocketServer`). |

## 4. The container

`Container` in `@thetis/lib/container` is a small inversion-of-control container.

- `token<T>(name)` creates a typed token.
- `container.bind(token, factory)` registers a factory. A second `bind` on the same token replaces the first and clears the cached instance.
- `container.get(token)` calls the factory on the first call and returns the same instance on later calls.
- `container.get` throws when the token has no binding.

The token table `T` in `packages/host/src/kernel.ts` lists every service:

`config`, `log`, `store`, `records`, `env`, `settings`, `users`, `auth`, `services`, `userspaces`, `mounts`, `fence`, `fences`, `registry`, `packages`, `providers`, `sessionStore`, `enumerator`, `providerCall`, `runner`, `sessions`, `journal`, `restart`, `cgroups`.

`store` is the storage driver. It is unbound until `createKernel` loads the package `storage.driver` names; a test binds `memoryStore()` to it instead. `records` holds the five `StoreMirror`s opened on the driver. `env` is the `EnvFile` the configuration references resolve against. `settings` is the `ConfigService`.

To replace a component, pass a `configure` function to `createKernel`:

```ts
import { createKernel, T } from "@thetis/host";

const kernel = await createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
  c.bind(T.log, () => (line) => logger.info(line));
});
```

`createKernel` refuses to run while a legacy record file is in the home (`assertMigrated`). It resolves the services after `configure` runs, loads the driver when `T.store` is still unbound, opens the records, wires the package listeners (the supervisor; the hook that clears a deleted package's configuration and documents; the hook that copies the system-layer configuration on promote) and the configuration listener (forget the userspace's providers and restart the affected services). It creates the promoted and shared directories. It then makes sure the system userspace exists.

## 5. The `Kernel` object

`createKernel(config, configure?)` returns a `Kernel`. It is `KernelServices` from the kernel plus the container.

| Member | Type | Function |
|---|---|---|
| `config` | `KernelConfig` | The effective configuration. |
| `users` | `UserStore` | User records. |
| `auth` | `AuthService` | Passwords and tokens. See [06-sessions-and-users.md](06-sessions-and-users.md) section 7. |
| `services` | `ServiceSupervisor` | `boot()` starts every installed service. See [05-packages.md](05-packages.md) section 13. |
| `userspaces` | `UserspaceLayout` | Userspace paths. |
| `packages` | `PackageManager` | Package operations. |
| `registry` | `PackageRegistry` | The package records. |
| `providers` | `ProviderRegistry` | Provider operations. |
| `sessions` | `SessionApi` | The session API. |
| `mounts` | `MountStore` | The host paths an admin granted into each person's fence. |
| `settings` | `ConfigService` | Per-package configuration: the layers, who may set what, what a package's code receives. See [09-configuration.md](09-configuration.md) section 4. |
| `store` | `StoreDriver` | The service plane's document store. The kernel holds the interface; the host loaded the driver. See [26-storage.md](26-storage.md). |
| `fences` | `Fences` | Open fences. |
| `journal` | `Journal` | The append-only record. |
| `restart` | `RestartLatch` | The latch behind a restart. See [25-restart.md](25-restart.md). |
| `restartPolicy()` | `string \| null` | The deployed unit's `Restart=`. |
| `container` | `Container` | The container, for tests and tools. Host only. |
| `removeUser(id)` | `Promise<void>` | Removes the user, closes its fence, removes its registry entries and mounts, clears its configuration namespaces and its `userspaces/<id>` store tree, deletes its userspace directory. |
| `shutdown()` | `Promise<void>` | Closes all fences, flushes the record mirrors, closes the driver. |

**Caution:** `removeUser` deletes the userspace directory. All sessions and packages of the user are lost.

## 6. Dependency graph

```
SessionApi -> UserStore, UserspaceLayout, PackageManager, JsonDirStore<SessionRecord>, PipelineRunner
PipelineRunner -> KernelConfig, Settings, Enumerator, ProviderCallStep, PackageManager, Fences, JsonDirStore, Journal
ProviderCallStep -> Settings, ProviderRegistry, Fences
ProviderRegistry -> Settings, PackageManager, UserspaceLayout, Fences
Enumerator -> KernelConfig, Fences
PackageManager -> KernelConfig, PackageRegistry, Fences
PackageRegistry -> StoreMirror<PackageRecord>            (namespace registry)
UserStore -> StoreMirror<UserRecord>                     (namespace users)
AuthService -> StoreMirror<Credential>, StoreMirror<TokenRecord>, UserStore   (auth/credentials, auth/tokens)
MountStore -> StoreMirror<{ mounts }>                    (namespace mounts)
ConfigService -> file layer, LayeredConfig(StoreDriver), EnvFile, PackageManager, PackageRegistry, UserspaceLayout, Journal
ServiceSupervisor -> Settings, UserStore, UserspaceLayout, PackageManager, Fences, Journal
PackageManager -> observes ServiceSupervisor (installed, uninstalled), the host's store hook (deleted), the host's config hook (promoted)
ConfigService -> onChange: the host forgets the userspace's providers and restarts the affected services

host: FencePool -> Fence, rpcFor(userspace), onOpen(userspace, handle)
host: rpcFor -> createRpcHandler(UserStore, PackageManager, SessionApi, AuthService, createControlHandler)   (resolved lazily)
host: onOpen -> ServiceSupervisor.opened                                                                     (resolved lazily)
```

The RPC handler needs `SessionApi`. `SessionApi` needs `PipelineRunner`. `PipelineRunner` needs `Fences`. `FencePool` needs the RPC handler. The host resolves this cycle. The `FencePool` factory receives a function `rpcFor`. That function resolves the services only when a fence opens.

## 7. The line-count limit

The test `packages/kernel/test/loc.test.ts` counts the lines in `packages/kernel/src/**/*.ts`. The count excludes:

- files that end in `.test.ts`;
- blank lines;
- lines that contain only a comment (`//`, `/* ... */`, or `*` continuation lines);
- `import` statements, including multi-line imports;
- re-export statements (`export * from`, `export { ... } from`).

The test fails when the count is 1,400 or more. The test prints a per-file table. At the end of the MVP the count was 1,200 under the old limit of 2,000. After the split into contracts, lib, sandbox, kernel, and host it was 1,075. With package forks it was 1,117. The limit went from 1,200 to 1,400 when the fence reload, the staleness report and the daemon restart landed, each a question of who may do what. With the storage contract and the configuration service (2026-09-18) the count is 1,386.

To keep the count low:

- Put behavior in packages, not in the kernel.
- Put mechanism in `@thetis/lib` or `@thetis/sandbox`. Keep the decision in the kernel.
- Add a kernel feature only when no package can provide it.
- Prefer one small class per responsibility.

## 8. Error handling

`KernelError` is `CodedError` from `@thetis/lib/error`. It carries a `code` string. The codes in use are:

| Code | Meaning |
|---|---|
| `invalid` | An argument failed validation. |
| `unauthorized` | The user may not do the operation. |
| `not-found` | The session does not exist. |
| `busy` | The session already runs a turn. |
| `cancelled` | The turn or the fence request was cancelled with `SessionApi.cancel`. |
| `fence` | The fence request failed or timed out, or the agent exited. |
| `package` | Package code threw an error. |
| `build` | A build or clone command failed. |
| `peer` | A peer dependency is missing. |
| `provider` | No provider serves the model, or the provider reported an error. |
| `enumerator` | The enumerator returned an invalid plan. |
| `step` | A step returned invalid mutations. |
| `tool` | The model called an unknown tool. |
| `rpc` | The fence called an unknown kernel method. |
| `storage` | The storage driver is missing, is not of type `storage`, failed the probe at start, or holds a document it cannot read. |

The `FencePool` drops its handle when an error has the code `fence`. The next request opens a new agent process.
