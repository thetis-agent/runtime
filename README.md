# Thetis

A self-modifying, multi-user AI agent harness: one small trusted kernel, one
unprivileged loop, and everything else as versioned packages from git registries.

One rule shapes everything:

> **The core and the kernel name no package, no service, and no vendor.**

A package declares what it requires. Another package, or the kernel, provides it.
The kernel matches names. If a name is not provided, the kernel says so in one
sentence.

> **Status: Milestone A is in progress.**
> Runtime review fixes are implemented. The operator approved idle memory up to
> 512 MB in [ADR 0041](docs/adr/0041-raise-idle-memory-ceiling.md) and edit latency up to
> two seconds in [ADR 0042](docs/adr/0042-allow-two-second-work-edits.md). See
> [TODO.md](TODO.md) §0 before you build on this.

---

## Requirements

This project runs on Linux only, inside bubblewrap, always. There is no code path
that starts an environment, gateway, service — or a test — outside the sandbox.

| Requirement | Why |
| --- | --- |
| **Node 24.18.0** | Editable TypeScript produces hash-verified JavaScript with the exact runtime version (ADR 0037) |
| **Linux with working unprivileged user namespaces** | `cat /proc/sys/kernel/unprivileged_userns_clone` must be `1` |
| **`bubblewrap`** (`/usr/bin/bwrap`) | The one and only sandbox adapter |
| **cgroup v2 with a delegated subtree** | Memory, task and CPU limits, and the pre-exec cgroup gate |
| **`systemd-run --user`** | `scripts/test.ts` creates its own delegated scope |
| **`git`** | The registry is the deployment's own bare git repository |
| `slirp4netns`, `unshare`, `flock` | Private network egress and the deployment lock. See [docs/platform-dependencies.md](docs/platform-dependencies.md) |

Runtime dependencies are pinned exactly and installed with `--ignore-scripts`.
Every one is justified in [docs/dependencies.md](docs/dependencies.md).

Both repositories have full GitHub CI and reviewed release delivery workflows.
See [CI and release delivery](docs/ci-delivery.md) for repository configuration,
exact source pairing, required gates, offline artifacts and production activation.

### Node version

The shell's default `node` on this host is **v20.20.2, which cannot run this
project** — it has no TypeScript type stripping. Invoke the Node 24 binary
directly:

```sh
export THETIS_NODE=/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node
"$THETIS_NODE" --version   # must print v24.18.0
```

`npm run check` and `npm run test` will fail under Node 20. Run the scripts with
`$THETIS_NODE` instead, as shown below.

---

## Quick start

```sh
git clone <runtime repository> runtime
git clone <packages repository> packages
cd runtime
npm install --ignore-scripts

# Generate committed guards/types, then adjacent execution artifacts.
"$THETIS_NODE" --import ./lib/artifacts/source.mjs lib/schema/generate.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/build.ts

# Both of these must be green before you commit anything.
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/check.ts    # generated freshness + tsc --strict + eslint + artifact freshness
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts     # the whole suite, inside bubblewrap
```

`check` verifies committed contract types, bootstrap code and generated schema
guards, then runs `tsc --noEmit --strict`, ESLint with `--max-warnings=0`, and
execution-artifact freshness. Rebuild after editing TypeScript. Generated
sidecars are ignored by git but included in immutable package releases; see
[execution artifacts](docs/execution-artifacts.md).

Both commands mount the separate repositories read-only into `/workspace`,
using the installed `packages/`, `lib/`, and `contracts/` layout (ADR 0035).
The package checkout defaults to `../packages`; set `THETIS_PACKAGES` for a
different location. No development path is written into generated types.
For a focused run, pass workspace-relative test paths or directory prefixes:
`"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts lib/registry lib/profile`.

`test` re-executes itself inside a `systemd-run --user` delegated scope bounded to
2,048 MiB, 256 tasks and 100% CPU, then runs every `*.test.ts` inside bubblewrap
with user, process and network namespaces. Each sandbox keeps its own 64-task
limit. Tests use no external network, real key or real model. Protocol deadlines
use injected clocks; performance assertions measure actual elapsed time.

`"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/bench.ts` asserts edit-to-serve at most two seconds (ADR 0042) and
aggregate kernel-plus-idle-environment RSS at most 512,000,000 bytes (ADR 0041)
through the same sandbox launcher. `"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/size.ts` counts
non-test kernel TypeScript lines excluding comment-only lines against 1,300
(ADR 0039), while reporting physical and excluded counts. The kernel-size gate
remains over budget; current benchmark results are in [implementation status](docs/implementation-status.md).

`"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/release.ts` exports the exact default profile and offline
registry bundle. The optional paid `scripts/live.ts` check is documented in
[docs/headless-startup.md](docs/headless-startup.md); it is never part of `test`.

### Checking conformance coverage

```sh
"$THETIS_NODE" --import ./lib/artifacts/source.mjs test/conformance-inventory.ts
```

Every conformance id in `docs/contracts/conformance/*.md`,
`docs/design/generations.md` and `docs/design/evaluator.md` must have a test whose
name begins with that id. It exits non-zero if any id is missing or skipped.
Currently 106/106 ids are covered with none skipped — though a named test does not
prove every clause of its case.

---

## Layout

```
kernel/       identity, boundary, secrets, generations — plus socket, log, main
lib/          shared code the moment a second package needs it
contracts/    schema.json (authoritative) + generated types.ts + conformance tests
profiles/     assembly recipes
test/         faux gateway, drivers, fixtures, the compatibility matrix
docs/         the read-only design copy, ADRs, and decisions-taken.md
scripts/      only what CI runs
```

Packages live in a separate registry: [`thetis-agent/packages`](https://github.com/thetis-agent/packages).
The development checkout is `/tank/data/Dev/thetis-agent/runtime` beside
`/tank/data/Dev/thetis-agent/packages`. `/opt/zero` is the installation target;
the source checkout has no dependency on that location.
The temporary `/opt/zero` compatibility symlink is no longer present; it was
not an installed release. Relocation preserved the original checkout
at `/opt/zero.pre-relocation-20260909`; it is a backup, not another working copy
to edit. Continue work in the new runtime directory.

### Root imports

`@/` names the runtime root: `import type { Secrets } from
'@/kernel/secrets/index.ts';`. Shared imports use `@/lib/...` and
`@/contracts/...`. Imports within independently versioned packages remain
relative. Source commands require `--import ./lib/artifacts/source.mjs`;
the npm scripts include it. Verified artifact launches use `register.mjs`,
which already includes alias resolution. See [ADR 0047](docs/adr/0047-root-relative-module-imports.md).

### The kernel

The kernel is deliberately ignorant. It matches strings in the requirements
namespace, verifies hashes, mints tokens, mounts sockets and moves pins. It knows
no package, no vendor, and no counter but `cost`. Grepping `kernel/` for a package
name should return nothing; a hit is a bug.

It holds exactly four things — identity, the boundary, secrets, generations —
against a 1,300-line budget. It is currently over that budget
([TODO.md](TODO.md) §2).

### Packages

Packages are not in this repository. Clone the registry beside the runtime:

```sh
git clone git@github.com:thetis-agent/packages.git ../packages
```

An assembled distribution already contains its selected `packages` directory.
Package publication and installation still use git commits and verified hashes;
the development mounts only supply the layout for checks and tests.

A package is a plain directory with `package.json` and `index.ts`. It exports
`stages` (functions on the turn stream), and optionally `skills` (a directory of
skill files) and `spawn` (services). There are no other kinds. A package with no
exports is a library.

| Package | Role |
| --- | --- |
| `core` | The loop, the event pipeline, the stored prefix, spill, notices, compaction |
| `cli` | Person-scoped command service over a Unix socket |
| `gateway-web` | WebSocket gateway and the lifted web surface, served per person on the target's public socket |
| `gateway-login` | The `password` authority |
| `tools-files` | File read/search/edit handlers with canonical grant checks |
| `storage-files` | Default bounded byte objects and durable append logs behind `contract/storage` |
| `retriever-local` | BM25 + dense with fusion as a setting; answers `retrieve` |
| `provider-mock` | Scripted provider with a cache model; passes the provider suite itself |
| `provider-openai-compatible` | HTTP/SSE adapter, OpenRouter-compatible |
| `registries` | Immutable local git registry delivery |
| `metrics` | Metrics service |
| `evaluator` | Paired-run scoring behind the gate |

A package may import `lib/` and `contracts/` only. Importing another package
directly is an ESLint error.

### Contracts

Contracts govern every process boundary. The JSON Schema is the authority; the
prose explains; a conformance test beats a paragraph. Four are the public
contracts Milestone A needs, with conformance suites in
[docs/contracts/](docs/contracts/README.md):

| Contract | Governs |
| --- | --- |
| `turn-events` | The events of a turn, their order, singletons, and every payload |
| `provider` | The normalized stream between the core and a model provider |
| `skills` | Pack layout, frontmatter, the card, and the `retrieve` messages |
| `kernel-socket` | Everything between an environment and the kernel |

Three more were added during implementation for the services that need them:
`registry`, `evaluator` and `metrics`. [Storage](docs/contracts/storage.md) adds
an in-process byte-storage contract, implemented by the default `storage-files`
package and shared `lib/storage` backend. The kernel retains encryption and
authority while the backend owns bounded file mechanics.

Data types are **generated** from the schemas into a committed `types.ts`
(`npm run generate`). `check` fails when generated output is stale. The storage
contract additionally declares its callable in-process API in `index.ts`.

---

## Running a deployment

The shipped recipe is `profiles/examples/two-account.recipe.json`: one mock
provider, separate Alice and Bob environments with separate writable spaces, and a
CLI service for each person. It needs no browser, no network and no model key.

```sh
"$THETIS_NODE" --max-old-space-size=32 --max-semi-space-size=1 \
  --no-experimental-strip-types --import ./lib/artifacts/register.mjs \
  kernel/main.ts /var/lib/thetis/seed.json
```

This acquires the deployment lock, reaps orphan writers in its own cgroup subtree,
replays observed generation records, probes recovered targets, and prints `ready`.
Stop with SIGTERM; restart with the same configuration and state.

Then talk to a person's CLI socket at
`<seed-root>/targets/<SHA256-base64url(target-id)>/runs/public/current.sock`:

```sh
printf '%s\n' '{"args":["new"]}' | socat - UNIX-CONNECT:"$ALICE_SOCKET"
printf '%s\n' '{"args":["send","CONVERSATION_ID","Hello"]}' | socat - UNIX-CONNECT:"$ALICE_SOCKET"
```

Use a new connection per command. `status`, `logs`, `reset`, `profile`, `health`,
`cancel <id>` and `subscribe <id> [cursor]` are also available. These are scoped
service sockets, not anonymous network listeners — only the matching principal's
trusted client should reach each one. (`socat` is not installed on this host; any
Unix-socket client works.)

**Read [docs/headless-startup.md](docs/headless-startup.md) before deploying.** It
covers installation inputs, the bounded-filesystem requirement for writable
mounts, password authority and the trusted kernel origin, master-key delivery over
an inherited descriptor, binding OpenRouter, and promoting a reviewed release
through `default.prepare` / `default.set`.

Some rules from that document are load-bearing and easy to get wrong:

- Every writable mount must sit on a filesystem whose enforced capacity is no
  larger than its declared `maximumBytes`. A large unrestricted host directory
  does not qualify, and the kernel refuses it rather than drop the quota.
- Supply exactly 32 bytes of master key through the inherited descriptor
  (normally fd 3) at every startup. Never put it in configuration, the
  environment, the repository or an environment directory.
- Never put invented hashes or placeholder commit ids in an installation profile.
- Do not share a cgroup subtree with a second kernel.

---

## Contributing

Read [AGENTS.md](AGENTS.md) first — it is the house rules in imperative form, and
it names the four documents you must read before editing:
`docs/00-proposal.md`, `docs/08-vocabulary.md`, `docs/design/generations.md`,
`docs/design/evaluator.md`. Then read all the ADRs and contracts.

Authority when documents disagree: **a JSON Schema beats the contract's prose; a
conformance test beats a paragraph; a higher-numbered ADR beats a lower one; the
proposal beats the post-mortem.** A disagreement you find is a bug in the
lower-authority document — fix your copy and add one line to
[docs/decisions-taken.md](docs/decisions-taken.md).

Deviating from the design requires a new record in `docs/adr/`, numbered after
0020, in the format of 0001, before the workaround. Never edit an accepted record.
Never deviate silently. **If the deviation would remove a guarantee — a boundary,
a secret rule, the gate, the act — stop and leave the record `Proposed`. That
decision belongs to a person.**

Some rules worth knowing before your first edit:

- No `any`, no non-null assertions, no casts to silence the checker, no
  `@ts-ignore`, no floating promises. Switches must be exhaustive.
- 400 lines per file, 60 lines per function — both enforced by ESLint.
- Open every module with a doc comment saying what it defends, citing an id
  (`ADR 0013 §2`, `TE-016`, `KS-015`).
- Comments say *why*, never *what*. Every `TODO` cites a record or test id.
- Errors are typed results at every boundary; throw only for programmer errors.
- Use the vocabulary from [docs/08-vocabulary.md](docs/08-vocabulary.md).
- Never delete or skip a failing conformance test to get green.
- Commit small and green — every commit passes `check` and `test`, and the message
  says what it defends, citing the id. Never rewrite history on `main`.

### Where things stand

- [TODO.md](TODO.md) — what remains, ordered by what blocks what
- [docs/implementation-status.md](docs/implementation-status.md) — the detailed
  record of what is implemented and exercised
- [docs/adr/](docs/adr/) — 47 records, including the approved 512 MB memory and two-second edit ceilings in ADRs 0041–0042; all listed in the index
- [docs/decisions-taken.md](docs/decisions-taken.md) — every implementation choice
  taken where the design was silent
- [docs/compatibility.md](docs/compatibility.md) — the two-direction socket matrix

There is deliberately no `docs/milestone-a.md`. It gets written when Milestone A
actually passes.

The [runtime review](docs/reviews/runtime-review-2026-09-10.md) records all seven
P1/P2 fixes and their regression coverage. The [package reuse assessment](docs/reviews/runtime-reuse-assessment-2026-09-10.md)
estimates where existing libraries could simplify support code.
