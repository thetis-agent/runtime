# 10 Development

## 1. Prerequisites

| Tool | Version | Use |
|---|---|---|
| Node.js | 24 or later | Runtime. The fence passes the running Node binary into the sandbox. |
| npm | 11 or later | Workspaces. |
| git | any | Git installs and the repositories. |
| bubblewrap (`bwrap`) | any | The sandbox. Optional. Without it the fence runs in mode `none`. |
| `slirp4netns`, `unshare` | any | Outbound-only networking for fences. Optional. Without `slirp4netns` the fence uses the host network. |
| cgroup v2 | | Per-fence limits. Optional. Needs a delegated cgroup: `Delegate=yes` on the unit, or `systemd-run --user --scope -p Delegate=yes node bin/thetis.js serve`. |

## 2. Set up

```sh
cd runtime
git submodule update --init      # after a fresh clone
npm install
npm run build
cp .env.example .env             # then set OPENROUTER_API_KEY
node bin/thetis.js init
node bin/thetis.js users add alice
node bin/thetis.js chat --user alice
```

## 3. Repositories

- `runtime` is a git repository. It contains the workspace root, the entry point, the documentation, and the submodule reference.
- `runtime/packages` is a separate git repository. It contains all packages. `runtime` references it as a submodule at path `packages`.

Commit package changes in `runtime/packages` first. Then commit the new submodule commit id in `runtime`.

```sh
cd runtime/packages && git add -A && git commit -m "..."
cd .. && git add packages && git commit -m "Update packages"
```

The `.gitmodules` URL is `./packages`. Change it to the remote URL of the packages repository before you push `runtime`.

## 4. Build

- `npm run build` runs `tsc -b` with the project references in `tsconfig.json`.
- Each package compiles `src/**` and `test/**` into `dist/`. The layout is `dist/src/...` and `dist/test/...`.
- `npm run clean` deletes all `dist` directories and build info files.
- Packages import `@thetis/kernel` through the workspace link in `node_modules/@thetis/kernel`. That link points to `packages/kernel`.

The compiler options are in `tsconfig.base.json`: target ES2022, module NodeNext, strict, composite, declaration, source maps.

## 5. Test

```sh
npm test                                   # build, then all kernel tests
node --test "packages/kernel/dist/test/**/*.test.js"
THETIS_TEST_SANDBOX=none npm test           # force the unfenced mode
THETIS_TEST_VERBOSE=1 npm test              # print agent stderr
```

See [11-testing.md](11-testing.md).

## 6. Run

```sh
node bin/thetis.js send --user alice "hello"
node bin/thetis.js chat --user alice --verbose
```

The agent's `stderr` goes to the CLI's `stderr` with the prefix `[<user>]`.

## 7. Code rules

- TypeScript with strict mode. ECMAScript modules. Import paths end with `.js`.
- Every class gets its dependencies through its constructor. No class creates its own dependencies. No global state.
- The composition root `createKernel` in `src/kernel.ts` is the only place that constructs kernel services.
- One class has one responsibility. Split a class that grows two.
- Depend on interfaces where a second implementation is plausible: `Fence` is the example.
- New capabilities go into packages. Add kernel code only for a new crossing of the fence or a new invariant.
- The kernel must stay under 2,000 counted lines. Run `npm test` after each kernel change. The test prints the count.
- Validate every value that crosses the fence into the kernel: step results, enumerator plans, manifests, RPC arguments.
- Use `KernelError` with a code for every failure the caller must distinguish.

## 8. Add a system package

1. Create `packages/<dir>/package.json` with a scoped name `@thetis/<name>` and a `thetis` field.
2. Create `packages/<dir>/src/index.ts`. Set `"main": "dist/src/index.js"`.
3. Create `packages/<dir>/tsconfig.json`:
   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": { "rootDir": ".", "outDir": "dist" },
     "include": ["src/**/*.ts", "test/**/*.ts"],
     "references": [{ "path": "../kernel" }]
   }
   ```
4. Add `{ "path": "packages/<dir>" }` to `tsconfig.json` in `<root>`.
5. Run `npm install` so the workspace link exists. Run `npm run build`.
6. Add the name to `systemPackages` in the config when it must be installed by default.

## 9. Change the kernel

1. Read [02-kernel.md](02-kernel.md) to find the module.
2. Change the class. Keep the constructor signature stable when possible. Update the factory in `src/kernel.ts` otherwise.
3. Add or update a unit test in `packages/kernel/test/unit.test.ts`. Add an end-to-end case in `test/e2e.test.ts` when the change crosses the fence.
4. Run `npm test`. Check the line count in the output.
5. Update the document in `docs/` that describes the changed behavior.

## 10. Change the agent or the protocol

The agent is in `packages/userspace-agent/src/agent.ts`. The kernel side is `packages/kernel/src/fence/process-fence.ts`. Both must agree on the message shapes in [03-fence.md](03-fence.md) section 5.

- Add a new operation: add a handler to `ops` in the agent. Add a caller in the kernel.
- Add a new RPC method: add a case in `createRpcHandler` in `src/rpc.ts`. Add a client method in the agent's `kernel` object. Add the type to `KernelClient` in `src/types.ts`.
- The e2e tests start the real agent. Run them after each change.

## 11. Replace the fence

1. Implement `Fence` and `FenceHandle` from `src/fence/fence.ts`.
2. Start the same agent, or another program that speaks the same protocol, inside the new environment.
3. Bind it: `createKernel(config, (c) => c.bind(T.fence, () => new MyFence(...)))`.
4. Run the e2e tests with the new binding.

## 12. Debugging

| Symptom | Check |
|---|---|
| `no provider package is installed` | `thetis packages list` without `--user`. The system userspace must have a provider. Check `systemPackages._system`. |
| `no installed provider serves model` | `thetis models`. Set `model` in the config to a listed id. |
| `OpenRouter apiKey is not configured` | `.env` has `OPENROUTER_API_KEY`. The config has `apiKey: "${OPENROUTER_API_KEY}"`. |
| `fence request ... timed out` | A tool or a step ran longer than `requestTimeoutMs`. |
| `userspace agent for <user> exited` | Run with `--verbose` and read `stderr`. The agent path must exist: run `npm run build`. |
| `stray output` in the log | Package code wrote to `stdout`. Use `console.error` in packages. |
| A package does not appear after install | Look at `registry.json`. Run `thetis packages list --user <id>`. The log shows a dead link. |
| `bwrap` errors at start | Set `fence.sandbox` to `none` to confirm the rest works. Then check user namespaces on the host. |
