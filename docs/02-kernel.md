# 02 Kernel

The kernel is the package `@thetis/kernel` in `packages/kernel`. It is the only trusted code. It runs in the host process.

## 1. Rules for the kernel

- The kernel must stay under 2,000 lines of code. The test `packages/kernel/test/loc.test.ts` enforces the limit. See section 6.
- The kernel must not contain domain behavior. Prompts, tools, memory, and providers are packages.
- The kernel must not run package code in the host process. The kernel sends package code into a fence.
- Each class receives its dependencies through its constructor. The composition root in `src/kernel.ts` wires all classes.

## 2. Source modules

| File | Class or export | Responsibility |
|---|---|---|
| `src/types.ts` | Types and constants | All shared types. The wire shapes. The package author contract. |
| `src/container.ts` | `Container`, `token()` | The inversion-of-control container. |
| `src/util.ts` | `AsyncQueue`, `KernelError`, `readJson`, `writeJson`, `newId`, `now`, `assert` | Small helpers. |
| `src/config.ts` | `KernelConfig`, `defaultConfig`, `loadConfig`, `saveConfig`, `configPath` | Configuration. See [09-configuration.md](09-configuration.md). |
| `src/users.ts` | `UserStore` | User records and authorization. |
| `src/userspaces.ts` | `UserspaceManager` | The directory layout of each userspace. |
| `src/fence/fence.ts` | `Fence`, `FenceHandle`, `KernelRpc`, `ExecResult` | The fence interfaces. |
| `src/fence/process-fence.ts` | `ProcessFence` | The process sandbox implementation. |
| `src/fence/pool.ts` | `FencePool` | One open fence per userspace. Reopens after a crash. |
| `src/packages/manifest.ts` | `readManifest`, `validateManifest`, `scopeOf`, `toInfo`, `declaresStep` | Manifest parsing and validation. |
| `src/packages/registry.ts` | `PackageRegistry` | The service-plane record of packages. |
| `src/packages/manager.ts` | `PackageManager` | Install, seed, link, uninstall. |
| `src/providers.ts` | `ProviderRegistry` | Provider discovery, model resolution, provider calls. |
| `src/sessions/store.ts` | `SessionStore` | Session files in the userspace. |
| `src/sessions/api.ts` | `SessionApi` | The session API for gateways. |
| `src/pipeline/enumerator.ts` | `Enumerator`, `BUILTIN_CALL`, `isBuiltin` | Builds and validates the step list. |
| `src/pipeline/provider-call.ts` | `ProviderCallStep` | The built-in call step and the tool loop. |
| `src/pipeline/runner.ts` | `PipelineRunner` | Runs one turn. Applies and validates mutations. Persists. |
| `src/rpc.ts` | `createRpcHandler` | The methods a fence can call on the kernel. |
| `src/kernel.ts` | `createKernel`, `T`, `Kernel` | The composition root and the token table. |
| `src/index.ts` | Re-exports | The public API of the package. |

## 3. The container

`Container` is a small inversion-of-control container.

- `token<T>(name)` creates a typed token.
- `container.bind(token, factory)` registers a factory. A second `bind` on the same token replaces the first and clears the cached instance.
- `container.get(token)` calls the factory on the first call and returns the same instance on later calls.
- `container.get` throws when the token has no binding.

The token table `T` in `src/kernel.ts` lists every kernel service:

`config`, `log`, `users`, `userspaces`, `fence`, `fences`, `registry`, `packages`, `providers`, `sessionStore`, `enumerator`, `providerCall`, `runner`, `sessions`.

To replace a component, pass a `configure` function to `createKernel`:

```ts
const kernel = createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
  c.bind(T.log, () => (line) => logger.info(line));
});
```

`createKernel` resolves the services after `configure` runs. It then makes sure the system userspace exists.

## 4. The `Kernel` object

`createKernel(config, configure?)` returns:

| Member | Type | Function |
|---|---|---|
| `config` | `KernelConfig` | The effective configuration. |
| `users` | `UserStore` | User records. |
| `userspaces` | `UserspaceManager` | Userspace paths. |
| `packages` | `PackageManager` | Package operations. |
| `providers` | `ProviderRegistry` | Provider operations. |
| `sessions` | `SessionApi` | The session API. |
| `fences` | `FencePool` | Open fences. |
| `container` | `Container` | The container, for tests and tools. |
| `removeUser(id)` | `Promise<void>` | Removes the user, closes its fence, removes its registry entries, deletes its userspace directory. |
| `shutdown()` | `Promise<void>` | Closes all fences. |

**Caution:** `removeUser` deletes the userspace directory. All sessions and packages of the user are lost.

## 5. Dependency graph

```
SessionApi -> UserStore, UserspaceManager, PackageManager, SessionStore, PipelineRunner
PipelineRunner -> KernelConfig, Enumerator, ProviderCallStep, PackageManager, FencePool, SessionStore
ProviderCallStep -> KernelConfig, ProviderRegistry, FencePool
ProviderRegistry -> KernelConfig, PackageManager, UserspaceManager, FencePool
Enumerator -> KernelConfig, FencePool
PackageManager -> KernelConfig, PackageRegistry, FencePool
FencePool -> Fence, rpcFor(userspace)
rpcFor -> UserStore, PackageManager, SessionApi   (resolved lazily to break the cycle)
```

The RPC handler needs `SessionApi`. `SessionApi` needs `PipelineRunner`. `PipelineRunner` needs `FencePool`. `FencePool` needs the RPC handler. The container resolves this cycle. The `FencePool` factory receives a function `rpcFor`. That function calls `c.get(T.sessions)` only when a fence opens.

## 6. The line-count limit

The test `test/loc.test.ts` counts the lines in `packages/kernel/src/**/*.ts`. The count excludes:

- files that end in `.test.ts`;
- blank lines;
- lines that contain only a comment (`//`, `/* ... */`, or `*` continuation lines);
- `import` statements, including multi-line imports;
- re-export statements (`export * from`, `export { ... } from`).

The test fails when the count is 2,000 or more. The test prints a per-file table. At the end of the MVP the count was 1,200.

To keep the count low:

- Put behavior in packages, not in the kernel.
- Add a kernel feature only when no package can provide it.
- Prefer one small class per responsibility.

## 7. Error handling

`KernelError` carries a `code` string. The codes in use are:

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

The `FencePool` drops its handle when an error has the code `fence`. The next request opens a new agent process.
