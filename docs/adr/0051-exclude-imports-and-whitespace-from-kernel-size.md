# ADR 0051 · Exclude imports and whitespace from kernel size

**Status:** Accepted · 2026-09-10; explicitly requested by the operator
**Deciders:** operator
**Amends:** ADR 0039's counted-line definition

## Context

The operator requested that the line counter stop counting imports and
whitespace. ADR 0039 excluded comment-only lines while retaining blank lines.

## Decision

Exclude whitespace-only lines and complete static import declarations from
the kernel's counted source lines, in addition to comment-only lines. Use the
TypeScript parser to recognize multiline, type-only, side-effect and
import-equals declarations, including import attributes.

Count a line containing implementation even when an import or comment shares
that line. Dynamic import expressions, import types within declarations and
re-exports remain code. Preserve nonblank literal contents; whitespace-only
lines inside comments, imports or template literals are classified as blank.

Report physical lines, comment-only lines, import-only lines, blank lines and
counted lines separately, both per file and in aggregate. Classifications are
disjoint and sum to the physical total. Keep the 1,300-line ceiling and the
existing exclusion of test files.

## Alternatives considered

A line-prefix regex misses multiline imports and can hide implementation on
the same line. Subtracting overlapping exclusions double-counts blank lines
inside comments or imports. Raising the ceiling changes more than requested.

## Consequences

Good: imports and formatting do not consume the implementation budget, and
the reported exclusions make the result auditable. Bad: the new count cannot
be compared directly with older measurements without their exclusion totals.
No source is compressed or relocated to change this measurement.

## Revisit

If the operator changes the counted constructs or chooses another size metric.
