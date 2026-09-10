# ADR 0042 · Allow two seconds for a watched work edit to serve

**Status:** Accepted · 2026-09-10; explicitly approved by the operator
**Deciders:** the operator
**Amends:** proposal §10, ADR 0002 and ADR 0041's edit-latency statement
**Supersedes:** the subsecond edit-to-serve ceiling only

## Context

The real watched-edit acceptance test recently measured about 1.57 seconds.
During the runtime review the operator instructed: "Edit latency can be 2s.
Proceed with the fixes across P1s and P2s."

## Decision

Accept watched work edits becoming available in at most 2,000 milliseconds.
Keep measuring the full interval from writing the source file through the work
watcher and successful generation switch, and verify the edited implementation
through the real deployment. Keep the mandatory process sandbox and the same
acceptance workload. The executable benchmark reports and enforces this limit.

The accepted aggregate idle-RSS ceiling remains 512,000,000 bytes under ADR 0041.
This decision does not change generation, authority, storage or kernel-size
requirements.

## Alternatives considered

Retaining the subsecond threshold conflicts with the operator's allowance.
Removing timing assertions or timing only part of the switch would stop testing
the requested behavior.

## Consequences

The acceptance gate now reflects the approved latency budget. Edits may take
longer than the original design target, and historical measurements remain
comparable because the workload and measured interval are unchanged.

## Revisit

When the operator changes the latency budget or the acceptance workload changes.
