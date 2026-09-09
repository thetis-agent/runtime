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
