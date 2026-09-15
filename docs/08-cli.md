# 08 Command-line gateway

The package `@thetis/gateway-cli` provides the `thetis` command. The entry point is `bin/thetis.js`. Run it from `<root>` with `node bin/thetis.js <command>` or `npm run thetis -- <command>`.

The CLI has two modes. When `thetis serve` runs, every other command connects to its control socket `$THETIS_HOME/thetis.sock` and is a client of that one kernel. Installs, passwords, and moderation then reach the running services. Without a daemon, a command starts a kernel in its own process and shuts it down at the end. Both modes use the same operator handler, `createControlHandler` in `packages/kernel/src/control.ts`, so a command behaves the same way in either mode.

The socket protocol is the fence RPC protocol over a Unix socket: `{ id, method, args }` in; `{ id, event }` lines, then `{ id, result }` or `{ id, error, code }` out. The socket has mode `0600`. Anyone who can open it is an operator.

## 1. Environment

| Variable | Effect |
|---|---|
| `THETIS_HOME` | The data directory. Default `~/.thetis`. A relative path is resolved against `<root>`. |
| `OPENROUTER_API_KEY` | Interpolated into the configuration. |

The CLI loads `.env` from the current directory and then from `<root>`. A variable that is already set is not replaced.

## 2. Commands

### 2.1 `init`

Creates `$THETIS_HOME/thetis.config.json` when it does not exist. The file contains the portable defaults. It does not contain derived paths. See [09-configuration.md](09-configuration.md).

### 2.2 `config`

Prints the effective configuration as JSON, with interpolated values.

**Caution:** The output contains the interpolated API key.

### 2.3 `users`

```
thetis users list
thetis users add <id> [--admin]
thetis users remove <id>
thetis users suspend <id>
thetis users unsuspend <id>
thetis users role <id> <admin|user>
thetis users passwd <id> [--password <text>]
```

- `add` creates the user with role `user`, or `admin` with `--admin`.
- `remove` deletes the user and its userspace directory.
- `suspend` blocks all session API calls for the user. `unsuspend` restores them.
- `list` prints `id`, `role`, `status`, and `createdAt`, separated by tabs.
- `passwd` sets the sign-in password for network gateways. Without `--password` it reads one line from standard input: `echo secret | thetis users passwd alice`. A new password revokes every login of the user.

### 2.4 `packages`

```
thetis packages list [--user <id>]
thetis packages install <source> [--user <id>]
thetis packages uninstall <name> [--user <id>]
thetis packages promote <name> --user <id>
thetis packages outdated [--user <id>]
thetis packages update [<name>] [--user <id>]
thetis install <source> [--user <id>]
thetis uninstall <name> [--user <id>]
```

- `install` and `uninstall` at the top level are the same commands.
- `outdated` compares each installed package's pin against the marketplace index and prints what is behind. `update` reinstalls those packages at the index's current commit, or one of them by name. Nothing updates on its own; these are the only way a package moves. See [18-marketplace.md](18-marketplace.md) section 7.
- Without `--user`, the commands act on the system userspace as `_system`. This is how a system gateway is installed: `thetis install @thetis/gateway-web`.
- `install` accepts a system name, a git URL, or a path inside the user's home. See [05-packages.md](05-packages.md) section 5.
- `list` prints `name@version`, `type`, and the store path.

### 2.5 `sessions`

```
thetis sessions list --user <id>
thetis sessions show --user <id> --session <id>
```

- `list` prints `id`, `turns`, `updatedAt`, and `parent` when set.
- `show` prints the full session record as JSON, with `status`.

### 2.6 `send`

```
thetis send --user <id> [--session <id>] [--verbose] <text...>
```

Runs one turn and prints the events. Without `--session` it creates a new session. Use `sessions list` to find the id for later turns.

### 2.7 `chat`

```
thetis chat --user <id> [--session <id>] [--verbose]
```

Starts an interactive loop. Without `--session` it creates a new session. Input lines:

| Input | Effect |
|---|---|
| text | Sends one turn and streams the reply. |
| `/new` | Creates a new session. |
| `/inspect` | Prints the session id, turn count, message count, harness, and status. |
| `/quit` or `/exit` | Ends the loop. |

The loop reads from standard input. Piped input works: `printf 'hello\n/quit\n' | node bin/thetis.js chat --user alice`.

### 2.8 `serve`

```
thetis serve
```

Runs the kernel until `SIGINT` or `SIGTERM`. It opens the control socket, arms the service supervisor, and starts every service that installed packages declare, in every userspace. See [05-packages.md](05-packages.md) section 13. Ctrl+C removes the socket, closes every fence, and stops every service. A second `serve` while one runs fails with `a thetis daemon is already running`. A stale socket file from a crash is replaced.

`promote` makes a user's package the default for everyone: it becomes `@thetis/<basename>` and is installed into every userspace. Admin scope. See [05-packages.md](05-packages.md) section 14.

### 2.9 `models`

```
thetis models [--user <id>]
```

Prints every model id and its provider package, separated by a tab. Without `--user` it lists the models visible to the system userspace.

### 2.10 `bench`

```
thetis bench run <suite> [--write] [--force] [--out <dir>] [--sandbox auto|bwrap|none] [--package <dir>]
thetis bench verify [<package-dir>]
```

`run` measures the harness against a suite. `verify` checks a package's `thetis.bench` declaration and runs
nothing. See [21-benchmarks.md](21-benchmarks.md).

**Note:** `bench` is the one command that never uses the data directory and never connects to a running
daemon. It starts a kernel in a temporary home and deletes it at the end, because the arms, the phases and
the installed set all have to be controlled for the numbers to mean anything.

The exit code is 1 when an arm claimed it surfaced something the assembled prompt does not show.

## 3. Event rendering

`send` and `chat` render events as follows:

| Event | Output |
|---|---|
| `text` | The delta, without a newline. |
| `tool.call` | A dim line `[tool <name>] <args>`. Arguments are cut at 400 characters. |
| `tool.result` | A dim line `[<name> -> <result>]`. The result is cut at 300 characters. |
| `error` | A red line `error: <message>`. |
| `step.start`, `step.end`, `usage` | Only with `--verbose`. |

## 4. Control methods

The command line talks to a running kernel through the control socket with these methods. An admin's fence reaches the same table through `operator.<method>` over the fence RPC; the kernel adds `actor` from the fence's user. `user` names the target user; it defaults to `_system`. Every method that changes something writes one journal row.

| Method | Arguments | Effect |
|---|---|---|
| `ping` | | `pong`. |
| `users.list`, `users.create`, `users.remove`, `users.setStatus`, `users.setRole`, `users.passwd` | `id`, `role`, `status`, `password` | User administration. |
| `packages.list`, `packages.install`, `packages.uninstall` | `user`, `source`, `name`, `actor` | Package management in that user's userspace. `actor` names who installs; the ownership rules use the actor's role. The CLI sends `_system`; the operator channel sends the admin. |
| `packages.promote` | `user`, `name` | Makes the package the default for everyone. Returns `{ name, userspaces }`. |
| `packages.installEveryone` | `source`, `actor` | Installs a package for every person, now and later. Returns `{ name, userspaces }`. See [05-packages.md](05-packages.md) section 15. |
| `journal.tail` | `limit`, `kind`, `target` | The newest journal rows, newest first. See [12-security.md](12-security.md) section 9. |
| `config.get` | | The configuration with secrets replaced by `•••`. |
| `models` | `user` | Every model the providers visible to that userspace serve. |
| `sessions.create`, `sessions.list`, `sessions.inspect`, `sessions.cancel`, `sessions.send` | `user`, `session`, `input`, `parent`, `model` | Session operations. `sessions.send` streams the turn events. `model` names the model for that turn. |

## 5. Option parsing

- `--key value` sets `key` to `value`.
- `--key` followed by another `--` option or nothing sets `key` to `true`.
- All other arguments are positional.

## 6. Exit codes

The process exits with `1` and prints the error message when a command throws. All other cases exit with `0`. A turn error is printed as an event. It does not change the exit code.

## 7. Trust model of the CLI

See [15-web-gateway.md](15-web-gateway.md) for the browser interface.

`--user` is not authenticated. The CLI is an operator tool on the host. Any person who can run the CLI can act as any user, including admins. A network gateway must authenticate callers before it maps them to a user.
