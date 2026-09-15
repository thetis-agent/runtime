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
- Resources: memory, process count, and CPU per fence through cgroup v2, when the kernel runs in a delegated cgroup.
- Environment: only the variables listed in [03-fence.md](03-fence.md) section 3.5. The kernel's environment, including `OPENROUTER_API_KEY`, does not reach any fence.
- Configuration: a package receives only its own `config.packages[<name>]` entry. The provider key reaches only the system userspace.

The test `fence isolation` in `test/e2e.test.ts` verifies the filesystem part.

## 3. What the fence does not enforce

- **Network, in mode `host`.** Without `slirp4netns` the fence shares the host network namespace and can reach `localhost` services and bind host ports.
- **Egress policy.** Mode `egress` is all-or-nothing: no per-package destination list. Routable machines on the local network stay reachable.
- **Disk.** No disk quota. A package can fill the filesystem.
- **Resource limits without delegation.** Without a delegated cgroup there are no memory, process, or CPU limits.
- **Time limits on tools.** `exec` has a default timeout of 120000 milliseconds. A tool can pass a larger value.
- **Mode `none`.** No isolation at all. The agent runs as the host user with full access.
- **Kernel exploits.** `bwrap` is a user-namespace sandbox, not a virtual machine. The design target is a microVM per userspace.

## 4. Authorization rules the kernel enforces

- Every session API call runs `users.authorize(id)`. Unknown and suspended users are rejected.
- A session is found only in the caller's own userspace directory.
- RPC from a fence runs as the userspace's own user. No argument can name another user. There is no `as`.
- `auth.login` is answered only for the system userspace. `auth.authenticate` and `auth.logout` are answered for any fence, but only when the token names that fence's own user; the system userspace may resolve any token.
- A fence whose user is an admin may call operator methods (`operator.<method>`, the table of the control socket). The kernel checks the role on every call and records the fence's user as the actor. A gateway that hides a button is a courtesy, not the gate.
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

## 6. Secrets

- Passwords are scrypt hashes in `$THETIS_HOME/auth.json`, mode `0600`. No fence can read the file.
- The control socket `$THETIS_HOME/thetis.sock` has mode `0600`. It gives operator rights to anyone who can open it, the same rights as running the CLI on the host.
- The gateway sockets `<userspace>/run/*.sock` have mode `0660`. The door and the userspace's own code reach them; a fence cannot see another userspace's `run/`.
- The OpenRouter key is in `<root>/.env`. `.gitignore` excludes it. The `thetis config` command prints the interpolated key.
- The key was pasted into the conversation that created this project. Rotate it when the project leaves development.
- The config file references the key as `${OPENROUTER_API_KEY}`. Do not write the literal key into the config file.
- A user provider must keep its own credentials inside the user's home. The kernel does not manage user secrets.

## 7. Denial of service

- A fence request stops after `requestTimeoutMs` (default 600000 milliseconds). The agent is killed and restarted.
- Output of `exec` is capped at 30,000 characters per stream.
- There is no limit on the number of sessions, the size of a conversation, or the size of the harness object.

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

`reported` values come from package code and are named so. Admins read the journal with `journal.tail` on the control socket or in the control panel's Activity section.

## 10. Mounts

A mount is an admin's grant of one host directory into one person's fence. The directory appears inside the fence at its host path. `rw` lets the agent and its tools write there. `ro` lets them read only. Only an admin sets mounts, with `thetis mounts` or the operator method `mounts.set`. The kernel checks that the path is absolute and normalized, that the mode is `rw` or `ro`, that the list has at most 32 entries, and that the user exists and is not `_system`. Every change writes one journal row of kind `mounts` with the user and the full list. The change closes the person's fence. The fence reopens with the new binds, and the person's services restart.

A mount is a hole in the fence, opened on purpose. The kernel does not check what the directory holds. A `rw` mount of a directory with secrets, with `.git`, or with code the host runs gives the agent those. A mount of a path under `$THETIS_HOME` or under another userspace shows that path to the person. The bind follows the host directory as it is now and later: files added on the host appear in the fence at once. A mount does not change the process, network, or resource rules of sections 2 and 3. In sandbox mode `none` a mount changes nothing on disk: the agent can already reach every host path. `THETIS_MOUNTS` still names the mounts, so the file tools treat them the same way in every mode.
