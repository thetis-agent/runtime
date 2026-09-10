# Runtime code review — 2026-09-10

Reviewed the current runtime working tree at `/tank/data/Dev/thetis-agent/runtime`, based on HEAD `51f8c7e` with substantial existing staged, modified and untracked work. This is a review of the implementation as it stands, not only the committed diff. Three specialist agents reviewed architecture, kernel lifecycle/isolation, and provider/protocol/storage behavior; the lead reviewed release, profile and evaluation paths and consolidated validation. The senior architect applied DRY, SOLID and the clean-code skill while respecting the project's typed-result boundaries and kernel authority rules.

Seven concrete defects were reproduced. P1 means fix before relying on sustained deployment or recovery; P2 means a functional defect with a narrower trigger. The architectural recommendations below are separate from defect severity. The user subsequently authorized all P1/P2 fixes, idle memory up to 512 MB and edit latency up to two seconds. The original findings and reproduction evidence remain below; remediation is recorded here.

Reproduction logs and scripts named below are local review evidence and are not published. Original finding locations describe the pre-fix working tree; use the remediation test links for current coverage.

## Authorized remediation · 2026-09-10

All seven findings are fixed. The final full mandatory-sandbox suite passes
**455/455 tests**, with no failures, skips or cancellations, in **349.80 seconds**.
The final artifact build and strict check pass, including TypeScript, lint,
generated-output freshness and execution-artifact freshness. Both repositories
pass `git diff --check`. Full test log (`thetis-review-fixes-full-test.log`, local evidence),
strict check (`thetis-review-fixes-check.log`, local evidence),
build log (`thetis-review-fixes-build.log`, local evidence).

Final measured idle RSS is **159,289,344 bytes** (82,116,608 kernel plus 77,172,736
environment) against **512,000,000 bytes**. The actual watched edit serves in
**1,591.96 ms** against **2,000 ms**. No vendor calls were made during review or remediation.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| P1 decimal settlement | Exact decimal balances; validate version-2 checkpoints before writing and migrate valid version-1 ledgers | [Provider checkpoint tests](../../lib/provider/checkpoint.test.ts), [exact money tests](../../lib/provider/money.test.ts) |
| P1 interrupted freezes | Restore service or stop in FAILED; preserve committed revision metadata and reserve recovery epochs before fencing | [Recovery tests](../../kernel/generations/recovery.test.ts) and [initial migration recovery](../../test/generation-initial-recovery.test.ts) |
| P1 unexpected process exits | Observe exits once, revoke credentials, close resources and supervise current serving generations through FAILED/reset | [Process tests](../../kernel/boundary/process.test.ts), [generation recovery tests](../../kernel/generations/recovery.test.ts) |
| P1 retained runs | Store immutable pins outside disposable workspaces; collect stopped runs after durable LIVE; preserve legacy pin anchors | [Real switch/reset/restart tests](../../test/generation-retention.test.ts), [retention boundaries](../../lib/snapshots/retention.test.ts) |
| P2 ephemeral identity capacity | Explicitly retire fresh runtime-owned targets after closing their authority, including failed transient starts | [Real transient/descriptor tests](../../test/authority-retirement.test.ts), [persistent fencing regression](../../kernel/identity/retirement.test.ts) |
| P2 run cost lifetimes | Separate periodic person windows from run ledgers retained until trusted credential expiry | [Run cost tests](../../lib/provider/run-cost.test.ts) |
| P2 dynamic work provisions | Recapture a complete registration set in an isolated empty state when changed dynamic provisions leave a gap; validate and bind it to candidate pins before the kernel probe | [Real watcher tests](../../test/work-registration.test.ts), [shared composition tests](../../lib/package-loader/composition.test.ts) |

The second review expanded recovery coverage to failed reset attempts, failed LIVE checkpoints, retries after a consumed epoch and non-idempotent initial migrations. Private probes stop before their validated state is captured; initial generations freeze during capture. Recovery uses the current revision's healthy snapshot without replaying its migration.

ADRs [0042](../../docs/adr/0042-allow-two-second-work-edits.md)–[0046](../../docs/adr/0046-retire-generation-resources.md) record the latency approval and implementation decisions. The benchmark asserts at most **2,000 ms** and **512,000,000 bytes**, preserving the measured workload and sandbox. New immutable pins have a separate 1,024-digest budget; already retained digests remain usable at capacity. Legacy pin anchors and immutable state history remain available for recovery.

Shared requirement composition addresses the senior architect's third recommendation. Transport deduplication and a unified registry-cache interface remain separate architectural follow-ups. The existing kernel-size debt remains: **1,680 counted lines** (1,700 physical minus 20 comment-only) against 1,300. The conformance-name inventory remains **106/106**, with none missing or skipped; this is not a clause-level acceptance audit.

The user's follow-up about npm reuse is covered in the [package assessment](runtime-reuse-assessment-2026-09-10.md). Execa, Piscina and decimal/SSE libraries offer modest support-code substitutions; they do not directly reduce the current kernel count. Estimated profile-history and argument-decoding extraction could remove 15–25 kernel lines while retaining authority decisions in the kernel. These estimates are not prototype measurements, and no dependencies were added.

## 1. P1 — Decimal reservation settlement can prevent provider restart

Location: [lib/provider/index.ts:49](../../lib/provider/index.ts#L49), especially the subtraction at line 53; [checkpoint.ts:30](../../lib/provider/checkpoint.ts#L30).

Three concurrent reservations of `0.01`, followed by settlement of all three, leave `reserved = -3.469446951953614e-18`. The real checkpoint writer saves this value successfully, but reopening rejects the checkpoint because its schema requires a nonnegative balance. Ordinary concurrent calls can therefore prevent provider startup after a restart. Nonzero rounding residue also defeats expired-entry reclamation, which checks `reserved === 0`.

Use reservation bookkeeping that guarantees an exact zero when the last reservation settles; preserve conservative accounting while calls remain active. Validate the persisted shape before acknowledging a save. Cover concurrent decimal reservations, persistence/reopen and expired-entry reclamation in one regression.

Evidence: provider findings and reproduction snippets (`thetis-runtime-review-provider-findings.md`, local evidence). The reproduction used the actual filesystem checkpoint implementation inside bubblewrap.

## 2. P1 — A checkpoint failure can strand a healthy environment in FROZEN

Location: [kernel/generations/driver.ts:134](../../kernel/generations/driver.ts#L134), the early returns at lines 141–145, and [checkpoint after transition at line 267](../../kernel/generations/driver.ts#L267).

`#move` records the FROZEN transition before writing its checkpoint. If that write fails, `#change` returns directly without rollback or thawing. The machine remains FROZEN and refuses admissions. `env.reset` cannot restore it because reset attempts a switch from FROZEN, which has no such transition.

Reproduced with a real generation, a healthy durable journal, and an `atomicWrite` failure limited to the FROZEN checkpoint. Later recovery writes would succeed, yet the result remains `state:"FROZEN", admits:false` and reset returns `The target in FROZEN cannot accept switch.` Route failures after transition initiation through recovery appropriate to the current state; restore the previous generation or reach a stopped FAILED state that can be reset. Keep recovery inside the generation machine.

Evidence: kernel reproduction output (`thetis-kernel-review-output.log`, local evidence), script (`thetis-kernel-review.mjs`, local evidence), delegated sandbox launcher (`thetis-kernel-review-launch.mjs`, local evidence).

## 3. P1 — An unexpectedly exited process remains advertised as LIVE

Location: [kernel/boundary/process.ts:43](../../kernel/boundary/process.ts#L43), [explicit-stop-only exit handling at line 111](../../kernel/boundary/process.ts#L111), and [runtime status at line 113](../../kernel/boundary/runtime.ts#L113).

Successful startup installs no supervision that feeds unexpected process exit back into the generation machine. Exit recording, credential revocation and process cleanup occur only through explicit `stop()`. Killing a real healthy generation with SIGKILL left `state:"LIVE", admits:true`, no `process.exit` observation, and a closed control socket. Status therefore reports readiness for a dead environment.

Handle unexpected exit through the generation machine, record its cause, revoke the run's authority, clean up resources and expose the correct unavailable or recovery state. Distinguish deliberate probe/old-generation shutdown from an unexpected serving-process exit.

Evidence: the `CRASH_STATUS` row in kernel reproduction output (`thetis-kernel-review-output.log`, local evidence).

## 4. P1 — Retained generation directories eventually block updates and reset

Location: [kernel/generations/prepare.ts:31](../../kernel/generations/prepare.ts#L31), with successful switch completion in [driver.ts:181](../../kernel/generations/driver.ts#L181).

Preparation limits the number of entries in `runs/` to 128, counting the `public` directory too. Successful generations accumulate there; failed candidates are discarded, but committed old generations are not retired. Starting with `public` and the initial generation, roughly 126 successful switches fill the pool. Further switches and resets fail; restart preparation uses the same capacity check.

The reproduction lowered the exported limit to three within the isolated test process: one real switch succeeded, then another switch and reset both failed with `The retained generation pool is full.` Add retirement based on live pin/checkpoint/recovery references and reserve capacity for recovery. Earlier directories can still hold reused pins, so simple age-based directory deletion is insufficient.

Evidence: the `RETAINED_RUN_CAPACITY` row in kernel reproduction output (`thetis-kernel-review-output.log`, local evidence).

## 5. P2 — Completed transient targets permanently consume identity capacity

Location: [kernel/identity/index.ts:119](../../kernel/identity/index.ts#L119), [admission at line 61](../../kernel/identity/index.ts#L61), and [transient authority creation](../../kernel/boundary/runtime.ts#L103).

Revocation removes tokens but never retires the corresponding `#generations` entry. Transient runs and empty scorer authorities generate fresh target IDs each time. After the configured capacity is consumed by cumulative targets, new identities are refused even when earlier executions have all closed. With capacity two, issuing and revoking two distinct targets makes the third fail with `The generation identity pool is full.` The default is 4096.

Add an explicit retirement operation for completed ephemeral targets once all associated authority is revoked. Preserve fencing history for persistent targets; deleting every generation record whenever a token disappears would weaken fencing.

Evidence: the `IDENTITY_AFTER_TWO_REVOKED_TARGETS` row in kernel reproduction output (`thetis-kernel-review-output.log`, local evidence).

## 6. P2 — A lifetime run cost limit resets with a periodic person window

Location: [lib/provider/reservation.ts:8](../../lib/provider/reservation.ts#L8), [window reset](../../lib/provider/index.ts#L38).

The trusted `caller.cost` limit is recorded as a synthetic person in the same expiring budget map. If the authenticated run outlives `windowMs`, its spent balance is reset and the same token can spend its full run ceiling again. An injected-clock reproduction consumed a ceiling of one, observed a correct refusal, advanced one window and observed another reservation of one succeed.

Separate lifetime run accounting from periodic person accounting, including persistence and authoritative retirement. This is a concrete single-responsibility problem: sharing bookkeeping for policies with different lifetimes changes the enforced guarantee.

Evidence: provider findings and reproduction snippets (`thetis-runtime-review-provider-findings.md`, local evidence).

## 7. P2 — Harmless work edits fail before dynamic provisions can be rediscovered

Location: [lib/profile/work-live.ts:37](../../lib/profile/work-live.ts#L37), [work requirement assembly](../../lib/profile/work-overlay.ts#L59), and [hash-bound registration retention](../../lib/package-loader/requirements.ts#L34).

Suppose package A provides `service/dynamic` during initialization and unchanged package B statically requires it. Editing only a comment in A changes its pin hash, correctly invalidating the old captured registration. `LiveWork.#apply` nevertheless resolves the complete dependency graph before invoking discovery. It now sees B's unmet dependency and refuses the edit before A can register the same provision again.

Reproduced with the real LiveWork, WorkQueue and snapshot path: the initial profile matched, the comment-only edit returned `gap`, and neither discovery nor switching ran. Matching the identical edited target with a fresh registration succeeded. The normal probe is never reached in this case. The deployment watcher also omits the optional description callback, so correcting only callback order is insufficient.

Share the construction of package requirements/provisions between work admission and kernel registration. Permit fresh isolated registration capture before the final concrete dependency check, then enforce the complete graph before activation. Preserve hash-bound registration authority.

Evidence: work-edit reproduction output (`thetis-runtime-review-work-repro.log`, local evidence), script (`thetis-runtime-review-work-repro.mjs`, local evidence).

## Senior architect recommendations

1. **Share bounded one-response socket exchanges.** [Registry client](../../lib/registry/client.ts#L11), [discovery client](../../lib/package-loader/discovery-client.ts#L10) and [provider description](../../lib/provider/client.ts#L26) repeat connection, framing, validation and cleanup logic. Their policies have diverged: registry tracks timeout expiry, discovery collapses it to I/O failure, and provider description has no deadline or pool. Extract connection lifetime, deadline, cancellation and cleanup behind a small injected transport API, with contract validation and request identity supplied by each caller. Keep streaming provider calls on a suitable streaming abstraction. This addresses DRY and dependency inversion with an observable failure-handling benefit.

2. **Give verified package caching one owner.** [Registry fetch handler](../../lib/registry/server.ts#L33), [profile delivery](../../lib/profile/delivery.ts#L14) and [bootstrap](../../lib/profile/bootstrap.ts#L46) independently implement cache lookup, fetch and hash verification with differing root/fallback checks. Bootstrap also reaches into the concrete registry's filesystem path to compact its Git backend at [line 45](../../lib/profile/bootstrap.ts#L45). Introduce one verified-cache operation and keep Git maintenance behind the registry boundary. Profile assembly can then depend on a narrow registry capability rather than backend layout details.

3. **Share requirement composition while preserving authorization boundaries.** [Work overlays](../../lib/profile/work-overlay.ts#L61) and [kernel registration requirements](../../lib/package-loader/requirements.ts#L45) independently merge manifests, retained registrations and fresh requirements/provisions before matching. Extract the pure composition with explicit inputs for the current registration set. Keep envelope checks, pin verification and final kernel authorization in their existing owners. Finding 7 demonstrates an actual failure caused by these related paths having different assumptions about when registrations are available.

## Original review validation and authorized memory change

The RSS acceptance ceiling is now **512,000,000 bytes, inclusive**, retaining the existing decimal MB convention and the same measured kernel, idle environment and sandbox descendants. [ADR 0041](../../docs/adr/0041-raise-idle-memory-ceiling.md) records the user's explicit approval. [The acceptance test](../../test/acceptance-performance.test.ts#L10), bench documentation and current README/TODO/status records reflect the change. Individual sandbox and heap limits retain their existing values.

Validation completed:

- Full offline suite **before the ceiling change:** 417 tests, **415 passed, 2 failed**, none skipped or cancelled, in 304.27 seconds. Failures were memory at 154,759,168 bytes against the former 120 MB ceiling, and work-edit latency at **1572.673659 ms against 1000 ms**. Full test log (`thetis-runtime-review-test.log`, local evidence).
- Focused memory test **after the change:** **passed**, measuring **156,164,096 bytes** against **512,000,000**. The kernel accounted for 79,720,448 bytes and the idle environment for 76,443,648. Memory test log (`thetis-runtime-review-memory.log`, local evidence).
- Execution artifact rebuild and the final strict check both **passed**. The check covers TypeScript, lint, generated contract freshness and artifact freshness. `git diff --check` is clean. Build log (`thetis-runtime-review-memory-build.log`, local evidence), final check log (`thetis-runtime-review-memory-check.log`, local evidence).
- Conformance-name inventory: **106/106**, none missing or skipped. This checks named coverage, not every clause. Inventory (`thetis-runtime-review-conformance.json`, local evidence).
- Kernel size: **1583 counted lines against 1300**, a previously documented acceptance failure.

The full suite was not rerun after the ceiling-only change; focused validation covers the changed assertion. Latency remains an outstanding failure. All defect reproductions ran in bubblewrap namespaces, with real generation processes for lifecycle findings. No vendor calls or commits were made.
