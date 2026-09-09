# ADR 0008 · Embeddings are a service, not part of the host's door

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Supersedes:** ADR 0007 §8 (`contract/llm` gaining `embed`)

## Context

The design exercise's port of Thetis's matcher needed dense embeddings,
and Thetis had fetched them from the provider with the same key the
completions used. Since the host's `llm` door is the only holder of a
provider key, the port put `embed` on the door. The operator asked what
that solved that the stages could not, and why the host should know.

Embeddings solve one thing: ranking a corpus too large for the prompt
without spending prompt tokens on it. That is a retriever's concern.
The host's door exists for what only the host can do for the
conversation model: hold its key, place the cache breakpoints, meter
spend, write the log row. An embedding model is none of those. Putting
it on the door privileges one retrieval technique and makes the host
change when a retriever's needs change, which is the rule the whole
design exists to avoid.

## Decision

1. `contract/llm` has `complete` only. The door does not embed.
2. An embedding model is `service/embed` under `contract/embed`, provided
   by a package: a local model run as a `deployment`-scope `spawn` with
   no key, or a provider-backed service that requires `secret/<key>`
   and receives it at spawn, never in an environment's process.
3. A retriever that wants embeddings declares `requires: { service/embed:
   "^1" }` and works without it if it can; `skills-thetis` falls back to
   BM25 alone. The gap message names a provider in the registries.
4. Spend on a provider-backed embedding service is not metered by the
   door. The host issued the secret to that service and lists it on the
   metrics page as unmetered external spend; a deployment that wants
   the number runs a local embedding model, which costs nothing.
5. The bench row records which `service/embed` provider, if any, was in
   the profile.

## Alternatives considered

**`embed` on the door, metered.** Lost: the host would then know a
second model kind, and every other model kind (reranker, image, speech)
would follow it in.

**A generic metered egress on the door.** Lost: it is a proxy for
arbitrary vendors inside the trusted process; the secret mechanism
already delivers a key to a sandboxed service without that.

## Consequences

Good: the door stays one thing; retrieval technique is a package
choice; a local embedding model is the default path and is free.

Bad: provider-backed embedding spend is invisible to the meter in the
first version; a second contract package exists.

## Revisit

If unmetered external spend on the metrics page becomes a real number,
add per-secret metering at the sandbox's network boundary, not on the
door.
