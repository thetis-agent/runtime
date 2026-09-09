# ADR 0022 · Keep iteration context appends outside the stored prefix

**Status:** Accepted · 2026-09-09
**Deciders:** implementing engineer, preserving the specified guarantees
**Amends:** contract/turn-events context-hook prose under ADR 0013

## Context

The context prose allows stages to append to `system`, while ADR 0013
stores system and skills once as the immutable prefix. TE-011 requires
context appends not to appear in the conversation file. Persisting an
iteration's system append in the prefix breaks TE-011; changing the
stored head on an ordinary turn breaks TE-009. Silently ignoring an
accepted append would misrepresent the hook's behavior.

## Decision

Iteration append hooks receive a push operation for `harness` or
`history` only. `system` and `skills` are readable, frozen sections owned
by the stored-prefix renderer. The initial system messages come from
the resolved profile; changing them requires an announced refresh.
A stage may append a system-role message to `harness` for ephemeral
instructions after the immutable head.

The implementation rejects an attempt to configure an iteration appender
for an immutable section. No security boundary, secret rule, gate, act,
prefix guarantee or conversation persistence guarantee is removed.

## Alternatives considered

**Store a context append during the first iteration.** Breaks TE-011.

**Re-render the system section every iteration.** Breaks TE-009 and ADR 0013.

**Accept and discard system appends.** Hides unmet requirements from the
stage and makes its diagnostics false.

## Consequences

Good: every accepted iteration append is sent to the model, stays
ephemeral and cannot invalidate the prefix. Section order stays fixed.

Lost: a stage cannot modify the immutable system prompt through its
iteration context hook. It must use profile configuration and an
announced refresh, or an ephemeral harness message.

## Revisit

When a package needs a separate initialization-time system contribution
contract. Do not overload the ephemeral context hook to provide one.
