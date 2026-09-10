# ADR 0045 · Recapture dynamic work provisions before resolving consumers

**Status:** Accepted · 2026-09-10
**Deciders:** operator (reviewed P1/P2 fixes); implementation session
**Amends:** ADR 0016's work-edit admission sequence
**Supersedes:** nothing

## Context

A work edit changes its package's pin hash. Correctly discarding the old
hash-bound registration removes any provisions declared only during initialization.
Resolving unchanged consumers before obtaining a fresh registration therefore
rejects even a comment-only producer edit. The ordinary private generation probe
registers packages individually and cannot necessarily resolve a graph containing
several such missing providers on its first registration.

## Decision

Keep ordinary work edits on the existing generation-probe path. If preflight
reports a dependency gap and an edited package's envelope permits dynamic
provisions, capture initialization in the existing disposable discovery process.
Use fresh empty state, verified candidate pins, no shared mounts, no network and
no secret store. The injected in-process launcher starts only this auxiliary
runtime; it does not invoke the deployment boot/orphan-reaping entry point.

Validate captured source identities, envelopes and the complete dependency graph,
then bind accepted registrations to the candidate pin hashes. Only the existing
generation driver may activate the candidate. Its private probe still verifies
the actual registrations, service declarations, pins and initialization health.
Missing or invalid provisions remain refusals; stale registrations never acquire
a new hash without fresh capture. Share pure manifest/registration composition
between preflight and kernel-side requirement checks.

## Alternatives considered

Keeping stale claims would remove pin binding. Launching discovery for every edit
adds avoidable work to ordinary static edits. Atomic multi-package registration
could let the normal probe recapture the full graph, but requires a new socket
operation and changes unrelated initialization callers. None is needed for this
targeted correction.

## Consequences

Valid dynamic-provider edits can reach activation while static edits keep their
existing path. Dynamic recapture adds a bounded auxiliary process only when the
existing metadata cannot resolve the candidate. No kernel authority, isolation,
secret, pin, probe or generation guarantee is removed.

## Revisit

When dynamic-profile edits need the same latency as static edits, consider an
atomic registration operation with equivalent kernel validation.
