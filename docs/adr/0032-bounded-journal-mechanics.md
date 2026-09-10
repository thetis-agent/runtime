# ADR 0032 · Keep journal provenance in the kernel and append mechanics in a library

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer
**Supersedes:** nothing

## Context

The kernel owns the distinction between observed and reported rows. Its
implementation also contains a generic queued file writer with byte
reservations and fsync. Functional assembly and recovery put the kernel
above its 1,500-line review threshold; generic file mechanics consume
space without contributing an authority decision.

## Decision

Move the bounded durable append writer into the existing lib/ndjson
workspace package. Keep row construction, provenance labels, recovery
reserve selection and the observed-only reader interface in the kernel.
The library accepts bytes and a byte ceiling, never a candidate's claim
to observed provenance. Keep the same fail-closed queue and fsync behavior.

## Alternatives considered

Compressing source lines conceals complexity. Moving provenance selection
would obscure the trust distinction. Keeping duplicate append mechanics
in the kernel increases the trusted review surface unnecessarily.

## Consequences

Good: the authority wrapper becomes smaller and the I/O mechanism remains
independently testable. Bad: reviewing the journal now follows one library
import. No provenance, durability, gate or boundary guarantee is lost.

## Revisit

When the journal storage format or durability primitive changes.
