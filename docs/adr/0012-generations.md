# ADR 0012 · Generations: how anything shared changes, and how it recovers

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, from the Codex debate (review/debate.md: A2, A6, F1, F5, F6, F12, F13, F14, S10)
**Amends:** ADR 0005 §7 (breaker), 0007 §7, 0010 §5; proposal chunks 6, 8, 9, 10

## Context

"The environment restarts at the next turn boundary" was undefined with
two conversations open. "The pins move" did not say what happens to a
migration already applied, to a second reviewer pressing the button
against a stale baseline, to a person whose environment cannot start, or
to the host's own upgrade. Undo restored code against migrated state.
Quotas covered a person's directories and not the pools everyone
shares.

## Decision

1. **A generation is the unit of change for anything shared:** a
   person's environment, a deployment-scope process, the default
   profile, and the host itself. A generation is the resolved pins plus
   a state snapshot taken with writers stopped.
2. **Every switch is one transaction:** stop admitting turns; drain the
   active turns under a deadline; snapshot; apply (install, migrate);
   start the new generation and probe it; switch the host-owned
   endpoint; drain the old under a deadline; stop it. A failed probe
   restores the previous generation, pins and state together. The old
   run's socket token is fenced at the switch.
3. **The default moves by compare-and-swap** on its generation number.
   Evidence is bound to the baseline it was measured against (ADR 0014);
   a reviewer pressing the button against a moved baseline gets a
   refusal that names the new baseline and what must be re-run.
4. **Undo restores a generation**, code and state, and lists the writes
   made since it, because a snapshot cannot un-write an external system.
   A migration must be backward-compatible or declare its recovery.
5. **Recovery does not depend on the broken thing.** The host shows
   status and logs and offers reset for an environment without starting
   it. Reset restores the last healthy generation of the person's
   profile; `work/` is preserved for repair. The mixed fallback of ADR
   0010 (default `core` with the person's other work packages) is
   replaced by this.
6. **The host upgrades by the same transaction:** stop admissions,
   drain, snapshot host state, install, probe, resume; the previous
   binary is kept, as Thetis's rebuild script kept its inode; a client
   major the new host does not support is refused before the switch.
7. **Every storage pool is bounded**, including project and company
   spaces, the registry cache, the turn log, and snapshots, with
   reserved recovery capacity so the host can always record a failure.
   A write or a publish that would exhaust a pool is refused with the
   pool's name.
8. **One runner adapter ships**; the interface stays; `none` is
   deleted. The boundary is mandatory or it is not.

## Consequences

Good: promotion, undo, recovery and upgrade are one mechanism with
one shape; multiple conversations are defined; a stale review cannot
land.

Bad: a switch waits for a drain, so a long tool call delays an update
by its deadline; the snapshot of `state/` at every switch costs disk
that the pool bound must include.
