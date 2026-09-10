# Conformance · contract/kernel-socket 1.0.0

Subjects: **K** the kernel; **E** an environment client (the core); **S**
a deployment-scope service (a provider, a gateway).

| Id | Subject | Given | When | Then |
| --- | --- | --- | --- | --- |
| KS-001 | K | a connection without the inherited descriptor's credential | connect | refused |
| KS-002 | K | client and kernel capability lists | connect | a method in only one list is never called; calling it answers `unsupported` |
| KS-003 | K | an old client (previous minor) against the new kernel, and the reverse | the suite | both pass the intersection |
| KS-004 | K | `session.list` for another person without the observe permission | request | refused `forbidden`; with the permission, the list |
| KS-005 | K | `session.submit` on a conversation the token's person does not own | request | refused |
| KS-006 | K | a gateway asserts `(kind, id, evidence)` for a kind it is not designated for | `identity.assert` | refused; nothing minted |
| KS-007 | K | a designated gateway asserts an id with no binding | `identity.assert` | refused `unbound`; no principal created |
| KS-008 | K | `secret.has` | request | true or false; never a value; `secret.set` over a package origin is refused |
| KS-009 | K | `package.register` with a name outside the envelope | request | refused, naming the name and the envelope; the package is inert |
| KS-010 | K | `install` with a hash that does not match the fetched tree | request | refused; nothing extracted |
| KS-011 | K | `install` of a version pinned by a live conversation, then a prune request for it | request | prune refused, naming the conversation |
| KS-012 | K | `usage.report` from a person-scope provider | request | accepted, labelled `candidate-reported`; from a deployment-scope provider, labelled `reviewed-reported` |
| KS-013 | K | `usage.report` with a run token not issued to that service's caller | request | refused |
| KS-014 | K | `results.submit` with identities whose baseline is not the current default generation | request | accepted and stored, but the review page marks it stale and `default.prepare` refuses to use it |
| KS-015 | K | `default.prepare(digest, baseline)` | request | returns a code bound to (digest, baseline); the kernel's origin serves one line with digest, baseline, gate; `default.set` with a wrong code, wrong digest, or moved baseline is refused |
| KS-016 | K | two `default.set` for different digests with valid codes at once | request | exactly one succeeds; the other answers `baseline-moved` |
| KS-017 | K | `run.stop` while a turn is mid-call | note | the client acknowledges within the drain deadline or the process group is killed; the log row says which |
| KS-018 | K | a control frame queued behind 10 MiB of bulk | delivery | the control frame is delivered first |
| KS-019 | K | `env.status` for a person whose environment cannot start | request | answers without starting it; `env.reset` restores the last healthy generation and preserves `work/` |
| KS-020 | E | `turn.report` | note | one per turn, ≤ 64 KiB, labelled `candidate-reported` in the log |
| KS-021 | K | a frame with unknown fields | any | ignored; the response validates |
| KS-022 | K | `token.whois` for a token of another run | request | the person and scope of that run, only to a deployment-scope service |
| KS-023 | K | `session.whois` | request | a run resolves a browser session only for the person it serves: a person-scope run is refused a token naming another person; a deployment-scope run may resolve any; the token is never echoed or logged (ADR 0038) |
| KS-024 | K | a target's service grant | mount | refused when the granted service is person-scoped and owned by another person; a same-owner grant is accepted (kernel/boundary/runtime.ts, ADR 0038) |
