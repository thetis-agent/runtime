# Design · the generation state machine

ADR 0012 as a machine. One machine, four targets: a person's
environment, a deployment-scope process, the default profile, and the
kernel itself. The kernel owns it. Targets differ only in what "apply"
does and who may start a switch.

## Definitions

- **Generation** `g`: `{ n, pins, stateSnapshot, prefixRenderer, at }`.
  `n` is monotonic per target; `pins` is the resolved package set with
  hashes; `stateSnapshot` names a snapshot taken with writers stopped.
- **Endpoint**: a kernel-owned socket path per target that routes to
  the live generation's process; clients hold the path, never the
  process.
- **Deadlines** (settings): `drain` 30 s, `probe` 10 s, `oldDrain` 60 s.

## States

```
LIVE(g)        serving on g; admitting turns
QUIESCING(g)   no new turns admitted; active turns draining under `drain`
FROZEN(g)      no turn active; writers stopped; snapshot being taken
APPLYING(g→h)  installing h's pins by hash; running migrations against a copy of state
PROBING(h)     h's process started on a private endpoint; health probe pending
SWITCHING(g→h) endpoint repointed to h; g still serving in-flight connections
DRAINING(g)    g's connections closing under `oldDrain`
LIVE(h)
ROLLING_BACK   any failure after FROZEN: restore g's state from the snapshot, repoint to g, kill h
FAILED(g)      rollback itself failed: target stopped, reason recorded, human required
```

## Transitions

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| LIVE(g) | `switch(h)` requested | caller's role may switch this target; for the default: `h.baseline == g.n` (the compare-and-swap) | QUIESCING(g) | admissions refused with `switching`; `run.stop` notes to active runs with the drain deadline |
| QUIESCING(g) | last active turn ended, or `drain` elapsed | — | FROZEN(g) | turns past the deadline are killed and logged `killed-for-switch`; their conversations get one line |
| FROZEN(g) | snapshot taken | snapshot verified (hash of the tree) | APPLYING(g→h) | `g.stateSnapshot` recorded |
| APPLYING(g→h) | installs done, migrations done on a copy | every pin's hash verified; migrations exit 0; the copy's format validates against each package's declared state version | PROBING(h) | h's process started by the runner on a private endpoint with the migrated copy |
| APPLYING(g→h) | any install or migration fails | — | ROLLING_BACK | reason recorded |
| PROBING(h) | health answers | within `probe` | SWITCHING(g→h) | the migrated copy becomes h's state |
| PROBING(h) | probe fails or times out | — | ROLLING_BACK | h killed; reason recorded |
| SWITCHING(g→h) | endpoint repointed | atomic rename of the socket path | DRAINING(g) | new connections reach h; g's run tokens fenced for new calls |
| DRAINING(g) | g's connections closed, or `oldDrain` elapsed | — | LIVE(h) | g's process stopped; `h.n = g.n + 1`; `env.updated` notes to dependants; for the default, every environment offered the update |
| ROLLING_BACK | g's state restored and g re-probed | — | LIVE(g) | writes made after the snapshot are listed in the log and the conversation |
| ROLLING_BACK | restore fails | — | FAILED(g) | target stopped; the kernel page shows the reason; `env.reset` offered |
| LIVE(h) | `undo` requested | caller may; a snapshot for g exists | QUIESCING(h) with target g | the same machine with `h→g`; writes since g are listed |

## Invariants

1. At most one switch per target at a time; a second `switch` on a
   QUIESCING or later target answers `switching`.
2. The endpoint is repointed exactly once per switch, atomically.
3. No state is written between FROZEN and SWITCHING except into the
   migrated copy.
4. A run token issued under g is refused for new calls after SWITCHING;
   in-flight calls complete or hit `oldDrain`.
5. `n` never decreases; undo produces `n+1` whose pins equal an older
   generation's.
6. Every transition writes one kernel-observed log row with the target,
   the states, the reason and the elapsed time.

## Per target

| Target | Who may switch | Apply | Probe |
| --- | --- | --- | --- |
| a person's environment | the kernel on a `work/` change, a profile update the person accepted, or `env.reset` | install pins into `envs/<user>`; migrate `state/` | `health.probe` on the environment process |
| a deployment-scope process | the kernel on make-default for a package it runs | install; migrate its `state/` | its `spawn.health` |
| the default profile | `default.set` with a valid code, after the gate | move the pins; snapshot every deployment-scope state; then switch each deployment-scope process as above; then offer environments | all deployment processes live |
| the kernel | an administrator, by the maintenance command | install the new binary beside the old; migrate the kernel store on a copy | the new binary answers `health.probe` on a private socket and accepts the current client major |

## Failure edges worth stating

- A `work/` change during QUIESCING is applied in the next switch, not
  this one; the frozen snapshot is of the tree at FROZEN.
- Two conversations open: both are drained; a turn that will not end
  is killed at `drain` and its conversation says so; this is the
  answer to "restart at a turn boundary" with two turns.
- A deployment process whose old and new versions cannot share state
  declares `migrate: "stop"` in its manifest; the machine then skips
  DRAINING and stops g at SWITCHING.
- The kernel's own switch fences every run token; environments
  reconnect to the new binary with capability negotiation; a client
  major the new kernel does not support is refused at PROBING, before
  the switch.

## Conformance (`contract/generations`, ships with the kernel)

| Id | Given | When | Then |
| --- | --- | --- | --- |
| GN-001 | LIVE with two active turns | `switch` | both drain; a turn sleeping past `drain` is killed and logged |
| GN-002 | APPLYING with a bad hash | install | ROLLING_BACK then LIVE(g); state byte-identical to the snapshot |
| GN-003 | PROBING with a process that never answers | `probe` elapsed | ROLLING_BACK; h's process gone |
| GN-004 | SWITCHING | a new connection | reaches h; a g run token's new call is refused `fenced` |
| GN-005 | two `default.set` with valid codes for different digests | concurrent | one LIVE(h), the other `baseline-moved` |
| GN-006 | LIVE(h) after a migration | `undo` | LIVE(g') with g's pins and g's snapshot; the log lists the writes made under h |
| GN-007 | the kernel switch with an old-major client connected | PROBING | refused before SWITCHING; the old kernel keeps serving |
