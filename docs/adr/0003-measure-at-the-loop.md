# ADR 0003 · Measure the harness as paired deltas at the loop, with benchmarks as packages

**Status:** Rejected · 2026-09-09. The operator rejected it the same day: it admitted a judge model for skill adherence, and a metric must be idempotent, never a model's opinion. The paired-delta, stage-row and benchmarks-as-packages parts are not disputed and return in the record that supersedes this one, without any judged number.
**Deciders:** the operator; this session, after the round-two self-improvement critic
**Supersedes:** the first draft's thirty metrics and six-rung ladder; Thetis's single retrieval bench with no gate

## Context

The successor changes the harness and not the model. A benchmark score
is mostly the model's. Thetis measured tool routing once, found the
shipped router at F1 0.24 against a known 0.42, and shipped 0.24 because
the number had no reader and no gate. The operator asks how tool
efficacy, tool matching and skills are measured, whether community
benchmarks apply, and insists the measurement sit at the loop side.

## Decision

1. **Paired deltas, model fixed.** Every benchmark runs the default
   profile and the candidate on the same model, tasks and seeds,
   interleaved, k runs each. The review page shows the delta and its
   interval. Absolute scores are recorded and never compared across
   models.
2. **Stage rows in the turn log.** Each stage that handles an event
   writes what it did and what it cost, keyed by package version. Every
   metric is a query over these rows; none is counted up front.
3. **Benchmarks are packages.** A community benchmark is a gateway-role
   stage that feeds its tasks as `input` for a bench account and a scorer
   that reads `end` and the task's final state. The host and the core
   know nothing about benchmarks. ToolRet and SkillRet run offline
   against the `retrieve` and `offer` stages at every relevant publish;
   BFCL, τ-bench, a Terminal-Bench or SWE-bench sample, GAIA and an MCP
   benchmark run on a schedule.
4. **The private suite stays in the host** and scores what no public
   benchmark does: skills, compaction, and harness tasks. It is rotated
   and held between 60 and 80 percent.
5. **The gate reads the lower bound** of the pass-rate delta, not the
   mean.

## Alternatives considered

**Judge-model scoring of whole trajectories.** Cheap and general; lost
because a judge drifts with its own model and cannot be paired. Used
only for skill adherence where a skill ships no test, and marked as such.

**Absolute leaderboard scores as the number.** Lost because they move
when the provider updates the model and say nothing about the harness.

**Benchmarks wired into the host.** Lost on the one rule: the host names
nothing. A benchmark is a package like any other, which also means a
person can write one.

## Consequences

Good: every number attributes to a package version; a tool with no lift
is visible; routing regressions are caught offline for free; a
benchmark is added by adding a package.

Bad: paired runs double the model spend at publish, and the `llm` door
must cap bench spend per day; twenty tasks resolve only ten-point
changes, so small improvements need a bigger suite before they can be
seen; public benchmarks are in the models' training data, which is
tolerable for deltas and disqualifying for absolutes.

## Revisit

When a community benchmark for Agent Skills retrieval or adherence
appears, adopt it and retire SkillRet. When the suite passes 80 percent
on the default for a month, grow it.
