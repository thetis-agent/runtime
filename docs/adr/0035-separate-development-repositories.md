# ADR 0035 · Review separate repositories in the installed directory layout

**Status:** Accepted · 2026-09-09
**Deciders:** the operator (repository separation); implementation session (development tooling)
**Supersedes:** nothing

## Context

The operator moved package sources to an independent git repository and wants
the runtime checkout beside it, separate from the configurable installation prefix.
Package imports already target the installed `packages/`, `lib/` and
`contracts/` layout. Absolute development imports would enter published bytes,
and linking host directories would make sandbox grants depend on host paths.

## Decision

Keep runtime and package source histories separate. Resolve the development
package checkout from `THETIS_PACKAGES` or a sibling `packages` directory.
An assembled distribution uses its own contained `packages` directory.
Run development checks and tests with both checkouts mounted read-only into
one private `/workspace` layout inside mandatory bubblewrap namespaces.
Discover package directories rather than enumerating a registry in code.
Generate package contract imports relative to that installed layout, so
committed output does not depend on checkout paths. Package changes remain
changes in the package repository. Development mounts do not replace the
registry's immutable publication, hash verification or installation checks.

## Alternatives considered

Absolute module mappings tie published sources to one workstation. Symlinks
outside a package's grants fail canonical root checks. Copying package sources
into the runtime repository creates two authorities for the same source.
Rewriting all package imports introduces a new module-resolution convention
without changing the deployed layout. None is necessary for this separation.

## Consequences

Good: relocation needs no source rewrite, and checks exercise the installed
layout using the actual separate checkout. Bad: development checking requires
bubblewrap, and editor navigation across the two repositories needs an editor
workspace. No boundary, secret, generation, gate or act guarantee is removed.

## Revisit

When the reviewed distribution adopts a different module-resolution contract.
