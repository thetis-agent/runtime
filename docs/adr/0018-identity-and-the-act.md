# ADR 0018 · The kernel needs identity and the act, not auth and approvals

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Amends:** ADR 0017 §3 (the `auth` and `approval` parts); ADR 0014 §4 (the approval page); ADR 0009 §5 (the secrets page)

## Context

ADR 0017 kept `auth` and `approval` in the kernel. The operator
pointed out that gateways already do authentication, that approvals
are a UI, and that the kernel needs only identity. ADR 0015 had half
conceded the first: a gateway returns evidence and the kernel resolves
the person. The rest of "auth" was login pages, cookies, password
checks and external flows, none of which holds a guarantee the kernel
must hold. "Approval" was a page; the guarantee behind it was smaller
than a page.

## Decision

1. **The kernel keeps identity:** principals; bindings from an external
   kind and id to a principal; roles and the per-role policy; the list
   of designated authentication authorities, set by an administrator;
   and token minting and validation for sessions and runs. About 150
   lines. Nothing else about how a person proves who they are.
2. **Authentication is a gateway's job.** A login gateway at deployment
   scope is designated the authority for the `password` kind and keeps
   its hashes in its own state; it asserts `(kind, id, evidence)` to the
   kernel, which checks the designation and the binding and mints a
   session token the gateway sets as its cookie. Discord, OAuth and any
   other kind are the same shape with a different gateway. A gateway
   that is not designated for a kind cannot assert it. A designation is
   an administrator's act in the kernel, like adding a registry.
3. **The review page is a gateway's.** Diff, note, checks, scores,
   unmet requirements and who runs it are displayed by the web UI
   package, in the reviewer's environment or the deployment's.
4. **The act stays in the kernel, and one line with it.** `default.set`
   is a kernel call taking the release digest and the baseline
   generation; the kernel checks the caller's role, the gate and the
   evidence identities, and moves the pin by compare-and-swap. Because
   the reviewer's own page may have been rewritten by a loop that wants
   its version adopted, the call is two steps: `default.prepare(digest)`
   returns a confirmation code, and the kernel's own origin renders one
   line of text, the digest, the baseline and the gate result, that no
   package serves; the reviewer submits the code from that line. About
   100 lines, and it is the whole of what "approval" ever needed to be.
5. **Secrets are entered the same way.** A gateway's form posts a
   person's secret directly to the kernel's origin; no package process
   sees the value. The secret store and its resolution stay in the
   kernel (ADR 0009).
6. **Status, logs and reset for a broken environment** are served by a
   deployment-scope gateway from the default profile, which does not
   need the person's environment to start; the kernel exposes them as
   calls.

The kernel is now: identity, the boundary, secrets, the door,
generations with the act. About 1,600 lines.

## Alternatives considered

**Password checking in the kernel.** Lost: it is one kind among many,
and the designation mechanism already exists for the others.

**No trusted confirmation at all.** Lost: the recursive case is the
product's stated goal, and a loop that can rewrite the reviewer's page
would otherwise approve itself. One line on the kernel's origin is the
smallest thing that breaks the cycle.

**A trusted approval gateway at deployment scope.** Lost: it would be
promoted through the approvals it renders, which is the cycle again.

## Consequences

Good: the kernel loses a part and a page; authentication kinds are
packages; the sponsor's public role can log in through whatever
gateway the sponsor chooses.

Bad: a login gateway version that accepts anything is a reviewed
change to the deployment's identity provider, which is the same trust
as a kernel pull request and must be reviewed as carefully; the
confirmation line is a second step a reviewer will find tedious.
