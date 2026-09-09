# ADR 0014 · Observed versus reported, the evaluator, and the gate

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, from the Codex debate (A4, F7, F8, F9, S6, S7, S8, S9)
**Amends:** ADR 0004 §2, §7, §8, §9, §10

## Context

ADR 0004 made the log host-written and hash-chained and called that
tamper resistance. But the stage rows in that log come from the core's
own event stream over the socket, and the core is the person's to
rewrite: a hash chain preserves a lie. The suite "lived in the host",
which put a task runner in a host that names nothing. The gate refused
any release whose lower bound was below zero, which blocks a UI fix on
noise. "Indistinguishable from a person" was a claim the design could
not keep. The review page lived in a rewritable package and also held
the button.

## Decision

1. **Two provenances, labelled.** Host-observed facts: metered usage,
   sandbox events, process exits, the evaluator's outcome checks.
   Candidate-reported facts: the stage rows the core sends. Only
   observed facts gate anything. Reported rows are kept, labelled, and
   used for diagnosis. The hash chain is dropped until an audit
   requirement exists; the log stays host-owned and append-only.
2. **The evaluator is a package**, at deployment scope, in its own
   sandbox, authorized by an administrator, holding the private tasks,
   seeds and scorers as its own assets that no environment can mount.
   The host verifies a result's identities (baseline, candidate, suite,
   scorer, model, seeds) before it counts. The host runs no evaluation
   code. Deterministic checks are cached by the hash of their complete
   inputs.
3. **The gate is non-inferiority with a declared margin.** A release
   lands if the lower bound of its lift interval is above a margin set
   before the run (the default is minus two points on pass rate),
   deterministic regressions are zero, and a person pressed the button.
   "Improved" is claimed only when the whole interval is above zero.
4. **Approval happens on the host's own page.** The review page in the
   UI package displays; the host page shows the release digest, the
   baseline and the gate result and holds the only button. A package
   page has no promotion authority. This is Thetis's rule for `/admin`
   applied to the one act that matters.
5. **The bench claim is bounded:** private scorers and expected
   answers, fewer fingerprints, an evaluation budget per person rather
   than a publish limit per package, and fresh holdouts reserved for
   promotion. "Cannot enumerate hidden tasks or read expected answers"
   replaces "sees its tasks". The literal-match lint is dropped.
6. **Initial scope:** deterministic regressions, paired lift and cost
   on representative tasks. Ablations, the retriever tournament and
   the community calendar are added when a decision needs them.

## Consequences

Good: the gate reads only what the candidate cannot forge; the host has
no evaluation code; a harmless fix is not blocked by noise; the button
cannot be spoofed by a page.

Bad: the evaluator package is one more thing to review; a margin is a
policy someone must set and defend.
