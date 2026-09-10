# ADR 0028 · Reset a failed target through the generation table

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation session, preserving the specified reset guarantee
**Amends:** design/generations.md, the transition table

## Context

The design offers `env.reset` after FAILED and KS-019 requires restoration
of the last healthy generation while preserving `work/`. Its transition
table has no outgoing edge from FAILED. Reset cannot be implemented with
that table without changing state outside the sole transition function.

## Decision

Add an authorized `reset` edge from FAILED to ROLLING_BACK. Restore the
last healthy pinned revision and verified state snapshot through the
existing private preparation and probe path. Fence to a fresh generation
before serving, including when the original failure preceded commitment.
Record reset and restoration as observed transitions. Leave independently
mounted `work/` unchanged. A live reset uses the same transaction with the
last retained healthy revision, or the current revision if none precedes it.

## Alternatives considered

A separate restart path loses the single-machine guarantee. Reusing the
old generation number could revive credentials and loses fencing. Leaving
FAILED terminal loses the promised recovery operation.

## Consequences

Good: the specified recovery operation has an explicit guarded transition.
Bad: one additional edge and guard case require conformance coverage. No
boundary, secret, gate, act, or fencing guarantee is removed.

## Revisit

When the design publishes an explicit reset or crash-recovery transition.
