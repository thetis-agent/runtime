# Runtime module: contracts

The types and constants every part of Thetis agrees on: messages, the pipeline, packages, identity, the fence, host packages, and what package code sees inside it. The package holds no code: types, and a few string constants. Nothing here carries policy; a regular expression or a default that a package needs lives in that package. It is imported everywhere: by the service plane in the host process, by the userspace agent inside each fence, and by every package that implements a step, a tool, a service, or a provider.

## What it provides

The shared runtime contracts. Extensions import their types through `@thetis/runtime/contracts`.

The contracts module imports no other runtime layer. Its types describe the shared vocabulary and adapter interfaces. Extensions import them through `@thetis/runtime/contracts`. `test/architecture.test.mjs` enforces the layer boundaries.

The constants:

| Constant | Value | Meaning |
|---|---|---|
| `SYSTEM_USER` | `_system` | The user that owns the system userspace. |
| `SYSTEM_SCOPE` | `@thetis` | The scope of system packages. |
| `STORAGE_TYPE` | `storage` | The package type of a storage driver, loaded by the host. |
| `HOST_TYPE` | `host` | The package type of a host package, loaded by the host and answering `host.<name>.<export>`. |

`test/kernel/seams.test.ts` snapshots this list: the runtime exports of this package are these strings and nothing else.

## Use

A step, a tool, and a service are exported functions typed from here:

```ts
import type { Step, Tool, Service } from "@thetis/runtime/contracts";

export const prompt: Step = async (ctx) => ({
  call: { ...ctx.call, system: "Answer briefly." },
});

export const shout: Tool = async (args, env) => String(args.text).toUpperCase();

export const startService: Service = async (env) => {
  env.log("started");
  return { stop: async () => {} };
};
```

A step receives a `PackageStepContext`: `session`, `turn`, `conversation`, `call`, `harness`, `config`, a `packages` query, `env`, `emit` (a turn event streamed to whoever watches the turn; the kernel relays it and reads only `usage` and `error`) and `signal` (aborted when the turn is stopped). It returns a `StepResult` with any of `conversation`, `call`, and `harness`, or nothing. A tool receives its arguments and a `ToolEnv`. Code in the fence reaches the kernel through `env.kernel`, a `KernelClient`; every call acts as the fence's own user. `kernel.providers.call(call, onEvent, signal)` is how a harness's call step sends a `ProviderCall`: the kernel routes it by `call.model` to the provider's fence and streams the `ProviderEvent`s back, so the calling fence never sees the key. A provider implements `call(call, signal?)`: the signal is a parameter rather than something the caller arranges from outside, because an async generator parked on an `await` never sees a `return()`, so a request that produces nothing can only be ended by the provider aborting its own request.

A host package exports `HostMethod`s, `(args, env: HostEnv) => Promise<unknown>`, and declares `"thetis": { "type": "host", "host": { "name": "grants" } }`. `HostEnv` gives it the home, the users, the grant records (`mounts`, `ssh`) with `get`, `all` and `set`, `journal`, `reloadFence(user)` and `log`. The host process loads it the way it loads a storage driver and re-imports its entry when the file changes.

The fence side is the pair `Fence` and `FenceHandle`, and the pool `Fences`. The kernel depends on these interfaces; `@thetis/runtime/sandbox` implements them. A different isolation technology implements `Fence` and replaces the binding in `@thetis/runtime`.

## Files

| File | Content |
|---|---|
| `messages.ts` | `Message`, `ToolCall`, `ToolSpec`, `ProviderCall`, `ProviderEvent`, `ModelDescriptor`, `ModelChoices`. |
| `pipeline.ts` | `StepRef`, `StepContext`, `StepResult`, `TurnEvent`, `TurnOptions`, `HarnessState`. |
| `packages.ts` | `Manifest`, `ThetisField`, `StepDecl`, `ToolDecl`, `UiDecl`, `PackageSource`, `ForkOrigin`, `PackageInfo`, `PackageRecord`, `DeletedPackage`, `SYSTEM_SCOPE`. |
| `identity.ts` | `UserRecord`, `AuthUser`, `Mount`, `SshGrant`, `Userspace`, `SessionInfo`, `SessionRecord`, `SessionSummaryRef`, `SYSTEM_USER`. |
| `guest.ts` | What package code sees: `StepEnv`, `KernelClient`, `PackageQuery`, `Step`, `Tool`, `ToolEnv`, `Service`, `ServiceEnv`, `Provider`, `UiCommand`, `EnumeratorContext`. |
| `fence.ts` | `Fence`, `FenceHandle`, `Fences`, `KernelRpc`, `EventSink`, `ExecResult`. |
| `bench.ts` | What a package declares to be benchmarked and what it reports: `BenchDecl`, `BenchClaim`, `Corpus`, `CapabilityRecord`. |
| `storage.ts` | `Store`, `StoreDriver`, `STORAGE_TYPE`. |
| `config.ts` | `ConfigDecl`, `ConfigKeyState`, `ConfigReport`, `ConfigLayer`: the declaration fields and the report shape. |
| `host.ts` | `HostEnv`, `HostMethod`, `GrantRecords`, `HOST_TYPE`. |
| `index.ts` | Re-exports all of the above. |

## Tests

The package has no tests of its own. `test/architecture.test.mjs` checks its import boundaries, and `test/kernel/seams.test.ts` checks the four runtime constants. Run every test with `npm test` from the runtime root.

Providers may emit `{ type: "request", body, at }` for inspection: `body` is the serialized request JSON without transport headers. Harnesses can persist it and emit `{ type: "context.updated" }` after saving; consumers fetch full context on demand. These are data events carried by the existing provider and turn streams, with no new kernel methods.
