# ADR 0030 · Replay recovery before admitting a restarted target

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving generation fencing
**Supersedes:** nothing; extends ADR 0025

## Context

The generation machine records durable snapshots and commitment intent but
does not define an event for restarting its trusted supervisor. Starting
again at generation one can revive an old epoch and discard committed pins.
The existing transition table cannot express recovery from an idle LIVE
checkpoint without pretending a new release was requested.

## Decision

Add an authorized `restart` transition from every state except FAILED to
ROLLING_BACK. Rehydrate the machine only from its observed journal. Record
restart intent, retain the last verified revision and state checkpoint,
consume a fresh epoch above both recorded generations, and probe before
publishing the recovered endpoint. FAILED continues to require reset.
Persist neutral revision checkpoints before publishing initial or changed
endpoints; never persist resolved secrets or inherited tokens. Refuse
recovery when the checkpoint and observed journal cannot be reconciled.

## Alternatives considered

Starting at one loses the fence. Treating restart as an ordinary switch
misstates its authority and cannot represent interrupted switches. Reusing
an idle epoch makes stale run identifiers ambiguous across supervisor lives.

## Consequences

Good: restart preserves pins and the conservative fence without admitting
an unprobed process. Bad: a supervisor restart consumes a generation even
when no release changed, and incomplete recovery metadata stops the target.
No boundary, secret rule, gate or act is removed.

## Revisit

When a future persistent supervisor can retain both process ownership and
credential admission atomically across a kernel upgrade.
