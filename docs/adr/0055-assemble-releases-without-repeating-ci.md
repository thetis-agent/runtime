# ADR 0055 · Assemble releases without repeating CI

**Status:** Accepted · 2026-09-10; explicitly requested by the operator
**Deciders:** operator
**Supersedes:** the release workflow's repetition of CI acceptance checks
**Preserves:** ADR 0012's sandbox, ADR 0048's signed delivery, ADR 0052's signing isolation

## Context

The operator considers revisions on the repositories' main histories verified
and requests removal of the release workflow's Verify release job. Repeating
the complete suite delays publication and a retry after a signing failure.
The existing v0.1.0 tag also contains the former verification action, so loading
release tooling from that tag would retain the old behavior on a new dispatch.

## Decision

CI continues to run all checks, size and boundary gates, tests and coverage.
Release dispatch validates the existing annotated tag and selected peer commit
against main history, then builds artifacts and assembles the selected sources
without rerunning those CI acceptance checks or generating fresh coverage.
Release does not require or claim a separately checked successful CI run.

Release orchestration comes from tracked runtime tooling on main. Runtime
dispatch uses its workflow commit; package dispatch records the fetched runtime
main commit. Candidate checkouts remain at their selected revisions, including
existing tags. Provenance records assembly mode and the tooling revision.

Publication still checks transferred checksums, source pairing and unchanged
tag identity, signs the delivery, verifies that signature and refuses an existing
release. The protected publication job executes no candidate code. It accepts
an unencrypted OpenSSH private signing key as raw text or base64 of the complete
file, normalizes transport formatting, validates it without printing secret data
and removes its temporary file on success or failure.

## Alternatives considered

Reusing a CI artifact would require a new run selector and exact-pair artifact
matching. Repeating CI contradicts the operator's instruction. Loading tooling
from the release tag would require a new tag merely to repair publication.
Removing signature and artifact-integrity checks would leave delivery corruption
and tag movement undetected and is outside the requested change.

## Consequences

Good: releases assemble and publish without duplicate acceptance runs; existing
tags can use repaired release tooling. Bad: main-history membership is the
operator's assurance of prior verification, not evidence checked by this job.
Release artifacts contain no new coverage report. Tooling and source revisions
can differ and must remain explicit in provenance.

## Revisit

When the operator wants publication bound to a particular successful CI artifact.
