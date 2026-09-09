# ADR 0004 · Idempotent, tamper-resistant measurement

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Supersedes:** ADR 0003 (rejected for admitting a judge model)

## Context

The harness under test can rewrite itself, and the person who publishes
a release is, for now, the only user and the reviewer. Any measurement
the harness can see, influence, or score itself against will be
optimised toward, by the model without malice or by a person with
intent. The operator's word for it is benchmaxing. Two further
constraints: a metric must be idempotent, the same number for the same
recorded trajectory with a scorer a person can read; and there is one
user, so metrics that need many people's decisions have no data.

## Decision

**One rule:** nothing under review scores itself, sees its scorer, or
sees its tasks. Everything else follows from it.

1. **Outcome, not opinion.** The primary number is paired lift:
   pass rate of the candidate minus the default, on the same model, the
   same tasks, the same seeds. A pass is decided by a test the *task*
   ships. No model judges anything. No package ships checks for itself;
   a package's value is only ever the lift it produces on tasks it did
   not write.
2. **The suite, the seeds, and the scorers live in the host.** An
   environment never reads them. Tasks arrive as ordinary `input` events
   through an ordinary gateway on an account that is indistinguishable
   from a person. Seeds are derived from a host secret and the task id,
   constant across releases, so paired runs share them and republishing
   cannot shop for a better draw.
3. **Checks run on the published commit in a clean host environment**,
   never in the publisher's environment, so nothing planted in
   `state/`, `work/`, `harness/` or a space can help.
4. **Every task runs as a mutated variant.** Names, numbers, paths and
   ordering are changed per run from the seed. A stage that recognises a
   task and injects its answer fails the variant. The unmutated task is
   never run.
5. **The model is pinned per suite run by the `llm` door.** A candidate
   profile cannot pick a different model for its own scoring.
6. **A scorer change is its own release**, scored by replaying the
   archived trajectories: the new scorer must reproduce the old scores
   within tolerance, and every divergence is listed on the review page.
   A release cannot change code and the scorer that scores it together.
7. **The gate is enforced by the host**, which recomputes it when *make
   default* is pressed. The review page in the web UI shows numbers; it
   does not decide. A host-rendered summary and the CLI show the same
   numbers for when the UI is not trusted.
8. **The turn log is a hash chain**, host-written, append-only. A
   rewritten history is detectable.
9. **The review page shows aggregates**; per-task results are shown only
   for the retired, public third of the suite. The held-out two thirds
   are never listed.
10. **Publishing the same package more than three times a day is
    refused.** Iterating versions against the gate is the remaining way
    to shop, and the refusal names the rule.

## What is measured

| Number | Definition | Gold or not |
| --- | --- | --- |
| `suite_lift` | paired pass-rate delta with its interval | tasks' own tests |
| `suite_cost` | provider spend per pass, from the `llm` door | none |
| `tool_lift`, `skill_lift`, `compaction_lift` | paired delta with the item offered or in context, minus withheld, on tasks tagged for it | tasks' own tests |
| `offer_f1`, `select_at_1` | offered set and first call against the task's gold tool set | host-held gold |
| `call_valid`, `call_error`, `call_latency`, `spill_rate` | from the `call` rows | none |
| `invariance` | fraction of mutated variants of a task on which the same tool is offered first and the same skill retrieved | none; the invariant is the gold |
| `regressions` | failing count among the deterministic checks derived from accepted play-through findings | the check |
| `skill_ndcg`, `tool_route_f1` | retrieval against a gold set, half of it held out and rotated | host-held gold |

Three numbers head the review page: `suite_lift` with its interval,
`suite_cost`, and `regressions`.

## Not measured, and why

- Skill adherence. It needs either a judge or checks the skill ships,
  and both are out. A skill is worth what it lifts.
- Human decision metrics (send-backs, undo within seven days, review
  latency). One user is too little data; the events are still logged.
- Anything a model reports about itself. The fresh-agent play-through
  stays as a practice; its findings become regression checks; only the
  checks are counted.

## Alternatives considered

**Package-shipped checks.** Cheap and expressive, lost because a package
would score itself. Retained only in the form of a task's test, which
the task author writes and the host keeps.

**A judge model with a rubric.** Rejected in 0003; not idempotent and
tunable by the thing it judges.

**Trusting the publisher's environment for the checks.** Lost because a
planted file or a modified `harness/` note is invisible in a diff.

**Unmutated tasks with a hidden list.** Lost because one leaked list
ends the suite; mutation makes leakage survivable.

## Consequences

Good: a harness change is scored only by what it makes tasks pass, on
tasks it cannot see, in a place it cannot reach, with a scorer it cannot
change in the same breath. The design holds with one user and with
many.

Bad: the suite is the whole signal, so its quality is the ceiling of
the measurement; writing outcome tests for tasks is real work and the
operator is, for now, the only one who does it. Mutation needs each task
to declare what may vary. Checks run twice the model spend of an
unpaired run and the `llm` door caps that per day. A clean host
environment per check costs an install per publish, which the
content-addressed cache makes seconds.

## Revisit

When a second user exists, revisit the human decision metrics. When a
community benchmark scores Agent Skills by outcome, adopt it. When a
release passes the gate and is undone within a week three times, the
suite is not measuring what matters and needs new tasks before anything
else changes.
