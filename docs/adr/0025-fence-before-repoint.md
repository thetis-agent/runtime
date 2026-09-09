# ADR 0025 · Persist commitment intent and fence before repointing

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving generation fencing
**Amends:** ADR 0023; design/generations healthy and repointed effects

## Context

The design repoints the endpoint atomically and then fences the old run
credentials. A filesystem rename and an in-memory credential fence cannot
be one atomic operation. Repointing first leaves an interval in which new
connections reach the candidate while old credentials still authorize new
calls. Recording commitment only after rename also makes a crash during
that interval indistinguishable from a switch that never committed.

## Decision

The durable transition into SWITCHING records commitment intent. Its
effects adopt the isolated state copy and advance the credential fence
before the endpoint rename begins. The repointed transition requires the
intent and successful atomic rename; it routes the new generation without
another fence. Recovery from SWITCHING or later conservatively follows
ADR 0023 and consumes a fresh number, even if failure occurred before the
rename or before the fence itself completed. Replay treats that durable
intent as potentially committed and never reactivates either prior epoch.

## Alternatives considered

Rename first: leaves the credential interval above. Undo a fence if rename
fails: revives delegated credentials. Add a separate transactional store
for filesystem routing and credentials: still cannot atomically change
kernel socket inodes and does not remove the need for recovery intent.

## Consequences

Good: old credentials are unusable when the new endpoint becomes visible,
and recovery has a durable conservative decision. Bad: a failed switch
may consume an additional number and briefly refuse old calls before the
endpoint moves. Unchanged-number rollback in that narrow interval is the
behavior lost; no boundary, secret rule, gate or act is weakened.

## Revisit

If endpoint routing and credential admission share a genuinely atomic
primitive in a later implementation.
