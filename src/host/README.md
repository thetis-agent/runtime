# Runtime module: host

The composition root: what a process that runs Thetis needs. `createKernel` wires the kernel's classes to the sandbox through a small container, loads the storage driver and the host packages, and `controlSocketPath` and `ControlServer` give the command line its socket. It runs in the host process. It is a daemon package: loaded once, held for the process's life, and changed only for its own bugs. `@thetis/gateway-cli` and the bench runner build their kernel with it.

## What it provides

An internal runtime module, not an installable extension.

The host is the composition root. It imports internal contracts, mechanisms, sandbox adapters and kernel services. The public `@thetis/runtime` entry point re-exports its API for applications such as the CLI and benchmark runner. `test/architecture.test.mjs` enforces these boundaries.

`createKernel(config, configure?)` registers the typed factories in `T`, accepts binding overrides,
opens the storage records, constructs the services, and connects lifecycle observers. Callers can
replace storage, the fence adapter or pool, host-extension dispatch, and logging before services resolve.
The public API is re-exported by `src/index.ts`; the host itself is an internal module.

The returned kernel owns users, credentials, package records, configuration, sessions, fences, host
extensions and the restart latch. `removeUser(id)` removes that user's records, sessions, files, grants
and held keys. `shutdown()` closes every fence, flushes the records, and closes the storage driver.

`HostPackages` loads host extensions by manifest name from the shipped or promoted packages. It
implements the single `HostExtensions` interface declared by the kernel. A fence pool is bound through
`Fences`, so a replacement need not inherit the default `FencePool` implementation.

## Use

Replace a component by rebinding its token before the services resolve:

```ts
import { createKernel, T } from "@thetis/runtime";

const kernel = await createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
  c.bind(T.log, () => (line) => logger.info(line));
});
```

Serve the control socket and start every installed service, the way `thetis serve` does:

```ts
import { ControlServer, controlSocketPath, createKernel, loadConfig } from "@thetis/runtime";
import { createControlHandler } from "@thetis/runtime/kernel";

const config = loadConfig(home, projectRoot);
const kernel = await createKernel(config);
const control = new ControlServer(controlSocketPath(config.home), createControlHandler(kernel));
await control.listen();
await kernel.services.boot();
```

The socket is `$THETIS_HOME/thetis.sock`, mode `0600`. Anyone who can open it is an operator.

## Files

| File | Content |
|---|---|
| `kernel.ts` | `createKernel`, `T`, `Kernel`. The bindings, the process fence from `config.fence`, the RPC handler a fence gets when it opens, the package and configuration listeners. |
| `store.ts` | Storage driver loading, package discovery and record lifecycle. |
| `host-packages.ts` | `HostPackages`, the implementation of host-extension dispatch. |
| `migrate.ts` | `assertMigrated`, `migrateStore`, `LEGACY_FILES`: the four JSON record files into the store, each renamed `.migrated`. |
| `control.ts` | `controlSocketPath`, `controlTokenPath`, `writeControlToken`, `readControlToken`. The operator socket's path, and the token a daemon requires on it. The token lives in the run directory the service manager guarantees and never in the data directory, where a fence could read it; it is written fresh on every start, so a dead daemon's token is never accepted by a live one; and its file is named after the data directory it serves, so the throwaway daemons started beside production for a test do not take each other's. A daemon from before that naming wrote a shared `control.token`, which is still read when this data directory has no file of its own, so upgrading the packages under a running daemon does not take its command line away. An installation whose unit declares no `RuntimeDirectory=` has no token and the socket admits anyone who can open it, as it always did. |
| `index.ts` | Re-exports, and `ControlServer`. |
| `test/e2e.test.ts` | The end-to-end suite. |
| `test/fixtures/` | `provider-echo`, a deterministic provider, and the `ui-good`, `ui-bad`, and `ui-dup` packages the web gateway's tests use. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suite of this package is `test/host/e2e.test.ts`: a real kernel with the real `ProcessFence` and userspace agent and the echo provider, no network. It covers seeding, the prompt and tool steps, the tool loop, a package written into the userspace and live on the next turn, scope and visibility between users, promotion, git installs, operator methods from a fence, cancel, RPC identity, the control socket, suspension, fence isolation, forks, mounts, a live `config.set` reaching a provider and restarting a service in place, `env.storage()` with its clearing on delete and on user removal, a removal taking the password, the tokens and the held keys with it so the id comes back with no password, a secret reaching a tool and nothing else, a fork inheriting its origin's key, the `0600` modes under `store/auth` and `store/secrets`, and `migrate`. To run it alone after `npm run build`: `node --test dist/test/host/e2e.test.js`. Set `THETIS_TEST_SANDBOX=none` to run it without bubblewrap.
