# 03 Fence

The fence is the boundary around one userspace. All package code runs inside a fence. The kernel is the only bridge across the fence.

## 1. Interfaces

The file `packages/kernel/src/fence/fence.ts` defines the contract.

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

`FencePool` in `src/fence/pool.ts` keeps at most one open handle per userspace.

- `handle(us)` opens the fence on the first call. Later calls return the same handle.
- `request(us, op, payload, onEvent, signal)` sends one request. When the error code is `fence`, the pool drops the handle. The next request opens a new agent.
- `close(id?)` closes one fence, or all fences when `id` is not given.

## 3. The process fence

`ProcessFence` in `src/fence/process-fence.ts` is the current implementation. It starts one long-lived Node process per userspace. The process runs `packages/userspace-agent/dist/src/agent.js`.

### 3.1 Sandbox modes

The option `sandbox` has three values:

| Value | Behavior |
|---|---|
| `auto` | Use `bwrap` when the probe `bwrap --ro-bind / / --unshare-pid -- true` succeeds. Otherwise use `none`. |
| `bwrap` | Always use bubblewrap. |
| `none` | Start the agent directly with `cwd` set to the userspace home. No isolation. |

`ProcessFence.mode` reports the resolved mode.

**Caution:** In mode `none` the agent can read and write any file the host user can. Use `none` for development only.

### 3.2 Environment variables of the agent

The kernel gives the agent this environment and nothing else:

| Variable | Value |
|---|---|
| `PATH` | The directory of the running Node binary, then the host `PATH`. |
| `HOME` | The userspace home directory. |
| `LANG` | The host `LANG`, or `C.UTF-8`. |
| `THETIS_USERSPACE` | The userspace root directory. |
| `THETIS_HOME_DIR` | The userspace home directory. |
| `THETIS_USER` | The user id. |
| `THETIS_STORE` | The userspace store directory. |

The kernel does not pass its own environment. Secrets in the host environment do not reach the fence.

### 3.3 Bubblewrap arguments

In mode `bwrap` the kernel starts `bwrap` with these arguments, in this order:

1. `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`.
2. `--tmpfs <path>` for each path in `fence.hidden`. The default hides `$THETIS_HOME`. This comes before the read-only binds, so a bind inside a hidden path still shows: the promoted packages directory `$THETIS_HOME/packages` is such a bind.
3. For each of `/usr`, `/etc`, `/opt`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, the Node install prefix, and each path in `fence.readOnly`: skip it when it does not exist; `--symlink <target> <path>` when it is a symbolic link; otherwise `--ro-bind <path> <path>`.
4. `--bind <userspace root> <userspace root>` and `--chdir <userspace home>`.
5. `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--die-with-parent`, `--new-session`.
6. `--setenv` for each variable in section 3.2.
7. `-- <node> <agent.js>`.

The result is:

- The agent sees the operating system read-only.
- The agent sees `<root>/packages` and `<root>/node_modules` read-only. System packages load from there.
- The agent sees its own userspace root read-write.
- The agent does not see `$THETIS_HOME`, other userspaces, `/home`, or the host `/tmp`.
- The agent has its own process table. The agent dies with the kernel.
- The network is shared with the host. See [12-security.md](12-security.md).

**Note:** `bwrap` creates empty mount-point directories for the parents of a bind. The agent can list these empty directories. It cannot read their real content.

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
| `root` | The userspace root. |
| `store` | The store directory. |
| `exec(cmd, opts)` | Runs `cmd` with `/bin/bash`. `opts.cwd` is relative to home. `opts.timeoutMs` defaults to 120000. Output is capped at 30,000 characters per stream. Returns `{ code, stdout, stderr }`. |
| `readFile(path)` | Reads a UTF-8 file. The path is relative to home. |
| `writeFile(path, content)` | Writes a UTF-8 file. Creates parent directories. |
| `kernel` | The kernel client. See section 6. |
| `session` | Tools only. `{ id, user, parent? }`. |
| `config` | Tools only. The configuration of the tool's package. |

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
| `kernel.packages.uninstall(name)` | `packages.uninstall` | Removes the package link and registry entry. Stops its service first. |
| `kernel.packages.list()` | `packages.list` | Returns the installed packages. |
| `kernel.sessions.create(parent?, as?)` | `sessions.create` | Creates a session. Returns a session reference. |
| `kernel.sessions.ask(session, input, as?)` | `sessions.ask` | Runs one turn to completion. Returns the final assistant text. |
| `kernel.sessions.send(session, input, onEvent, as?)` | `sessions.send` | Runs one turn. Each `TurnEvent` arrives through `onEvent`. Resolves at the end. |
| `kernel.sessions.cancel(session, as?)` | `sessions.cancel` | Stops the running turn. Returns `false` when no turn runs. |
| `kernel.sessions.list(as?)` | `sessions.list` | Lists the sessions. |
| `kernel.sessions.inspect(session, as?)` | `sessions.inspect` | Returns one session record with its status. |
| `kernel.auth.login(id, password)` | `auth.login` | Returns `{ token, user }` or `null`. System userspace only. |
| `kernel.auth.authenticate(token)` | `auth.authenticate` | Returns `{ id, role }` or `null`. System userspace only. |
| `kernel.auth.logout(token)` | `auth.logout` | Revokes the token. System userspace only. |

`as` names the user a session call acts for. The kernel accepts it from the system userspace only. Any other fence gets the error `unauthorized`. This is how a system gateway serves every user: it authenticates a person with `auth.authenticate` and passes that id as `as`. A method that is not in this list fails with the code `rpc`.

## 7. Services

A package can declare a service. See [05-packages.md](05-packages.md) section 13. The agent runs the service in its own process:

- `service.start` loads the export and calls it with a `ServiceEnv`: the `StepEnv` fields plus `config` (the package's configuration) and `log(line)`, which writes to `stderr` with the package name as prefix. The export can return `{ stop() }`. The agent keeps one instance per package.
- `service.stop` calls `stop()` and forgets the instance.
- The agent exits when the fence closes. Every service exits with it.

**Caution:** A service must not write to `process.stdout`. It shares the protocol channel with the agent. Use `env.log`.

## 7. Failure modes

| Event | Effect |
|---|---|
| The agent crashes during a step. | The step fails with code `fence`. The turn ends with an `error` event. The next request restarts the agent. |
| Package code throws. | The request fails with code `package`. For a step, the turn ends with an `error` event. For a tool, the tool result is `error: <message>` and the turn continues. |
| A request exceeds the timeout. | The request fails with code `fence`. The agent is closed. |
| `bwrap` is missing. | Mode `auto` falls back to `none`. Mode `bwrap` fails on `open`. |
