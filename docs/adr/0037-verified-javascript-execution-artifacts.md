# ADR 0037 · Verify JavaScript execution artifacts alongside TypeScript sources

**Status:** Accepted · 2026-09-09; explicitly approved by the operator
**Deciders:** operator
**Amends:** ADR 0002's no-build-step guarantee

## Context

The real kernel plus one idle environment currently measures approximately
253–258 MB RSS against 120 MB. An actual watched file-tool edit takes roughly
1.8–1.9 seconds against one second, even with ADR 0036's generation-local cache.
Both required launches and the responsive initialization monitor remain intact.
Startup measurements identify schema compilation and module loading as remaining
costs. These measurements do not prove that a build step alone meets either limit.

## Decision

Permit a deterministic, bounded release step that produces JavaScript execution
artifacts from the exact reviewed TypeScript sources. Record both source and
output hashes and the exact generator/runtime version in the immutable release.
Verify those artifacts before mounting them. Generate only the affected artifacts
for a work edit, off the kernel event loop, and include that time in edit-to-serve.

Keep TypeScript as the editable source and the existing strict check as the gate.
Do not evaluate a package to transform it. Preserve relative imports, worker
entry points, source-to-error locations, plain-directory package discovery,
generation fencing, read-only probes, fresh serving processes, and descriptor
custody. A missing or mismatched artifact refuses activation; it cannot select
unreviewed output. Schema-validator generation would need the same freshness and
conformance checks as generated contract types.

The operator explicitly approved this change after reviewing its summary.
The earlier UI deferral and permission to use a model key were not approval to
change ADR 0002; implementation starts only after this separate decision.

## Alternatives considered

Continue direct execution and optimize schema compilation and native caches:
preserves the current decision and remains available, but is not yet measured
within either acceptance limit. Raise the limits or reuse the writable probe:
hides a failing requirement or removes a boundary. Change languages: introduces
a second toolchain before establishing whether bounded type erasure is enough.

## Consequences

Good: serving processes may avoid TypeScript parser retention and repeated
startup compilation. Bad: publication and each source change now have an
explicit artifact-generation step, contrary to the selected no-build workflow;
verification and source mapping add machinery. Performance remains unproven.
The kernel budget, memory ceiling and latency ceiling are not waived.

## Revisit

After the operator decides, and again after measuring the complete implementation
against cold idle memory, real watched edits, conformance and source freshness.
