# Design · `skills-all`

Every skill in the profile is attached to the model's context on every
turn. No retrieval. Written 2026-09-09 against the seventh draft of
[00-proposal.md](../00-proposal.md) and ADRs 0001–0006. Sized against
`/opt/thetis/skills` as it is today.

## The corpus, measured

| Set | `SKILL.md` files | Bytes | Tokens (÷4) |
| --- | ---: | ---: | ---: |
| Whole corpus | 138 | 1,206,277 | ~300,000 |
| Without `moor/` and `torchship/` (36 + 66 files, 907,284 bytes) | 36 | 298,993 | ~75,000 |
| Reference files beside skills (not `SKILL.md`) | 67 | 440,648 | not attached |
| `universal = true` skills | 4 | ~26,000 | ~6,500 |

Windows in the live configuration: the local Qwen server reports 65,536
tokens; hosted models 200,000 to 1,000,000. The whole corpus fits no local
model and only the largest hosted ones. That fact shapes everything below.

## 1. What the package exports

One stage, answering one event. It provides `stage/retrieve`, the same
name `retriever-local` provides, so installing it is a swap (rule 4).

| Event | What the stage does |
| --- | --- |
| `retrieve` | Ignores the query. Enumerates every installed package in the profile that has a `skills/` directory, reads each `SKILL.md`, and answers with the full list in a fixed order: `universal = true` first, then by skill id, whole skills only. If the list exceeds the budget the event carries, it drops from the end of that order, whole skills only, and records the dropped ids in its answer. |

It handles no `context` event. The proposal's table says a skills pack
"answers `context` from `SKILL.md` files" and separately that a runtime
answers `retrieve`; I could not build both without the same skill text
entering the prompt twice. I took `retrieve` alone and assumed the core
renders the answer into the pinned-skills block of `context` (see
FINDINGS 1).

Payload shapes I had to assume, written as I would put them in
`contract/turn-events`:

```
retrieve.request  { conversation, turn, query: string, model: string, budget: number /* tokens available for skills */ }
retrieve.answer   { skills: [ { id, package, version, path, text } ], dropped: [ id ], order: "fixed" }
```

`budget` and `model` are not in the proposal. Without them the stage
cannot know it is about to exceed a 65k window (FINDINGS 2).

## 2. `package.json`

```json
{
  "name": "skills-all",
  "version": "1.0.0",
  "description": "Attach every skill in the profile on every turn. No retrieval.",
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/skills-corpus": "^1"
  },
  "provides": {
    "stage/retrieve": "1.0.0"
  },
  "stages": "./index.ts"
}
```

No `setting/`, no `secret/`, no `spawn`, no `cap/`. The order is fixed
in code so that the answer is a pure function of the installed skill
files, which is what rule 7 and ADR 0004 both want.

`contract/skills-corpus` does not exist in the proposal. It is the
contract every skills *content* package and every `stage/retrieve`
provider must share, or a runtime cannot find skills at all (FINDINGS 3).
Sketch:

```
contract/skills-corpus 1.0.0
  layout:     <package>/skills/<id>/SKILL.md, children as subdirectories
  frontmatter: name, brief, when_to_use, universal, tags[], children, version   (Thetis's format, unchanged)
  provides:   a content package provides skills/<id> for each skill it ships, so ids are singletons per profile
  conformance: frontmatter parses; brief ≤ 300 bytes; ids unique; children resolve; body is UTF-8 Markdown
```

`contract/turn-events` is shipped by `core`. For this package to be
checked at publish, that contract needs a conformance test for
`stage/retrieve` providers: given a fixture profile, the answer validates
against `retrieve.answer`, is identical across two calls, and every `id`
in it exists in the fixture (FINDINGS 4).

## 3. The byte-identical rule

Rule 7: the retrieved skills are pinned per conversation by
`package@version` and the prompt stays byte-identical until the
conversation ends.

Satisfied, with two conditions the proposal does not state.

**Who pins.** The stage is stateless and serves many conversations; it
cannot remember a pin. I assumed the core writes a `pinned` record into
the conversation's JSONL after the first `retrieve` of a conversation,
listing `package@version` and a content hash for every skill in the
answer, and on later turns passes that record back in `retrieve.request`
so the stage serves exactly those versions (FINDINGS 5).

**Where the old bytes are.** When `skills-rpg` moves from 1.9.0 to 2.0.0
mid-conversation, the environment's `node_modules`-equivalent now holds
2.0.0. The stage must read 1.9.0 from somewhere. Inside the sandbox only
the environment directory, the person's spaces and the registry cache
exist (ADR 0005). So the registry cache must keep every version any live
pin references and expose it as `<cache>/<name>/<version>/`, read-only
(FINDINGS 6). Given that, the stage reads pinned versions from the cache
and unpinned ones from the profile, and the prompt bytes do not move.

**Cost per turn against the real corpus,** at Thetis's measured cache
behaviour (turn two onward ~99 % of the prompt served from cache):

| Corpus attached | Prompt tokens | Fresh turn at $3/M | Cached turn at $0.30/M |
| --- | ---: | ---: | ---: |
| Whole (138 skills) | ~300,000 | $0.90 | $0.09 |
| Without moor/torchship (36) | ~75,000 | $0.23 | $0.023 |
| `retriever-local`, k = 4 (Thetis today) | ~3,000 | $0.009 | $0.001 |

Every turn, before the conversation itself. Thetis's whole-system turn
cost $0.0106 fresh and $0.0010 cached. `skills-all` on the trimmed
corpus is 25× that on a cached turn and cannot run on the local model at
all. The compactor cannot recover any of it: the pinned block is prefix
and is exempt from compaction by rule 7 (FINDINGS 7).

## 4. Measurement under ADR 0004

nDCG and hit@1 are meaningless: the set is everything. What is
meaningful, all paired against the default profile (`retriever-local`)
on the same model, tasks and seeds:

| Number | What it says for this package |
| --- | --- |
| `suite_lift` | the only verdict. The hypothesis is that attaching everything beats retrieving four; the suite decides |
| `suite_cost` | expected to be worse by the table above; the review page shows it beside the lift |
| `skill_lift` (pack level) | lift of the whole pack over no skills at all, one ablation, not 138 |
| `context_tokens` by stage | from the stage rows; attributes the cost to this package |
| `end_by_limit` | turns that died on context; expected to rise on the trimmed corpus, certain on the whole one |
| `invariance` | must be 1.0: the same answer for every mutated variant. A value below 1.0 means the stage is not the pure function it claims |
| `regressions` | unchanged |

Two things the measurement cannot do. It cannot run the whole corpus on
the local model, and the suite runs on the model the `llm` door pins; if
that is the local model, this package fails every task and the lift is
−100 %, which is correct and uninformative (FINDINGS 8). And it cannot
give per-skill lift without 138 paired ablations; a package that
attaches everything gets one number for the whole pack.

## 5. Adding a skill

1. The author's agent puts a content package (say `skills-team`) under
   `work/`, adds `skills/<id>/SKILL.md`, and adds `skills/<id>` to
   `provides`.
2. The environment restarts at the turn boundary; `skills-all` finds the
   new directory on the next `retrieve`. Conversations already open keep
   their pin; new ones include it. The person sees it on the next new
   conversation.
3. Publish. The checks run `contract/skills-corpus` conformance (parse,
   brief length, id uniqueness across the profile), the semver floor
   (new `skills/<id>` provision → at least minor; removed → major; body
   text only → patch, DECIDED-HERE), and the suite, paired, because a
   `retrieve` stage's input changed.
4. Review shows the diff, the lift, and the cost delta, which for this
   package is the new skill's bytes on every turn.

Nothing in `skills-all` changes when a skill is added. That is its whole
argument.

## 6. FINDINGS

1. **Two paths for skills into the prompt.** Chunk 2 says a skills pack
   "answers `context` from `SKILL.md` files" and a runtime answers
   `retrieve`. Built literally, skill text enters twice. DECIDED-HERE:
   only `stage/retrieve` produces skill text; the core renders the answer
   into the pinned-skills block of `context`; a content package has no
   stage at all. The proposal should delete the `context` role for skills
   packs or say the core does the rendering.
2. **`retrieve.request` has no budget and no model.** A stage cannot
   size its answer to the window. Thetis had `context_window:<model>`
   in `context_window.rs`. DECIDED-HERE: `retrieve.request` carries
   `budget` and `model`; the core computes `budget` from the window
   minus reserve.
3. **No contract for skill content.** After round four a package exports
   only `stages`; nothing says how a skills content package exposes its
   files or how a runtime finds them. DECIDED-HERE: `contract/skills-corpus`
   with the layout, Thetis's frontmatter, `provides: skills/<id>` per
   skill (singleton ids per profile), and a conformance test. Without it
   two runtimes would index two different things.
4. **`stage/<event>` providers have no contract to be tested against.**
   ADR 0006 tests providers of `service/<name>` against
   `contract/<name>`; a `stage/retrieve` provider has only
   `contract/turn-events`. DECIDED-HERE: `contract/turn-events` carries
   a conformance test per event for providers of `stage/<event>`.
5. **Who pins.** Rule 7 says the set is pinned per conversation; it does
   not say by whom or where. A stage is stateless. DECIDED-HERE: the core
   writes a `pinned` record into the conversation JSONL after the first
   `retrieve` and passes it back on later turns.
6. **Old versions must stay readable inside the sandbox.** Rule 7 needs
   the bytes of a superseded package version; ADR 0005 mounts only the
   environment, spaces and the registry cache. DECIDED-HERE: the cache
   keeps every version a live pin references and exposes
   `<cache>/<name>/<version>/` read-only; rule 14's deletion must respect
   live pins, not only profile pins.
7. **Pinned skills and compaction.** Rule 7 exempts the pinned block from
   change; chunk 6 says compaction is a view. Nothing says whether the
   pinned block counts against the compaction budget. For this package
   the block is 75k–300k tokens and the compactor can reclaim none of
   it. The proposal should state: pinned skills are outside the
   compactor's reach and inside the window budget.
8. **The suite's model decides this package's fate.** ADR 0004 pins the
   model per suite run. A package whose viability depends on the window
   cannot express that as a requirement: `cap/` is machine facts. Either
   `retrieve.request.model` is enough (the stage truncates and the lift
   shows the truth) or a requirement `model/context >= N` is needed.
   DECIDED-HERE: truncate, record `dropped`, let the lift speak; add no
   requirement kind.
9. **Rule 9 is silent on skills.** A profile change writes one line into
   the conversation and refuses a missing tool; a skill that vanished
   from the profile mid-conversation is still served from the pin. That
   is right, but the one line should also name skill packages that
   changed, or the person cannot tell why a new conversation behaves
   differently.
10. **Cost is invisible at review unless `context_tokens` by stage is on
    the page.** ADR 0004's review page lists `suite_lift`, `suite_cost`,
    `regressions` and "rows that moved". For this package the decisive
    row is tokens per turn attributed to the stage; it must be one of
    the rows that can move.
