# ADR 0033 · Separate generation snapshot projection from transition authority

**Status:** Accepted · 2026-09-09
**Deciders:** this session
**Supersedes:** nothing

## Context

The proposal puts generation authority in a small kernel. Production assembly,
recovery and maintenance pushed that kernel beyond its 1,500-line review limit.
Immutable history projection itself neither authorizes a transition nor applies
an effect; it is also the representation consumed by durable recovery.

## Decision

Move pure generation snapshot projection into `lib/generation-state`, deriving
its structural types from the persisted snapshot schema. Keep the transition
table, guard evaluation, serialization, observed journal commit and publication
of the resulting state in the kernel. The helper cannot mutate the source view,
write a row, admit a request or launch a process.

## Alternatives considered

Compressing kernel lines conceals complexity. Moving transition selection or
guards would move authority and weaken the kernel boundary. Keeping the pure
projection in the kernel spends the review budget on shared format mechanics.

## Consequences

The kernel becomes smaller without losing a guarantee. The cost is a shared
module dependency whose behavior remains covered by every generation transition
and recovery test. No state change becomes possible without the kernel's
observed transition commit.

## Revisit

Revisit if projection acquires I/O, policy decisions or executable effects.
