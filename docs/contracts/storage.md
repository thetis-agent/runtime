# contract/storage · 1.0.0

This contract specifies an in-process byte-storage factory. Its authoritative
configuration and error schemas are in `contracts/storage/schema.json`, with
generated data types in `types.ts`; `index.ts` specifies the callable interface.
There are no new process-boundary messages or public storage socket.

`StorageProvider.open(root, limits)` opens opaque byte objects in an exclusively
owned root with an existing canonical parent. `has(key)` reports the committed inventory, `get(key)` returns owned
bytes, and `put(key, bytes)` atomically replaces one value. Missing keys return
`not-found`, invalid keys or object limits return `invalid-args`, exhausted pools
return `budget`, and filesystem or durability failures return `io`. Unknown
configuration fields are ignored. Keys cannot name paths.

All providers must bound entries, per-value bytes and total retained bytes.
The default limits are 4,096 entries, 65,536 bytes per value and 67,108,864 retained
bytes. One object read or replacement may be in flight; further object I/O
returns `budget`, so reads cannot allocate an unbounded pool or observe a pending
replacement. An operation owns a copy of its input, and open captures its limits
before asynchronous work. Replacing a value reclaims its previous
logical byte reservation. Temporary disk capacity includes one additional value
and filesystem metadata; mounted filesystem quotas still apply (ADR 0012).

`StorageProvider.journal(path, { rowBytes, queuedRows })` opens an append log.
Each `append(bytes, maximum)` reserves both queue and file bytes before writing,
counts existing bytes after reopen, preserves admission order and acknowledges
only synchronized bytes. `maximum` allows an authority to retain recovery space.
Invalid journal configuration returns `io`; invalid or exhausted append ceilings
return `budget`. `close()` drains admitted writes, is idempotent, and rejects new
appends immediately. A durability failure refuses subsequent writes. The kernel
chooses provenance and reserves; the backend sees only bytes.

The default `storage-files` package exports `storage` implementing this factory.
Both it and the kernel reuse `lib/storage` to avoid direct package imports.
The kernel's default is a reviewed library dependency and cannot be replaced by
a person profile. The package grants no paths, keys, identities or authority;
ordinary consumers use it within their existing sandbox mounts.

The file backend accepts only canonical roots and private regular files, refusing
symlinks, hard links, special entries and later root replacement. Root ownership
must exclude other writers, including a second mutable handle; multi-process
coordination is outside this version. An atomic replacement synchronizes its file
before rename and the directory afterward. A failed replacement poisons the
handle until reopen, including reads, because its committed outcome can be
uncertain. Interrupted temporary files remain bounded inventory until operator
recovery; they are never interpreted as a secret or an observed row.

Existing secret filenames and AES-GCM envelopes and existing NDJSON journals are
compatible. Secret scope/name binding, encryption keys, grants, provenance,
generation transitions and snapshots remain their current owners' decisions.

Adding optional configuration is a minor release; changing a required argument,
result, error meaning or durability guarantee requires a major. The reusable
contract-owned cases in `contracts/storage/conformance.ts` run against the actual
default package in `packages/storage-files/index.test.ts`.
