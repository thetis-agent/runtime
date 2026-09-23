# Runtime architecture

`src/index.ts` is the public entry point of `@thetis/runtime`, a TypeScript library targeting Node.js.
Zod is its only third-party runtime dependency. Importing it does not start a daemon, open a socket, or load
an extension. The embedding application calls `createKernel(config, configure?)` and owns shutdown.

The runtime repository owns all core source and its tests. `packages/` is a separate repository for
extensions and applications, including the CLI and benchmark runner. Core modules are directories,
not separately versioned npm packages. They use relative ESM imports ending in `.js`.

## Responsibilities and dependency direction

| Module | Responsibility | Allowed internal dependencies |
|---|---|---|
| `contracts` | Shared data schemas, inferred types and adapter interfaces | None |
| `lib` | Reusable mechanisms such as records, queues and RPC framing | `contracts` |
| `kernel` | Authorization, ownership, sessions and pipeline coordination | `contracts`, `lib` |
| `sandbox` | Default OS process isolation and fence pool | `contracts`, `lib` |
| `host` | Composition, startup, storage loading and host facts | `contracts`, `lib`, `kernel`, `sandbox` |
| `door` | HTTP routing to gateway sockets | None |
| `userspace-agent` | Execute extension code inside a fence | `contracts`, `lib` |

The kernel depends on `Fence`, `Fences` and `StoreDriver` contracts. It does not import the sandbox,
the host, or an extension. Providers, model/tool loops, prompts and UI behavior belong to extensions.
Extension names in configuration are data; their implementations are loaded through the configured
adapters. The default configuration retains the shipped installation's package choices.

## SOLID, DRY and clean code

- Keep one reason to change per module or class. Authorization belongs in the kernel, OS details in
  adapters, and object construction in the host. Keep orchestration separate from I/O mechanisms.
- Extend behavior through contracts, configuration and packages. Do not add provider or tool branches
  to the kernel. Replacement adapters must honor cancellation, isolation and lifecycle contracts.
- Define interfaces around what callers need. Share each contract once; do not duplicate an interface
  in both the consumer and its adapter. Prefer the `contracts` layer for shared vocabulary.
- Parse unknown boundary data with Zod before using it as a DTO. Infer the DTO from its schema;
  authorization and state transitions remain service responsibilities. Extension schemas stay with
  their owners. See [validation](docs/validation.md) for the boundary and compatibility rules.
- Inject collaborators through constructors. Domain services must not resolve an IoC container or
  import a global service instance. `src/host/kernel.ts` is the composition root.
- Use descriptive names, small cohesive functions and one level of abstraction per function. Extract
  repeated policy or mechanisms only when they represent the same responsibility. Avoid speculative
  wrappers and compressing statements to meet a line budget.
- Comments explain constraints and intent. Tests verify observable behavior and architectural
  guarantees, including failure and cancellation paths, rather than reproducing the implementation.

## Inversion of control and dependency injection

`Container` holds typed, lazy singleton factories. `T` defines the service tokens. `createKernel`
registers the standard factories, then calls the supplied configuration callback before resolving
services. Rebinding a token changes that instance's dependency graph; there is no global container.

Inject `T.store` to bypass loading a storage-driver package, `T.fence` to replace the OS adapter,
`T.fences` to replace the complete pool through the `Fences` interface, and `T.hosts` to replace host
extension dispatch. Service constructors receive their resolved dependencies directly.

`test/host/runtime.test.ts` boots the public API with an in-memory store and injected fences and host
extensions. It runs a session without any installed extension or default process adapter.

## Public API and build

| Import | Purpose |
|---|---|
| `@thetis/runtime` | Kernel creation, configuration, IoC tokens, adapter types and control-socket helpers |
| `@thetis/runtime/contracts` | Extension SDK types and protocol constants |
| `@thetis/runtime/schemas` | Shared Zod schemas for runtime data contracts |
| `@thetis/runtime/lib/<module>` | Shared mechanisms used by extensions |
| `@thetis/runtime/kernel` | Kernel services and operator handlers for host applications |
| `@thetis/runtime/sandbox` | Default fence implementations for host applications |
| `@thetis/runtime/door` | HTTP routing adapter for the CLI |

Extensions declare a peer dependency on `@thetis/runtime`. In this checkout they also declare
`"@thetis/runtime": "file:../.."` as a development dependency, and TypeScript extensions reference
`../../tsconfig.runtime.json`. They must not reach into runtime source or compiled internals by path.
The former `@thetis/kernel`, `@thetis/host`, `@thetis/contracts`, `@thetis/lib`, `@thetis/sandbox`,
`@thetis/door` and `@thetis/userspace-agent` packages have been replaced by this library.

`npm run build:runtime` builds `src/` into `dist/src/` without compiling extensions. `npm run build`
also builds runtime tests into `dist/test/` and the extension workspaces. `npm test` runs both sets.

`test/architecture.test.mjs` parses TypeScript imports to enforce the layer table, keep extensions
out of the runtime's dependency graph, and keep container resolution in the composition layer.
`test/kernel/seams.test.ts` protects protocol shapes. `test/kernel/loc.test.ts` keeps the kernel small;
the count excludes its supporting modules and is not a measure of the entire runtime's complexity.
The integration suites exercise real process fences, RPC, storage and gateway behavior.

Moving a running installation to this layout requires rebuilding and restarting its daemon so it
uses the new guest entry path and module graph. Keep the runtime and packages repository changes
together when committing or deploying this migration.

The runtime 0.2 [content contract](docs/content.md) carries ordered JSON parts through every boundary. `AssetAccess` owns authorization, `AssetStore` is injected through `T.assetStore`, and the default file store handles bytes outside userspaces. The harness assembles streamed parts; providers interpret modalities. `lib/kernel-client.ts` is the shared mapping for both fence and in-process clients.
