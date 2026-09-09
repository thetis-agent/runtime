# ADR 0020 · Budgets are enforced in-band by the provider; `cost` is a reserved counter

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, correcting ADR 0019 §4 and §5 the same day
**Amends:** ADR 0019

## Context

ADR 0019 removed the door and said the kernel enforces a budget by
refusing to mount a provider socket for the rest of the window. That is
after the fact: the kernel learns of spend only when the provider
reports it, and a runaway loop inside one run can exceed a budget
before any unmount. It also said usage is formless, which leaves a
budget rule with no counter it can rely on across providers.

The operator asked whether the door's removal had merit or was
agreement for its own sake. The key point had merit. These two clauses
did not survive that question.

## Decision

1. **A deployment-scope provider enforces budgets in-band.** At start
   the kernel hands it the rules that apply, `cost ≤ N per person per
   day` and a request rate, keyed by run token; the provider refuses a
   call that would exceed them with `error.code = "budget"` and the
   rule's name. The kernel's refusal to mount is the backstop, not the
   mechanism.
2. **`contract/provider` reserves one counter,** `cost`, in a declared
   currency unit the deployment configures, so a rule can read it from
   any provider. Every other counter is formless.
3. **The trust level is stated.** Metering, like authentication after
   ADR 0018, now rests on a reviewed deployment-scope package rather
   than on kernel code. The guarantee that a person cannot control the
   meter holds because that package is in no one's environment; the
   cost is that a careless review of a provider release weakens it
   where a careless kernel pull request would have had to be merged by
   the same people. The design accepts this and says so.

## Consequences

Good: budgets are enforced at the call, as the door did; a rule has a
counter it can trust.

Bad: one counter is opinionated after all; a provider must implement
budget refusal to be default.
