# ADR 0052 · Installed service recovery and provisioning

**Status:** Accepted · 2026-09-10
**Deciders:** runtime implementers, under the operator's instruction to finish installation and updates
**Amends:** ADR 0048's installer and service lifecycle; ADR 0050's public socket paths and maintenance retention
**Preserves:** GN-002, GN-007, ADR 0025, ADR 0030, ADR 0037; ADR 0049 remains Proposed

## Context

The first installer implementation tested directory creation without starting the
installed launcher. It retained temporary source paths, copied an unverified host
Node installation, and rendered system units for user services. Its dry-run and
uninstall paths did not follow the actual selected provisioning path.

The supervisor also forgot the serving store and generation on restart. A
successful update could therefore revert to the initial seed on the next boot.
Public socket paths changed on every update, and retired stores accumulated.

## Decision

The standalone installer is generated from small reviewed shell source files.
The check gate verifies its freshness. Dry-run executes the same provisioning
functions with writes disabled. Recorded installation choices govern uninstall;
existing state, keys, accounts and incomplete installations are never silently
overwritten. System services use the dedicated account and root-held credentials;
user and foreground installations use a private credential beside their code.
User services require existing bounded storage and delegated controllers. TPM2
credentials are supported for system services only.

Bootstrap downloads the exact Node archive whose digest is in signed provenance,
checks it before execution, then verifies the full release and artifact tree.
Installed seed references name retained release files. Check and apply both
verify staged releases; an in-progress or existing directory is not evidence of
verification. Administrator authentication and the generation transaction remain
required to apply or undo. Supervisor or Node changes require an explicit service
migration; they are reported, never restarted by the timer.

The supervisor persists the serving prepared run and release alongside the
observed generation journal. Recovery uses that journal's epoch and verifies
the recorded code pins and canonical paths before launching. An interrupted
transaction restores the last serving store through the existing restart and
restored transitions; committed epochs are not reused. Publication updates a
synced directory alias at `<state>/live`, so proxy configuration keeps a stable
path through updates and recovery. This alias contains no authority or sockets
passed to a sandbox. The kernel's private stores and descriptor rules stay intact.

Retirement runs under the supervisor's transaction exclusion and keeps the live
and previous prepared runs, stores and release references. It never deletes a
path outside its canonical managed roots. Undo selects the previous code through
the machine's undo edge, while capturing current state for rollback of a failed
undo; the prior stopped store supplies the state being restored.

## Alternatives considered

Hand-maintaining a second dry-run plan caused the original divergence. Importing
shell fragments from the checkout would break `curl | sh`; generation keeps a
single deliverable with small source files. Requiring a preinstalled exact Node
version defeats bootstrap and does not verify that executable's provenance.

Putting stable endpoint policy in the kernel would require a new deployment
schema and kernel lines. A host-owned atomic directory alias solves the proxy
path problem without changing sandbox authority. Recovering from the original
seed loses later state; choosing the newest directory by name can select an
uncommitted candidate. Recovery therefore joins explicit run metadata to the
observed journal.

## Consequences

Good: installation modes have reviewable effects, verified bootstrap has no Node
prerequisite, and restart and update preserve serving state and public addresses.
Bad: installed recovery metadata and generated installer output need freshness
and fault-path tests. A user service cannot provide the key separation of a
root-held system credential. Public release signing and a green release size
gate remain prerequisites for a public one-liner; local fixtures are not releases.

## Revisit

When ADR 0049 is accepted, when cross-Node service migration is designed, or when
the kernel acquires a separate endpoint root that replaces the host alias.
