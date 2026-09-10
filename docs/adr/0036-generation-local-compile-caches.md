# ADR 0036 · Keep optional Node compilation caches inside generation state

**Status:** Accepted · 2026-09-09
**Deciders:** implementation session
**Supersedes:** nothing

## Context

Both launches required by ADR 0026 repeatedly strip the same TypeScript and
compile the same module graph. Schema tuning alone still measured approximately
two seconds from a work edit to serving. Node 24.18 supports a compilation cache
for TypeScript as well as JavaScript, without replacing direct source execution.

## Decision

Enable Node's optional module cache beneath a sandbox's writable, bounded working
directory. Its bytes belong to that generation's state and existing filesystem
quota. Read-only probes may write only their isolated state copy, never shared
grants. Flush the loop's startup cache before declaring it ready, so the fresh
serving process can reuse it after commitment. Node still checks source content
and runtime compatibility; a miss recompiles the source normally.

Never mount this cache into the kernel or another principal. It carries no
runtime values, provider responses, credentials or conversation context. It is
not publication evidence, a replacement for pinned-source verification, or a
reason to skip a probe. A full or unavailable cache cannot grant more space or
authority. No pre-transpiled application distribution or new dependency is added.

## Alternatives considered

Sharing one host cache crosses trust scopes. Reusing the probe as the serving
process loses the read-only boundary. Increasing the one-second threshold hides
the failure. Changing languages or adding a mandatory transpilation step revisits
the selected execution model before measuring its built-in cache.

## Consequences

Good: unchanged modules can avoid repeated parsing without changing the generation
machine. Bad: cache files consume state quota and snapshot time; cold launches
still compile normally. Neither the latency nor memory requirement is waived.

## Revisit

If cache storage materially increases snapshot costs or cannot deliver the
required measurements. Node's cache is an implementation detail, not a contract.

Reference: [Node 24.18 module cache](https://nodejs.org/download/release/v24.18.0/docs/api/module.html#module-compile-cache).
