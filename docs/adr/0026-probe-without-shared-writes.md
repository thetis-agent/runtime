# ADR 0026 · Probe without shared writable grants

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving the frozen-state boundary
**Amends:** ADR 0012; design/generations PROBING and SWITCHING effects

## Context

The design starts a private candidate and makes that same process live by
renaming its endpoint. It also forbids shared writes between FROZEN and
SWITCHING. A private endpoint does not stop candidate initialization from
writing a shared work directory mounted read-write. Bubblewrap fixes its
mount grants at launch; promoting read-only grants in the existing process
would require retaining a separate mount-privileged mechanism.

## Decision

Migrations and the initial probe receive shared writable grants as
read-only. Only the isolated state copy and private endpoint directory are
writable. After the durable SWITCHING intent and fence, the supervisor
stops that probe process, revokes its credential, and starts the serving
process with the same verified pins and migrated state plus the ordinary
shared grants. The serving process receives a fresh credential in the
committed epoch and must pass another bounded health probe before the
endpoint is repointed. Both launches occur through the generation machine
and mandatory runner. Failure uses fresh-epoch recovery under ADR 0025.

## Alternatives considered

Give the initial probe shared write access: loses the frozen-state
guarantee. Trust init to avoid writes: makes the boundary a convention.
Retain a privileged namespace mount helper: adds a second mechanism and
more trusted code to support promotion of one process.

## Consequences

Good: the mandatory runner remains the sole launch mechanism and a probe
cannot mutate shared work before SWITCHING. Bad: a switch pays for two
starts and initialization must remain idempotent as TE-021 requires. The
probe process's identity is not preserved into serving. The subsecond
edit-to-serve requirement still applies and must be measured; this record
does not waive it or weaken a boundary, secret rule, gate or act.

## Revisit

If a smaller, reviewed mount-promotion mechanism becomes available and
retains the same isolation and credential guarantees.
