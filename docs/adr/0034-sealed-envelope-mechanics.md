# ADR 0034 · Separate authenticated byte envelopes from secret authority

**Status:** Accepted · 2026-09-09
**Deciders:** this session
**Supersedes:** nothing

## Context

The proposal locates secret custody and scope enforcement in the kernel. Complete
recovery and maintenance assembly exceeded the 1,500-line kernel review budget.
AES-GCM envelope serialization is a stateless byte-format operation, distinct
from choosing a scope, retaining a key or authorizing a reader and writer.

## Decision

Move bounded AES-256-GCM byte-envelope encoding and decoding into `lib/files`.
The kernel retains its master key, scope selection, grants, name-to-AAD binding,
write authorization, bounded storage pool and refusal policy. The helper receives
a key only for one call and cannot resolve names, open files or fall back to a
second key or scope. It accepts no callbacks and performs no asynchronous work.

## Alternatives considered

Moving the secret store would move authority. Compressing the implementation
would hide complexity. Keeping generic encoding in the kernel consumes review
space without protecting an additional boundary.

## Consequences

No secret guarantee is removed. A smaller kernel depends on a separately tested
cryptographic format helper; this is an additional module to audit. Authentication
failures return no partial plaintext. Existing cross-scope, log-leak and tamper
tests continue to exercise the actual kernel store.

## Revisit

Revisit if the helper starts retaining keys, selecting scopes or accessing files.
