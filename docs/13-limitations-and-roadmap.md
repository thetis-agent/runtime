# 13 Limitations and roadmap

## 1. Status

The MVP defined in [ARCHITECTURE.md](ARCHITECTURE.md) section 2 is complete:

| Component | State |
|---|---|
| Kernel | Config-driven pipeline, built-in provider call, session persistence. 1,210 counted lines. |
| Fence | Process sandbox with bubblewrap. Filesystem and process isolation. No network isolation. |
| Package manager | Scoped store per userspace. Install from a local path, a git URL, or a system name. |
| Provider | `@thetis/provider-openrouter`. |
| Gateway | `@thetis/gateway-cli`. |
| Tool | `@thetis/tool-exec`. |

Verified: a user asked Thetis in a conversation to add a prompt step and a tool. Thetis wrote the package, tested it with `node`, installed it, and both were active on the next turn.

## 2. Known gaps

| Gap | Effect | Where to fix |
|---|---|---|
| No microVM fence | Shared network and kernel with the host. | Implement `Fence`; rebind `T.fence`. |
| No network namespace | Port collisions between users. Reachability of host services. | `ProcessFence.spawn`: add `--unshare-net` and an egress path for providers. |
| No quotas | One user can exhaust the host. | Fence implementation. |
| No `service` packages | A package cannot start a long-running process that the kernel manages. `publish` is recorded and ignored. | New kernel crossing: start on install, stop on uninstall. |
| No port publishing | Nothing outside the fence reaches a package service. | Service plane forwarder (L4). |
| No package sharing | A `@user/*` package cannot be given to another user. | `PackageRegistry` share operation plus a copy or link into the target store. |
| No authentication | The CLI trusts `--user`. | A network gateway package. |
| No enumerator package shipped | The default plan is kernel code. | Write `@thetis/enumerator-default` and set `config.enumerator`. |
| Gateway runs on the host | `@thetis/gateway-cli` is not fenced. | Acceptable for a CLI. A network gateway must run in the system userspace. |
| Git installs untested | Regression risk. | Add an e2e case with a local bare repository. |
| Conversation grows without bound | Large session files. Slow turns. | A `memory` package that summarizes, or a size limit in the kernel. |
| Subagent turns block the parent tool call | Long subagent tasks hit `requestTimeoutMs`. | Background sessions with a poll or a notify RPC. |
| `models()` of OpenRouter lists 400+ ids | One HTTP call per 5 minutes per process. | Acceptable. Cache to disk if needed. |
| Config `${VAR}` with a missing variable becomes `""` | Silent misconfiguration. | Warn in `loadConfig`. |

## 3. Recommended order of work

1. **`@thetis/enumerator-default` as a package.** Small. Proves the replaceable enumerator path end to end. Add an e2e case.
2. **A memory package.** A `history` step that summarizes old messages into `harness.summary` and an `after` step that updates it. Keeps sessions usable for long.
3. **Network gateway.** A minimal HTTP gateway with token authentication in the system userspace. Requires `service` packages and `host` publishing. Do these three together.
4. **Network isolation.** `--unshare-net` plus a per-userspace egress proxy for provider calls, or move to a microVM.
5. **Quotas.** cgroups for the process fence, or the microVM limits.
6. **Package sharing.** Registry share operation and `@thetis/*` promotion.
7. **Skills.** `skill-type` and `skill` packages as in ARCHITECTURE.md section 11. Pure package work; no kernel change.

## 4. Open design questions

These are unchanged from ARCHITECTURE.md section 12:

- User addresses for `user`-published ports.
- Whether a replacement enumerator must honor the default phase names.
- Ordering conflicts between packages that claim the same phase.
- Review and revocation for shared packages.
- Where authentication lives and the format of a signed identity assertion.
- Per-user provider spend.
- Verification that a hostile enumerator can only hurt its own user. The current validation limits it to declared steps of its own userspace. A formal check is not done.
