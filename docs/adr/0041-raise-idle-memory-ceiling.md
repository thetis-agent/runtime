# ADR 0041 · Allow 512 MB for the kernel and one idle environment

**Status:** Accepted · 2026-09-10; explicitly approved by the operator
**Deciders:** the operator
**Amends:** proposal §10 and ADR 0002's idle-memory target
**Supersedes:** the 120 MB aggregate idle-RSS ceiling only

## Context

The acceptance test measures the real kernel plus one idle environment and its
sandbox descendants. Recent measurements around 155 MB exceed the original
120 MB target. During the runtime review, the operator explicitly instructed:
"Memory is allowed to go up to 512MB; raise the ceiling as well".

## Decision

Accept aggregate idle RSS up to and including 512,000,000 bytes, using the
existing decimal MB convention. Keep the same measured processes, cold-start
setup and mandatory sandbox. The acceptance test and `scripts/bench.ts` enforce
this ceiling and continue reporting the measured bytes.

The edit-to-serve ceiling remains under 1,000 milliseconds. Individual sandbox
cgroup limits, heap settings, storage quotas, kernel line budget and all
authority and generation guarantees retain their existing settings. This is an
explicitly approved change to memory acceptance, not milestone acceptance.

## Alternatives considered

Keeping 120 MB conflicts with the operator's approved allowance. Removing the
memory assertion would lose the requested ceiling. Changing which processes
are measured would make earlier measurements incomparable.

## Consequences

Good: the executable gate reflects the operator's memory budget while retaining
a real, bounded measurement. Bad: accepted idle deployments may consume more
memory than the original design allowed. Historical measurements and accepted
records remain intact; current acceptance documents cite this amendment.

## Revisit

When measured deployment capacity or the operator's memory budget changes.
