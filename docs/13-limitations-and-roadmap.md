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
| Tool | `@thetis/tool-exec`, `@thetis/tools-files`, `@thetis/tools-plan`, and `@thetis/terminal` for shell sessions. |

Verified: a user asked Thetis in a conversation to add a prompt step and a tool. Thetis wrote the package, tested it with `node`, installed it, and both were active on the next turn.

## 2. Known gaps

| Gap | Effect | Where to fix |
|---|---|---|
| No microVM fence | User namespaces, not a virtual machine, separate a fence from the host kernel. | Implement `Fence`; rebind `T.fence`. |
| No egress policy | A fence with `egress` reaches any address; there is no per-package destination list. | A policy in the egress helper, or a proxy. |
| No disk quota | One user can fill the filesystem. | A quota per userspace root. |
| `/proc/meminfo` reports the host | A fence reads its own limit at `/sys/fs/cgroup/memory.max` ([03-fence.md](03-fence.md) section 3.3), but `MemTotal` is still the whole machine. Anything that sizes itself from `MemTotal` — a language runtime picking a heap, a build tool picking a job count — overshoots the limit and is OOM-killed. | A FUSE layer such as `lxcfs` over `/proc` in the fence. |
| `publish` unused | A service is reachable through the door by convention (`run/web.sock`), not through a `publish` grant. | Make the door read `publish` when a second kind of published socket exists. |
| No package sharing between named users | A `@user/*` package can be made the default for everyone (`packages.promote`), not given to one other user. | `PackageRegistry` share operation plus a link into the target store. |
| Archive flags are gateway state | They live in the system userspace home. The CLI does not see them. | Acceptable. A session metadata field in the kernel would share them. |
| No enumerator package shipped | The default plan is kernel code. | Write `@thetis/enumerator-default` and set `config.enumerator`. |
| Gateway runs on the host | `@thetis/gateway-cli` is not fenced. | Acceptable for a CLI. A network gateway must run in the system userspace. |
| Marketplace registries are cloned whole | A large registry costs a full shallow clone per refresh and per install. | Sparse checkout, or an index published by the registry itself. |
| Conversation grows without bound | Large session files and calls. | A `memory` package that summarizes into `harness`, written so the prefix of the call stays append-only. See [16-prompt-cache.md](16-prompt-cache.md) section 8. |
| Cache accounting is per reply only | No per-session or per-user totals. | A gateway or a service package that sums the `usage` of the `message` events. |
| No end-to-end benchmark probe | Every benchmark figure is about what the harness made available, never about whether a task was answered. Gold says which capability a person thought a question needs, not which one this harness needs. | Pin a model, run tasks behind a cost ceiling, and derive the tags by ablation. See [21-benchmarks.md](21-benchmarks.md) section 11. |
| Subagent turns block the parent tool call | Long subagent tasks hit `requestTimeoutMs`. | Background sessions with a poll or a notify RPC. |
| `models()` of OpenRouter lists 400+ ids | One HTTP call per 5 minutes per process. | Acceptable. Cache to disk if needed. |
| Config `${VAR}` with a missing variable becomes `""` | Silent misconfiguration. | Warn in `loadConfig`. |
| Projects have no skill switches in the page yet | `@thetis/skills` honours `skills.disable` ([23-skills.md](23-skills.md)), but the Skills section of a project's page is a note. The sidebar head slot of the shell must draw the switcher for it to appear. | `@thetis/ui-skills` and a switch per skill in `@thetis/projects`, the way it lists `tools` (item 6 below). See [22-projects.md](22-projects.md). |
| A shell session does not learn a new size while a program is running | Node cannot set a pty's window size without a native module, and the repository has no third-party runtime dependency, so `@thetis/terminal` resizes with an `stty` that can only be sent at a prompt. A full-screen program already running keeps its old size; the next one starts at the new one. The page says so in the row. | A native pty module, which costs the repository its first compiled dependency. See [24-terminal.md](24-terminal.md) section 7. |
| No remote shell sessions | `@thetis/terminal` opens sessions in the person's own fence only. There are no `ssh_host_*` tools. It crosses the fence's egress policy and its authority model. | A person runs `ssh` inside a session. A remote registry would be a feature in its own right. |
| A shell session does not survive the fence closing | A `mounts.set`, a reload, a reinstall or a daemon restart closes the fence, and every session in it stops. The transcript is in memory only, so it goes with it. | Acceptable. Reattaching would mean a process outside the fence holding a shell inside it, which inverts the model. |
| A restart that hits its deadline cuts a turn, and does not tell the person it belonged to | The latch waits two minutes for every conversation to go quiet and then restarts anyway. That person's transcript ends with their own message and nothing after it. It is recorded (`restart.fire` with `cut`) but not said to them. See [25-restart.md](25-restart.md) section 7. | Write a note into each cut session before exiting — which means writing to a conversation on behalf of somebody who is not the caller, inside the shutdown path, and needs its own design. |
| A restart is not zero-downtime | The port is refused for the seconds a restart takes, so a browser sees a failed connection rather than a pause. | Socket activation. Any attempt must first close this hazard: `services.boot()` spawns every fence **before** the door listens, and file descriptors are not namespaced, so a naively inherited listening socket would be inherited by every fenced agent, which could then accept browser connections and read session cookies. Adopt the descriptor before spawning anything, and check `LISTEN_PID`. |
| A configuration change needs a restart | `thetis serve` reads `thetis.config.json` once and holds it, `packages` included, so a reload cannot pick one up. | Acceptable. Re-reading it would mean deciding what a changed fence or provider setting does to a running userspace. |

## 3. Recommended order of work

1. **`@thetis/enumerator-default` as a package.** Small. Proves the replaceable enumerator path end to end. Add an e2e case.
2. **A memory package.** A `history` step that summarizes old messages into `harness.summary` and an `after` step that updates it. Keeps sessions usable for long.
3. **Disk quotas.** cgroups cover memory, processes and CPU; disk is open.
4. **Egress policy.** Per-package destinations for the `egress` network mode.
5. **Package sharing with a named user.** Registry share operation. Promotion to `@thetis/*` exists.
6. **Skills.** `@thetis/skills` (the format and the library), `@thetis/skills-all` and `@thetis/skills-l1` are shipped: see [23-skills.md](23-skills.md). In progress, per `docs/plans/skills.md`: `@thetis/skills-hybrid` with the embedding cache, `@thetis/skills-thetis` (the skills that teach Thetis), the bench run for the `skills` peer group with charts, `@thetis/ui-skills`, and the project switches. Pure package work; no kernel change.
7. **The end-to-end benchmark probe.** It is what turns imported judgements into gold derived from this harness, by ablation on a pinned model.
8. **Cache keep-alive and a native Anthropic provider.** See [16-prompt-cache.md](16-prompt-cache.md) section 11.

## 4. Open design questions

These are unchanged from ARCHITECTURE.md section 12:

- User addresses for `user`-published ports.
- Whether a replacement enumerator must honor the default phase names.
- Ordering conflicts between packages that claim the same phase.
- Review and revocation for shared packages.
- The format of a signed identity assertion for delegation. Authentication itself now lives in the kernel (`AuthService`).
- Per-user provider spend.
- Verification that a hostile enumerator can only hurt its own user. The current validation limits it to declared steps of its own userspace. A formal check is not done.
