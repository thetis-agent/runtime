# TODO

Milestone A is **in progress, not accepted**. Runtime review fixes and performance ceilings updated 2026-09-10;
the earlier status was recorded 2026-09-09 against
runtime `51f8c7e` and package registry `325f3ae`, both with uncommitted changes.
The original implementation prompt is preserved in
[docs/implementation-prompt.md](docs/implementation-prompt.md).

The proposal, schemas, conformance suites and accepted ADRs remain authoritative.
This list tracks remaining work; it does not waive acceptance requirements.

## 0. Current verification

Strict checking, generated-type freshness and lint now pass. Registry fixtures
explicitly load their schemas; schema programming errors no longer masquerade as
registry I/O failures. The production evaluator integration passes with real
candidate generations, ordinary accounts and private scorer observations.

The seven P1/P2 runtime review findings are fixed under ADRs 0043–0046, with
regressions for accounting, generation failure recovery, resource retirement and
dynamic provider edits. The import refactor passes the full **457/457-test** suite, with no
failures, cancellations or skips. The subsequent counter-only change passes all
four focused counter tests. Strict checking and both freshness gates pass.
Validation results are recorded in `docs/implementation-status.md`.

The headless two-account integration exercises a real watched `work/` edit and
verifies that the edited tool serves only Alice while Bob remains unchanged.
ADRs 0041–0042 approve aggregate idle RSS at most 512 MB (512,000,000 bytes) and
edit-to-serve latency at most two seconds (2,000 milliseconds). Both tests retain
the original measured workload, mandatory sandbox and generation fence. Earlier
120 MB and subsecond failures remain historical results under the former gates.

Performance follow-up: profile the complete switch, including verified pin preparation, schema
compilation and both process launches. ADR 0026 requires a read-only probe and a
fresh serving process after commitment; reusing the probe as a writer would
remove a guarantee and requires a person's decision, not an optimization patch.
ADR 0036 enables bounded, generation-local native caches without a build step.
ADR 0037 is **Accepted** by the operator and implemented: deterministic,
hash-verified JavaScript artifacts replace direct TypeScript execution in newly
assembled plans. Changed files compile in a bounded child; unchanged output
comes only from a trusted pin. Schema guards have freshness and differential
checks. Acceptance uses the operator-approved two-second ceiling from ADR 0042.

Pending, not yet exercised: chat through the browser. The operator lifted the
UI deferral and approved ADR 0038; `gateway-web`'s `assets/`, its public
socket, the operator's static `/login` and `/<person>/` proxy rules, and the
kernel's new `session.whois` are being implemented separately from this
record. There is no deployment-scope front package. Nothing here claims that
work is built, tested, or measured yet.

Do not commit until both `check` and the full `test` command pass.

## 1. Acceptance requirements

| Requirement | Status |
| --- | --- |
| Two accounts chat in separate sandboxes | Exercised headlessly through registry assembly and person-scoped CLI sockets |
| Chat through the lifted UI | Exercised on the mock provider: two accounts signed in through a real browser (Playwright) via a throwaway proxy, chatted, and stayed isolated (ADR 0038) at both the HTTP and UI layers; a real trailing-slash redirect bug was found and reported (not fixed). Not a claim that Milestone A is complete — see `docs/implementation-status.md` "Web surface acceptance · 2026-09-10" for the full account, RSS figures, and the bug's exact file:line |
| Chat on OpenRouter | Four live answer turns pass across two sandboxed accounts, with a combined USD 0.04 configured ceiling; kept separate from offline tests |
| Turn two at least 99% cache hit | Passes in the deterministic mock model only |
| Every conformance id passes | 106/106 ids have named tests, none missing or skipped; inventory is not complete clause-level acceptance |
| `work/` edit serves in at most 2 seconds | Passes at 1,591.96 ms against 2,000 ms under ADR 0042 |
| Kernel plus idle environment at most 512 MB | Passes at 159,289,344 bytes against 512,000,000 bytes under ADR 0041 |
| Type checker and lint clean | Full strict check, generated types and execution-artifact freshness pass after the review fixes |
| Labelled observed and reported turn rows | Exercised through actual environments, provider error/disconnect paths, metrics and evaluator integration; complete clause-level audit remains |

## 2. Kernel budget

The integrated DI/IoC inventory has **1,774 physical non-test TypeScript lines**.
Under operator-approved ADRs 0039 and 0051, it excludes **190 import-only lines**,
**140 blank lines** and **21 comment-only lines**. The **1,423 counted lines**
remain **123 lines above** the unchanged 1,300-line budget. The installer and
update work adds exactly one kernel file, `kernel/supervisor-main.ts`, the
production entry ADR 0048 requires, at **2 counted and 6 physical lines**;
everything else it adds is in `lib/`. The DI/IoC refactor keeps named dispatch
handlers and evaluation authority composition in the kernel; it does not move
authority to reduce the count.
ADR 0040 moves byte-store mechanics behind `contract/storage`, with the default
file backend shared by `storage-files` and the kernel. This extraction removes
15 kernel lines at introduction; the current total includes the review's new
failure recovery, supervision and resource-retirement authority.
Identity, boundary, secret custody and generation authority must stay in the
kernel. Do not compress code or move authority merely to improve the count.
Record any further architectural extraction before implementation.

## 3. Missing deliverables

- Operator review of the generated `profiles/default/` and its corresponding
  installation seed. The profile now has 58 exact pins and a matching offline
  git bundle; its reconstruction test verifies every commit and tree hash.
  The example recipe and package bundle alone are not a provisioned deployment.
- A passing `scripts/size.ts` result; kernel size remains above its limit.
  Performance acceptance uses ADRs 0041–0042's approved memory and latency ceilings.
- A reproducible installation path to `/opt/zero`. `install.sh`, the systemd
  units, the supervised kernel entry and `zero update`/`zero undo` are built and
  tested offline against a signed local `file://` release under ADR 0048; the
  privileged first install on a real host has **not** been run. The
  copy-pasteable procedure and what to observe are in
  [docs/install.md](docs/install.md); the
  operator runs it and records the measurements. Idle RSS must be re-measured
  because a supervised deployment adds a second Node process.
- `docs/milestone-a.md` remains deliberately absent until acceptance passes.

## 4. Follow-up integration and testing

- Audit every clause, schema-coded boundary error, matcher branch and generation
  guard rather than treating the 106 named ids as complete proof.
- Verify remaining lifecycle cases such as attachment handling and background
  notices through the session API. Do not infer coverage from a nearby test name.
- Validate persistent-volume provisioning on a deployment host. Enforced
  storage capacities and fail-closed root checks already exist; unbounded host
  directories are not a permissible shortcut.
- Keep future OpenRouter checks opt-in and separately budgeted. The authorized
  four-turn check is complete; do not rerun it automatically as part of tests.
- Blocking initialization tests cover synchronous JavaScript; they do not prove
  termination of every blocking native operation.
- Compatibility tests use the local green transport baseline
  `d8aa0d1200c7c24a0fa7f671c41eece204b377fe`, not a previously deployed release.
  Preserve/fetch that revision in CI; tests do not fetch from the network.
- ADR 0052 implements verified Node archive bootstrap, mode-specific provisioning,
  recorded uninstall choices, durable supervisor recovery, stable proxy paths
  through `<state>/live`, and maintenance store retirement. The installed lifecycle
  suite is the acceptance gate for these paths; see `docs/install.md`.
- Pending: the browser acceptance for ADR 0038 — sign in at `GET /login`
  through the operator's proxy, `POST /login`, redirect to `/<person>/`, and
  complete a turn over `/ws` for each of two sandboxed people, then record the
  result in `docs/implementation-status.md`. A 2026-09-10 attempt could not
  reach this: bringing up `profiles/examples/two-account.recipe.json` failed
  at `test/deployment-assembly.ts:48` with a `hash-mismatch` on pinned
  execution artifacts, reproduced independently by `scripts/bench.ts` and
  traced to concurrent uncommitted edits in the runtime tree during that
  session, not a defect at one fixed file:line. Retry once the tree settles
  and `scripts/test.ts`/`scripts/bench.ts` are confirmed green. Still not
  built or measured as of this record.

Completed items from the previous handoff are described in
`docs/implementation-status.md`: provider final accounting, mock startup settings,
registration activation, isolated network egress, default/recovery integration,
oversized-frame handling, metrics, evaluator and mutator properties are no longer
listed here as wholly unimplemented.

## 4a. Installer and update findings to investigate and confirm

Three findings from the ADR 0048 installer and update work. Each is handled for
now; each needs a person to confirm the handling is the one we want.

1. **Stable supervised public sockets and retained stores.** ADR 0052 supersedes
   the operational cost in ADR 0050 with a synced host alias at `<state>/live`.
   The kernel still uses private generation stores. The supervisor's lifecycle
   test checks update, state undo, restart and retention through this alias.

2. **A refusal could kill the serving kernel.** `lib/maintenance/schema.json`'s
   reply enum does not contain identity's codes, and the supervisor SIGKILLs a
   child whose reply fails validation — so `whois` on an unknown session killed
   the kernel instead of refusing the caller. `host.ts` now maps an identity
   refusal to `forbidden` and normalises every outgoing code to the wire enum,
   with unknown codes becoming `io`. To confirm: whether normalising is right or
   whether the enum should be widened so a refusal keeps its own code; and
   whether any other `Application.execute` branch can still produce a code the
   supervisor cannot parse (`maintenancePause`/`maintenanceResume` return
   `switching` and `not-found`, both outside the enum, and both now silently
   become `io`). A test that drives each branch to a refusal is missing.

3. **Two sandbox facts that silently disable tooling.** OpenSSH calls
   `getpwuid(getuid())` before doing any work and fatals without an
   `/etc/passwd` entry, so no `ssh-keygen` invocation could run inside the
   mandatory namespace; `scripts/test.ts` now mounts a one-line synthetic
   `/etc/passwd`, and `lib/sandbox-runner/namespace.ts` is deliberately
   unchanged so no deployment or package sandbox gains account data. Separately,
   Debian's `/usr/bin/awk` is a symlink into `/etc/alternatives`, which the
   sandbox's bare `--dir /etc` does not provide, so every `awk` call inside a
   sandbox fails with "not found" — `install.sh` uses `cut` and `sed` instead.
   To confirm: whether the test namespace should carry the passwd entry at all
   or whether release verification should move entirely outside every sandbox;
   and whether any other tool in the boundary inventory depends on `/etc`
   (a sweep of `/etc/alternatives` symlinks among the recorded tools has not
   been done).

## 5. Repository workflow

Runtime development belongs at `/tank/data/Dev/thetis-agent/runtime` beside the
separate `/tank/data/Dev/thetis-agent/packages` repository. ADR 0035 defines the
read-only `/workspace` mount layout used by checks and tests. An assembled
distribution may instead contain `packages/`; `THETIS_PACKAGES` selects a
non-sibling development checkout.

Use Node 24.18.0, not this host's default Node 20. Run from the runtime checkout:

```sh
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/build.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/check.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs test/conformance-inventory.ts
```

Checks require bubblewrap and working user namespaces. Tests additionally create
a delegated user-systemd cgroup. Focus a test run with workspace-relative paths,
for example `scripts/test.ts test/evaluation-main.test.ts lib/registry`.

Keep changes in each repository separately. Preserve the existing uncommitted
work and staged package removals; this continuation makes no commits. ADR 0021
is already Accepted; its historical Proposed decision entry was superseded by
the operator's acceptance. ADR 0037 is separately Accepted and implemented;
that approval does not waive latency, kernel size or installation work. The
separate ADR 0041 approval raises only the aggregate idle-memory ceiling to
512 MB; individual sandbox limits remain enforced.
