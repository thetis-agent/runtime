# ADR 0040 · Put byte storage behind a contract and default file backend

**Status:** Accepted · 2026-09-09
**Deciders:** the operator, requesting a storage contract and default package
**Amends:** ADR 0032's journal mechanism and ADR 0034's storage pool placement
**Supersedes:** nothing

## Context

The kernel still implements a secret store's directory inventory, entry ceiling,
writer admission and file access. Those are byte-storage mechanics. The operator
requested a file or SQLite package behind a contract to reduce kernel code.
Secret authorization and journal provenance remain kernel guarantees.

## Decision

Introduce `contract/storage` for bounded byte objects and durable append logs.
Ship `storage-files` in the default profile. Its implementation is shared in the
`lib/storage` workspace package because both the kernel and ordinary packages
need it, following the existing shared-library rule. The ordinary package exports
the contract's factory; the kernel imports the fixed, reviewed library default,
never a discovered package or an executable selected by a person profile.

Move secret directory inventory, pool accounting, read limits and serialized
atomic replacement into this backend. Store only authenticated ciphertext there.
Keep the key, scope/name binding, grants, authorization and refusal to fall back
inside the kernel. Journal consumers use the same factory's append interface;
row provenance and recovery reserve selection remain in the kernel. Preserve
existing `.sealed` filenames, envelope bytes and NDJSON journal layout.

The contract is an in-process API, not a new public socket or tool capability.
It grants no filesystem access: callers already need an exclusively owned root
inside their existing boundary. The backend rejects unsafe keys, symlinks and
nonregular entries, bounds inventory and retained bytes, and acknowledges writes
only after file and directory synchronization. Failed writes poison the handle
until reopened because a failed synchronization can have an uncertain outcome.

## Alternatives considered

SQLite would add a format migration and database lifecycle without helping the
current opaque-object and append use cases. It can implement the same contract
later. A replaceable storage service for the kernel's journal would let rewritable
code forge observed history. Moving encryption or scope resolution would remove
secret guarantees. Neither follows from delegating byte storage.

## Consequences

Good: kernel storage users depend on an explicit contract; the file backend is
tested independently and preserves existing data. Bad: the shared implementation
remains part of the trusted dependency review, and this extraction alone does
not promise to reach the 1,300-line budget. Generation snapshots, checkpoints,
conversation layouts and their authority are not redesigned by this decision.

## Revisit

When a second backend is required, or a caller needs transactions across objects,
multiple writers, or storage across a process boundary.
