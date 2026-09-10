# ADR 0054 · Raise the kernel size ceiling to 1,500 lines

**Status:** Accepted · 2026-09-10; explicitly requested by the operator
**Deciders:** operator
**Amends:** ADR 0051's ceiling and the kernel budget in AGENTS.md

## Context

The operator requested a 1,500-line kernel gate while adding GitHub workflow
coverage reports. The current kernel counts 1,423 lines under ADR 0051 and
exceeds the previous 1,300-line ceiling.

## Decision

Raise the enforced kernel source ceiling to 1,500 counted lines. Keep ADR 0051's
counting rules, test-file exclusion and physical/excluded line inventory. Keep
identity, boundary, secrets and generation authority in the kernel. The gate
continues to fail above the approved ceiling.

## Alternatives considered

Keeping 1,300 contradicts the operator's explicit instruction. Compressing source
or moving authority to meet that limit would obscure the implementation. Removing
the size gate would go beyond the requested increase.

## Consequences

Good: the current 1,423-line kernel passes with 77 lines remaining. Bad: the
trusted implementation may grow by 200 counted lines beyond its former limit.
This approval changes no memory, latency, coverage or conformance requirement.
Historical measurements and accepted ADR text retain their original thresholds.

## Revisit

When the kernel approaches 1,500 lines or the operator chooses another metric.
