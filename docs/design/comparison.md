# Comparison · ranking three skill packages under ADR 0004

Written 2026-09-09 from the three designs. The question the benchmark
answers: on a pinned model, which of `skills-all`, `skills-l1` and
`skills-thetis` makes more tasks pass, at what cost, and can a person
trust the number.

## 1. Arms

Four profiles, identical except the rows below. `retriever-none` is the
floor every package is measured against: universal skills only, no
retrieval, no skill tools.

| Arm | `stage/retrieve` | `offer` changes | Other |
| --- | --- | --- | --- |
| `none` | `retriever-none` | none | universal bodies only |
| `all` | `skills-all` | none | every skill, fixed order, truncated to budget |
| `l1` | `skills-l1` | `+ load_skill` (enum of catalog) | catalog + universal bodies; re-injects loaded bodies |
| `thetis` | `skills-thetis` | `+ skill_search`, `+ skill_fetch` | pinned cards; bodies pulled by tool |

The swap is not one name. `l1` and `thetis` each add tools, so the
prompt's tool prefix, `offer_tokens`, and the number of model round trips
change with the package. That is correct: the package is the whole
mechanism, and the benchmark scores mechanisms. The comparison must not
subtract the tool cost back out.

All arms run the same model, pinned by the `llm` door, in a clean host
environment on the published commit, with `embed` available so
`skills-thetis` runs dense plus BM25 (the arm's `embed` availability is
recorded on every row).

## 2. Tasks and gold

Two families from the host suite, plus one control.

**Skill-tagged tasks.** A task is tagged with skill S by ablation that no
package author touches: the host runs the task on `none` with S's body
forced into context and on `none` without it, k runs each, same seeds;
if the pass-rate difference is at least 0.3, the task carries tag S.
This derivation uses no retriever, so it cannot favour one. Tags are
recomputed each rotation.

**Log-derived pairs**, from the Thetis design: a conversation whose
first message is Q, where the agent fetched skill S and the task's test
passed, adds `(Q, S)` to the retrieval gold. Idempotent over the turn
log. Author-written SkillRet pairs are retired to the public half within
two rotations.

**Control tasks.** Tasks tagged with no skill. A package that bloats the
context must not lower the pass rate here; this is where `skills-all`'s
harm shows on a small window.

Sizing against the corpus of 17 top-level skills: three tagged tasks
per skill gives 51, plus 30 controls. See §6 for what that resolves.

## 3. What each package can honestly produce

| Number | `all` | `l1` | `thetis` | Comparable |
| --- | --- | --- | --- | --- |
| `skill_ndcg@4` | undefined (the set is everything) | undefined (a set of loads, unranked) | yes | no |
| `skill_hit@1` | undefined | first `load_skill` names the tag | rank 1 names the tag | only as "first choice correct" |
| `skill_loaded_none` | n/a | tasks with no load | tasks with no `skill_fetch` | informative, not the same act |
| `skill_lift` vs `none` | yes | yes | yes | **yes** |
| `skill_tokens` per turn, by stage | yes | yes | yes | **yes** |
| `offer_tokens` | 0 | yes | yes | **yes** |
| `turn_iterations` | yes | yes | yes | **yes** |
| `suite_cost` per pass | yes | yes | yes | **yes** |
| `cache_hit_turn2` | yes | yes | yes | **yes** |
| `invariance` | 1.0 by construction | yes | yes | **yes** |
| `end_by_limit` | yes | yes | yes | **yes** |

The one table the review page shows for the three, all paired against
`none` on the same model, seeds and variants:

| Arm | `skill_lift` (tagged) | `skill_lift` (control) | `skill_tokens`/turn | `offer_tokens` | `turn_iterations` | `suite_cost`/pass | `cache_hit_turn2` | `invariance` | `end_by_limit` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

Retriever-only numbers (`skill_ndcg`, `skill_hit@1`) are shown in a
second table under the arm that produces them, never in the shared one.

## 4. Mutation policy for skill queries

The Thetis designer found that substituting names, numbers and paths in
a first message can delete the words a skill matches on, so a variant
would measure the mutator, not the retriever. Policy:

- The host builds a stoplist at run time from the corpus: every token in
  any skill's `name`, `description`, `tags`. The mutator never replaces a
  token on that list.
- Gold pairs mark mutable spans; the mutator changes only those spans.
- A variant is rejected, and the seed advanced, if its overlap with the
  original's card vocabulary falls below 0.9.
- `invariance` for skills is: the same skill first (`thetis`), the same
  first load (`l1`), across all variants of one task. `all` scores 1.0
  by construction and that is fine; the number exists to catch a
  matcher that keys on entities.

## 5. Statistics

- k = 5 per arm for any change to `stage/retrieve` (06 says 3; skills
  effects are small and the tool round trip adds variance).
- Paired by task, seed and variant; the interval is the bootstrap over
  task-level differences, 2,000 resamples.
- The gate on any of the three: lower bound of `skill_lift` on tagged
  tasks not below zero, **and** lower bound of `skill_lift` on controls
  not below −0.05. A package may not buy tagged lift with control harm.
- Minimum detectable effect against this corpus, estimated from Thetis's
  turn variance: 51 tagged tasks at k = 5 resolve about 9 points of
  lift; 150 tasks resolve about 5. The page shows the MDE beside every
  number. Below 150 pairs, `skill_ndcg` is shown without a gate.

## 6. Expected outcome, by model

The answer is model-dependent, and the page must say which model it was.

**Local model, 65k window** (`local-qwen`): the trimmed corpus is ~75k
tokens, so `all` truncates to budget and drops most skills; expect
`skill_lift` near zero on tagged tasks, negative on controls, and
`end_by_limit` on long tasks. `l1` costs ~5k tokens of catalog and
universal bodies and depends on whether a 27B model calls `load_skill`
at all; `skill_loaded_none` is the number to watch. `thetis` costs ~3k
and its lift is the ranker's `hit@1`. Expected order: `thetis` ≥ `l1` >
`all`.

**Hosted model, 200k window**: the trimmed corpus fits and is cached
after turn one at about 25× the per-turn cost of `thetis`. Whether the
model uses 36 skills better than 4 is the open question; long-context
attention dilution says no, recall says yes. `l1` improves with a model
that reliably calls tools. Expected order is unknown; that is why the
benchmark exists.

Why model-dependent: in `all` the capacity is the window; in `l1` the
matcher is the model; only in `thetis` is the matcher the package. A
deployment chooses its default per pinned model, and a change of model
re-runs this comparison.

## 7. Benchmaxing holes specific to skills

| Hole | Defence |
| --- | --- |
| Gold written by the package's author, tuned with the ranker (SkillRet's history) | tags by ablation on `none`; pairs derived from the log; authored pairs retire to the public half; held-out half never listed |
| Marking suite-relevant skills `universal` to bypass retrieval | universal bodies count in `skill_tokens`; the universal count is a review-time check across the candidate profile (cap 20); `none` includes universals, so a universal skill's lift belongs to the pack, not the matcher |
| Rewriting `description` or `tags` to match held-out queries | held-out never listed; variants mutate entities; description ≤ 1,024 bytes by the conformance test; a card whose vocabulary grows toward the public half is visible in the diff |
| A retriever that pins a huge set on turn one (cheap after caching) | `retrieve.request.budget` is enforced by the core, which truncates and records `dropped`; `skill_tokens` and `suite_cost` are on the shared table |
| A retriever that also handles `context` and injects bodies outside the skills section | the core renders the `retrieve` answer into the skills section itself; tokens attribute to the stage regardless of section (findings, seam 3) |
| Wrapper prompt-engineering (`l1`'s catalog XML, `thetis`'s card layout) | the rendering of retrieve entries is the core's, from `contract/turn-events`; a package supplies entries, not prose |
| Tags derived on the default profile favour the default retriever | tags are derived on `none` with the skill forced, retriever-free |
| Loading everything through the tool (`l1` loads all 17) | `turn_iterations`, `skill_tokens` and `suite_cost` on the shared table; the control gate |
| Comparing `hit@1` across mechanisms as if one scale | the shared table excludes it; the page labels it per arm |
| Publishing repeatedly to catch a favourable draw | seeds constant across releases; three publishes a day |

## 8. What runs when

At every publish of a package that provides `stage/retrieve` or provides
`skills/<pack>`: the conformance tests, the offline retrieval gold on
the held-out half (for arms that can produce it), and the paired suite
on tagged and control tasks against `none` and against the current
default. The three-way table is a scheduled run, monthly and on a model
change, because it needs all arms and costs about four suite runs.
