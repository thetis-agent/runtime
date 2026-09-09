# ADR 0027 · Keep initialization off the environment monitor

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving TE-022
**Amends:** ADR 0002's single-event-loop implementation; ADR 0016 §4

## Context

The design imports plain TypeScript packages and requires a late init to
leave only that package inert while the environment remains healthy.
A timer on the same event loop cannot interrupt a synchronous loop in
module evaluation or init. A Promise race therefore cannot implement
TE-022 for all permitted JavaScript.

## Decision

The unprivileged environment has a small monitor on its main thread.
Its single loop and all package evaluation run in one worker thread in
that same sandboxed process. The monitor owns initialization deadlines.
The worker announces each package before importing it. If evaluation or
init fails or exceeds the probe budget, the monitor terminates the
worker, excludes that package, and initializes the remaining profile in
a fresh worker. Successful initialization is idempotent as TE-021
requires. No active conversations are admitted during this recovery.

The monitor remains responsive to health and stop throughout startup.
The excluded package's gap is retained for the next conversation boundary.
Worker messages are bounded and schema-validated. The kernel acquires no
package-loading knowledge, and every thread remains in the mandatory
environment sandbox and resource group.

## Alternatives considered

A timer around a direct import cannot interrupt synchronous JavaScript.
A worker for every package adds persistent isolates and a message hop to
every hook. A separate privileged loader would enlarge the trusted kernel.

## Consequences

Good: a stuck init cannot block the environment monitor, and the loop
still has ordinary in-process stage calls after initialization. Bad: an
init failure repeats earlier successful initialization, and one worker
adds memory and startup cost. Neither the idle-memory nor edit-to-serve
limit is waived. Initialization side effects must remain idempotent;
runtime stage code still shares the environment's authority and state.

## Revisit

If measured startup or memory cost requires a smaller mechanism that can
still interrupt arbitrary initialization without blocking health.
