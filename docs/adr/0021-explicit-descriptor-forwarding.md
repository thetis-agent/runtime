# ADR 0021 · Do not mistake close-on-exec for a child authority boundary

**Status:** Proposed · 2026-09-09
**Deciders:** pending a person's decision
**Supersedes:** nothing while Proposed; concerns ADR 0010 §5–6 and TE-024

## Context

The design puts stages in the mutable environment process and gives that
process the kernel socket and run credential. ADR 0010 §5–6 says children
inherit neither socket nor token, with inherited close-on-exec descriptors
as the mechanism. TE-024 requires a handler's child to hold no kernel
socket descriptor. Proposal §13 rule 6 requires the boundary to hold
regardless of what a person rewrites inside an environment.

Close-on-exec prevents implicit inheritance. It does not prevent a
process that owns a descriptor from explicitly forwarding it. Node's
`spawn` accepts an existing descriptor in `stdio`; it duplicates that
descriptor into the child. A stage has this API and shares the core's
process authority. Rewriting a spawn wrapper is unnecessary.

The reproduction in `test/descriptor-forwarding.test.ts` uses a real Unix
socket and two real Node processes inside bubblewrap with user, process
and network namespaces. The outer test passes the connected socket as
descriptor 3 to the environment fixture. That fixture asserts from
`/proc/self/fdinfo/3` that close-on-exec is set, then starts a child with
`env: {}` and `stdio: ['ignore', 'inherit', 'inherit', 3]`. The child
writes `child-used-the-inherited-socket`; the original socket listener
receives it. No socket path or credential is passed through the child's
environment, disk or command line. Observed flags on Node 24.18.0 were
`02004002`, including Linux's `02000000` close-on-exec bit.

This reproduction tests descriptor possession, exactly the part TE-024
forbids. It does not claim a cross-person escape, forge a run credential,
or test a kernel implementation that does not yet exist. A same-process
stage can also copy any run credential it can read, so token secrecy
from that stage's chosen child cannot be obtained by descriptor flags.

## Decision

No boundary workaround is implemented. Stop Milestone A implementation
pending a person's decision, as required by the implementation prompt.

The minimal proposed change is to narrow the child rule to **no implicit
inheritance**, explicitly treating an environment and children to which
it delegates authority as the same run principal. The kernel would still
enforce person, scope, role, budget and generation fencing. TE-024 would
need to distinguish ordinary inheritance from deliberate delegation.
That removes the stronger child-authority guarantee and cannot be
accepted by the implementing agent.

If the stronger guarantee is required, the design needs a trusted
process/privilege boundary for stage execution and child creation rather
than an in-process wrapper. Its treatment of intentional proxying by the
mutable core also needs to be stated. No such redesign is selected here.

## Alternatives considered

**Keep the current guarantee and rely on close-on-exec.** Rejected by the
executable reproduction: the flag is set and the child still receives
the socket through explicit `stdio` forwarding.

**Require every stage to use a safe spawn wrapper.** Insufficient as a
boundary against mutable code in the same process. A stage can import
`node:child_process` directly or rewrite the wrapper.

**Forbid process creation in the environment.** This could remove the
demonstrated child path but also removes the permitted stage children
and changes the execution design. It is not silently substituted.

**Move stage execution behind a stronger trusted boundary.** Potentially
preserves more isolation but changes the one-process stage architecture,
cost and authority model; it needs a separate concrete design.

## Consequences

Good: the repository contains a reproducible security finding instead
of an implementation that claims an unenforced boundary. Original
accepted records and conformance ids remain intact.

Bad: Milestone A is unfinished. The proposed narrowing loses the
guarantee that a deliberately spawned child cannot possess its parent's
kernel descriptor. Namespace isolation and the outer resource limits
do not repair that particular delegation path.

## Revisit

When a person accepts a precise child-authority threat model or approves
a concrete stronger execution boundary. Keep this reproduction; add the
chosen enforcement tests without deleting or silently skipping TE-024.
