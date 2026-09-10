# Implementation status · updated 2026-09-10

Milestone A is **in progress, not accepted**. The operator accepted ADR 0021's
run-principal boundary and separated the package repository. A prior
confirmation deferred UI only; memory remains measured, with its ceiling now
512 MB under operator-approved ADR 0041, with edit latency at most two seconds
under ADR 0042. The operator has since lifted that UI deferral and explicitly
approved ADR 0038; work on the web surface is starting in this continuation
and is not yet implemented or measured.

## DI/IoC integration · 2026-09-10

The remaining DI/IoC changes are integrated with the installer and update work
and ADR 0047's root imports. All twelve changed or added files from the preserved
DI/IoC checkout match the integrated sources after adapting their import paths.
The package repository has no additional pending DI/IoC changes.

Kernel startup composes evaluation extensions through explicit accessors, and
runtime dispatch delegates to named methods that retain identity, prune and
reported-note authority. Shared services and providers now use `lib/service/control.ts`
with their own health projections and note policies. The earlier integration
already included the lazy evaluation bootstrap, driver context access, shared
control implementation and regression tests.

The integrated kernel has **1,423 counted lines** from **1,774 physical lines**,
excluding **190 import-only**, **140 blank** and **21 comment-only** lines under
ADRs 0039 and 0051. It remains **123 lines above** the unchanged 1,300-line ceiling.

The offline default profile is regenerated from the integrated sources, with
**58 exact pins**, including `lib/update` and `autoupdate`. Its registry bundle
SHA-256 is `64f9d78c2275f176c918c0a4a1be97af20ee637e44322a5707ce369e0b463e59`.

Validation against package commit `016d6a1`: strict checking, lint, generated
output and execution-artifact freshness pass. All **542/542 tests** pass inside
the mandatory sandbox in **436.88 seconds**, with no failures, cancellations or
skips. The kernel package-name boundary check passes, and the conformance inventory
covers **106/106 IDs** with none missing or skipped. Aggregate kernel-plus-idle-
environment RSS is **159,924,224 bytes** against 512,000,000; watched edit-to-serve
latency is **1,653.93 ms** against 2,000. The separate kernel-size gate remains red
at the count above. Shell parsing passes; shellcheck is unavailable on this host.

Logs: `/tmp/thetis-ioc-integrated-build.log`, `/tmp/thetis-ioc-integrated-check.log`,
`/tmp/thetis-ioc-integrated-test.log`, `/tmp/thetis-ioc-integrated-release.log`,
`/tmp/thetis-ioc-integrated-conformance.json` and `/tmp/thetis-ioc-integrated-size.json`.

## Root import validation before integration · 2026-09-10

ADR 0047 maps `@/` to the runtime repository root in TypeScript, source launches
and verified-artifact launches. Relocated revisions and workers resolve their
own dependencies. The isolated runtime/package pair, including the upstream
forwarded-prefix redirect correction, passes **457/457 tests** with no failures,
skips or cancellations in **368.87 seconds**. Strict checking, generated-output
freshness and artifact freshness pass. Idle RSS is **159,186,944 bytes** and
watched edit latency is **1,781.55 ms**, within the approved limits.

The subsequent counter-only change in ADR 0051 passes four focused sandboxed
counter tests and strict checking. Its inventory at that checkpoint was **1,361 counted
lines**: **1,700 physical**, excluding **185 import-only**, **134 blank** and
**20 comment-only** lines. The kernel remained **61 lines above** the unchanged
1,300-line ceiling. Older measurements below use their recorded counting policy.

The refactor was validated in an isolated checkout to preserve concurrent
installer/update work in the shared workspace; that unrelated work is not part
of these commits. Logs: `/tmp/thetis-alias-publish-test.log`,
`/tmp/thetis-alias-publish-check.log`, `/tmp/thetis-counter-test.log`,
`/tmp/thetis-counter-check.log` and `/tmp/thetis-counter-size.json`.

## This continuation

- The operator authorizes all seven P1/P2 runtime review fixes and accepts a
  two-second watched-edit ceiling in ADR 0042. ADRs 0043–0046 cover exact decimal
  accounting and separate run lifetimes, observed process exits and reset-safe
  recovery, dynamic registration recapture, and retirement of ephemeral
  workspaces and identities. Focused regressions and the final full suite pass
  (**455/455**, none skipped). Recovery tests include failed reset attempts, consumed epochs,
  postcommit checkpoint failures and non-idempotent initial migrations.
- On 2026-09-10 the operator explicitly permits memory up to 512 MB and requests
  raising the ceiling. Accepted ADR 0041 sets aggregate kernel-plus-idle-environment
  RSS acceptance to at most 512,000,000 bytes. The same cold process measurement
  remains in the test and benchmark. ADR 0042 subsequently permits edit latency
  at most 2,000 ms; individual sandbox limits retain their existing settings.
- The operator lifts the earlier UI deferral and explicitly approves ADR 0038:
  each person's `gateway-web` target (person scope) keeps the wire and gains
  `assets/`, serving both over its own public socket; there is no new
  deployment-scope front package. The operator's TLS endpoint maps `/login`
  and `/<person>/` to the matching target's public socket by static rule, and
  `gateway-web` checks the `thetis_session` cookie itself by calling the
  kernel's new `session.whois`. A deployment-scope front that spliced bytes
  into each person's socket was proposed and refused: it would need an
  exception to the boundary rule at `kernel/boundary/runtime.ts:265`. Other
  agents are implementing this now; none of it is built, tested or measured
  as of this record. See ADR 0038 and `TODO.md` §1.
- The operator separately accepts ADR 0037. The implementation supplies verified
  JavaScript under original TypeScript URLs, disables implicit stripping in
  artifact processes, preserves worker entry points and checks pairs before
  mounting copied pins. Bounded work compilation reuses unchanged output only
  from trusted previous pins; edited package schemas regenerate their guards.
- Generated schema guards load lazily and check their referenced-schema
  fingerprints before taking a shortcut. Dynamic schemas retain Ajv. Artifact,
  schema, registry and snapshot focused suites pass all 27 tests; strict checking
  and both generated-output freshness gates pass. See
  [execution artifacts](execution-artifacts.md) for commands and bounds.
- Artifact-related registry tmpfs exhaustion is fixed without raising its memory
  limit: incremental object packing and hash-checked immutable cache links avoid
  duplicate pages. Generation and mutable-state snapshots remain isolated copies.
- The opt-in OpenRouter check passes four real answer turns across two sandboxed
  accounts using the operator-authorized TOML key source. Its combined configured
  cost ceiling is USD 0.04. Key bytes travel through private inherited descriptors;
  temporary encrypted storage uses a random master key and is removed afterward.
  The TOML is unchanged, and the ordinary suite remains offline.
- Static spawn requirements no longer masquerade as dynamic envelope additions.
  New regression coverage permits declared requirements while still refusing
  undeclared secrets and explicit out-of-envelope additions.
- ADR 0036 enables generation-local Node compilation caches without introducing
  transpilation. Ajv avoids redundant root compilation and reference inlining.
  Real health measurements distinguish import, schema and worker startup phases.
  Discovery and discarded-write assertions explicitly account for cache files;
  production journals still contain every changed path.
- `scripts/bench.ts` and `scripts/size.ts` enforce the current acceptance limits.
  Kernel size remains above its limit; memory and edit latency now use the
  operator-approved ceilings in ADRs 0041–0042 without changing what is measured.
- `profiles/default/` now contains 52 exact pins and their offline git bundle,
  including the execution artifacts and the new shared artifact library.
  Reconstruction into a fresh registry verifies every commit and tree hash,
  materializes the closure, and refuses a changed hash. Two exports with one git
  compression worker produce identical manifests, locks, checksums and bundle
  bytes. The current bundle SHA-256 is
  `34f02f16a8a824c9c0c31aca30b83a694dade84fd9a475f5b6a2971433b0c169`;
  two fresh exports compare byte-for-byte. These package artifacts are not a
  finished installer or approved kernel.
- The approved build step improves measured memory and edit latency. The latest
  operator-approved ceilings are 512 MB and two seconds.
  These changes do not complete Milestone A.
- ADR 0035 reviews the runtime and independent package checkout in a read-only
  `/workspace` sandbox matching the installed directory layout. Package discovery
  ignores repository metadata but still refuses escaped symlinks. The default
  development layout is sibling `runtime/` and `packages/` repositories;
  `THETIS_PACKAGES` remains an optional override, not a compiled-in host path.
- Checks cover generated types, strict TypeScript and lint in both repositories.
  Package imports remain relative and their generated bytes survive relocation.
  Regression tests distinguish allowed shared imports from forbidden direct
  package imports. The test runner also accepts focused workspace-relative paths.
- Registry fixtures now initialize their schema service before use. Committed
  schema failures escape as programming errors rather than misleading registry
  I/O results. Lazy socket parameter validation remains synchronous.
- The production evaluator integration now passes. Kernel stdout contains only
  its readiness document, transient setup names the generation-owned endpoint,
  and session methods negotiate without granting candidates upstream routing.
  The fixture stops its preparation-only provider before kernel startup reaps
  the dedicated cgroup subtree.
- Changes in `core/kernel-control.ts` and `core/startup.ts` remain in the separate
  package repository. Its existing `cli/template.test.ts` edit is preserved.
  No commits are made in either repository.

## Installer and update path · 2026-09-10

The operator approved the installer and update plan. ADR 0048 is Accepted and
implemented; ADR 0049 (a pre-authorised update policy) is written and left
**Proposed** — `--auto-update` accepts only `none` and refuses every other value
with one sentence naming that record. ADR 0050 records a blocker the plan did
not see and the workaround taken for it.

Built and exercised offline:

- `kernel/supervisor-main.ts` (two counted, six physical kernel lines) over
  `lib/maintenance/supervisor.ts`: it holds the deployment lock, builds the
  kernel revision from the release's published `kernel-pins.json`, calls
  `Maintenance.start`, and serves a 0600 control socket taking
  `status | update | undo | stop`. Authority is an administrator session the
  **running kernel** resolves: a new `whois` command on the existing maintenance
  IPC, added to `lib/maintenance/schema.json` and `host.ts`. The supervisor
  never names a person and never caches a principal.
- `lib/maintenance/pins.ts`: a supervised revision uses the hashes the release
  published and refuses a tree that differs (`hash-mismatch`).
- `lib/sandbox-runner/cgroup.ts`: `delegate()` accepts an explicitly named
  `.service` root as well as a `run-*.scope`; its single-process and
  `cpu memory pids` checks are unchanged. The pure `delegated()` predicate is
  tested, since no `.service` cgroup exists inside the test namespace.
- `lib/update/*`: the tag advertisement parser (bounded to 1 MiB, no API token,
  no JSON), the policy selector, release verification (signature → checksums →
  provenance-to-tag → published pin hashes → ADR 0037 artifacts), staging that
  promotes only after every check, `updates/status.json`, and the operator
  command `zero status | update --check | update --apply | undo | prune-releases`.
- `install.sh` (644 lines, `dash -n` clean) with the four systemd units embedded
  as heredocs and copied for review under `units/`, and `lib/update/seed.ts`,
  which writes the installation's recipe and trusted seed from the release's own
  reviewed sources through `catalog()`, `materialize()` and `target()` rather
  than from shell. `test/installer.test.ts` runs it against a signed `file://`
  release: six cases, all green, covering the ADR 0049 refusal, the ADR 0050
  state-root limit, the `--dry-run` golden step list, unit/copy byte equality,
  four refusal paths that stop before any file exists under the prefix, and a
  fresh install whose seed, recipe, `install.json` and `accounts.json` all
  validate against their own contracts with no password or account id in the
  installer's output.
- `.github/scripts/verify.sh` and `.github/workflows/release.yml`: releases gain
  `kernel-pins.json`, `SHA256SUMS.sig`, a published `allowed_signers` line and a
  `provenance.node` object, and the publishing job verifies the signature again
  before it uploads.
- `test/release-fixture.ts`: a complete, signed, offline release built from the
  workspace with a throwaway ed25519 key, so every installer and updater test
  runs with no network.
- `packages/autoupdate`: the in-product notice, `network: "none"`, reading the
  host's status file from a read-only mount. It applies nothing — a package
  cannot write the code prefix, reach the control socket, or start or stop a
  process.

Two findings worth reading before the first real install:

1. **ADR 0050.** A supervised kernel runs on the private store copy
   `lib/maintenance/prepare.ts` makes per generation. Nesting that copy under
   `runs/<n>-<uuid>/state` pushes every target's public endpoint past the
   107-byte `sockaddr_un` limit `lib/socket/endpoint.ts` enforces, so a
   supervised deployment with any public-socket target could not have survived
   its first update. `Maintenance` gained an optional short `stateRoot`, off by
   default; the installer's state root is `/var/lib/z` and the supervisor
   refuses one longer than 18 bytes. The residual cost is recorded: a target's
   socket path now contains the generation, so the operator's TLS endpoint must
   be repointed after every kernel update until a `Deployment.endpoints` root
   exists, which needs kernel lines this work did not have.
2. **A refusal could kill the serving kernel.** A maintenance reply carrying a
   code outside the reply schema's enum failed the supervisor's validator, which
   SIGKILLed the kernel instead of reporting the refusal; `whois` on an unknown
   session produced exactly that. `host.ts` now maps an identity refusal to
   `forbidden` and normalises every outgoing code to the wire enum.

The kernel budget moved for a reason unrelated to this work: the same session
revised `scripts/source-lines.ts` and reformatted the kernel, so the inventory
now reads 1,733 physical and **1,387 counted** lines against 1,300. Under that
accounting the installer work's whole kernel cost is two counted lines. Earlier
1,680-line figures are historical.

Validation of this work: `scripts/check.ts` exit 0; `test/conformance-inventory.ts`
exit 0 with 0 missing and 0 skipped; the full suite **532/542** with 0 skips and
0 cancellations. The ten failures are a race with a concurrent session in the
same tree — `lib/service/control.ts` appeared without its execution artifacts
during the run's first minute, so every sandbox mounting `lib` refused under
ADR 0037 — and all ten pass on the settled tree (a 12/12 rerun of the five
files). Both acceptance measurements pass under ADRs 0041–0042: idle RSS
**159,481,856** bytes against 512,000,000, and edit-to-serve **1,622.73 ms**
against 2,000. `scripts/size.ts` stays red at 1,423 counted lines against 1,300.

Measurements are **not** updated by this work and must be retaken on a real
host: a supervised deployment adds a second Node process with the same heap
flags as the kernel, so the ADR 0041 idle-RSS figure of 159,289,344 bytes does
not describe an installed deployment. Nothing privileged was run here — no
`sudo`, no mount, no writes under `/opt`, `/etc` or `/var/lib`, no `systemctl`,
no `zero` account. Every test runs with
`--prefix <tmp> --state <tmp> --no-mount --service none`. The privileged first
install is a copy-pasteable procedure in `docs/install.md` under "First install
on this host", for the operator to run.

## Implemented and exercised

- Evidence-derived identity, scoped secrets, descriptor delivery, generation
  fencing and deliberate same-run delegation; credentials and provider text are
  excluded from kernel observations. Provisional credentials never admit
  ordinary calls, and rollback consumes a fresh generation number.
- Bounded NDJSON and negotiated Unix-socket transport, schema validation,
  cancellation, deadlines, control-frame priority and both directions of the
  pinned local transport compatibility matrix.
- The unprivileged loop, dispatcher ownership, frozen observers, isolated
  appenders, immutable rendered prefixes, scoped persistent conversations,
  branching history, notices, streamed spill files and protected compaction.
  Real monitor/worker sessions keep provider deltas out of the kernel.
- Plain-directory discovery, envelope checks, independent initialization,
  captured registrations, verified registry publication and installation,
  retention and neutral target assembly. Actual two-account CLI conversations
  use separate sandboxes and writable spaces with a shared mock service.
- Deterministic mock caching and configurable startup scripts; the compatible
  HTTP/SSE provider uses conservative budget reservations and durable checkpoints.
  Early errors and disconnected consumers still settle and report usage, while
  failed final attribution refuses subsequent calls. Live OpenRouter answers now
  pass separately; no real-vendor cache-hit result is claimed.
- Actual generation-machine process switching, read-only probes, fresh serving
  launches, snapshot isolation, migration, undo, reset and durable restart
  recovery. Default promotion checks code, role, origin, gate and CAS; crash
  recovery restores frozen members before admitting work. Maintenance also
  proceeds through the documented generation controls.
- Mandatory bubblewrap namespaces, pre-exec cgroup admission, bounded writable
  filesystems, verified freezing and orphan reaping. Private network egress has
  isolated tests; an actual installation still needs provisioned bounded volumes.
- Separate observed and reported logs with provenance labels, oversized-frame
  diagnostics, metrics queries and an evaluator using ordinary candidate runs,
  privately mounted scorers and observed outcomes. Mutator determinism and
  stoplist properties are exercised; inventory coverage alone does not establish
  every evaluator clause.
- Person-scoped CLI, password authority and trusted kernel origin are exercised
  headlessly. Visual gateway UI work begins under ADR 0038 in this
  continuation, following the operator's lifted deferral; it is not yet
  implemented or exercised.

## Current acceptance validation · 2026-09-10

After the authorized P1/P2 fixes, the full mandatory-sandbox suite passes
**455/455 tests**, with zero failures, skips or cancellations, in **349.80 seconds**.
The watched edit serves in **1,591.96 ms** against **2,000 ms**. Kernel RSS of
**82,116,608 bytes** plus idle environment RSS of **77,172,736 bytes** totals
**159,289,344 bytes** against **512,000,000 bytes**.

The artifact build, strict TypeScript, lint, generated-output freshness and
execution-artifact freshness all pass. Both repositories pass `git diff --check`.
The conformance-name inventory covers **106/106 ids**, with none missing or
skipped; it remains a named-coverage inventory, not a clause-level acceptance audit.

At the review-remediation checkpoint, ADR 0039 reported **1,680 counted lines**,
or **1,700 physical lines minus 20 comment-only lines**, against **1,300**.
ADR 0051's current measurement appears above.
The review fixes therefore do not complete Milestone A. No commits or vendor calls
were made during remediation.

Logs: `/tmp/thetis-review-fixes-full-test.log`,
`/tmp/thetis-review-fixes-check.log`, `/tmp/thetis-review-fixes-build.log`,
`/tmp/thetis-review-fixes-size.json` and
`/tmp/thetis-review-fixes-conformance.json`.

## Pre-remediation validation · 2026-09-10

The full review suite ran before ADR 0041 changed the ceiling: **417 tests,
415 pass, 2 fail, none skipped or cancelled**. Its two failures were aggregate
idle RSS of **154,759,168 bytes** against the former 120,000,000-byte ceiling
and watched-edit latency of **1,572.67 ms** against 1,000 ms.

After the ceiling change, the focused memory test passes: kernel RSS
**79,720,448 bytes** plus idle environment RSS **76,443,648 bytes**, totaling
**156,164,096 bytes** against **512,000,000 bytes**. It uses the same processes
and mandatory sandbox. At this stage the full suite had not been rerun and the
preceding latency failure remained outstanding. Earlier suite counts and
120 MB comparisons below retain their historical meaning.

The conformance inventory then covered **106/106 ids**, with none missing or
skipped; this does not establish every clause. Kernel size was **1,583
counted lines**, or 1,602 physical lines minus 19 comment-only lines, against
1,300. After refreshing the changed execution artifacts, strict TypeScript,
lint, generated-output freshness and artifact freshness all pass. The runtime
working tree also passes `git diff --check`.

## Web surface acceptance · 2026-09-10

Phase 4 acceptance of the Milestone A clause "two accounts chat in their own
environments through the lifted web UI" was retried later the same session,
after the concurrent-edit hash-mismatch reported earlier on this date cleared
(`"$THETIS_NODE" scripts/build.ts --check` exits 0) and no
`scripts/test.ts --delegated` process was still running. This time the
deployment started and the walkthrough was completed against the mock
provider. This is not a claim that Milestone A is complete — only that this
one clause was exercised end to end, honestly, with the observations below.
The deployment and its stand-in proxy are still running as of this writing
(see `/tmp/claude-1000/-tank-data-Dev-thetis-agent/acceptance/README.md` for
the URL, credentials and shutdown steps); nothing was torn down.

**What was exercised.** Route B: a driver
(`/tmp/claude-1000/-tank-data-Dev-thetis-agent/acceptance/outer.ts` →
`inner.ts`) reusing `test/deployment-assembly.ts`'s `fixture()`/`deployed()`
under the same delegated `systemd-run --user --scope -p Delegate=yes` + bwrap
plan `scripts/test.ts` uses, with one deviation: `/assembly` is bound to a
real host tmpfs instead of bwrap's private one, so the deployment's unix
sockets stay reachable from a plain host process. `inner.ts` resolves each
target's live socket via `dep.running.runtime.endpoint(id)`
(`kernel/boundary/runtime.ts:117`) and writes it to `ready.json`. A throwaway
Node HTTP proxy (`proxy.mjs`, plain HTTP, no TLS) path-routes
`/login*`→`login`, `/alice/*`→`alice-web` (prefix stripped,
`x-forwarded-prefix: /alice` added), `/bob/*`→`bob-web` likewise, forwarding
WebSocket upgrades too, and listens on `127.0.0.1:8777` — distinct from the
operator's own real TLS-terminating reverse proxy
(`/opt/thetis/target/release/thetis`, listening on `10.10.50.1:8777`, a
different address on the same host). Two socket-plumbing problems specific to
this throwaway rig (not the target codebase) had to be worked around to reach
this point: the resolved socket paths, translated from the sandbox's
`/assembly/...` view to the host's real tmpfs directory, exceeded AF_UNIX's
~108-byte `sun_path` limit (Node/libuv reported this as a bare `ENOENT`, not
`ENAMETOOLONG`); the fix was short-named `/tmp/thetis-acceptance-<id>.sock`
symlinks pointing at the real paths. Separately, the proxy's own router
initially matched `req.url` including its query string, so
`/login?error=refused` 404'd; fixed by routing on the pathname only and
forwarding the full original URL upstream. Both are fixed in `proxy.mjs`
under `/tmp/.../acceptance/`, not in this repository.

The root cause is concurrent, currently uncommitted edits landing in the
runtime tree during this session, not a defect fixed at one file:line: a
first scan (`lib/artifacts/verify.mjs`'s `verified()`, run directly against
every `.ts`/`.ts.js`/`.ts.artifact.json` triple under `runtime/{lib,contracts,
kernel}` and `packages/*` with `$THETIS_NODE` v24.18.0) found only
`lib/deployment/work.ts` mismatched (its `.ts.js` and `.artifact.json`
mtime 00:39:15 predate the `.ts` source's mtime 00:39:28 by 13s: the recorded
output hash still matches the current `.ts.js`, only the recorded source hash
is stale). A second scan four minutes later, after no action by this session
other than reading files, additionally found `lib/generation-state/
projection.ts`, `kernel/generations/index.ts` and `kernel/generations/table.ts`
mismatched, each with a source mtime of 00:43:08 — after the first scan and
after `scripts/build.ts` had already regenerated their artifacts at 00:39:15.
A third scan fifteen seconds later found the same four files and no more: the
churn is real but was not observed growing further. Per this repository's own
rules (`brief.md`: "Both repos carry uncommitted work from the previous
continuation"), this session left all four files untouched and did not
attempt to rebuild them again, since doing so would both exceed this
session's edit permissions and race a mechanism that was still moving. This
is corroborated directly: `ps aux` at 00:46 showed live, non-self `bwrap`
processes (not started by this session) running a focused
`"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts` invocation over exactly this area —
`kernel/boundary/process.test.ts`, `kernel/generations/{act,default,driver,
index,recovery}.test.ts`, `lib/generation-state/projection.test.ts`,
`test/generation-{initial-recovery,retention}.test.ts` — i.e. another,
concurrently active process was mid edit-build-test cycle on the same
generations/work code this session's acceptance attempt depended on. That
process was left running and untouched.
**Two-account chat, isolation, and RSS.** Signed in as `alice-login` /
`bob-login` (fixed test passwords from `test/deployment-assembly.ts`'s
`loginPasswords`) through the proxy, in two separate browser tabs. Both
accounts sent and received turns against `provider-mock` (e.g. "Second turn,
checking isolation." → "Hello."); a live WebSocket capture of one full turn
recorded the exact `assistant` event: `{"type":"event","kind":"assistant",
"text":"Hello.","usage":{"cost":0.001,"in":650,"out":1,"cached":455,
"cached_write":0}}`, preceded by `turn-started`/`delta` and followed by
`turn-finished`/`accepted` — matching the wire shapes noted in this session's
earlier assets review (the `hello` reply is now
`{"type":"user","user":{...},"capabilities":[...]}`, not a bare user-info
frame). Isolation (ADR 0038) held at both the HTTP and UI layers: `curl` with
alice's raw session cookie got `200` from `/alice/api/me` and `401`
(`{"ok":false,"error":{"code":"auth","message":"Sign in to continue."}}`) from
`/bob/api/me`; in the browser, bob's conversation sidebar never showed
alice's conversation (and vice versa) across the whole session. The sidebar
footer correctly rendered "Signed in as: <person>" with a live/"connected"
status, and a wrong password rendered the login page's alert banner ("The id
or password was refused.") rather than a bare redirect loop or blank page.
Idle RSS of the three sandboxed target processes, measured directly
(`ps -o rss,cmd` on each target's innermost `node .../service.ts` process,
identified by matching its bwrap ancestor's `--ro-bind .../pins/<hash>`
mounts back to the target hashes in `ready.json`): `alice-web` **59,260 KB**,
`bob-web` **58,372 KB**, `login` **122,636 KB** (`gateway-login` is
noticeably heavier than either `gateway-web` instance; not investigated
further here). These are cold, single-session numbers, not a load test, and
are separate from the kernel-process RSS figures measured elsewhere on this
page.

**A real bug found while driving the UI (not fixed, per this session's
scope).** When a previously-established browser session stops validating
(observed here after this session's own proxy restarts during debugging
invalidated an in-memory session — not itself a codebase defect: a fresh
login immediately after works and keeps working) and the browser is on
`/alice/` at that moment, the client redirects to
`/login?next=%2Falice` — a `next` value with **no trailing slash**. On
successful re-authentication, that value is echoed back verbatim as the
landing URL (`/alice`, not `/alice/`). Because the SPA's asset tags use
paths relative to the current URL, the browser then requests
`/theme.css`, `/app.css` and `/app.js` against the document root instead of
`/alice/`, all three 404, and the app is stuck showing "connecting"
indefinitely — a real, reproducible dead end for an end user, not a proxy
artifact (confirmed: the identical redirect chain with a trailing-slash
`next` value, e.g. `/login?next=%2Fbob%2F`, lands cleanly with no 404s).
File:line: `packages/gateway-web/http.ts:39-45`'s `redirectToLogin` builds
`next` from the `x-forwarded-prefix` header (here, `/alice`, per this
session's own proxy — but any reverse proxy setting that header without a
trailing slash would trigger the same path) without normalizing it to a
directory-style path; `packages/gateway-login/server.ts:52` then redirects to
`safeNext(params.get('next')) ?? \`/${encodeURIComponent(result.value.person)}/\``
on success — the `next` branch never gets the trailing slash that the
fallback branch (used only when there is no `next` at all) does. Not fixed,
per this task's scope; reported here with exact file:line and a confirmed
repro/non-repro contrast instead.

`scripts/size.ts`'s kernel-size and lint/typecheck/artifact-freshness figures
from earlier on this date are unaffected by this retry and are not repeated
here.

## Historical validation · 2026-09-09

The working tree is based on runtime `51f8c7e` and package registry `325f3ae`,
with uncommitted changes in both. The final full suite reports **356 tests:
354 pass, 2 fail, none skipped or cancelled**, in **221.49 seconds**, from the
relocated runtime using sibling package discovery. Only the actual idle-memory
and watched-edit latency assertions fail. The previous artifact run found two
unbuilt TE-023 fixture failures; those fixtures now build before pinning and both
real shutdown/fencing tests pass unchanged. No test is removed or skipped.
`/opt/zero` is no longer present; development uses the runtime checkout directly,
and the relocation backup remains untouched. No installed distribution or new
commit is created.

- Strict checking and lint pass with zero warnings; committed schema output is
  fresh across both repositories.
- The conformance inventory has 97 required ids, 97 covered, none missing and
  none skipped. This is an inventory, not Milestone A acceptance.
- Tests run under real bubblewrap user, process and network namespaces in a
  delegated supervisor bounded to 2,048 MiB, 256 tasks and 100% CPU. Individual
  sandbox resource limits remain unchanged. No real model, key or external
  network is required. Protocol deadlines use injected clocks; performance
  assertions measure real elapsed time.
- The watched edit actually changes Alice's serving file tool and leaves Bob's
  generation unchanged, but its under-1-second assertion is still failing.
  The final full run measures **1,499.55 ms** against the 1,000 ms ceiling;
  the preceding artifact run measured 1,538.05 ms, and the pre-artifact full
  baseline was 1,896.26 ms. No passing latency claim is made.
- The actual kernel measures **80,138,240 bytes RSS**; one idle environment and
  its sandbox descendants measure **75,091,968 bytes**, totaling **155,230,208
  bytes** against the 120,000,000-byte ceiling. The pre-artifact full baseline
  was 257,855,488 bytes. Kernel RSS includes its worker
  threads. The external test supervisor and separate provider are not counted.
  This is a cold deployment measurement, not a post-GC or prewarmed estimate.
- The kernel-size inventory after ADR 0040 reports 1,602 physical non-test
  TypeScript lines minus 19 comment-only lines: 1,583 counted, over the
  1,300-line budget. A grep for discovered package names finds no matches in
  non-test kernel TypeScript. No kernel-size compliance is claimed.
- ADR 0040 adds `contract/storage` and the default `storage-files` package. The
  shared `lib/storage` backend owns bounded opaque objects and durable append
  mechanics. The kernel retains encryption, scope/grant checks and provenance;
  existing sealed objects and journal formats remain compatible. The extraction
  removes 15 counted kernel lines, independent of concurrent boundary changes.
- Storage validation runs 403 full-suite tests: 399 pass; the two existing
  performance limits and two concurrently added web-asset tests fail. Measured
  RSS is 155,459,584 bytes and work-edit latency is 1,477.01 ms. After final
  storage concurrency fixes, 23 focused storage, secret, journal, crash-recovery,
  maintenance and trusted-startup tests pass. Full strict checking reports only
  gateway-web type/lint failures; storage types, lint and generated artifacts
  pass. The final rebuilt default bundle independently reconstructs all 56 exact
  pins offline, including the three new storage pins. These results do not waive
  any CI gate.
- Both repositories pass `git diff --check`. The default bundle independently
  reconstructs all 52 pins in the full suite and two exports are byte-identical.
  The authorized paid model check is not rerun during this continuation.

## Remaining acceptance

See `../TODO.md` for the ordered follow-up: kernel budget,
clause-level conformance review, operator review of the generated
default, its installation seed and a reproducible installer with bounded
persistent volumes. The live demonstration and benchmark scripts are no longer
missing. Visual UI work is no longer deferred; it is starting under ADR 0038
and is not yet implemented or measured. A development checkout and package
bundle at the intended paths are not a finished installation.

The copied design schemas and design documents remain intact. ADRs 0021–0046 are
indexed. ADR 0037 and ADR 0038 are Accepted following the operator's explicit
approval. ADRs 0041–0042 separately accept the 512 MB idle-memory and two-second
edit-latency ceilings; historical
Proposed entries remain superseded records. No milestone
completion report is written because Milestone A has not passed.

## Reproduction

From the runtime checkout, with its sibling package repository present:

```sh
export THETIS_NODE=/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/build.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/check.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs test/conformance-inventory.ts
```

Use `THETIS_PACKAGES` only for a non-sibling package checkout. The shell's default
Node 20 cannot run this project's TypeScript directly. Required sandbox or cgroup
failures are errors, never permission to run tests without their boundary.


## Installer and update completion · 2026-09-10

ADRs 0052–0053 supersede the earlier installer lifecycle limitations. The generated
standalone installer bootstraps the Node archive bound by signed provenance,
retains seed source paths, renders the selected service mode, enables its check
timer and records provisioning choices for uninstall. Release signing is confined
to protected publication jobs. Check and administrator apply independently verify
release signatures, annotated runtime tags, code pins and execution artifacts.

The installed default deployment has passed a complete local lifecycle with the
shipped `zero` launcher: install without Node on PATH, start at generation 1,
check and repeat verification, authenticate and apply at generation 2, undo to the
previous code/store at generation 3, restart from retained state at generation 4,
prune and purge. Its public paths stay under `<state>/live`. Whole deployment
exports have a separate 65,536-entry bound; individual code trees remain capped
at 10,000. Retirement preserves the live and previous stores.

System/user/foreground and TPM2 modes have provisioning and rendering coverage;
external manager commands are controlled test edges. No privileged installation
on this host, TPM2 enrollment, public signed release or external TLS-proxy
acceptance is claimed. Automatic apply remains refused under Proposed ADR 0049.
Node or supervisor changes require an explicit service migration. The unchanged
kernel inventory remains 1,423 counted lines against 1,300, blocking public
release delivery until corrected. Historical measurements above remain records
of their earlier revisions.

ShellCheck 0.9.0 reports no warnings for the generated installer and the three
CI shell scripts. CI runner provisioning now installs ShellCheck explicitly; the
local check wrapper reports its absence on PATH, so this lint was also run from
a temporary extracted package without changing the host installation.

The completion run passes **554/554 tests** in **687.97 seconds**, with no skipped
or cancelled tests. It measures kernel plus one idle environment at
**160,018,432 bytes** against 512,000,000 and edit-to-serve at **1,740.21 ms**
against 2,000. All 106 named conformance ids have enabled tests; the package-name
scan finds no kernel matches. The installed lifecycle takes 207.25 seconds in
that run. The final split-volume boot-order adjustment also receives focused
service-rendering validation. These results do not waive the kernel-size gate
or replace privileged host acceptance.
