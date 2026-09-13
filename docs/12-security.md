# 12 Security

## 1. Trust boundaries

| Zone | Trust | Code that runs there |
|---|---|---|
| Service plane (the kernel process) | Trusted | `@thetis/kernel` and `@thetis/gateway-cli`. |
| System userspace `_system` | Fenced. Holds service secrets. May act for any user over RPC. | System providers, system gateways such as `@thetis/gateway-web`, and any `@thetis/*` package installed there. |
| User userspace | Fenced. Untrusted code. | The user's packages and the system packages linked into it. |

The kernel treats every value from a fence as untrusted input. It validates step results, enumerator plans, manifests, and RPC arguments.

## 2. What the fence enforces (mode `bwrap`)

- Filesystem: the agent writes only inside its userspace root. The operating system, `<root>/packages`, and `<root>/node_modules` are read-only. `$THETIS_HOME` is masked. `/home` and the host `/tmp` are not visible.
- Processes: the agent has its own PID namespace. It cannot see or signal host processes. It dies with the kernel.
- IPC and hostname: separate namespaces.
- Environment: only the variables listed in [03-fence.md](03-fence.md) section 3.2. The kernel's environment, including `OPENROUTER_API_KEY`, does not reach any fence.
- Configuration: a package receives only its own `config.packages[<name>]` entry. The provider key reaches only the system userspace.

The test `fence isolation` in `test/e2e.test.ts` verifies the filesystem part.

## 3. What the fence does not enforce

- **Network.** The fence shares the host network namespace. Code in any userspace can reach any address the host can reach, including services on `localhost`. Ports bound by two users collide.
- **Resource limits.** No CPU, memory, or disk quotas. A package can exhaust host resources.
- **Time limits on tools.** `exec` has a default timeout of 120000 milliseconds. A tool can pass a larger value.
- **Mode `none`.** No isolation at all. The agent runs as the host user with full access.
- **Kernel exploits.** `bwrap` is a user-namespace sandbox, not a virtual machine. The design target is a microVM per userspace.

## 4. Authorization rules the kernel enforces

- Every session API call runs `users.authorize(id)`. Unknown and suspended users are rejected.
- A session is found only in the caller's own userspace directory.
- RPC from a fence runs as the userspace's own user. A fence cannot name another user. The system userspace is the exception: it may pass `as` and call `auth.*`, because a system gateway serves every user. Code installed there is trusted to that extent.
- A user installs only into scope `@<own id>/*`. Only admins install `@thetis/*`.
- A local install path must resolve inside the userspace root. `..` escapes are rejected.
- A package enumerator can schedule only steps that installed packages declare.
- A tool call runs only a tool that a step attached to `call.tools`, and that tool runs in the caller's own fence.

## 5. Authentication

The kernel has none. The CLI trusts `--user`. Anyone who can run the CLI on the host is an operator. A network gateway must:

1. Authenticate the caller.
2. Map the caller to a user id.
3. Call the session API with that id only.

The kernel holds the identity for this: `AuthService` keeps passwords and login tokens in the service plane ([06-sessions-and-users.md](06-sessions-and-users.md) section 7). `@thetis/gateway-web` exchanges a password for a token over RPC and keeps the token in a cookie. See [15-web-gateway.md](15-web-gateway.md) section 9. The cookie is `HttpOnly` and `SameSite=Strict`. It is `Secure` only with the `secure` configuration key. The server binds to `127.0.0.1` by default.

## 6. Secrets

- Passwords are scrypt hashes in `$THETIS_HOME/auth.json`, mode `0600`. No fence can read the file.
- The OpenRouter key is in `<root>/.env`. `.gitignore` excludes it. The `thetis config` command prints the interpolated key.
- The key was pasted into the conversation that created this project. Rotate it when the project leaves development.
- The config file references the key as `${OPENROUTER_API_KEY}`. Do not write the literal key into the config file.
- A user provider must keep its own credentials inside the user's home. The kernel does not manage user secrets.

## 7. Denial of service

- A turn with a runaway tool loop stops after `maxToolRounds` (default 40) rounds.
- A fence request stops after `requestTimeoutMs` (default 600000 milliseconds). The agent is killed and restarted.
- Output of `exec` is capped at 30,000 characters per stream.
- There is no limit on the number of sessions, the size of a conversation, or the size of the harness object.

## 8. Recommendations before multi-tenant use

1. Replace `ProcessFence` with a microVM fence, or add `--unshare-net` with an explicit egress proxy for provider calls.
2. Add per-userspace quotas (cgroups or the microVM limits).
3. Put TLS in front of the web gateway.
4. Add a size limit for `conversation` and `harness` in `PipelineRunner.apply`.
