# 13 Limitations and roadmap

## 1. Status

The MVP defined in [ARCHITECTURE.md](ARCHITECTURE.md) section 2 is complete:

| Component | State |
|---|---|
| Kernel | Config-driven pipeline, built-in provider call, session persistence. 1,210 counted lines. |
| Fence | Process sandbox with bubblewrap: filesystem, process, user, and network isolation; cgroup limits. |
| Package manager | Scoped store per userspace. Install from a local path, a git URL, or a system name. |
| Provider | `@thetis/provider-openrouter`. |
| Gateway | `@thetis/gateway-cli` on the host. `@thetis/gateway-web` in each person's fence, `@thetis/gateway-login` in the system userspace, `@thetis/door` on the host port. |
| Tool | `@thetis/tool-exec`. |

Verified: a user asked Thetis in a conversation to add a prompt step and a tool. Thetis wrote the package, tested it with `node`, installed it, and both were active on the next turn.

## 2. Known gaps

| Gap | Effect | Where to fix |
|---|---|---|
| No microVM fence | User namespaces, not a virtual machine, separate a fence from the host kernel. | Implement `Fence`; rebind `T.fence`. |
| No egress policy | A fence with `egress` reaches any address; there is no per-package destination list. | A policy in the egress helper, or a proxy. |
| No disk quota | One user can fill the filesystem. | A quota per userspace root. |
| `publish` unused | A service is reachable through the door by convention (`run/web.sock`), not through a `publish` grant. | Make the door read `publish` when a second kind of published socket exists. |
| No package sharing between named users | A `@user/*` package can be made the default for everyone (`packages.promote`), not given to one other user. | `PackageRegistry` share operation plus a link into the target store. |
| Archive flags are gateway state | They live in the system userspace home. The CLI does not see them. | Acceptable. A session metadata field in the kernel would share them. |
| No enumerator package shipped | The default plan is kernel code. | Write `@thetis/enumerator-default` and set `config.enumerator`. |
| Gateway runs on the host | `@thetis/gateway-cli` is not fenced. | Acceptable for a CLI. A network gateway must run in the system userspace. |
| Marketplace registries are cloned whole | A large registry costs a full shallow clone per refresh and per install. | Sparse checkout, or an index published by the registry itself. |
| Conversation grows without bound | Large session files and calls. | A `memory` package that summarizes into `harness`, written so the prefix of the call stays append-only. See [16-prompt-cache.md](16-prompt-cache.md) section 8. |
| Cache accounting is per reply only | No per-session or per-user totals. | A gateway or a service package that sums the `usage` of the `message` events. |
| Subagent turns block the parent tool call | Long subagent tasks hit `requestTimeoutMs`. | Background sessions with a poll or a notify RPC. |
| `models()` of OpenRouter lists 400+ ids | One HTTP call per 5 minutes per process. | Acceptable. Cache to disk if needed. |
| Config `${VAR}` with a missing variable becomes `""` | Silent misconfiguration. | Warn in `loadConfig`. |

## 3. Recommended order of work

1. **`@thetis/enumerator-default` as a package.** Small. Proves the replaceable enumerator path end to end. Add an e2e case.
2. **A memory package.** A `history` step that summarizes old messages into `harness.summary` and an `after` step that updates it. Keeps sessions usable for long.
3. **Disk quotas.** cgroups cover memory, processes and CPU; disk is open.
4. **Egress policy.** Per-package destinations for the `egress` network mode.
5. **Package sharing with a named user.** Registry share operation. Promotion to `@thetis/*` exists.
6. **Skills.** `skill-type` and `skill` packages as in ARCHITECTURE.md section 11. Pure package work; no kernel change.
7. **Cache keep-alive and a native Anthropic provider.** See [16-prompt-cache.md](16-prompt-cache.md) section 11.

## 4. Open design questions

These are unchanged from ARCHITECTURE.md section 12:

- User addresses for `user`-published ports.
- Whether a replacement enumerator must honor the default phase names.
- Ordering conflicts between packages that claim the same phase.
- Review and revocation for shared packages.
- The format of a signed identity assertion for delegation. Authentication itself now lives in the kernel (`AuthService`).
- Per-user provider spend.
- Verification that a hostile enumerator can only hurt its own user. The current validation limits it to declared steps of its own userspace. A formal check is not done.
