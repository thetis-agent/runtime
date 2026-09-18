# 12 Security

## 1. Trust boundaries

| Zone | Trust | Code that runs there |
|---|---|---|
| Service plane (the kernel process) | Trusted | `@thetis/kernel`, `@thetis/host`, `@thetis/sandbox`, `@thetis/lib`, `@thetis/contracts`, and `@thetis/gateway-cli`. |
| The door | Trusted, runs in the host process. Copies bytes; never authenticates. | `@thetis/door`, started by `thetis serve`. |
| System userspace `_system` | Fenced. Holds service secrets. The only fence that may log people in. | System providers, the login target `@thetis/gateway-login`, the marketplace service, and any `@thetis/*` package installed there. |
| User userspace | Fenced. Untrusted code. Holds that person's authority and nobody else's. | The person's packages, the system packages linked into it, and that person's own `@thetis/gateway-web`. |

The kernel treats every value from a fence as untrusted input. It validates step results, enumerator plans, manifests, and RPC arguments.

## 2. What the fence enforces (mode `bwrap`)

- Filesystem: the agent writes only inside its userspace root, its `rw` mounts (section 10), and, for the system userspace, the shared directory. The operating system, `<root>/packages`, `<root>/node_modules`, `$THETIS_HOME/packages` (the promoted packages), `$THETIS_HOME/shared`, and the `ro` mounts are read-only. The rest of `$THETIS_HOME` is masked. `/home` and the host `/tmp` are not visible.
- Processes: the agent has its own user and PID namespaces, no capabilities, and cannot create a nested user namespace. It cannot see or signal host processes. It dies with the kernel.
- IPC and hostname: separate namespaces.
- Network, in mode `egress` (the default when `slirp4netns` is installed): a private network namespace with outbound NAT. The fence reaches the internet and the local network; it cannot reach the host's loopback and cannot bind a host port. Mode `none` gives no network at all.
- Resources: memory, process count, and CPU per fence through cgroup v2, when the kernel runs in a delegated cgroup. The fence's own group, and only its own, is bound read-only under `/sys/fs/cgroup` so the agent can read the limit it is held to — at the path its own `/proc/self/cgroup` names, because a runtime resolves its group by appending that line to the mount point and the group bound at the mount root makes that concatenation name nothing (it crashed .NET intermittently). It cannot write the group, and it sees no other fence's. See [03-fence.md](03-fence.md) section 3.3.
- Environment: only the variables listed in [03-fence.md](03-fence.md) section 3.5. The kernel's environment, including `OPENROUTER_API_KEY`, does not reach any fence.
- Configuration: a package receives its own effective configuration, the four layers merged along its fork chain ([09-configuration.md](09-configuration.md) section 4), and nothing of another package's. A fork receives its origin's. A key set at a person's layer reaches that person's fence only; a key at the system layer reaches every fence that holds the package. The OpenRouter key reaches the system userspace through `@thetis/provider-openrouter`. **It also reaches every person's fence today**: the shipped default for `@thetis/skills-hybrid` is `embeddings: { apiKey: "${OPENROUTER_API_KEY}" }`, and that package is in `systemPackages["*"]`, so a person's tools and steps run beside a process that holds the key. Set `packages["@thetis/skills-hybrid"].embeddings` to a key with its own budget, or to `{}` for lexical ranking, before giving a fence to someone you do not trust with the key.

The test `fence isolation` in `test/e2e.test.ts` verifies the filesystem part.

## 3. What the fence does not enforce

- **Network, in mode `host`.** Without `slirp4netns` the fence shares the host network namespace and can reach `localhost` services and bind host ports.
- **Egress policy.** Mode `egress` is all-or-nothing: no per-package destination list. Routable machines on the local network stay reachable.
- **Disk.** No disk quota. A package can fill the filesystem. `env.storage()` caps one document at 256 KiB and nothing else: there is no total quota per package or per person.
- **Resource limits without delegation.** Without a delegated cgroup there are no memory, process, or CPU limits.
- **Time limits on tools.** `exec` has a default timeout of 120000 milliseconds. A tool can pass a larger value.
- **Mode `none`.** No isolation at all. The agent runs as the host user with full access.
- **Kernel exploits.** `bwrap` is a user-namespace sandbox, not a virtual machine. The design target is a microVM per userspace.

## 4. Authorization rules the kernel enforces

- Every session API call runs `users.authorize(id)`. Unknown and suspended users are rejected.
- A session is found only in the caller's own userspace directory.
- RPC from a fence runs as the userspace's own user. No argument can name another user. There is no `as`.
- `store.*` and `config.*` take a package name, not a user. The kernel prefixes the store namespace with the fence's own user (`userspaces/<user>/<package>/...`) and takes the fence's own user as the configuration layer, so a fence reaches only its own documents and its own layer. `config.set` from a fence refuses a key declared `scope: "system"`, whatever the person's role.
- `config.effective` is answered for any package installed in the same fence, secrets included. A fence is one person's authority: a package in it may load another's configuration the way the web gateway runs another package's UI commands.
- `auth.login` is answered only for the system userspace. `auth.authenticate` and `auth.logout` are answered for any fence, but only when the token names that fence's own user; the system userspace may resolve any token.
- A fence whose user is an admin may call operator methods (`operator.<method>`, the table of the control socket). The kernel checks the role on every call and records the fence's user as the actor. A gateway that hides a button is a courtesy, not the gate.
- `restart.request` asserts that the actor is an **admin**, not merely that it is not a user. The operator channel admits any fence whose role is not `user`, which admits the system userspace; that fence has no business ending every turn on the host. See section 11.
- A user installs only into scope `@<own id>/*`. Only admins install `@thetis/*`.
- A local install path must resolve inside the userspace root. `..` escapes are rejected.
- A package enumerator can schedule only steps that installed packages declare.
- A tool call runs only a tool that a step attached to `call.tools`, and that tool runs in the caller's own fence.

## 5. Authentication

The kernel holds passwords and login tokens: `AuthService` in the service plane ([06-sessions-and-users.md](06-sessions-and-users.md) section 7). The CLI trusts `--user`; anyone who can run the CLI on the host is an operator.

For browsers, three parts share the work and none of them holds more than it needs:

1. **The door** on the host port routes by path prefix and never authenticates. A prefix is routing, not authority.
2. **The login target** in the system userspace exchanges a password for a token, sets the cookie, and sends the browser to `/<person>/`.
3. **The person's gateway** in that person's own fence resolves the cookie with `auth.authenticate`, which the kernel answers only when the token names that person. A cookie for someone else is a `401`, whatever the URL says.

The cookie is `HttpOnly` and `SameSite=Strict`, `Path=/`. It is `Secure` with the login target's `secure` key. The door binds `127.0.0.1` by default. See [15-web-gateway.md](15-web-gateway.md).

A `POST` from another site is refused by its `Sec-Fetch-Site` header. Two routes are Server-Sent Events streams over `GET` and that check does not apply to them: `/api/events` and `/api/ext/<scope>/<name>/<verb>/stream` ([15-web-gateway.md](15-web-gateway.md) section 11.5). An `EventSource` sends no header of its own, so there is nothing to read; it does not need one, because the browser refuses an `EventSource` to another origin before the gateway sees it, while it lets a cross-site `POST` through. Both streams are guarded the way every other route is: the login cookie, which the kernel resolves only when the token names this fence's own person, and the door's routing of `/<person>/` to that person's gateway. A streaming verb runs the code of a package that person installed, in that person's fence, and its declared `role` is checked before the code runs, as for a command.

## 6. Secrets

The kernel manages secrets now: passwords, tokens, and the secret keys of a package's configuration.

- Passwords are scrypt hashes in the private store namespace `auth/credentials`; login tokens are in `auth/tokens`. With the default driver these are `$THETIS_HOME/store/auth/credentials/` and `.../tokens/`, directories of mode `0700` with files of mode `0600`. No fence can read them: `$THETIS_HOME` is masked in every fence, and the e2e suite asserts that no file under `store/auth` and `store/secrets` has a group or other permission bit.
- A configuration key declared `secret: true`, or an undeclared key whose name matches `key`, `secret`, `token` or `password`, is stored in the private namespaces `secrets/system` and `secrets/users/<user>`, never in `config/*`. It reaches only the fence its layer is for, inside that package's effective configuration. See [09-configuration.md](09-configuration.md) section 4.
- Who sets a secret: an admin at the system layer (`thetis config set`, the Configuration section of the control panel); a person at their own layer (**Configure** in the marketplace, `kernel.config.set` from their fence); the model through `configure_package` at the person's layer. **Caution:** a secret the model sets was pasted into the conversation, and the transcript keeps it. The tool's description says to prefer the panel. `thetis config set --stdin` keeps a secret out of the shell's history and out of `ps`.
- A secret is never returned. `config.show`, `package_config`, the CLI and the panel report a secret as `set` or `not set`; the only value shown is a pure `${VAR}` reference, which is a name and not a value. A secret nested inside a non-secret value (`embeddings.apiKey`) is shown as `•••` at any depth. The journal rows `config.set` and `config.unset` carry the key name and `secret: true`, never the value.
- The secrets are plain files with restrictive modes, not encrypted at rest. Anyone who can read the service plane's user on the host reads them.
- The control socket `$THETIS_HOME/thetis.sock` has mode `0600`. It gives operator rights to anyone who can open it, the same rights as running the CLI on the host.
- The gateway sockets `<userspace>/run/*.sock` have mode `0660`. The door and the userspace's own code reach them; a fence cannot see another userspace's `run/`.
- The OpenRouter key is in `<root>/.env`. `.gitignore` excludes it. `packages` in the configuration keeps its `${VAR}` references unresolved, so `thetis config` prints the reference under a secret-looking key as `•••` and never the key; `thetis config show` prints a pure reference as the reference. No command prints an interpolated secret.
- The key was pasted into the conversation that created this project. Rotate it when the project leaves development.
- The config file references the key as `${OPENROUTER_API_KEY}`. Do not write the literal key into the config file. A key that must not sit in `.env` goes into the store: `thetis config set <package> <key> --stdin`.
- A user provider can keep its credentials in the person's own configuration layer, where only that person's fence receives them, or inside the person's home.

## 7. Denial of service

- A fence request stops after `requestTimeoutMs` (default 600000 milliseconds). The agent is killed and restarted.
- Output of `exec` is capped at 30,000 characters per stream.
- There is no limit on the number of sessions, the size of a conversation, or the size of the harness object.
- An extension stream (`GET /api/ext/<scope>/<name>/<verb>/stream`) has no timeout and no size cap. The package that declares the verb decides how long it runs and how much it sends; the gateway stops it only when the browser lets go.

## 8. Recommendations before multi-tenant use

1. Put TLS in front of the door.
2. Run the kernel in a delegated cgroup so the limits apply.
3. Add a size limit for `conversation` and `harness` in `PipelineRunner.apply`.
4. Consider a microVM fence for a stronger boundary than user namespaces.

## 9. The journal

`$THETIS_HOME/journal.jsonl` is the append-only record of what happened: one JSON object per line with `at`, `kind`, `actor`, `target`, and `data`. The kernel writes it; no fence can read it. It rolls to `journal.1.jsonl` past 16 MiB.

| Kind | Actor | Target | Data |
|---|---|---|---|
| `user.create`, `user.remove`, `user.role`, `user.status`, `user.password` | the admin, or `operator` from the CLI | the user | `role`, `status` |
| `package.install`, `package.uninstall`, `package.promote`, `package.everyone` | the admin or `operator` | the userspace, or the package for `everyone` | `name`, `version`, `source`, `promoted`, `userspaces` |
| `turn.start`, `turn.end` | the person | the session | `turn`, `ms`, `error`, and `reported`: the usage the provider reported, summed |
| `service.start`, `service.stop`, `service.fail` | (the kernel) | the userspace | `package`, `error` |
| `fence.reload` | the admin, or `operator` from the CLI | the person whose workspace it was | |
| `config.set`, `config.unset` | the person (from their fence or the `configure_package` tool), the admin, or `operator` from the CLI | the person whose layer changed, or `_system` for the system layer | `package`, `key`, `layer` (`user` or `system`), `secret`. Never the value. |
| `restart.armed`, `restart.again`, `restart.refused` | the admin, or `operator` | `daemon` | `reason`, and `why` on a refusal: one of `off`, `unsupervised`, `no-listener`, `young`, `policy` |
| `restart.cancel` | the admin, or `operator` | `daemon` | `reason` and `by` of the restart that was called off |
| `restart.fire` | whoever asked for the restart | `daemon` | `reason`, `quiet`, `waitedMs`, `cut` |
| `daemon.start`, `daemon.stop` | `daemon` | `daemon` | `pid`, `supervised`, `restartPolicy` on the start; `why` on the stop |

`restart.fire` with `quiet: false` and a non-empty `cut` is the row to look for: it is the only durable record that somebody's turn was truncated. The latch waits two minutes for every conversation to go quiet and then restarts anyway, and the person whose turn it cut is not told ([25-restart.md](25-restart.md) section 7). A restart reads as three rows in order: the `restart.fire`, the `daemon.stop` it caused, and the `daemon.start` of the process systemd put in its place.

`reported` values come from package code and are named so. Admins read the journal with `journal.tail` on the control socket or in the control panel's Activity section.

## 10. Mounts

A mount is an admin's grant of one host directory into one person's fence. The directory appears inside the fence at its host path. `rw` lets the agent and its tools write there. `ro` lets them read only. Only an admin sets mounts, with `thetis mounts` or the operator method `mounts.set`. The kernel checks that the path is absolute and normalized, that the mode is `rw` or `ro`, that the list has at most 32 entries, and that the user exists and is not `_system`. Every change writes one journal row of kind `mounts` with the user and the full list. The change closes the person's fence. The fence reopens with the new binds, and the person's services restart.

A mount whose host path is not a directory when the fence opens is skipped: the fence opens without it, and `THETIS_MOUNTS` does not name it. The mount stays in the store, so it binds again as soon as the directory is there. Because a mount that is written down and a mount that works look the same in the file, `mounts.list` and `mounts.set` answer each mount with `present` (true only for a directory now) and `kind` (`dir`, `file`, or `none`). The command line, the control panel, and the project page all say which, so nobody learns from a failed `read_path` that a bind was skipped.

`mounts.browse` lists the directories directly under one host path, for a picker. It is an operator method, so only an admin reaches it: a person's fence shows only what is bound into it, and a person who cannot bind a directory has no reason to see the host's shape. The listing holds directories alone, leaves out hidden names unless asked, is capped at 500 entries, and never throws: it answers what the path is (`dir`, `file`, `none`) and whether it can be read. It reads names, never file contents.

A mount is a hole in the fence, opened on purpose. The kernel does not check what the directory holds. A `rw` mount of a directory with secrets, with `.git`, or with code the host runs gives the agent those. A mount of a path under `$THETIS_HOME` or under another userspace shows that path to the person. The bind follows the host directory as it is now and later: files added on the host appear in the fence at once. A mount does not change the process, network, or resource rules of sections 2 and 3. In sandbox mode `none` a mount changes nothing on disk: the agent can already reach every host path. `THETIS_MOUNTS` still names the mounts, so the file tools treat them the same way in every mode.

## 11. Restarting the daemon

A restart ends every turn in progress on this host and every terminal shell session ([25-restart.md](25-restart.md)). It is an operator act, and two separate things keep it one.

**The kernel asserts an admin.** `restart.request` checks the actor's role itself, in `packages/kernel/src/control.ts`, rather than leaving it to the operator channel. The channel admits any fence whose role is not `user`, which admits the system userspace: that fence holds the providers, the sign-in page and the marketplace service, and none of that is a reason to end every turn on the host. A request that names no actor came over the control socket, whose `0600` holder is the operator, as with every other command.

**The tool is confined by what is installed.** A tool declaration carries no `role` field, unlike a `ui.commands` entry, so a tool every model can see and only an admin may use would be a setting that records an intention: most people's model would offer it and collect refusals. Authority here is what is installed. `@thetis/tool-operator` is installed per admin, with `thetis packages install @thetis/tool-operator --user <admin-id>`, and it is not in the default `systemPackages["*"]`. **Putting it in `systemPackages["*"]` is a configuration error.** The kernel refuses a caller who is not an admin whatever is installed, so the packaging is the signal and the kernel is the guard. The package's statusbar chip has the same authority for the same reason and checks no role of its own: the gateway lists the extension only for the people who have the package.

The five refusals `off`, `unsupervised`, `no-listener`, `young` and `policy` are not authorization. They refuse a restart that would not come back, or that would become a loop, and they refuse it for the operator too. See [25-restart.md](25-restart.md) section 4.2.
