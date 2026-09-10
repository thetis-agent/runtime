# ADR 0053 · Bound deployment exports separately from individual code trees

**Status:** Accepted · 2026-09-10
**Deciders:** runtime implementers, under the installer and updater completion request
**Amends:** GN-007's host store export settings; ADR 0052's recovery implementation
**Preserves:** per-pin snapshot limits, bounded workers, byte and depth limits, immutable observations

## Context

The installed lifecycle test starts the complete default deployment before
applying an update. Exporting its stopped store exceeded the 10,000-entry limit
intended for an individual code pin: the store contains several individually
bounded target trees. Small supervisor fixtures did not expose this mismatch.
The eight-entry path-relocation history would also reject a fourth ordinary
kernel update because each transaction exports twice.

## Decision

Individual snapshots retain their 10,000-entry limit. Whole stopped deployment
exports and their subsequent hash use a separate 65,536-entry setting, retaining
the existing 1 GiB byte and 64-level depth limits and bounded worker pool. The
export operation selects that bound; package-supplied snapshot requests do not.

Relocation histories retain their 65,536-byte bound and gain a 512-entry cap,
enough for the supervisor's bounded 128 maintenance attempts plus restarts.
Existing observations and stored snapshot identities are not rewritten.

Installer acceptance uses separate bounded code and state mounts, matching the
installed layout. It does not charge the downloaded Node archive and installed
Node binary against a deployment's state filesystem quota.

## Alternatives considered

Increasing every snapshot limit would loosen unrelated per-package checks.
Dropping immutable code directories from exports would require a new recovery
format and proving every retained run can reconstruct them. Dropping relocation
entries without rewriting all dependent checkpoints could strand old paths.

## Consequences

Good: an ordinary installed deployment can be updated while every traversal and
buffer remains bounded. Bad: aggregate exports may take longer and reach their
separate cap; they continue to refuse excess instead of producing partial state.
The installed lifecycle test covers the complete deployment rather than a small
kernel fixture.

## Revisit

When retained code is stored outside deployment exports, or when measured
deployment sizes justify a different explicit aggregate setting.
