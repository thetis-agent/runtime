# ADR 0017 · The host is a kernel: what stays, what is delegated

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Amends:** every earlier record's use of "the host"; the proposal's chunk 11

## Context

The trusted process was called "the host" through eight drafts. After
the Codex debate it holds auth, registries, the door, environments, the
sandbox runner, a secret store, generations, an approval page and a
CLI, and my honest estimate had grown from 1,400 lines to about 3,000.
The operator asked whether it could be cut into packages and reduced.

The post-mortem's central finding was that Thetis's kernel did too
much. The question is therefore which parts of the trusted process are
trusted because they must be, and which are there because nobody moved
them.

## Decision

1. **The trusted process is the kernel.** The loop stays `core`; it is
   unprivileged. "Thetis's kernel" always names the old binary.
2. **The rule for what stays:** a part stays in the kernel only if
   delegating it would lose a guarantee that rests on the kernel being
   the one that does it. Everything else is a package at deployment
   scope, reviewed and sandboxed like any other, reaching authority
   through a narrow kernel call. Kernel calls are the unit of
   delegation: small, named, and listed in `contract/kernel-socket`.
3. **What stays, and why:**

   | Part | Why it cannot be delegated | Budget |
   | --- | ---: | ---: |
   | auth: identity, roles, bindings, project membership | the thing that says who someone is cannot be a package a person can replace | 300 |
   | the boundary: the socket, per-run tokens, the runner interface and its one adapter | the fence cannot be inside the yard (ADR 0005) | 500 |
   | secrets: the store, resolution by scope, delivery at spawn, the page that sets them | a secret must never pass through rewritable code (ADR 0009) | 200 |
   | the door: key, meter, limits, routing to a provider, the observed log row | metering and the key are what a person must not control (ADR 0011, 0014) | 300 |
   | generations: install by pinned hash, snapshot with writers stopped, compare-and-swap on the default, switch, restore | the one writer of shared truth (ADR 0012) | 400 |
   | the approval page and the evidence-identity check behind the button | no rewritable code in the path of the one act that matters (ADR 0014) | 200 |

   About 1,900 lines. That is the floor, set by authority rather than
   taste, and it is where the first draft's estimate was.
4. **What is delegated, as packages at deployment scope:**

   | Package | What it does | The kernel call it uses |
   | --- | --- | --- |
   | `registries` | fetch from the list, resolve requirements with semver, store a publish in the deployment's registry, search for a provider for a gap message | `install(name, version, hash)`: the kernel verifies the hash against the pin before anything is extracted, so a wrong resolver can mislead review but cannot install wrong bytes |
   | `cli` | `env reset`, `default set`, `user add`, status and logs | the same socket methods the pages use, with an administrator's token |
   | `snapshots` | retention and pruning of space and state snapshots, the seven-day window | `snapshot(target)` and `prune(id)`; the taking of a snapshot inside a generation switch stays in the kernel because it needs writers stopped |
   | `metrics` | the log query surface and the metrics page | read access to the observed log |
   | `evaluator` | already a package (ADR 0014) | result submission with identities |
   | providers, gateways, retrievers | already packages | — |

5. **Registration at `init` (ADR 0016) applies to these packages** as to
   any other; their envelopes are reviewed like anyone's, and a
   deployment can swap its `registries` package the way it swaps a
   retriever.

## Alternatives considered

**Leave it as one process and call it the host.** Lost: the growth was
real and the rule that stops it did not exist.

**Delegate auth or the door too.** Lost: both are the guarantee, not a
service; a package that decides identity or meters its own spend is the
thing every other record forbids.

**Rename `core` to kernel.** Lost: the loop holds no authority and the
word would say it does.

## Consequences

Good: the kernel has a rule for its own size; three parts leave it;
`registries` becomes swappable; the microkernel shape makes the
delegation surface a listed contract rather than a growing binary,
which is the exact opposite of Thetis's kernel.

Bad: one more socket hop for registry operations at publish and
install, off the turn path; four small deployment-scope processes
where there was one; the kernel calls must be written with the same
tolerance and change classes as every contract.

## Revisit

When a kernel part exceeds its budget by half, ask which guarantee it
holds; if none, it is a package.
