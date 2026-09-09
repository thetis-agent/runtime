# Design exercise · three skill packages

Requested by the operator on 2026-09-09: design three packages that each
solve skill attachment differently, as a test of the proposal's event
model, requirements and contracts. Each was designed by a separate
Fable 5.1 subagent working from the proposal and the decision records,
told to make the minimum decision wherever the proposal was
under-specified, mark it, and report it as a finding.

| Package | Approach | Document |
| --- | --- | --- |
| `skills-all` | every skill attached to the system prompt; no retrieval | [skills-all.md](skills-all.md) |
| `skills-l1` | Anthropic's open Agent Skills design: name and description always present, the body loaded by a tool the model calls | [skills-l1.md](skills-l1.md) |
| `skills-thetis` | Thetis's matcher: BM25 plus embeddings with fusion, briefs pinned per conversation, bodies pulled on demand | [skills-thetis.md](skills-thetis.md) |

[comparison.md](comparison.md) designs the paired benchmark that ranks
them under ADR 0004, and [findings.md](findings.md) collects what the
exercise found wrong or missing in the proposal.


Outcome: ADR 0007, which amends 0005 and 0006, then ADR 0008, which moves embeddings off the host's door into a service, and changes to proposal
chunks 2, 3, 6, 10 and rules 7, 9 and 14.

## Second exercise · three tool packs

Requested by continuation on 2026-09-09. Three packages that expose
tools three ways, to force the `offer` and `call` shapes, the read-only
rule, spill, the sandbox and scoped secrets into a written contract.

| Package | Approach | Document |
| --- | --- | --- |
| `tools-files` | in-process file tools over the three spaces, with spill | [tools-files.md](tools-files.md) |
| `tools-mcp` | a client to an external MCP server, with a per-person token | [tools-mcp.md](tools-mcp.md) |
| `tools-terminal` | stateful shell sessions inside the sandbox | [tools-terminal.md](tools-terminal.md) |

[contract-turn-events.md](contract-turn-events.md) is the first written
draft of `contract/turn-events`, reconciled from both exercises, and
[findings-tools.md](findings-tools.md) the reconciled findings.


## Thought experiment · RAG on every message, and MCP, as packages only

Asked by the operator on 2026-09-09: with no change to the core, the
host or the environment, can these be added as packages?

**RAG, yes.** A `context` append-hook stage reads the latest message from
`history`, queries an index built in `init` from the spaces and kept in
`state/`, and appends passages to `harness`, after the stored prefix so
the cache holds. Ranking is BM25 in process or `service/embed` from
another package. Or a `search_docs` tool, letting the model decide. It
found one hole, now fixed in `contract/turn-events`: nothing said a
`context` append was ephemeral. It also found a naming trap: `retrieve`
is the skills singleton and runs on turn 1 only; a RAG author will reach
for it first.

**MCP, yes for a stdio server with a static token**, as `tools-mcp.md`
designed it, including sampling (a stage may require `service/llm` and
call the door). **No for a hosted server behind OAuth** until the host
has a secret kind that exchanges and refreshes (ADR 0010 §10). **Yes as one generic connector** since ADR 0016: the
package declares an envelope (`secret/mcp-*`, `service/mcp-*`, egress)
and registers one concrete set per configured server at `init`.


## Thought experiment · the full call chain in a gateway

Asked by the operator on 2026-09-09: can a gateway show the provider
request, each tool request and response, the streams and the model's
thinking, as Thetis's web UI did?

Three gaps, all in the contracts and none in the kernel, fixed as minor
versions: an `observe` hook on every event for any stage, since `call`
and `offer` were visible only to their actors; `model.begin`,
`model.event` and `model.end` emitted by the core with the normalized
exchange, since after ADR 0019 the model call was not an event;
`delta.reasoning` and a `reasoning` content kind with an opaque vendor
payload kept in history and passed back. Persistence is a `trace`
package that observes and writes to the person's space. One policy
line: a role may be allowed to observe another person's conversations.
What a gateway will not get, by design: the vendor's wire bytes.


## Implementation designs

| Document | What it fixes |
| --- | --- |
| [evaluator.md](evaluator.md) | the evaluator package: manifest, the suite on disk, a run, seeds, two sandboxes, results, rotation, findings to regressions, its conformance |
| [generations.md](generations.md) | the generation state machine: states, transitions, guards, invariants, per-target apply and probe, failure edges, its conformance |
