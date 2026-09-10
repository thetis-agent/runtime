# ADR 0044 · Account provider costs exactly for their authorized lifetime

**Status:** Accepted · 2026-09-10
**Deciders:** the operator, authorizing the P1/P2 runtime-review fixes; implementation session
**Amends:** ADR 0020's provider accounting and checkpoint mechanics
**Supersedes:** floating-point balance subtraction and expiring run cost ceilings

## Context

Three simultaneous reservations of 0.01 leave a negative floating-point residue
after settlement. Persisting it succeeds, but the nonnegative checkpoint schema
then prevents provider restart. Nonzero residue also prevents idle entry cleanup.
The same ledger expires both periodic person budgets and a run's total cost
ceiling, allowing a still-authenticated run to spend its ceiling again.

## Decision

Use exact decimal arithmetic for provider balance admission, reservation and
settlement. Convert each validated finite nonnegative number's decimal spelling
into integer units with 324 fractional places, covering the smallest finite
JavaScript number. Persist canonical decimal strings, preserving exact balances
across restarts without imposing a new currency precision restriction.

Keep person-window cost balances separate from lifetime run cost balances.
Request-rate windows remain periodic. Run balances are keyed only by credential
digest and expire at the trusted `expires` already returned by kernel
`token.whois`; prompt options cannot change it. Reclaim expired entries only when
their in-flight reservations are settled. Period rollover retains outstanding
person reservations, and restart conservatively charges unfinished reservations.

Write a version-2 bounded checkpoint after validating it. Read version-1 numeric
checkpoints through an explicit migration. Preserve legacy synthetic run entries
even after their old person window expires; their missing retirement deadline
is filled only when the same credential is authenticated again. Unresolved
legacy entries remain within the existing bounded account pool and require
operator recovery if they exhaust it. Never infer expiry and discard spend.

## Alternatives considered

Clamping small negative values hides accounting errors and can undercharge a
ceiling. Fixed currency micro-units reject currently valid smaller prices.
Keeping all run balances in expiring person windows repeats the cost bypass.
Dropping old synthetic run records at upgrade loses already-authorized spend.

## Consequences

Good: decimal settlement cannot corrupt checkpoints; a run's cumulative ceiling
survives person-window rollover and provider restart. Existing schema-coded
refusals, pre-vendor durability and bounded pools remain enforced. Bad: exact
arithmetic and explicit checkpoint migration add code; old records without
trusted retirement metadata cannot all be reclaimed automatically.

## Revisit

When a deployment requires a different currency representation or a kernel
notification for retiring legacy run digests earlier than credential expiry.
