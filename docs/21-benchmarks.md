# 21 Benchmarks

The benchmarks measure the harness, not the model. They answer one question: when a package changes what
Thetis puts in front of the model, is the result better, and at what cost?

A package opts in through its manifest. A suite of tasks runs against every package that opted into it, plus
a floor that has none of them. Each package then carries a `BENCH.md` that compares it with its peers.

## 1. What is measured

There are two probes. The first is deterministic, needs no model and is free: it measures what the harness
made available for a request and what that cost. The second puts a real model in the loop, costs money, and
answers a question the first cannot — whether the model does the right thing with what it was given.

A provider sees the assembled `ProviderCall`: the system prompt, the tool schemas, the conversation, the
parameters, and the cache hints. That is the only place in the system where all five are final. The bench
therefore measures from a provider of its own, `@thetis/provider-bench`, which records what it was given and
answers from a script. It never reaches the network.

Two properties of the kernel make this work with no kernel change:

- `Enumerator.defaultPlan` schedules a step only when its declared phase is in `config.phases`
  (`packages/kernel/src/pipeline/enumerator.ts`). The bench adds a phase named `bench`; no production
  configuration lists it, so a bench step cannot run on an ordinary turn.
- `ProviderRegistry.resolve` falls back to a provider that advertises the model `*`
  (`packages/kernel/src/providers.ts`). The bench puts its addressing in `call.model` as
  `bench/<run>/<arm>/<task>/<attempt>`, so the query text reaches the harness exactly as the suite wrote it.
  This matters: a retriever matches on the query, and a marker added to it would change the thing measured.

**Caution:** do not measure from a step. `ctx.call.messages` is empty for the whole pipeline — only the
built-in call fills it from the conversation — and `@thetis/prompt-cache` adds its hints in the `call` phase,
after a `bench` step has run. A step sees neither.

## 2. Claims are checked, not believed

Every record in the capability corpus carries an opaque token in its body, called a canary. A mechanism can
reformat a body however it likes and must keep the token. The bench then finds what actually reached the
prompt by looking for canaries, with no knowledge of how the mechanism stores anything.

A package also reports what it believes it surfaced. That report is never scored. It is compared against the
canaries, and the difference is reported:

| Number | Meaning |
|---|---|
| `adapterLies` | Claimed as in the prompt with no canary to show for it. This fails the run. |
| `adapterModest` | Reached the prompt and was not claimed. Not a failure. |
| `offeredUnverified` | Claimed reachable with nothing naming it and nothing returning it. Excluded from every score. |

Reach is proved differently for each shape of mechanism. A body in the prompt is proved by its canary. A
catalogue entry is proved by the prompt naming the capability. A search tool is proved by returning the
capability when the bench calls it with the task's own words. None of the three is taken on trust.

## 3. Suites

| Suite | Needs | Measures |
|---|---|---|
| `assembly-cost@1` | nothing | What a package costs the prompt: bytes by segment, how much of the prefix survives a turn, how many steps run. Any package can opt in. |
| `tool-recall@1` | authored gold | What share of the offered tools a task needed, and what the rest cost. |
| `skill-recall@1` | the capability corpus | Which capabilities a request made reachable, how far away they were, and what the rest cost. |

Any suite runs against a real model with `--model`. The same provider then forwards to the real one and goes
on measuring, so the figures are the same figures with token counts, cost and selection added.

A suite lives in `packages/bench/suites/<name>/`: `suite.json`, `tasks.jsonl`, an optional `script.json` for
the provider, and for `skill-recall@1` a `corpus.json` and `corpus.jsonl`.

## 4. Opting in

```json
"thetis": {
  "type": "loader",
  "steps": [
    { "id": "pin", "phase": "prompt", "export": "pin" },
    { "id": "bench-import", "phase": "bench", "export": "importCorpus" },
    { "id": "bench-report", "phase": "bench", "export": "benchReport" }
  ],
  "bench": {
    "suites": ["skill-recall@1"],
    "corpus": "caps@1",
    "peerGroup": "skills",
    "importer": "importCorpus",
    "adapter": "benchReport"
  }
}
```

| Field | Use |
|---|---|
| `suites` | Required. The suites this package runs, each named `id@version`. |
| `corpus` | The corpus the package imports. Required by any suite that has one. |
| `peerGroup` | Which packages this one is compared against. Default: the first suite id. |
| `importer` | The export that reads the corpus. Must also be a step with phase `bench`. |
| `adapter` | The export that reports what was surfaced. Must also be a step with phase `bench`. |
| `arms` | Names of internal configurations, when a package has more than one. |
| `report` | Where the generated view goes inside the package. Default `bench`. |

`importer` and `adapter` must appear in `thetis.steps` with `phase: "bench"`. That declaration is how they
are called, and it is why they cannot run outside a bench. `thetis bench verify <dir>` checks this without
running anything.

The kernel does not read `thetis.bench` and does not validate it. `validateBench` in
`packages/bench/src/manifest.ts` does, because the kernel never needs the field and a better error belongs
where the author is working.

### 4.1 The two seams

**Corpus in.** The bench writes the corpus to `bench/corpus.json` under the userspace home before the first
turn. The importer reads it with `env.readFile` and builds whatever representation it likes, anywhere under
`env.cwd`. It runs on every bench turn, so it must be idempotent.

**Ids out.** The adapter returns a claim in `harness["@thetis/bench"].claims[<package>]`:

```js
{ direct: ["cap.a"], offered: ["cap.b"], reach: "catalogue", ranked: ["cap.b", "cap.a"] }
```

`direct` is in the prompt now. `offered` is one tool call away. `reach` says which kind of call: `catalogue`
for a named entry, `search` for a ranked query. `ranked` is an order, and only a mechanism that ranks has one.

**Note:** the kernel replaces `harness` and does not merge it. An adapter must spread what is already there,
or it will delete another package's state.

## 5. What may be compared

A number goes in the shared table only when every arm in the suite can produce it. `ndcg`, `hit_at_1` and
`mrr` cannot: a mechanism with no order has no ranking to score, and a first choice means a different act for
a loader than for a ranker. They are printed under the arm that produced them and never beside another's.

Three figures are always printed together — `recall_reach`, `undershoot` and `overshoot_bytes` — because a
package wins any one of them by degenerating. Attach everything and undershoot is zero. Attach nothing and
overshoot is zero. Only the three together say anything.

Every comparison is paired by task against the floor, which cancels the constant cost of the harness: the
guide, the package list, the fence round trip. Intervals come from a seeded bootstrap over tasks with 2,000
resamples, and the half-width is printed beside every mean as the smallest difference that many tasks can
resolve. A win/tie/loss count sits beside each paired figure, because a mean can hide one pathological task.

### 5.1 With a model in the loop

`--model <id>` makes `@thetis/provider-bench` forward every call to a real provider and record what comes
back. The address still rides in `call.model` and the real model id is put back at the boundary, so the query
text is untouched either way and the measurement is the same measurement.

| Number | Where |
|---|---|
| `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache_read_ratio` | shared |
| `bytes_per_token` | shared — the only place bytes and tokens meet, so a drift from the floor's ratio is visible |
| `select_at_1` | per arm |

`select_at_1` is per arm and not shared, for the same reason `hit_at_1` is. It asks whether the model chose
correctly when the mechanism asked it to choose. A mechanism that pins what it believes is right never asks,
so it has no selection to score, and counting that absence as a failure would compare two different acts.

**Caution:** this is expensive. One task of `skill-recall@1` on a cheap model cost about twelve cents, mostly
because the model searched seven times before answering. Use `--tasks <n>` and `--max-cost <usd>`. The ceiling
governs whether to start another call, not what one costs — a call's price is not known until it is made — so
the last call may carry the total a little past the line.

### 5.2 Units

Bytes, not tokens. The repository has no tokeniser and adding one would be its first runtime dependency.
Bytes are also kept apart by segment — `system`, `tools`, `messages` — because byte density differs between
prose and a JSON schema, and a single total would understate the arm that spends its bytes on tool schemas.
`non_ascii_ratio` is printed as a tripwire for an arm whose bytes buy an unusual number of tokens.

### 5.3 Latency

Absolute milliseconds are not committed. The fence opens lazily inside the first request, the userspace is
seeded inside the first send, `fence.sandbox: "auto"` resolves differently on different machines, and
`step.end.ms` includes serialising the whole context across the fence. A ratio against the floor is printed
only when a suite has at least 30 tasks and the paired difference clears its own interval. Below that the
verdict changes between consecutive runs of the same code, which is a reason to say nothing. Raw timings stay
in `report.json`.

## 6. The artifact

One authoritative report per suite at `<root>/bench/<suite>/report.json`, holding every arm. Each
participating package then carries `bench/<suite>/report.json` and a `BENCH.md` that renders those reports
filtered to itself, its peers and the floor.

The package's copy carries the suite's digest. A copy whose digest no longer matches is stale, which is also
what catches a fork that copied a package directory along with its numbers.

`digest = sha256(canonical(inputs))` over the corpus digest, the suite digest, the scorer version, the seed,
the model, the sandbox mode, and every arm as `name@version`. It is over inputs only, so writing a report
cannot change its own digest. A peer publishing a new version invalidates the comparisons it appears in,
which is what a comparison is for.

**Note:** the scorer version is this package's version, read from its own manifest. Change how a number is
computed and you must bump `packages/bench/package.json`, or reports will keep their old digest and will not
be rewritten.

A peer's row appears only when its report used the same corpus digest and the same suite digest. Otherwise it
is left out and the reason is stated. Two incomparable numbers printed side by side is the worst thing this
system could do.

## 7. Gold

`skill-recall@1` imports its corpus and its judgements from **SkillRet** (`ThakiCloud/SKILLRET`, Apache-2.0),
a public collection of real agent skills with checked relevance judgements. It is imported rather than
authored because gold that decides which package wins must not be written by anyone with a stake in the
answer. `packages/bench/suites/skill-recall-v1/GOLD.md` records the revision, the sampling rule and the
splits. `packages/bench/scripts/import-skillret.mjs` rebuilds it deterministically.

Those bodies are other people's work, under MIT and Apache-2.0. Each record keeps its author, repository,
source URL and licence, and `packages/bench/suites/skill-recall-v1/NOTICE.md` lists all 287 with their terms.
A corpus that stripped them would be a redistribution without the terms it was given under.

`tool-recall@1` is authored, because no public dataset knows about Thetis's own tools.
`packages/bench/suites/tool-recall-v1/GOLD.md` says why that is defensible here and would not be for skills.

Tasks are split `tune`, `holdout` and `holdback`. The held-back split lives in `$THETIS_HOME/bench/holdback/`
— outside the packages directory, which every fence mounts read-only, so package code cannot read the
questions it is scored on. That is enforced by the fence, not by a convention.

Every suite has control tasks: questions no capability should help with. Without them an arm that attaches
everything scores perfectly, because it can only be caught where the right answer is to attach nothing.

## 8. Running

```sh
npm run bench -- run assembly-cost@1
npm run bench -- run skill-recall@1 --write
node bin/thetis.js bench run tool-recall@1 --write --sandbox none
node bin/thetis.js bench verify packages/tools-files
```

| Option | Effect |
|---|---|
| `--write` | Write the suite report and each participating package's view. Without it nothing is written. |
| `--force` | Write even when the digest is unchanged. |
| `--out <dir>` | Also write the suite report to this directory. |
| `--sandbox` | `auto`, `bwrap` or `none`. Recorded in the report; arms of one report must share it. |
| `--package <dir>` | Add a package that is not under `packages/`. |
| `--model <id>` | Put a real model in the loop. Costs money. |
| `--max-cost <usd>` | Stop starting calls once this much has been spent. Default 1. |
| `--tasks <n>` | Take only the first n tasks. For use with `--model`. |

The exit code is 0 when every arm conformed and 1 when one did not.

A run boots its own kernel in a temporary `$THETIS_HOME` and deletes it afterwards. It never touches the
data directory and never talks to a running daemon: the arms, the phases and the installed set all have to be
controlled for the numbers to mean anything.

## 9. In continuous integration

Every suite is deterministic and free, so the reports in the repository must be exactly what the code
produces. `.github/workflows/ci.yml` regenerates them all and fails on any difference, then runs them again
and fails if anything was written at all.

That second check is the one worth understanding. A retriever that answers differently on identical input
cannot be compared with anything, so non-determinism is a defect the build reports rather than noise it
averages away.

A run against a real model is `.github/workflows/bench-model.yml`, by hand only, with a model, a task count
and a cost ceiling as inputs. Its result is a run artifact and is never committed.

## 10. Where it appears

The control panel shows a bench badge on each package row, and the suites and last run in the package detail.
The marketplace index carries `bench.suites`, which is how a comparison finds peers in other registries
without cloning them. `@thetis/harness-core` lists a package's suites in the system prompt and leaves its
bench steps out of it, because a step that cannot run on an ordinary turn should not be described as if it
could.

## 11. Reference mechanisms

`packages/bench/fixtures/arms/` holds four small packages that share no internal representation. They exist
so the contract can be shown to work before a real capability package is written:

| Arm | Mechanism |
|---|---|
| `skills-flat` | Every body in the prompt, in corpus order, until a byte budget runs out. |
| `skills-l1` | Every name and description in the prompt; bodies behind a `load_skill` tool. |
| `skills-rank` | BM25 over the corpus; the best few bodies pinned, the rest behind a `skill_search` tool. |
| `skills-liar` | Claims capabilities it never injected. It exists so the bench can be shown catching it. |

The first three are scored in one table. The fourth is used only by
`packages/bench/test/skills.e2e.test.ts`, which asserts that its claims are caught and that it is scored on
the evidence instead.

## 12. What the numbers do not say yet

- **The gold is imported, not derived.** The judgements say which capability a person thought a question
  needs. They do not say which capability *this harness* needs to answer it. Only ablation can establish that:
  withhold a capability, run the task against a model, and see whether the pass rate falls. Per-capability
  ablation is not built. Withholding a whole package is, because the floor arm is exactly that.
- **Nothing scores whether a task was answered.** There is no check script and no judge. `select_at_1` is as
  close as it gets: it says the model reached for the right thing, not that it then did the right thing.
- **No suite runs against a model by default.** `--model` is a deliberate act with a bill attached, and no
  committed report carries model figures unless someone chose to pay for them.

Each report states its own limits in a **Notes** section. Read them before quoting a figure.
