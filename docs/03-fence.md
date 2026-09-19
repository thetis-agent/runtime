# 03 Fence

The fence is the boundary around one userspace. All package code runs inside a fence. The kernel is the only bridge across the fence.

## 1. Interfaces

The file `packages/contracts/src/fence.ts` defines the contract. The package `@thetis/sandbox` implements it. The kernel sees only the interfaces.

```ts
type KernelRpc = (method: string, args: unknown) => Promise<unknown>;

interface FenceHandle {
  request(op: string, payload: unknown, onEvent?: (event: unknown) => void, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface Fence {
  open(userspace: Userspace, rpc: KernelRpc): Promise<FenceHandle>;
}
```

- `Fence.open` starts the environment for one userspace. The kernel passes an `rpc` function. Code in the fence uses it to call the kernel.
- `FenceHandle.request` sends one operation. Events arrive through `onEvent` before the result. When `signal` aborts, the kernel sends a cancel message to the agent and rejects the request with the code `cancelled`. See section 5.6.
- A different isolation technology, for example a microVM, implements `Fence` and replaces the binding of `T.fence`.

## 2. The fence pool

`FencePool` in `packages/sandbox/src/pool.ts` implements the interface `Fences` and keeps at most one open handle per userspace.

- `handle(us)` opens the fence on the first call. Later calls return the same handle.
- `request(us, op, payload, onEvent, signal)` sends one request. When the error code is `fence`, the pool drops the handle. The next request opens a new agent.
- `close(id?)` closes one fence, or all fences when `id` is not given.

## 3. The process fence

`ProcessFence` in `packages/sandbox/src/process-fence.ts` is the current implementation. The bubblewrap arguments are in `src/bwrap.ts`. The agent process and its frames are in `src/handle.ts`. It starts one long-lived Node process per userspace. The process runs `packages/userspace-agent/dist/src/agent.js`.

### 3.1 Sandbox modes

The option `sandbox` has three values:

| Value | Behavior |
|---|---|
| `auto` | Use `bwrap` when the probe `bwrap --ro-bind / / --unshare-pid -- true` succeeds. Otherwise use `none`. |
| `bwrap` | Always use bubblewrap. |
| `none` | Start the agent directly with `cwd` set to the userspace home. No isolation, no limits, the host network. |

`ProcessFence.mode` reports the resolved mode.

**Caution:** In mode `none` the agent can read and write any file the host user can. Use `none` for development only.

### 3.2 Network modes

The option `fence.network` decides what the fence can reach:

| Value | Behavior |
|---|---|
| `auto` | `egress` when `/usr/bin/slirp4netns` exists and the sandbox is `bwrap`, else `host`. |
| `egress` | A private network namespace with outbound NAT through `slirp4netns`. The fence can reach the internet and the local network. It cannot reach the host's loopback and cannot bind a host port. DNS goes to the helper at `10.0.2.3`. |
| `none` | A private network namespace with no interface. |
| `host` | The host's network namespace, as before. |

`ProcessFence.networkMode` reports the resolved mode. In `egress` mode `unshare --map-root-user --net` creates the namespace before bubblewrap starts, because `slirp4netns` cannot enter a namespace bubblewrap made itself. The helper runs as a child of the kernel, is placed in the fence's cgroup, and stops with the fence.

### 3.3 Resource limits

`fence.limits` gives each fence a cgroup v2 group with `memory.max`, `memory.swap.max` 0, `pids.max`, and `cpu.max`:

| Key | Default | Meaning |
|---|---|---|
| `memoryMb` | 1024 | Memory of the fence and its helper. |
| `pids` | 512 | Processes and threads. |
| `cpuPercent` | 200 | CPU time; 100 is one core. |

Limits need the kernel process to run in a delegated cgroup: `Delegate=yes` on the systemd unit (`deploy/thetis-runtime.service` has it), or `systemd-run --user --scope -p Delegate=yes node bin/thetis.js serve` for a development run. `Cgroups.detect` in `packages/sandbox/src/cgroup.ts` moves the kernel into a child group, enables the controllers for siblings, and creates `fence-<user>` per fence. Without delegation the kernel logs `[fence] resource limits off` once and runs the fences unlimited.

#### The fence reads its own limits

A fence that cannot see its limit cannot tell an OOM kill from a transient failure. It is killed at `memory.max`, sees the host's free memory, calls the exit 137 flaky, and retries. A runtime that cannot see it sizes its heap for the machine and is killed at the limit it never knew about. So the fence gets its own cgroup namespace, and its own cgroup directory — only that one — is bound read-only inside the sandbox at `/sys/fs/cgroup`. The agent reads:

| File | Meaning |
|---|---|
| `memory.max` | The fence's memory limit in bytes. This, not `MemTotal`, is how much memory the fence has. |
| `memory.current` | What it uses now. |
| `memory.peak` | The high-water mark of this group. |
| `memory.events` | Counters; `oom_kill` rising is the proof that a child died at the limit. An exit code of 137 with `oom_kill` unchanged is something else. |
| `pids.max`, `pids.current` | The process and thread limit, and the count. |
| `cpu.max`, `cpu.stat` | The CPU quota and the time used, including `throttled_usec`. |

The path to those files is `/sys/fs/cgroup` plus the line in `/proc/self/cgroup`, which is how any runtime resolves its own group. Inside the fence that line reads `0::/`, so the path is `/sys/fs/cgroup` itself. `Cgroups.fence` in `packages/sandbox/src/cgroup.ts` decides the destination and nothing hardcodes the unit's name. An agent finds its own group the way everything else does: read `/proc/self/cgroup`, read that path under `/sys/fs/cgroup` — under the namespace both steps collapse to reading `/sys/fs/cgroup/memory.max`.

**Why the namespace and the mount root go together.** `bwrap --unshare-cgroup` makes the group the fence is already in — `Cgroups.place` put it there while the launch gate was shut, section 3.4 — the root of the hierarchy the fence can see. `/proc/self/cgroup` then reads `0::/`, and the group belongs at the mount point, as in any container. Three things follow that the previous layouts could not give:

- `statfs("/sys/fs/cgroup")` answers `cgroup2fs`. This is how .NET decides which cgroup version it is on. With the group bound at a nested path, the mount point is the tmpfs bubblewrap made to hold it, .NET concludes cgroups v1, finds no v1 hierarchy, and sizes its heap from the host's memory: `GC.GetGCMemoryInfo().TotalAvailableMemoryBytes` read 404315037696 in a fence limited to 8 GiB. With the namespace it reads 6442450944 — 75% of the limit, which is what the .NET GC takes of a container's memory.
- The concatenation of mount point and `/proc/self/cgroup` line lands on the group. Binding the leaf at the mount root *without* a namespace breaks exactly this: the line is still the full host path, the concatenation names a directory that is not there, and `dotnet --version` inside a fence aborted with `munmap_chunk(): invalid pointer` (exit 134) or a segfault, intermittently, while a build in the same shell succeeded. Commit `74e1a3f` in the packages repository did that, `a10fcea` corrected it by mirroring the host path, and `c740376` replaced both with the namespace. The two halves are one change and are never mixed.
- The fence cannot name a cgroup path outside its own group at all, because there is none inside its namespace.

**When the host has no cgroup namespace.** `hasCgroupNamespace` in `packages/sandbox/src/bwrap.ts` requires `/proc/self/ns/cgroup` to exist (Linux 4.6 and later) and `bwrap --ro-bind / / --unshare-cgroup -- true` to exit 0 — the flag is run, not inferred from a version, so an older bubblewrap or a kernel that refuses `CLONE_NEWCGROUP` answers no. The answer is probed once, on the first open that has a cgroup to bind. A no falls back to the `a10fcea` layout: no `--unshare-cgroup`, the group bound under the mount point at the full path `/proc/self/cgroup` reports, the agent reading its limits by that line. That layout is crash-free and is what shipped before; what it cannot do is teach .NET its heap size. Detection failing never fails a fence.

The bind is read-only: the fence learns what it has, it does not change it, it cannot write `cgroup.procs` or create a group of its own, and it sees no other fence's group — `/sys/fs/cgroup` inside a fence holds that fence's own control files and nothing else. Nothing else of `/sys` is mounted.

**Out of scope:** `/proc/meminfo` still reports the host's memory, because the kernel has no per-cgroup `meminfo`. A tool that reads `MemTotal` still sees the whole machine. Correcting that needs a FUSE layer such as `lxcfs` over `/proc`, which is not part of the fence today. Until then, the `memory.max` of the fence's own group is the number to trust, and a tool that guesses from `MemTotal` has to be told its size explicitly.

A runtime that reads `MemTotal` rather than its cgroup is still wrong by the whole machine. A runtime that reads its cgroup is now right: .NET, the JVM (`UseContainerSupport`, on by default) and anything else that looks for a cgroup v2 filesystem at `/sys/fs/cgroup` finds one, with this fence's limit in it. On a host without cgroup namespaces the fallback layout applies and those runtimes fall back to host memory, as they did before; there the heap size has to be given explicitly.

### 3.4 The launch gate

The agent starts behind a gate. The kernel spawns `/bin/sh -c 'printf ready >&6; read -r go <&5 || exit 97; exec "$@"' sh bwrap ...`. The shell reports on descriptor 6 that its namespaces exist, the kernel places the process in its cgroup and, in `egress` mode, brings the network up, then writes to descriptor 5. Only then does bubblewrap run. A failure before the gate opens kills the process and fails the open with the code `fence`.

### 3.5 Environment variables of the agent

The kernel gives the agent this environment and nothing else:

| Variable | Value |
|---|---|
| `PATH` | The directory of the running Node binary, then the host `PATH`. |
| `HOME` | The userspace home directory. |
| `LANG` | The host `LANG`, or `C.UTF-8`. |
| `THETIS_USERSPACE` | The userspace root. |
| `THETIS_HOME_DIR` | The userspace home. |
| `THETIS_STORE` | The package store. |
| `THETIS_SHARED` | The shared directory. See section 3.7. |
| `THETIS_USER` | The user id. |
| `THETIS_MOUNTS` | A JSON list of the mounts bound into the fence, each `{ "path", "mode" }` with mode `rw` or `ro`. `[]` when there is none. Set in every sandbox mode. A mount whose host path is not a directory is skipped and is not in the list, so this is what the fence has, not what was asked for. See [12-security.md](12-security.md) section 10. |
| `THETIS_DOCKER` | The path of the Docker socket inside the fence, `/var/run/docker.sock`. Set only when a socket is really bound, and absent otherwise, so a tool asks the environment what this fence has instead of probing a path and guessing why it is missing. See section 3.9. |

The kernel does not pass its own environment. Secrets in the host environment do not reach the fence.

### 3.6 The bubblewrap command

In mode `bwrap` the kernel builds the command in this order:

1. `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`.
2. `--tmpfs <path>` for each path in `fence.hidden`. The default hides `$THETIS_HOME`. This comes before the read-only binds, so a bind inside a hidden path still shows.
3. For each of `/usr`, `/etc`, `/opt`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, the Node install prefix, and each path in `fence.readOnly`: skip it when it does not exist; `--symlink <target> <path>` when it is a symbolic link; otherwise `--ro-bind <path> <path>`. The defaults include `<root>/packages`, `<root>/node_modules`, and the promoted packages `$THETIS_HOME/packages`.
4. The shared directory: `--bind` for the system userspace, `--ro-bind` for everyone else.
5. In `egress` mode: `--ro-bind $THETIS_HOME/fence-resolv.conf /etc/resolv.conf`.
6. When the kernel has a delegated cgroup: `--ro-bind-try <delegated root>/fence-<user> /sys/fs/cgroup`, which goes with `--unshare-cgroup` in step 9. On a host without cgroup namespaces the destination is instead `/sys/fs/cgroup/<that directory's path under the cgroup filesystem>` — the fence's own `/proc/self/cgroup` line, on this host `/sys/fs/cgroup/system.slice/thetis-runtime.service/fence-<user>` — and bubblewrap makes the intermediate directories. The mount root and the namespace are one choice: either together or neither, because a runtime resolves its group by concatenating that line with the mount point. See section 3.3. The flag is `-try`, and the option is left out entirely when limits are off, because this must never keep a fence from starting.
7. When the fence is given Docker: `--ro-bind-try <host socket> /var/run/docker.sock`. See section 3.9.
8. `--bind <root> <root>` for the userspace root and `--chdir <home>`.
9. For each mount of the user (`Userspace.mounts`): `--bind <path> <path>` for mode `rw`, `--ro-bind <path> <path>` for mode `ro`. A mount whose path does not exist on the host is logged and skipped; the fence still opens. A mount comes after the binds above, so it wins over a read-only bind of a parent directory. `THETIS_MOUNTS` lists the mounts that were bound.
10. `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`, then `--unshare-cgroup` when step 6 bound the group at the mount root, then `--cap-drop ALL --disable-userns --die-with-parent --new-session`, and `--unshare-net` in mode `none`.
11. `--setenv` for each variable of section 3.5.

The agent sees the operating system read-only, its own userspace read-write, the shared directory, the promoted packages, its mounts, its own cgroup read-only, and the Docker socket when it is given one. It does not see `$THETIS_HOME`, other userspaces, `/home`, the host `/tmp`, or any other fence's cgroup — with the namespace it cannot even name one. It has no capabilities and cannot make a nested user namespace. What it can do through the Docker socket is another matter, and section 3.9 is explicit about it.

Steps 6 and 10 depend on the launch gate of section 3.4. `Cgroups.place` creates `fence-<user>` and the kernel moves the launcher into it while the gate is still shut, so the directory is there by the time bubblewrap execs and the process is already in the group when bubblewrap unshares — which is what makes that group, and not the delegated root, the namespace's root. In mode `none` there is no bubblewrap, no bind and no namespace; on a cgroups v1 host `Cgroups.detect` finds no `0::` line in `/proc/self/cgroup`, returns nothing, and both are left out with the limits. In `egress` mode the launcher is wrapped in `unshare --map-root-user --net`; the cgroup namespace is taken by bubblewrap inside that and the two do not interact.

### 3.7 The shared directory

`$THETIS_HOME/shared` is written by the system userspace and read by every fence. `@thetis/marketplace` writes its index there. Package code reaches it as `env.shared`. The kernel gives it no meaning.

### 3.8 The `run` directory

`<userspace>/run` holds the unix sockets a service of that userspace listens on. `@thetis/gateway-web` listens on `run/web.sock`; `@thetis/gateway-login` on `run/login.sock` in the system userspace. The door on the host connects to them. See [15-web-gateway.md](15-web-gateway.md).

### 3.9 Docker

`fence.docker` decides whether every fence is given the host's Docker socket, bound read-only at `/var/run/docker.sock` — the path the Docker CLI reads without being told, whatever the socket is called on the host, so `docker` and `docker compose` work inside the fence with nothing configured.

| Value | Behavior |
|---|---|
| `auto` | Bind a socket the kernel can actually use, and otherwise nothing, silently. This is the default. |
| `on` | Bind the socket whether or not the probe passes. For a daemon that starts after the kernel, or a socket whose permissions arrive later. |
| `off` | Never bind. |

`dockerSocket` in `packages/sandbox/src/docker.ts` chooses the host path. A path named in `fence.dockerSocket` is the **only** candidate: naming one and silently getting a different daemon because that one failed a probe is a worse outcome than no Docker at all. With nothing named the order is `DOCKER_HOST` when it is a `unix://` endpoint — a `tcp://` one names no path and cannot be bound, so it is not a candidate — then `/var/run/docker.sock`, `/run/docker.sock`, and `$XDG_RUNTIME_DIR/docker.sock` for a rootless daemon. Usable means the path is a socket and `access(W_OK)` passes for the kernel's own user and its supplementary groups, which for a `root:docker` socket is exactly the question of whether the kernel's user is in the `docker` group. A socket that is there but unusable is worth telling apart from no socket at all: binding it would hand the fence a permission error from the CLI rather than the honest absence of Docker.

Three properties of the bind, each deliberate:

- **A unix socket is filesystem, not network.** The bind works in every network mode, `none` included. `packages/sandbox/test/docker.test.ts` proves it by asking the daemon for its version from a fence started with `--unshare-net`.
- **Read-only still permits `connect`.** That needs write permission on the socket *inode*, which a mount's read-only flag does not govern. What read-only does buy is that the fence cannot unlink the socket or put its own there.
- **It is bound last among the read-only binds, and under no other bind's path.** A bind of a parent directory lands on top of whatever was mounted beneath it. Getting this backwards is not hypothetical; it is how `fence.hidden` stopped masking `$THETIS_HOME` when the data directory moved under `/opt`.

Host paths line up, which is what makes `docker compose` work against a mounted repository: a mount appears in the fence at its host path, so a relative bind mount in a compose file resolves to the same directory whether the CLI in the fence or the daemon on the host reads it.

**What this gives away.** Everything. A process that can talk to the daemon can start a container with `--privileged` and `/` bound into it, so socket access is host root: the filesystem, process, capability, cgroup and network rules of sections 3.2, 3.3 and 3.6 stop applying to anything it asks the daemon to run. It is on by default because on a single-operator installation the fence is not relied on as a boundary, and because each alternative — a filtering proxy over the daemon API, a daemon per userspace, a separate build host — costs considerably more than it buys there. Set `fence.docker` to `"off"` on any installation where a fence holds code you do not already trust with the host. See [12-security.md](12-security.md) section 3.

**Reachability is a separate question, and the answer surprises people.** In network mode `egress` the fence has no route to the host's loopback, so a container listening there — which is what `network_mode: host` with a loopback bind address gives, and what a published port on `127.0.0.1` gives — cannot be reached from the fence that started it. The fence can reach a container on a bridge network by its address. `ProcessFence` logs this once when it binds a socket in `egress` mode, because the failure otherwise reads as a broken stack rather than a fence rule. `fence.network: "host"` is the way to reach loopback containers, and it is not much of a concession next to the socket itself.

## 4. The userspace agent

The package `@thetis/userspace-agent` is the guest side of the fence. Its source is `packages/userspace-agent/src/agent.ts`.

The agent:

- reads requests from `stdin`, one JSON object per line;
- writes responses to `stdout`, one JSON object per line;
- writes logs to `stderr`. The kernel forwards each `stderr` line to the `log` service with the prefix `[<user id>]`;
- redirects `console.log`, `console.info`, and `console.debug` to `stderr`. This keeps `stdout` clean for the protocol;
- exits when `stdin` closes.

**Caution:** Package code that writes to `process.stdout` directly corrupts the protocol. The kernel ignores lines that are not JSON and logs them as stray output.

### 4.1 Module loading

The agent loads a package export in these steps:

1. Read `<store>/node_modules/<package>/package.json`.
2. Resolve `main` relative to the package directory. The default is `index.js`.
3. Read the modification time of the `main` file.
4. Import the file URL with the query `?v=<modification time>`. A changed file gets a new module instance.
5. Read the named export. Throw when it is not a function.

### 4.2 The environment object for package code

The agent builds one `StepEnv` object. Steps receive it as `ctx.env`. Tools receive it as their second argument with two extra fields.

| Field | Content |
|---|---|
| `cwd` | The userspace home. |
| `shared` | The shared directory: written by the system userspace, read-only in every other fence. |
| `root` | The userspace root. |
| `store` | The store directory. |
| `exec(cmd, opts)` | Runs `cmd` with `/bin/bash`. `opts.cwd` is relative to home. `opts.timeoutMs` defaults to 120000. Output is capped at 30,000 characters per stream. Returns `{ code, stdout, stderr }`. |
| `readFile(path)` | Reads a UTF-8 file. The path is relative to home. |
| `writeFile(path, content)` | Writes a UTF-8 file. Creates parent directories. |
| `storage(namespace?)` | A `Store` of documents this package keeps in the service plane's store, under `userspaces/<user>/<package>/<namespace>` (default `default`). The kernel builds the prefix from the fence's user and the package whose code runs, so a package reaches only what it wrote. A document is capped at 256 KiB. See [26-storage.md](26-storage.md) section 7. |
| `kernel` | The kernel client. See section 6. |
| `session` | Tools only. `{ id, user, parent? }`. |
| `config` | Tools only. The effective configuration of the tool's package. See [09-configuration.md](09-configuration.md) section 4. |

## 5. Wire protocol

Each message is one line of JSON.

### 5.1 Kernel to agent: request

```json
{ "id": "r7", "op": "step", "payload": { ... } }
```

### 5.2 Agent to kernel: event, result, error

```json
{ "id": "r7", "event": { ... } }
{ "id": "r7", "result": ... }
{ "id": "r7", "error": "message and stack" }
```

Zero or more `event` lines come first. Exactly one `result` or `error` line ends the request. The kernel rejects the request with a `KernelError` of code `package` when it receives `error`.

### 5.3 Agent to kernel: RPC

```json
{ "rpc": "k3", "method": "packages.install", "args": { "source": "packages/hello" } }
```

The kernel answers with zero or more events and then one result:

```json
{ "rpcEvent": "k3", "event": { ... } }
{ "rpcResult": "k3", "result": ... }
{ "rpcResult": "k3", "error": "message", "code": "busy" }
```

`code` is the `KernelError` code. The agent sets it on the rejected `Error` as `code`.

### 5.4 Operations

| `op` | Payload | Result |
|---|---|---|
| `ping` | `{}` | `"pong"`. The kernel sends it once after `open`. |
| `exec` | `{ cmd, cwd?, timeoutMs? }` | `{ code, stdout, stderr }` |
| `step` | `{ package, export, ctx }` | A `StepResult` with only `conversation`, `call`, `harness`, or `null`. |
| `tool` | `{ package, export, name, args, session, config }` | The return value of the tool. |
| `enumerate` | `{ package, export, ctx: { session, packages, phases } }` | An array of step references. |
| `provider.models` | `{ package, export, config }` | An array of `ModelDescriptor`. |
| `provider.call` | `{ package, export, config, call }` | `null`. Each `ProviderEvent` arrives as an `event` line. |
| `service.start` | `{ package, export, config }` | `"started"`, or `"running"` when the service already runs. See section 7. |
| `service.stop` | `{ package }` | `"stopped"`. |

In `step`, `ctx` is a `StepContext`. Its `packages` field is an array. The agent wraps the array into a `PackageQuery` and adds `env`. Its `config` field holds only the configuration of the step's own package.

### 5.5 Cancel

The kernel sends this line to stop a request that is in progress:

```json
{ "cancel": "r7" }
```

The kernel rejects the request with the code `cancelled` at the same time. It ignores every later `event`, `result`, or `error` line with that id. The agent aborts the request's `AbortSignal`:

- `exec` kills the process.
- `provider.call` stops reading the provider stream. This closes the provider's iterator.
- Other operations run to the end. Their result is discarded.

### 5.6 Timeouts

Each request has a timer of `requestTimeoutMs` milliseconds. The default is 600000. On timeout the kernel rejects the request with the code `fence`. The pool then drops the handle and closes the agent.

When the agent process exits, the kernel rejects all pending requests with the code `fence`.

## 6. The kernel client

Code inside the fence reaches the kernel through `env.kernel`. Every method runs as the fence's own user. The kernel authorizes the user on each call.

| Method | RPC method | Behavior |
|---|---|---|
| `kernel.packages.install(source)` | `packages.install` | Installs a package into this userspace. Returns `PackageInfo`. |
| `kernel.packages.uninstall(name)` | `packages.uninstall` | Removes the package link and registry entry. Stops its service first. Puts back the package a fork replaced. |
| `kernel.packages.delete(name)` | `packages.delete` | Uninstalls a package of this userspace's own scope and deletes its directory under the home. Returns `{ name, path, restored? }`. |
| `kernel.packages.list()` | `packages.list` | Returns the installed packages. |
| `kernel.sessions.create(parent?, as?)` | `sessions.create` | Creates a session. Returns a session reference. |
| `kernel.sessions.ask(session, input, as?)` | `sessions.ask` | Runs one turn to completion. Returns the final assistant text. |
| `kernel.sessions.send(session, input, onEvent, opts?)` | `sessions.send` | Runs one turn. Each `TurnEvent` arrives through `onEvent`. Resolves at the end. `opts.model` names the model for this turn; steps may still change `call.model`. |
| `kernel.sessions.cancel(session, as?)` | `sessions.cancel` | Stops the running turn. Returns `false` when no turn runs. |
| `kernel.sessions.list(as?)` | `sessions.list` | Lists the sessions. |
| `kernel.sessions.inspect(session, as?)` | `sessions.inspect` | Returns one session record with its status. |
| `kernel.models()` | `models` | Returns `{ model, models }`: the configured default and every model the providers visible to this userspace serve. |
| `kernel.config.show(name)` | `config.show` | The state of every key of a package installed in this fence, at this person's own layer over the system's, secrets redacted. Returns a `ConfigReport`. `not-found` for a package not installed here. |
| `kernel.config.set(name, key, value)` | `config.set` | Sets one key in this person's own layer, secrets included. Refuses `null`, a declared type mismatch, and a key declared `scope: "system"`. Returns the report. |
| `kernel.config.unset(name, key)` | `config.unset` | Removes one key from this person's own layer. Returns the report. |
| `kernel.config.effective(name)` | `config.effective` | What that package's code receives: every layer merged, secrets included, references resolved. For any package installed in this fence. |
| `kernel.auth.login(id, password)` | `auth.login` | Returns `{ token, user }` or `null`. System userspace only. |
| `kernel.auth.authenticate(token)` | `auth.authenticate` | Returns `{ id, role }` or `null`. System userspace only. |
| `kernel.auth.logout(token)` | `auth.logout` | Revokes the token. System userspace only. |

`as` names the user a session call acts for. The kernel accepts it from the system userspace only. Any other fence gets the error `unauthorized`. This is how a system gateway serves every user: it authenticates a person with `auth.authenticate` and passes that id as `as`. A method that is not in this list fails with the code `rpc`.

`env.storage(namespace?)` is five more RPC methods, sent by the storage client in `packages/userspace-agent/src/env.ts` rather than by `env.kernel`:

| RPC method | Arguments | Behavior |
|---|---|---|
| `store.get` | `package`, `namespace?`, `key` | The document, or `null` when there is none. |
| `store.set` | `package`, `namespace?`, `key`, `doc` | Replaces the document. A document over 256 KiB, an array, or a `null` anywhere in it is refused with the code `invalid`. |
| `store.delete` | `package`, `namespace?`, `key` | Removes the document. |
| `store.list` | `package`, `namespace?`, `prefix?` | The keys. |
| `store.clear` | `package`, `namespace?` | Removes the namespace and those beneath it. |

The fence names the package and a sub-namespace; the kernel prefixes them with `userspaces/<fence user>/`, so nothing a fence sends can leave its own tree. The `config.*` methods take a package name the same way, and the kernel supplies the fence's own user as the layer. In the system userspace the own layer is the system layer.

## 7. Services

A package can declare a service. See [05-packages.md](05-packages.md) section 13. The agent runs the service in its own process:

- `service.start` loads the export and calls it with a `ServiceEnv`: the `StepEnv` fields plus `config` (the package's effective configuration, read once here) and `log(line)`, which writes to `stderr` with the package name as prefix. The export can return `{ stop() }`. The agent keeps one instance per package.
- `service.stop` calls `stop()` and forgets the instance.
- When the package's configuration changes (`config.set`, `config.unset`, or a changed entry on `thetis config reload`), the kernel sends `service.stop` and then `service.start` with the new configuration. The service is restarted in place; the fence stays open. See [05-packages.md](05-packages.md) section 13.
- The agent exits when the fence closes. Every service exits with it.

**Caution:** A service must not write to `process.stdout`. It shares the protocol channel with the agent. Use `env.log`.

## 7. Failure modes

| Event | Effect |
|---|---|
| The agent crashes during a step. | The step fails with code `fence`. The turn ends with an `error` event. The next request restarts the agent. |
| Package code throws. | The request fails with code `package`. For a step, the turn ends with an `error` event. For a tool, the tool result is `error: <message>` and the turn continues. |
| A request exceeds the timeout. | The request fails with code `fence`. The agent is closed. |
| `bwrap` is missing. | Mode `auto` falls back to `none`. Mode `bwrap` fails on `open`. |
