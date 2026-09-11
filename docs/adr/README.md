# Architecture decision records

Use an ADR only for a major architectural choice: a change to system structure, trust or isolation boundaries, execution, or persistence that needs substantial cross-component redesign to reverse.

Features, bug fixes, refactors, defaults, dependency updates, workflows and budget adjustments belong in the relevant guide, tests and pull request. A repeated question or a day's work is not sufficient reason for an ADR. Routine records have been consolidated into [implementation notes](../implementation.md); git retains their history.

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
| [0023](0023-fenced-rollback.md) | Recover fenced generations without reviving credentials | Accepted |
| [0025](0025-fence-before-repoint.md) | Persist commitment intent and fence before repointing | Accepted |
| [0026](0026-probe-without-shared-writes.md) | Probe without shared writable grants | Accepted |
| [0027](0027-isolate-initialization-from-the-environment-monitor.md) | Keep initialization off the environment monitor | Accepted |
| [0029](0029-private-network-egress.md) | Configure egress inside the mandatory network namespace | Accepted |
| [0030](0030-replay-recovery-before-admission.md) | Replay recovery before admitting a restarted target | Accepted |
| [0035](0035-separate-development-repositories.md) | Review separate repositories in the installed directory layout | Accepted |
| [0037](0037-verified-javascript-execution-artifacts.md) | Verify JavaScript execution artifacts alongside TypeScript sources | Accepted by the operator |
| [0038](0038-per-person-public-sockets-and-session-whois.md) | Per-person public sockets for the web surface, and `session.whois` | Accepted by the operator |
| [0040](0040-storage-contract-and-default-file-backend.md) | Storage contract and default file backend | Accepted by the operator |
| [0048](0048-supervised-kernel-service-and-installed-layout.md) | Supervised kernel service and the installed layout | Accepted by the operator |
| [0049](0049-pre-authorised-kernel-updates.md) | Pre-authorised kernel updates for fixes and improvements | Proposed: stops for the operator |
| [0050](0050-the-act-from-a-package-page.md) | The act may be driven from a package page | Accepted by the operator |
| [0051](0051-a-panel-may-answer.md) | A contributed panel may act, within a declaration | Proposed |
| [0052](0052-a-conversation-with-more-than-one-person.md) | A conversation with more than one person | Proposed: not built |
