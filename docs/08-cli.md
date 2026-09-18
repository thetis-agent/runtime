# 08 Command-line gateway

The package `@thetis/gateway-cli` provides the `thetis` command. The entry point is `bin/thetis.js`. Run it from `<root>` with `node bin/thetis.js <command>` or `npm run thetis -- <command>`.

The CLI has two modes. When `thetis serve` runs, every other command connects to its control socket `$THETIS_HOME/thetis.sock` and is a client of that one kernel. Installs, passwords, and moderation then reach the running services. Without a daemon, a command starts a kernel in its own process and shuts it down at the end. Both modes use the same operator handler, `createControlHandler` in `packages/kernel/src/control.ts`, so a command behaves the same way in either mode.

The socket protocol is the fence RPC protocol over a Unix socket: `{ id, method, args }` in; `{ id, event }` lines, then `{ id, result }` or `{ id, error, code }` out. The socket has mode `0600`. Anyone who can open it is an operator.

## 1. Environment

| Variable | Effect |
|---|---|
| `THETIS_HOME` | The data directory. Default `~/.thetis`. A relative path is resolved against `<root>`. |
| `OPENROUTER_API_KEY` | What the shipped `${OPENROUTER_API_KEY}` references under `packages` resolve to. |

The CLI loads `.env` from the current directory and then from `<root>` into its environment. A variable that is already set is not replaced. The daemon reads `<root>/.env` again whenever it changes, for the `${VAR}` references under `packages` ([09-configuration.md](09-configuration.md) section 2).

## 2. Commands

### 2.1 `init`

Creates `$THETIS_HOME/thetis.config.json` when it does not exist. The file contains the portable defaults. It does not contain derived paths. See [09-configuration.md](09-configuration.md).

### 2.2 `config`

```
thetis config
```

Prints the configuration file over its defaults as JSON. The `${VAR}` references under `packages` stay as written, and every string under a secret-looking key (`key`, `secret`, `token`, `password`) prints as `•••`. It does not connect to the daemon. The subcommands that read and change per-package configuration are section 2.15.

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

Runs the kernel until `SIGINT` or `SIGTERM`. It opens the control socket, arms the service supervisor, and starts every service that installed packages declare, in every userspace. See [05-packages.md](05-packages.md) section 13. Ctrl+C or `SIGTERM` closes the door, open browser streams included, removes the socket, and closes every fence, which stops every service; an agent that has not exited two seconds after its `SIGTERM` is killed. If the shutdown is still not complete after five seconds, `serve` logs what it was waiting on and exits anyway. A second `serve` while one runs fails with `a thetis daemon is already running`. A stale socket file from a crash is replaced.

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

### 2.11 `mounts`

```
thetis mounts list [--user <id>]
thetis mounts add <user> <path> [--ro]
thetis mounts remove <user> <path>
thetis mounts browse [path]
```

A mount binds a host directory into one person's fence at the same path. `list` prints one line per mount: the user, the path, the mode, and what the host has there now — `bound`, `skipped (not on the host)`, or `skipped (a file, not a directory)`. A skipped mount is written down and not in the fence. Without `--user` it prints every user's mounts. `browse` prints the directories directly under `path` (the root without one), so a path can be checked or found before it is bound. `add` binds `<path>` read-write, or read-only with `--ro`. `add` of a path that is already mounted replaces its mode. `remove` unbinds the path. `<path>` must be absolute and normalized. A user has at most 32 mounts. The system user has none.

`add` and `remove` send the whole list with `mounts.set`. The kernel writes the store namespace `mounts`, writes one journal row, and closes the person's fence. The fence reopens with the new binds on the next request, and its services restart. Give `--ro` after the path. `add` fails with a sentence when the host has no directory at the path: the mount is written down, and the fence opens without it. See [12-security.md](12-security.md) section 10.

### 2.12 `reload`

```
thetis reload --user <id>
thetis reload --all
```

A reload closes one person's fence and opens it again. Their gateway, their terminal and every other service in that workspace start on the code that is on disk now, and the kernel drops the provider cache it holds for that userspace. Every open terminal shell session in the fence dies with the old process, and a turn in flight ends with the code `fence`; conversations and files are untouched. It takes about a second. `_system` is a legal target, unlike a mount: the providers and the sign-in page live there. `--all` reloads every active person one at a time with `_system` last, so the sign-in page blips once, at the end. It is `--user <id>` or `--all`, never both and never neither.

Each line names the services that restarted, or says the fence reopens on the next request when nobody runs a service there. One workspace that fails does not stop the rest: the line names it and repeats the command to retry, and the exit code is 1. A reload does not reach the kernel, the door, `thetis.config.json`, or anyone else's workspace. See [25-restart.md](25-restart.md) section 2.

### 2.13 `status`

```
thetis status
```

What is running, and whether it is the code that is on disk now. One line for the daemon: how long it has been up, whether systemd started it, what the deployed unit's `Restart=` says, and whether its own code is newer on disk. Then one line per workspace that exists: when its fence opened or that none is open, the services in it, and the same freshness. An armed restart is one more line, in the same words `thetis restart status` and the page use.

Every stale line is followed, after the whole listing, by the command that fixes it: `thetis reload --user <id>` for a workspace, `thetis restart --reason "..."` or `sudo systemctl restart thetis-runtime.service` for the daemon. A workspace with no fence open is never stale: the next request opens it on whatever is there then. See [25-restart.md](25-restart.md) section 3.

### 2.14 `restart`

```
thetis restart [--reason <text>] [--yes]
thetis restart status
thetis restart cancel
```

Asks the running daemon to replace its own process, which is the only thing that picks up new code in the kernel, the host, the sandbox, the door, `@thetis/lib`, `@thetis/contracts`, the `thetis` command, or `thetis.config.json`. It ends **every turn in progress, everywhere**, and every terminal shell session. Conversations come back with their history and people stay signed in.

Nothing has restarted when the command returns. The kernel arms a latch: the request waits for every turn running anywhere to end, counts down ten seconds where everyone can see it, and only then exits, so systemd starts the replacement. It waits at most two minutes; at that deadline it restarts anyway and the journal names whose turn it cut. The command prints what a restart ends before it asks anything, then asks for confirmation unless `--yes` is given; with no terminal to confirm at and no `--yes` it fails rather than guess. `--reason` is shown to everyone waiting and written to the journal, and defaults to `asked for at the host`. What the command prints back is the latch's own sentence, word for word, so the host, the page and the model read the same words about the same latch.

A restart is refused with nothing armed, and the exit code is 1, for one of five reasons: `off` (`control.allowRestart` is false), `unsupervised` (systemd did not start this daemon), `no-listener` (this is a short-lived command's own kernel, not the serving daemon), `young` (up less than `control.minUptimeSecs`), and `policy` (the **deployed** unit does not say `Restart=always`). The last reads the running system rather than this checkout, because the unit file here is not the unit systemd is using: under `Restart=on-failure` a clean exit stays down, so the daemon asks systemd what the deployed policy is and refuses unless the answer is `always`, and refuses when it cannot be read at all. See [25-restart.md](25-restart.md) section 4.2.

`restart status` says whether one is armed and, when none is, whether one would be accepted at all and why not. `restart cancel` calls an armed one off; nothing armed is not an error and writes no journal row. An armed restart can also be cancelled from the statusbar chip of `@thetis/tool-operator` ([25-restart.md](25-restart.md) section 5.1).

### 2.15 `config show`, `config set`, `config unset`, `config reload`

```
thetis config show [<package>] [--user <id>]
thetis config set <package> <key> [<value>] [--user <id>] [--json] [--stdin]
thetis config unset <package> <key> [--user <id>]
thetis config reload
```

Per-package configuration, live in the running daemon ([09-configuration.md](09-configuration.md) section 4). Without `--user` a command acts on the system layer; with it, on that person's own layer over the system's.

`show <package>` prints one line for the package (`<package>, inherits <origin>: <summary>`) and then one line per key with six tab-separated cells: the key, its state (`set`, `missing`, `unset`), the value as JSON or `•••` for a secret, the layer the value came from (`default`, `file`, `system`, `user`), the origin it was inherited from, and the `${VAR}` names that are not in the environment. `show` without a package prints one line per installed package, the broken ones first and marked `!`, with the kernel's sentence. The control methods are `config.show` and `config.list`.

`set` takes the value as one argument; with `--json` it is parsed, so a number, a boolean, an object or an array can be set; with `--stdin` it is read from standard input, so a secret never lands in the shell's history. A declared key must match its type; `null` is refused; a key declared `scope: "system"` is refused with `--user`. The answer is the key's new state and the package's sentence, never the value. The service of the package, and of every fork of it, restarts in place.

`reload` reads `packages[*]` of `thetis.config.json` again, prints `changed: <names>` or `nothing changed in the file`, and one line `restarted <package> for <user>` per service it restarted. It does not re-read any other field of the file.

### 2.16 `migrate`

```
thetis migrate
```

Moves the four record files of a data directory from before 2026-09-18 (`users.json`, `auth.json`, `registry.json`, `mounts.json`) into the store and renames each `<file>.migrated`. It refuses to run while a daemon answers the socket, because a daemon holds the records in memory. It prints one line per file imported and names the files that were not there; a second run prints `nothing to migrate`. The daemon refuses to start while any of the four files is still in the home, so this is the one command to run after updating an older installation. See [26-storage.md](26-storage.md) section 8.

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
| `mounts.list` | `user` | The mounts of that user as `{ "<user>": [ { path, mode, present, kind } ] }`, or of every user without `user`. `present` is true only when the host has a directory at the path now; `kind` is `dir`, `file`, or `none`. |
| `mounts.set` | `user`, `mounts` | Replaces that user's mounts with `mounts`, a list of at most 32 `{ path, mode }` with an absolute normalized path and mode `rw` or `ro`. The user must exist and must not be `_system`. Writes the `mounts` namespace of the store, journals `mounts`, and closes the user's fence so it reopens with the binds. Returns the list with `present` and `kind`. |
| `mounts.browse` | `path`, `all` | The directories directly under `path` (`/` without one): `{ path, parent, kind, readable, truncated, entries: [ { name, path } ] }`. Directories only, hidden names left out unless `all` is `"true"`, at most 500 entries. A missing or unreadable path is not an error: `kind` and `readable` say so. |
| `fence.reload` | `user` | Closes that user's fence and opens it again, so its services, its provider and the agent are the code on disk now, and drops the provider cache the kernel holds for that userspace. `_system` is a legal target, unlike `mounts.set`. Journals `fence.reload`. Returns `{ user, services }`, the installed packages that declare a service. See [25-restart.md](25-restart.md) section 2. |
| `status` | | What is running and whether it is the code on disk: `{ daemon: { startedAt, uptimeSecs, supervised, restartPolicy, codeAt, stale }, restart, workspaces: [ { user, openedAt, codeAt, stale, services } ] }`. `restartPolicy` is the deployed systemd unit's `Restart=`, or null when it could not be read. `restart` is the armed restart, or null. Changes nothing and writes no row. |
| `restart.request` | `reason`, `actor` | Arms the restart latch; nothing restarts in the call. `reason` is required. When an `actor` is named, that user must be an admin. Returns `{ state, why?, message, pending? }` with `state` one of `armed`, `again`, `refused`; `message` is the latch's own sentence. Journals `restart.armed`, `restart.again` or `restart.refused`, with `why` on a refusal. See [25-restart.md](25-restart.md) section 4. |
| `restart.status` | | `{ startedAt, uptimeSecs, supervised, armable, why?, pending?, policy }`. `why` is the refusal code a request would get now. Writes no row. |
| `restart.cancel` | | Disarms an armed restart. Returns `{ cancelled, was }`. Journals `restart.cancel` only when something was armed: nothing pending is not an event. |
| `journal.tail` | `limit`, `kind`, `target`, `actor_filter` | The newest journal rows, newest first. See [12-security.md](12-security.md) section 9. |
| `config.get` | | The configuration file over its defaults, `${VAR}` references unresolved, secret-looking keys replaced by `•••`. |
| `config.list` | `user` | One `ConfigReport` per package installed in that person's userspace, at their layer, or per package installed anywhere at the system layer without `user`. |
| `config.show` | `name`, `user` | The state of every key of one package: `{ package, user?, inherits, keys, summary, broken }`. Secrets carry no value. `not-found` when the package is not installed. |
| `config.set` | `name`, `key`, `value`, `user`, `actor` | Writes one key at the system layer, or at that person's with `user`. Refuses `null`, a declared type mismatch, and a `scope: "system"` key with `user`. Journals `config.set` without the value. Restarts the affected services. Returns the report. |
| `config.unset` | `name`, `key`, `user`, `actor` | Removes one key from that layer. Journals `config.unset`. Returns the report. |
| `config.reload` | | Reads `packages[*]` of `thetis.config.json` again. Returns `{ changed, restarted }`: the package names whose entry differs, and `{ user, package }` for every service restarted. |
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
