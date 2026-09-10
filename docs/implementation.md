# Implementation notes

Current implementation details and acceptance settings belong here and in their focused guides and tests. They are not architecture decisions. This page replaces the routine records listed below; their full text remains recoverable in git history before this cleanup. Record numbers are retained only to resolve existing references.

## 0022 · Context appends

Iteration hooks append only to ephemeral harness or history sections. System and skills belong to the stored prefix; changing them requires an announced refresh. See TE-009–011.

## 0024 · Tool-call history

The provider 1.1 content schema carries assistant tool calls with their ids, names and original argument bytes. Persist them before executing calls so subsequent requests and conversation reloads preserve the request/result pair.

## 0028 · Failed-target reset

An authorized reset leaves FAILED through the existing recovery transition, restores verified healthy pins and state, preserves work, and uses a fresh fenced epoch. See KS-019.

## 0031 · State validation

Bounded state-format parsing lives in lib/files. The kernel supplies the exact recorded schemas and refuses advancement unless validation succeeds.

## 0032 · Journal writing

The bounded append writer lives in lib/ndjson and the storage backend. The kernel constructs observations, chooses provenance and reserves recovery capacity.

## 0033 · Generation projection

lib/generation-state projects immutable snapshots. The kernel retains guards, transitions, effects and durable publication.

## 0034 · Secret envelopes

lib/files encodes authenticated AES-GCM byte envelopes. The kernel retains keys, scope/name binding, authorization and storage policy.

## 0036 · Compilation caches

Optional Node caches are private to each generation's bounded state. Cache misses compile normally; caches confer no authority and never replace source or artifact verification.

## 0039 · Source measurement

See the current counting rules under implementation note 0051. Documentation does not consume implementation budget.

## 0041 · Memory acceptance

The accepted aggregate idle RSS ceiling is 512,000,000 bytes for the real kernel, one idle environment and their measured descendants. Individual process limits remain separately enforced.

## 0042 · Edit latency

The accepted watched-edit limit is 2,000 milliseconds, measured from the source write through artifact generation and successful serving. The test verifies the changed behavior.

## 0043 · Crash recovery

Observe process exits exactly once and revoke their authority. Unexpected serving exits enter FAILED through the generation table. Checkpoint failures recover through the same machine. Snapshot validated migrated state before publishing a healthy generation; reset uses that generation's own format.

## 0044 · Provider accounting

Provider balances use exact decimal arithmetic. Person windows and lifetime run ceilings have distinct ledgers; trusted credential expiry governs retirement. Version-2 checkpoints migrate numeric version-1 balances without discarding unresolved spend. Final attribution and settlement precede terminal responses, including early vendor errors.

## 0045 · Dynamic provisions

If an edited dynamic provider creates a dependency gap, recapture its registration in bounded isolated discovery. Bind the result to fresh candidate pins and validate its envelope and graph before ordinary generation activation.

## 0046 · Resource retirement

Keep immutable pin digests separately from active run workspaces. After a durable LIVE checkpoint retire inactive workspaces while preserving live and previous state, undo references and legacy pin anchors. Retire ephemeral identity entries only when their owning execution closes.

## 0047 · Root imports

`@/` resolves against the importing runtime revision in source, worker and verified-artifact execution. Cross-package imports use the alias; imports inside movable packages remain relative. Reject malformed or escaping aliases.

## 0050 · Socket path lengths

Installed private generation stores use short sibling paths under `<state>/g`. The current implementation limits that root to 18 bytes to keep Unix socket addresses within 107 bytes. `/var/lib/thetis` satisfies the bound; `<state>/live` supplies stable proxy paths.

## 0051 · Kernel counting

The TypeScript parser excludes comment-only, static-import-only and whitespace-only lines, without double counting. Lines containing implementation remain counted. Report all categories and exclude tests.

## 0052 · Installed lifecycle

The installer is generated from `scripts/installer/` shell sources and canonical `units/` templates. Bootstrap verifies signed Node and release bytes, retains seed inputs, records provisioned resources and uses the selected service manager. Supervisor recovery joins serving metadata with the observed journal; the live alias preserves public addresses.

## 0053 · Deployment exports

Whole stopped deployment exports allow 65,536 entries; individual code snapshots retain 10,000. Both keep their byte and depth bounds. Relocation history is bounded to 512 entries and 65,536 bytes.

## 0054 · Kernel budget

The accepted kernel ceiling is 1,500 counted lines under note 0051. Keep authority in the kernel; do not compress code or move authority to improve the count.

## 0055 · Release delivery

Release tooling must not repeat the full CI suite. Runtime publication reuses the exact successful CI delivery, whose pins were computed from and checked against the assembled archive. Release signatures and tag identity remain mandatory; signing is isolated from candidate execution. See [CI delivery](ci-delivery.md) for the current workflow.

## Paid API tools

Tool stages can use an authenticated service connection supplied at initialization.
The registered process owns API access and cost admission. See
[tool services](tool-services.md) and [the wire contract](contracts/tool-service.md).
