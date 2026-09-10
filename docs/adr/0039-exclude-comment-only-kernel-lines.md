# ADR 0039 · Exclude comment-only lines from the kernel size budget

**Status:** Accepted · 2026-09-09
**Deciders:** the operator, explicitly permitting comment exclusion
**Amends:** the physical-line accounting used for proposal §10 and ADR 0031

## Context

The kernel size gate counts every physical non-test TypeScript line, including
the required defence comments. The operator permits excluding comment lines.
Deleting documentation should not be a way to recover implementation budget.

## Decision

Exclude lines occupied only by comments from the 1,300-line kernel budget.
Count a line containing code once even when it also contains a comment. Keep
blank lines outside comments counted, preserving the existing rule for them.
Blank lines inside a block comment belong to that comment and are excluded.
Use TypeScript syntax to distinguish comments from strings, regular expressions
and template literals. Report physical lines, excluded comment lines and the
resulting budget count per file and in total. Continue excluding test files.

## Alternatives considered

Deleting comments loses review context. Text-only comment matching mistakes
URLs, regular expressions and template contents for comments. Excluding every
line touched by a comment lets a trailing comment hide implementation. Raising
the 1,300-line limit changes more than the operator authorized.

## Consequences

Good: documentation no longer consumes implementation budget, and both counts
remain visible. Bad: the gate now needs the already-pinned development
TypeScript parser. The code budget and other acceptance gates are unchanged.

## Revisit

If the operator changes the treatment of blank lines or selects another size
metric. Source compression and moving authority solely to improve a count
remain unacceptable.
