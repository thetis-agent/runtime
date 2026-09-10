# Architecture decision records

One file per decision, numbered, never edited after acceptance except to
change its status. A decision that is reversed gets a new record that
supersedes the old one; the old one stays. This directory moves to the
successor repository as `docs/adr/` on day one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-typescript-over-a-compiled-language.md) | TypeScript over a compiled language | Accepted |
| [0003](0003-measure-at-the-loop.md) | Measure the harness as paired deltas at the loop, with benchmarks as packages | Rejected: admitted a judge model |
| [0004](0004-idempotent-tamper-resistant-measurement.md) | Idempotent, tamper-resistant measurement | Accepted |
| [0005](0005-environment-boundaries-enforced-by-the-host.md) | Environment boundaries are enforced by the host, through a sandbox runner | Accepted, amended by 0007 |
| [0006](0006-contracts-are-packages.md) | Contracts are packages, with a schema and a conformance test | Accepted, amended by 0007 |
| [0007](0007-skills-as-data-and-the-context-prefix.md) | Skills packs are data; context has core-ordered sections; the pin covers the prefix | Accepted; §8 superseded by 0008 |
| [0008](0008-embeddings-are-a-service.md) | Embeddings are a service, not part of the host's door | Accepted |
| [0009](0009-secrets-have-scope.md) | Secrets have a scope, and the door resolves them by caller | Accepted |
| [0010](0010-notices-lifecycle-and-the-tool-path.md) | Notices between turns, the stage lifecycle, and the tool path | Accepted |
| [0011](0011-providers-are-stream-adapters.md) | Providers are stream adapters behind the door | Accepted |
| [0012](0012-generations.md) | Generations: how anything shared changes, and how it recovers | Accepted |
| [0013](0013-the-stored-prefix.md) | The stored prefix replaces the perpetual pin | Accepted; supersedes 0007 §5, 0010 §4 |
| [0014](0014-observed-versus-reported.md) | Observed versus reported, the evaluator, and the gate | Accepted; amends 0004 |
| [0015](0015-identity-namespaces-and-contract-trims.md) | Identity, package namespaces, registry changes, and contract trims | Accepted; amends 0006, 0010 |
| [0016](0016-registration-at-initialization.md) | Configuration is a contract; a package registers at initialization within a declared envelope | Accepted; amends 0010 |
| [0017](0017-the-kernel.md) | The host is a kernel: what stays, what is delegated | Accepted; §3 amended by 0018 |
| [0018](0018-identity-and-the-act.md) | The kernel needs identity and the act, not auth and approvals | Accepted |
| [0019](0019-no-door.md) | No door: keys live on providers, usage is formless counters | Accepted; §4–5 corrected by 0020 |
| [0020](0020-budgets-in-band.md) | Budgets are enforced in-band by the provider; `cost` is a reserved counter | Accepted |
| [0021](0021-explicit-descriptor-forwarding.md) | Deliberate descriptor delegation shares the run principal | Accepted by the operator |
| [0022](0022-ephemeral-context-sections.md) | Keep iteration context appends outside the stored prefix | Accepted |
| [0023](0023-fenced-rollback.md) | Recover fenced generations without reviving credentials | Accepted |
| [0024](0024-tool-call-history.md) | Preserve assistant tool calls as normalized content | Accepted |
| [0025](0025-fence-before-repoint.md) | Persist commitment intent and fence before repointing | Accepted |
| [0026](0026-probe-without-shared-writes.md) | Probe without shared writable grants | Accepted |
| [0027](0027-isolate-initialization-from-the-environment-monitor.md) | Keep initialization off the environment monitor | Accepted |
| [0028](0028-reset-failed-generations.md) | Reset failed targets through the generation table | Accepted |
| [0029](0029-private-network-egress.md) | Configure egress inside the mandatory network namespace | Accepted |
| [0030](0030-replay-recovery-before-admission.md) | Replay recovery before admitting a restarted target | Accepted |
| [0031](0031-shared-state-format-mechanics.md) | Keep state-format mechanics in the shared files package | Accepted |
| [0032](0032-bounded-journal-mechanics.md) | Keep journal provenance in the kernel | Accepted |
| [0033](0033-generation-snapshot-projection.md) | Separate snapshot projection from transition authority | Accepted |
| [0034](0034-sealed-envelope-mechanics.md) | Separate authenticated byte envelopes from secret authority | Accepted |
| [0035](0035-separate-development-repositories.md) | Review separate repositories in the installed directory layout | Accepted |
| [0036](0036-generation-local-compile-caches.md) | Keep optional Node compilation caches inside generation state | Accepted |
| [0037](0037-verified-javascript-execution-artifacts.md) | Verify JavaScript execution artifacts alongside TypeScript sources | Accepted by the operator |
| [0038](0038-per-person-public-sockets-and-session-whois.md) | Per-person public sockets for the web surface, and `session.whois` | Accepted by the operator |
| [0039](0039-exclude-comment-only-kernel-lines.md) | Exclude comment-only lines from the kernel size budget | Accepted by the operator |
| [0040](0040-storage-contract-and-default-file-backend.md) | Storage contract and default file backend | Accepted by the operator |
| [0041](0041-raise-idle-memory-ceiling.md) | Allow 512 MB for the kernel and one idle environment | Accepted by the operator |
| [0042](0042-allow-two-second-work-edits.md) | Allow two seconds for a watched work edit to serve | Accepted by the operator |
| [0043](0043-observe-exits-and-recover-interrupted-freezes.md) | Observe process exits and recover interrupted freezes | Accepted |
| [0044](0044-exact-provider-budget-lifetimes.md) | Preserve exact provider budgets for their proper lifetimes | Accepted |
| [0045](0045-recapture-dynamic-work-provisions.md) | Recapture dynamic provisions for work edits | Accepted |
| [0046](0046-retire-generation-resources.md) | Retire generation resources when their authority ends | Accepted |

## Decisions in the register that still need a record

The decision register in [../05-successor.md](../05-successor.md) holds
twenty decisions with one-line reasons. Each becomes a record when its
consequences are first felt, in this order of likely need.

| Register row | Record to write |
| --- | --- |
| D2, D3 | Releases as the unit of change; semver as the dependency graph |
| D8 | One namespace of requirements and provisions; git registries pinned by commit |
| D6 (kinds) | Stages over turn events instead of package kinds |
| D15 | The LLM door in the host |
| D11, D13 | The default moves only by a reviewer's act |
| D1 | The loop as the only fixed thing, itself a package |
