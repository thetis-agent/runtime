# ADR 0021 · Do not mistake close-on-exec for a child authority boundary

**Status:** Accepted · 2026-09-09
**Deciders:** the operator, explicitly approved in this session
**Amends:** ADR 0010 §5–6 and TE-024; explicit operator approval

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

Treat an environment and its deliberately delegated children as one run
principal. Require **no implicit inheritance**: the normal spawn path
passes only approved standard streams, no kernel socket and no run token.
Keep descriptors close-on-exec and credentials out of environment
variables, disk and command lines.

The kernel independently enforces the original person's scope, role and
generation on every request. Forwarding a descriptor never mints a new
principal or grants more authority. Children remain within the run's
sandbox, resource limits and spending attribution. Generation fencing
invalidates delegated authority together with the original run.

TE-024 tests ordinary spawning for descriptor and credential leaks. Keep
the deliberate-forwarding reproduction and test that delegation cannot
escape the original person's authority or survive generation fencing.
The stronger claim that a malicious environment cannot deliberately
share its existing authority is withdrawn with the operator's approval.
No separate process boundary between in-process stages is introduced.

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

Bad: Milestone A is unfinished. The accepted narrowing loses the
guarantee that a deliberately spawned child cannot possess its parent's
kernel descriptor. Namespace isolation and the outer resource limits
do not repair that particular delegation path.

## Revisit

When a deployment needs separate principals for stage children. That
requires a new execution-boundary design, including intentional proxying.
Keep the reproduction and the ordinary-inheritance TE-024 test.
