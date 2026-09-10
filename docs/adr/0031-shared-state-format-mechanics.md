# ADR 0031 · Keep state-format mechanics in the shared files package

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation session, preserving kernel authority
**Supersedes:** nothing

## Context

The design budgets the physical kernel directory at about 1,300 lines and
requires moving responsibilities when it exceeds 1,500. Assembling the
code-bound default transaction, its own-origin endpoint and lifecycle hooks
reached 1,503 production lines. Its generation preparation module included
ordinary canonical file reading and JSON Schema validation mechanics.
Those operations do not decide who may switch, which schemas apply, or
whether a transition is allowed; shared file and schema packages already
provide their underlying operations.

## Decision

Place bounded state-format file validation in the existing shared files
workspace package. The kernel supplies the isolated state root, exact
recorded format declarations, schema service and byte limit. It must check
the typed result before advancing the generation table. Keep grant checks,
pin verification, snapshot authority, migration execution and all generation
transitions in the kernel. This is a source responsibility split, not an
unprivileged validation service or a new trust boundary.

## Alternatives considered

Deleting validation loses a guarantee. Delegating the validation decision
to the candidate trusts the subject of the check. Compressing unrelated
statements merely to meet a line count hides the responsibility instead of
moving it. None is used.

## Consequences

Good: the physical kernel contains authority and coordination while the
files package contains its reusable bounded document mechanics. Bad: the
kernel directory's line count alone does not include its already-trusted
shared filesystem and schema dependencies. No validation, boundary,
secret, gate, act or rollback guarantee is lost.

## Revisit

If state-format validation requires target-specific policy rather than
recorded schema data.
