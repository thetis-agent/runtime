# ADR 0043 · Observe process exits and recover interrupted freezes

**Status:** Accepted · 2026-09-10
**Deciders:** the operator, authorizing the runtime review fixes; implementation session
**Amends:** ADR 0012, ADR 0028 and ADR 0030; generation failure handling

## Context

A checkpoint failure after recording FROZEN returned without restoring the
stopped writers. The target then refused both turns and reset. An unexpected
process exit also left its generation LIVE, retained its credential, and omitted
the observed exit until an explicit stop. Reset after a migrated generation
additionally needs that generation's healthy state, rather than its predecessor's
pre-migration snapshot.

## Decision

Observe every sandbox process exit and complete descriptor closure, credential
revocation, resource cleanup and one durable exit observation exactly once.
Expected stops remain owned by their active generation transaction. Unexpected
serving exits wait for that transaction to settle and, if still current, enter
FAILED through an explicit guarded `crashed` transition. FAILED refuses admission
and permits the existing authorized reset under a fresh fenced epoch. This
bounded failure path does not introduce an automatic restart loop.

Recover failures after the switch has begun through the generation machine,
including checkpoint failures following QUIESCING and FROZEN. A QUIESCING failure
uses the existing authorized restart edge and restores a fresh fenced epoch;
later failures use rollback. Failed recovery stops the target and records FAILED,
so repairing storage leaves the documented reset operation available.

Record each fresh recovery epoch through a guarded `recovering` transition in
ROLLING_BACK before fencing. Its candidate retains the healthy pins and snapshot
being restored, and restoration adopts that reserved candidate exactly. A failed
attempt therefore remains visible to the next reset or supervisor restart.
When LIVE has already been recorded, adopt the corresponding process and pins
before handling a following checkpoint failure; stop that adopted generation
and expose FAILED rather than attempting a rollback from LIVE.

Stop a successful private probe and snapshot its validated migrated state before
recording healthy. Bind that snapshot to the candidate generation. Undo retains
the predecessor's frozen snapshot, while crash reset restores the current
generation's own healthy format and pins together.
The initial generation likewise freezes and snapshots its successfully probed
state before publishing LIVE. Recovered starts restore that format without
rerunning the migration that produced it.

## Alternatives considered

Leaving a crashed or frozen target LIVE preserves an unusable readiness claim.
Restarting directly from an exit listener bypasses generation authority and can
create an unbounded crash loop. Reusing pre-migration state with new pins cannot
restore a valid generation. Ignoring checkpoint errors would publish authority
without durable recovery metadata.

## Consequences

Good: every exit revokes authority and is observed; interrupted switches either
restore service or expose reset; migrated generations retain a usable healthy
snapshot. Bad: recovery after an interrupted quiesce consumes a fresh epoch, and
capturing the stopped private probe adds bounded snapshot work to a switch.
Existing scope, fencing, journal and reset guarantees remain in force.

## Revisit

When reviewed restart policies and a bounded deployment circuit breaker are
implemented through the same generation transitions.
