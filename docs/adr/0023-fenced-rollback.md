# ADR 0023 · Recover fenced generations without reviving credentials

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving the accepted boundary
**Amends:** ADR 0012 §2; design/generations rollback transition

## Context

The design says that any failure after FROZEN restores LIVE(g). It also
requires monotonic generation numbers and permanently fences g's tokens
when the endpoint switches. If recovery after that switch reused g's
number, either its process could not receive usable credentials or old
credentials would become usable again. Restoring pins and state cannot
restore the credential epoch.

## Decision

Before endpoint commitment, rollback restores g unchanged. After endpoint
commitment, rollback restores g's pins and verified snapshot under a fresh
number greater than both g and the failed candidate. Recovery fences the
failed candidate as well. The transition records the recovered number;
old and failed-candidate credentials remain refused. The state machine
still owns every change, and recovery still requires a successful probe.

## Alternatives considered

Reset the token fence to g: loses the boundary for delegated credentials.
Keep g's number but bypass fencing for recovery: creates a second
credential mechanism and makes the number cease to identify a run epoch.
Refuse all rollback after commitment: loses automatic recovery.

## Consequences

Good: recovery retains the pins, snapshot, monotonicity and credential
boundary. Bad: rollback after commitment consumes a number and the
recovered generation is not numerically identical to g. That numeric
identity is the only design behavior lost; no boundary, secret rule,
gate or act is weakened.

## Revisit

If generation identity and credential epochs become explicitly separate
concepts in a later accepted design.
