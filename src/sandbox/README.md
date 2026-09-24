# Runtime module: sandbox

The process fence: one long-lived userspace agent per userspace, under bubblewrap, with cgroup limits and outbound-only networking. It runs in the host process next to the kernel. It builds the fence; it does not decide who may cross it. The kernel sees only the interfaces `Fence`, `FenceHandle`, and `Fences` from `@thetis/runtime/contracts`; `@thetis/runtime` binds this package to them.

## What it provides

An internal runtime module, not an installable extension.

The sandbox imports the internal `contracts` and `lib` modules. The host binds it to the fence interfaces; the kernel never imports it. `test/architecture.test.mjs` enforces these boundaries.

In mode `bwrap` the agent sees the operating system read-only, its own userspace root read-write, the shared directory (writable for the system userspace, read-only for everyone else), the package tree and the promoted packages read-only, its mounts at the mode they were granted, its own cgroup read-only under `/sys/fs/cgroup`, and — unless `fence.docker` is `off` — the host's Docker socket. It has its own user, PID, IPC, UTS and — when the host has them — cgroup namespaces, no capabilities, cannot make a nested user namespace, and dies with the kernel. It does not see `$THETIS_HOME`, other userspaces, `/home`, the host `/tmp`, or any other fence's cgroup.

The cgroup bind is what lets an agent tell an OOM kill from a transient failure: it reads its real `memory.max`, `memory.current` and `memory.events` (`oom_kill`) instead of guessing from the host's free memory, and it is what lets a language runtime size its heap for the fence instead of for the machine. The fence gets its own cgroup namespace (`--unshare-cgroup`) and its group is bound at `/sys/fs/cgroup` itself, as in any container: the process is already in `fence-<user>` when bubblewrap unshares, so inside, `/proc/self/cgroup` reads `0::/` and the mount point is a cgroup2 filesystem holding that group's own files. A runtime resolves its group by appending that line to the mount point, and this is the layout in which the concatenation lands on the group — measured: `dotnet` then reports `TotalAvailableMemoryBytes` 6 GiB under an 8 GiB limit instead of the host's 376 GB.

`hasCgroupNamespace` asks the host rather than assuming: `/proc/self/ns/cgroup` has to exist (Linux 4.6 and later) and `bwrap --unshare-cgroup -- true` has to succeed. When it does not, the fence falls back to the layout of the previous release — no namespace, the group bound under the mount point at the full path `/proc/self/cgroup` still reports — and the agent finds it by reading that line. The two never mix: the group at the mount root without a namespace makes the concatenation name a directory that does not exist, and .NET aborts at random inside the fence (`munmap_chunk(): invalid pointer`). The bind is `--ro-bind-try`, so a kernel without a delegated cgroup, a cgroups v1 host, or mode `none` simply gets no bind and no namespace — none of this ever keeps a fence from starting. `/proc/meminfo` still reports the host's memory; that would need a FUSE layer such as `lxcfs` and is out of scope. The layout is decided in `cgroup.ts`.

| Option | Values | Meaning |
|---|---|---|
| `sandbox` | `auto`, `bwrap`, `none` | `auto` uses `bwrap` when `bwrap --ro-bind / / --unshare-pid -- true` succeeds, else `none`. `none` starts the agent directly, with no isolation. |
| `network` | `auto`, `egress`, `none`, `host` | `egress` is a private network namespace with outbound NAT through `slirp4netns`: no host loopback, no host ports. `none` has no interface. `auto` picks `egress` when `/usr/bin/slirp4netns` exists and the sandbox is `bwrap`. |
| `docker` | `auto`, `on`, `off` | Whether every fence gets the host's Docker socket, bound read-only at `/var/run/docker.sock` so the CLI finds it with nothing configured. `auto` binds one the kernel can use and is otherwise silent; `on` binds it whether or not the probe passes; `off` never does. **Socket access is host root** — a container with `--privileged` and `/` bound in undoes every other rule here. On by default for a single-operator installation; `off` anywhere a fence holds code not already trusted with the host. |
| `limits` | `memoryMb`, `pids`, `cpuPercent` | `memoryMb` defaults to `"auto"`: no memory ceiling, the fence may use the whole machine, and a number caps it instead. `auto` keeps the group and its accounting (`memory.current`, `memory.peak`, `oom_kill`) and drops only the ceiling; `memory.swap.max` follows, zero under a number and `max` under `auto`. A cgroup v2 group per fence, bound read-only inside it at `/sys/fs/cgroup` with a cgroup namespace, or at the path `/proc/self/cgroup` names when the host has no such namespace. Needs the kernel process in a delegated cgroup; otherwise the fences run unlimited, get no bind, and the kernel logs `[fence] resource limits off` once. |

A person's mount is a grant, and a grant is not quietly taken back. The fence binds things inside paths a person may have been granted -- `fence.readOnly` binds the checkout's `packages` and `node_modules` so the fence sees the code it runs -- and a read-only bind inside a read-write mount makes that subtree read-only with both flags still in the command line and nothing to report. It happened: a person granted `rw` over the checkout got a workspace where the two directories they most wanted to edit refused writes, while `THETIS_MOUNTS`, the project page and the system prompt all said `rw`, and an agent was the one to find out. So `resolveGrants` binds such a path read-write instead. Two kinds are left alone, because they are policy and not convenience: anything behind a `tmpfs` mask inside the grant, which is the service plane being hidden and specific things revealed through it read-only, so a grant over `/opt/zero` still cannot write the shared directory or the promoted packages; and any bind whose source is not its target, which is the fence putting some other host path somewhere (the resolver, the ssh files, the cgroup) rather than the person's own directory.

The agent gets this environment and nothing else: `PATH`, `HOME`, `LANG`, `THETIS_USERSPACE`, `THETIS_HOME_DIR`, `THETIS_STORE`, `THETIS_SHARED`, `THETIS_USER`, `THETIS_MOUNTS`, `THETIS_HEARTBEAT_MS`, `THETIS_STEP_DEADLINE_MS`, `THETIS_DOCKER` when a Docker socket is bound, `SSH_AUTH_SOCK` and `THETIS_SSH` when an ssh agent is running with a granted key in it, and `GIT_CONFIG_SYSTEM` when the fence holds repository keys. The kernel's own environment does not reach the fence.

Repository keys are the installation's own ssh keys, each for exactly one repository -- a private registry, say -- and only the system userspace holds them. The fence's agent holds every key it was granted, and GitHub takes the first key that authenticates as anybody, so an agent holding two deploy keys reaches one repository and is refused by the other; ssh cannot see which repository git wants. So `writeSshFiles` gives each repository key an ssh host alias of its own (`repoRoute` in `lib/git-url`), written before `Host *` with the real host, port and user, `HostKeyAlias` so the real host's known-hosts line is what is checked, and `IdentityFile /etc/ssh/<alias>.pub` with `IdentitiesOnly yes`: given only the public half, ssh asks the agent to sign with the matching key and offers no other. The public half is bound read-only beside the configuration; the private key never is. `/etc/ssh/gitconfig` then rewrites every spelling of the repository (`git@host:o/r.git`, `ssh://`, `https://`, `git://`, and the spelling configured) to the alias url with `insteadOf`, and `GIT_CONFIG_SYSTEM` points git at it, so any `git` in the fence uses that repository's key and no other. The rewritten spellings all end in `.git`, because `insteadOf` matches a prefix and `git@host:o/r` would also catch `git@host:o/r-other.git`. Like the ssh files, the git file replaces the host's system layer rather than adding to it.

### The timer measures silence, not work

Each request has a timer of `requestTimeoutMs` milliseconds, and it asks one question: **is the fence still there.** It is not a limit on how long the work may take, and it must never become one again. A `step` request runs a whole turn inside the fence -- every model call, every tool, every subagent under it -- so a timer armed when the request was sent and never reset was a cap on the turn itself. It fired on a turn that was streaming happily, ten minutes and 1.9M prompt tokens in, killed it, and left the session on disk holding the person's question and no answer at all.

So the timer is reset by every sign of life for that call: an event, the result, and the heartbeat frame `{ id, alive: true }` that the agent sends every `heartbeatFor(requestTimeoutMs)` milliseconds for as long as it is working on that request. The reset happens in `PendingCalls` through `OpenCall.onLive`, not through `onEvent`, because most callers here pass no `onEvent` and a caller that passed none had no reset at all. A tool that is quiet for twenty minutes -- a build, a long clone -- is a healthy fence and is never disturbed; only a fence whose process has stopped turning goes quiet in a way that counts.

`heartbeatFor` is a tenth of the timeout, capped at 15 seconds and floored at 50 ms, and the kernel passes the number it chose to the agent in `THETIS_HEARTBEAT_MS` so both ends agree: a fence beating slower than it is waited for would be killed for being busy. Ten missed beats is the threshold, which a live event loop does not manage.

The beat is unconditional, which takes this timer away as the bound on anything the fence is *willing* to wait for for ever. The agent puts that bound back on its own side, where the right thing fails: `THETIS_STEP_DEADLINE_MS`, half the silence budget, is how long an operation that is not the model loop may run before the agent stops it and answers with the package and export that hung. Half, so the two never disagree -- the package's own failure always comes first, and nobody is told their fence died when what actually happened is that a prompt step hung. `@thetis/runtime/userspace-agent`'s README has the rule and the exemptions.

When the timer does fire, the request is not settled where it stands. It takes the same route as an abort: `{ cancel: id }` goes to the agent, the reply within `cancelGraceMs` is delivered as any other, and a step that was stopped hands back what it kept -- the text it streamed, the tool calls it closed. The caller is told once, on the call's own event sink, with an `error` event of code `fence` carrying the same sentence the rejection would have: what the request was, how long the silence lasted, how far into the work it fell, and that a live fence reports itself every so often, so this one's agent process is wedged or gone. Only a fence that will not even answer the cancel ends as a rejection, and then the pool drops the handle and the next request opens a new agent.

Two things follow from a rejection, and both had to be said out loud after this went wrong in production.

**The record and the wire do not agree by themselves.** A step's events are relayed to the browser as they arrive, but its *result* is applied to the conversation only when the request resolves. A rejection means `PipelineRunner.apply` never runs, and the turn's `finally` then saves a conversation holding only what the person typed: the answer they watched being written is on their screen and nowhere else. That is why a timeout takes the cancel route rather than settling where it stands -- so the step returns, and what it returns is recorded.

**Dropping the handle is not enough; the process has to go with it.** `FencePool.request` forgets the handle on any `fence`-coded error *and* closes it. Forgetting alone leaked the whole fence: the agent kept running unattached, still LISTENing on that workspace's `run/web.sock`, still holding its cgroup and its ssh agent, while the next request opened a second fence whose gateway could not bind the socket the first one had. One was found live on the host forty minutes after the turn that orphaned it, on a workspace `thetis status` was reporting as having no fence open. The close is dispatched and never awaited, and a close that throws or hangs is swallowed: the caller is reporting a fence error and the cleanup of a fence that has already gone wrong must not become a second way to get stuck. It is bounded regardless -- `close` asks for the stop, waits `exitGraceMs` after SIGTERM and then SIGKILLs. Any other code (`tool`, `step`, `provider`) is the fence working perfectly and reporting a failure, and leaves it open.

The pool stamps every fence it opens with the moment it opened (`openedAt()`) and with the package versions of that userspace at that moment (`loadedVersions()`, `{ userId: { name: version } }`), read through the `versionsOf(us)` reader the host passes at construction. Both are dropped when the handle is forgotten, so a userspace with no fence open reports nothing. The pool never interprets either: the kernel compares what a fence loaded with what is on disk now.

## Configuration

`config.fence` holds `sandbox`, `network`, `limits`, `readOnly`, `hidden`, `docker`, and `dockerSocket`; `config.agentPath` names the agent the fence starts; `config.requestTimeoutMs` is the request timer. The host passes them to `ProcessFence`.

## Use

The host binds the fence to the token `T.fence`. A different isolation technology replaces the binding:

```ts
import { createKernel, T } from "@thetis/runtime";

const kernel = createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
});
```

Resource limits apply when the kernel runs in a delegated cgroup. For a development run:

```sh
systemd-run --user --scope -p Delegate=yes node bin/thetis.js serve
```

The systemd unit `deploy/thetis-runtime.service` sets `Delegate=yes`.

## Files

| File | Content |
|---|---|
| `process-fence.ts` | `ProcessFence`. Resolves the sandbox, network and Docker modes, spawns the agent, opens the launch gate. `mode`, `networkMode` and `dockerMode` report what was resolved. |
| `plan.ts` | `MountIntent`, `orderIntents`, `resolveGrants`, `validateIntents`, `renderIntents`. What the fence mounts, as data: declared in any order, ordered parents-first so nothing lands on top of anything, grants resolved so nothing lands *inside* a person's mount and takes it back, checked, and rendered to flags last. |
| `bwrap.ts` | The bubblewrap arguments and the launcher command around the gate. | Builds the plan in `fencePlan` and renders it.
| `handle.ts` | `ProcessHandle`. One agent process: requests out, RPC in, the request timer, cancel, and a close that kills an agent still there two seconds after `SIGTERM`. |
| `pool.ts` | `FencePool`. Implements `Fences`: at most one open fence per userspace, reopened after a crash. |
| `cgroup.ts` | `Cgroups`, `fenceMount`, `limitValues` (one fence's limits as the control files spell them, pure so the decision can be read and tested on its own). Per-fence limits under the kernel's delegated cgroup. `fenceDir` names the group on the host, `fence` adds where the fence has to see it: the mount point itself with a cgroup namespace, and the mount point plus the group's path relative to the cgroup filesystem root without one, which is what `/proc/self/cgroup` then reports inside. Only this file spells a cgroup path. |
| `network.ts` | `startEgress`, `hasSlirp`. The `slirp4netns` helper. |
| `docker.ts` | `dockerSocket`, `FENCE_DOCKER_SOCKET`. Which host socket to bind, and why a bind that is read-only, last among the read-only binds, and independent of the network mode is the right shape. A path named in the configuration is the only candidate. |
| `index.ts` | Re-exports. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suites of this package are `test/sandbox/handle.test.ts` (`close` waits for the agent to exit and kills one that ignores `SIGTERM`) and `test/sandbox/bwrap.test.ts` (the cgroup bind: the destination, where it sits in the argument list, that it is absent when limits are off, and — under a real `bwrap` — that the fence reads its own limits there, sees no sibling, cannot write them, and that `dotnet --version` runs ten times over without aborting), and `test/sandbox/docker.test.ts` (which socket is chosen and that a named one is never substituted, where it is bound and that it is read-only, and — under a real `bwrap` with a real daemon — that the daemon answers from a fence with no network at all). `test/sandbox/plan.test.ts` covers the plan itself: the ordering rule, a mask under a bound parent and a bind under a mask (against a real `bwrap`), the conflicts that are reported, and grants -- a read-only bind inside an `rw` mount bound read-write, a mask and a relocated bind left alone, a `ro` mount staying read-only, and, under a real `bwrap`, a granted directory writable all the way down. To run them alone after `npm run build`: `node --test "dist/test/sandbox/*.test.js"`. The real fence runs in `test/host/e2e.test.ts`; its case `fence isolation` checks that a userspace cannot read the service plane or another userspace.
