# Design · the evaluator package

The package that scores a release (ADR 0004, 0014, 0019 §6, 0020). It
runs at deployment scope, in its own sandbox, and holds the suite, the
seeds and the scorers as assets no environment can mount. The kernel
runs no evaluation code; it verifies a result's identities before the
result counts.

## `package.json`

```json
{
  "name": "evaluator",
  "version": "1.0.0",
  "stages": "./index.ts",
  "requires": {
    "core": "^1",
    "service/registry": "^1",
    "cap/os.linux": "*",
    "setting/evaluator.margin": "*",
    "setting/evaluator.runs": "*",
    "setting/evaluator.budget_per_day": "*",
    "secret/evaluator.seed": "*"
  },
  "provides": { "service/evaluator": "1.0.0" },
  "envelope": { "requires": ["cap/network.egress"], "provides": [], "spawn": { "scope": "deployment", "network": "none" } },
  "settings": {
    "evaluator.margin":        { "kind": "number",  "default": -2,  "help": "non-inferiority margin on pass rate, points" },
    "evaluator.runs":          { "kind": "integer", "default": 3,   "help": "paired runs per arm; 5 for a core or provider change" },
    "evaluator.budget_per_day":{ "kind": "number",  "default": 25,  "help": "cost per person per day for evaluation, in the deployment's currency" },
    "evaluator.hold":          { "kind": "list<number>", "default": [60, 80], "help": "keep the default's pass rate inside this band by rotation" }
  },
  "spawn": [
    { "id": "runner", "cmd": "node", "args": ["runner.js"], "health": { "rpc": "ping" }, "restart": "on-failure", "scope": "deployment", "network": "none" }
  ]
}
```

`secret/evaluator.seed` is the deployment's seed secret (ADR 0004 §2);
the kernel delivers it to the `runner` spawn only. The evaluator's own
directory holds `suite/` and is mounted into no other sandbox.

## The suite on disk

```
suite/
  tasks/<id>/task.json      the task: family, request, gold, mutation, required tools, budget
  tasks/<id>/checks/        the outcome test: files the scorer sandbox runs; never mounted in the candidate's sandbox
  tasks/<id>/fixture/       state the candidate sandbox starts with (a repo, a space, a save)
  retired/<id>/             the public third; readable by environments through the registry
  gold/skills.jsonl         (query, skill id) pairs, half held out by seed
  gold/tools.jsonl          (query, tool set) pairs
  regressions/<id>.json     deterministic checks derived from accepted play-through findings
```

`task.json`:

```json
{
  "id": "t-0142", "family": "tool" | "skill" | "long" | "harness",
  "request": "Add a tool that lists the largest files under {path}",
  "mutable": { "path": "path", "names": ["Alice"], "numbers": ["12"] },
  "requires": ["tools-files/read_path@1"], "required": ["tools-terminal/run@1"],
  "gold": { "tools": ["tools-files/list_path@1"], "skills": ["careful-surgery"] },
  "budget": { "cost": 0.40, "iterations": 20 },
  "since": "2026-09", "source": "conversation 8f3a… 2026-08-30",
  "checks": "checks/run.sh"
}
```

## A run

1. **Arms.** The default profile and the candidate release, resolved by
   the registry package, installed by the kernel by hash into two clean
   sandboxes per task: the model's and the scorer's.
2. **Seeds.** `seed(task, run) = HMAC(secret, task.id ‖ run)`. The same
   seeds for both arms. The mutator derives every variable in
   `mutable` from the seed, respecting the card-vocabulary stoplist for
   `skill` tasks.
3. **The turn.** The runner is a gateway-role stage on a bench account
   whose identity is an ordinary binding; it submits the mutated
   request as `input` through the kernel's session API and observes
   `end`. The provider instance and model are the evaluator's profile
   settings; the result carries both.
4. **Scoring.** After `end`, the candidate sandbox is frozen and its
   spaces mounted read-only into the scorer sandbox, where
   `checks/run.sh` runs and exits 0 or non-zero. No model is called by
   the scorer. `data` columns from `call` answers are read from the
   log, never from the candidate.
5. **Ablation** for `tool_lift` and `skill_lift`: the same task with the
   named tool withheld from `offer` or the skill removed from the
   pinned set, on tasks that tag it, skipping `required` tools.
6. **Result.** One `results.submit` with identities `{ baseline,
   candidate, suite, scorer, provider, model, seed }` and one row per
   (task, run, arm): `pass`, `iterations`, `cost`, counters, `dropped`,
   `end.reason`.

## Numbers

Computed from rows by the metrics package, never by the evaluator:
`suite_lift` as the mean paired difference with a bootstrap interval
over tasks; `suite_cost`; `regressions` as the count of failing
`regressions/` checks on the candidate; `tool_lift`, `skill_lift` where
tagged; `invariance` from SK-013's rule. The gate (ADR 0014 §3) is
computed by the kernel at `default.prepare` from these rows and the
margin setting.

## Rotation

Monthly, a stage of this package reads the turn log's `input` texts of
the past month (it may observe the log with the role permission), drafts
candidate tasks from them into `suite/drafts/`, and a person promotes
them by writing `checks/`. Tasks the default passes at 95 % for two
months retire to `retired/`. The band setting keeps the default between
60 and 80 %.

## Findings to regressions

The fresh-agent play-through reports findings as JSON. A person accepts
one by writing `regressions/<id>.json` with a deterministic check (a
walkthrough step and an assertion the faux gateway can run). The count
of failing checks is `regressions`.

## Budget

`evaluator.budget_per_day` is the evaluation rule handed to the
deployment provider at start (ADR 0020), keyed by the bench account;
a run that would exceed it stops and the review page says so.

## Conformance (`contract/evaluator`, ships with this package)

| Id | Given | When | Then |
| --- | --- | --- | --- |
| EV-001 | the same candidate twice | two runs | identical seeds, identical mutations, identical rows |
| EV-002 | a candidate sandbox | during the turn | `suite/` and `checks/` are not mounted; a stage that tries to read them gets `outside-roots` |
| EV-003 | a task marked `required` for a tool | ablation | the tool is not withheld; the row says `required_by` |
| EV-004 | a candidate that changes `core` | runs | scored by the previous default `core` as well; both rows present |
| EV-005 | a result with a stale baseline | submit | stored, flagged, unusable by `default.prepare` |
| EV-006 | a bench account | any turn | its identity is an ordinary binding; no flag, header or environment variable distinguishes it |
