# Design · `skills-thetis`

Thetis's skill matcher as a `stage/retrieve` provider for the successor.
Written 2026-09-09 against `00-proposal.md` (seventh draft) and ADRs
0001–0006. Source read: `crates/thetis/src/skill_index.rs` (rank, RRF,
absorption, promotion), `skills.rs` (frontmatter, tree, L0/L1 blocks),
`embeddings.rs` (cache keyed by model, dimensions, card hash),
`skill_manager.rs` (pin once per session), and the retrieval bench, which
survives only on the `bench-results` branch and in history: the working
tree reverted it in `86eb3383`.

## 1. Events and stages

The package exports four stages. Payload shapes marked *assumed* are not
in the proposal; see FINDINGS.

| Event | Handler | What it does |
| --- | --- | --- |
| `index` (*assumed*, fired once at environment start and after a `work/` restart) | `collect` | Receives every skill card the profile's packs answer with: `{id, package, version, parent, children[], brief, whenToUse, tags[], universal, contentHash, bodyPath, resources[]}`. Builds the tree (depth ≤ 3, parent absorption needs it), the BM25 index over `name + brief + whenToUse + tags` (the card, never the body), and asks `service/llm` to embed any card whose `(model, dims, contentHash)` is not in `state/skills-thetis/vectors/`. Universal skills are counted; more than 20 is logged and the first 20 in profile order are kept. |
| `retrieve` `{conversationId, query, limit, pinned?}` | `rank` | If `pinned` is non-empty, returns exactly that set, reading each card at its pinned `package@version` from the registry cache, and does not rank. Otherwise ranks the first user message: whole corpus if `corpus ≤ limit`; dense cosine over 1536-d vectors with reciprocal-rank fusion against BM25 at weight 0.7 when a query vector exists, else BM25 alone; candidate pool 50; parent absorption; truncate; child promotion. Answers `{pinned: [{id, package, version, score, how}]}`. The core persists that answer in the conversation log; every later turn's `retrieve` arrives with it filled. |
| `context` `{sections}` (*assumed to be sectioned; see F3*) | `cards` | Appends to the `skills` section: the L0 block (one brief per universal skill) and one L1 card per pinned skill (brief, when-to-use, tags, child index, related). Bodies are never injected. Reports its byte count for the stage row. |
| `offer` / `call` | `tools` | Offers `skill_search(query, limit)` (rank without pin, `readOnly`) and `skill_fetch(id, file?, offset?, limit?)` (L2 body or an L3 resource from `bodyPath`, `readOnly`, windowed in characters). |

Children: a child card carries `parent`; absorption drops a child when
its parent also ranks; promotion pulls a parent in beneath a ranking
child. `children = "none"` in frontmatter makes a leaf of a populated
directory. `universal = true` cards are always in L0 and never pinned.
`harness/` notes are not skills and are not indexed (proposal chunk 6).

## 2. `package.json`

```json
{
  "name": "skills-thetis",
  "version": "1.0.0",
  "description": "Skill retrieval: dense + BM25 fusion, parent absorption, pinned per conversation.",
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/skill-cards": "^1",
    "contract/llm": "^1",
    "service/llm": "^1",
    "setting/skills.limit": "*",
    "setting/skills.fusion_weight": "*",
    "setting/skills.embedding_model": "*"
  },
  "provides": {
    "stage/retrieve": "1.0.0"
  },
  "stages": "./index.ts",
  "thetis": { "state": "state/skills-thetis/" }
}
```

`stage/context`, `stage/offer` and `stage/call` are handled but not
provided: many stages answer those events, so they are not singletons.
Only `retrieve` has one answerer (F2).

Contracts this package needs, with messages sketched:

- **`contract/skill-cards`** (new; this author writes it as a separate
  package per ADR 0006): the `index` answer above, and `skill_fetch`'s
  result `{id, file, text, offset, total}`. Conformance test: a pack
  that answers `index` produces cards with a non-empty `brief` ≤ 200
  chars, `whenToUse` ≤ 1024, depth ≤ 3, and `contentHash` equal to the
  hash of the card fields. Frontmatter is accepted in Thetis's TOML
  form and in the Agent Skills form (YAML `name`, `description`,
  `metadata`); `description` maps to `brief` and `whenToUse` when the
  Thetis fields are absent (F6).
- **`contract/llm`** (the host's): `complete` (streamed) and **`embed`**
  `{model, input[]} → {vectors[][], dims}`. DECIDED-HERE: the door
  exposes `embed`, metered like `complete`, because embeddings are a
  provider call with a key, and the key never reaches an environment
  (ADR 0005). If the door's version lacks `embed`, `rank` runs BM25 only,
  as Thetis did without a key.
- **`contract/turn-events`** (core's): `index`, `retrieve`, `context`,
  `offer`, `call` as above.

Storage is `state/skills-thetis/`: `vectors/` keyed by
`(model, dims, contentHash)` as Thetis did, so a body edit never
re-embeds; a rebuildable BM25 index. No `service/` is required: the
corpus is under a hundred cards and the index is rebuilt at `index`.

## 3. Pinning across packages

A pin is `[{id, package, version}]`, written by the core into the
conversation log on the first `retrieve` answer. On later turns the
retriever gets it back and resolves each card at its pinned version
from the registry cache, which is mounted read-only in every sandbox
(ADR 0005) and holds every version ever installed. The corpus may be
five skill packs at five versions and the retriever itself at another;
the pin names each card's own package and version, so a pack update
mid-conversation changes nothing the model sees until the conversation
ends. The retriever's own version is recorded on the same log line by
the core (stage row), so `skills-thetis@1.0.0 → 1.1.0` mid-conversation
is also visible and, because the pin is data, harmless: the new version
reads the same pins.

A fresh conversation on the same session (the campaign's case) has no
pin and ranks again. `skill_search` never pins.

## 4. Measurement under ADR 0004

- **SkillRet nDCG@4 and hit@1.** Gold pairs `(query, skill id)` held by
  the host, half held out and never listed; the retired half is public.
  Run offline at every publish that touches `stage/retrieve` or a skills
  pack; no model call for BM25, one `embed` call per unseen query.
- **The gold set's provenance is the risk.** Thetis's SkillRet was 61
  cards and 36 queries written by the same author as the ranker, and its
  fusion weight of 0.7 and absorption rules were tuned against it. A
  package that ships with tuned defaults and the gold that tuned them is
  scoring itself. DECIDED-HERE: the host derives new gold pairs from the
  turn log, idempotently: a conversation whose first message is `Q`,
  where the agent later called `skill_fetch(S)` and the task passed, adds
  `(Q, S)`. One third rotates monthly as the proposal says, and the
  author-written set is retired to the public half within two rotations.
- **Paired lift.** `skill_lift` on suite tasks tagged with a skill:
  default profile with `skills-thetis` versus the same profile with
  `retriever-none` (universal skills only). The pass is the task's own
  test. This is the number that says the ranker earns its place; nDCG
  only says it ranks.
- **`invariance`.** The task mutation substitutes names, numbers and
  paths in the first message; the same skill must rank first. Gold pairs
  mark which spans are mutable so a mutation cannot delete the
  skill-bearing words (F9).
- **Resolution.** 18 held-out queries cannot resolve a 0.03 nDCG delta;
  Thetis's own bench marked its fusion gain "ns". Until the log-derived
  gold grows past ~150 pairs, the gate on this package is `skill_lift`
  and the offline numbers are shown without a gate.

## 5. Porting notes

Lifts as written, about 300 lines of TypeScript: BM25 (k1 1.2, b 0.75,
tokenizer drops punctuation and single characters), cosine over cached
vectors, weighted RRF (K = 60), candidate pool 50, whole-corpus shortcut
at or below the limit, absorption, promotion, deterministic tie order by
id, the embedding cache key and batch size 64, the four disclosure
levels, L0 and L1 block formatting, the frontmatter parser and lint
limits (brief 200, when-to-use 1024, universal 20, depth 3).

Changes: the fusion weight default is 0.7 (Thetis's config file), not
the code's 0.0; the `skill-system` skill says fusion lost on a 35-card
corpus while the bench measured a non-significant gain, so the default
is a setting and the held-out gold decides. Embeddings go through
`service/llm`, never a base URL. `skill_write` and `skill_delete` are
dropped: authoring a skill is editing a skills pack under `work/`, and
the environment restart re-fires `index`. Pins are data in the log, not
a host KV key. `skills-view` (the gateway's read-only interface) becomes
the web UI reading the same `index` answer.

## 6. FINDINGS

Places the proposal was under-specified or wrong for this package, with
the minimum decision taken.

- **F1 · No event enumerates the corpus.** The proposal's event list
  (`input, retrieve, context, offer, call, token, output, end`) has no
  way for a retriever to learn what skills the profile's packs hold.
  DECIDED-HERE: an `index` event at environment start and after every
  restart, answered by any stage with cards; belongs in
  `contract/turn-events`.
- **F2 · `provides: stage/<event>` is a singleton, but most events have
  many handlers.** `context`, `offer`, `call` are answered by every pack.
  DECIDED-HERE: a package provides `stage/<event>` only for events the
  core requires exactly one answer to (`retrieve`); handling is not
  providing. The proposal should say which events are singletons.
- **F3 · `context` has no ordering.** "Stages run in profile order" gives
  no way to guarantee skills before harness notes before history, which
  rule 7 and chunk 6 both assume. DECIDED-HERE: `context` carries named
  sections (`system`, `skills`, `harness`, `history`) and the core fixes
  their order; a stage appends to a section. A flat message list cannot
  express the byte-identical-prefix requirement.
- **F4 · Embeddings are unaddressed.** Nothing says whether the `llm`
  door offers `embed`. DECIDED-HERE: `contract/llm` v1 includes `embed`,
  metered; absent it, BM25 only.
- **F5 · Pins say `package@version` but nothing says who writes them or
  where.** DECIDED-HERE: the core writes the first `retrieve` answer to
  the conversation log and replays it into later `retrieve` events; the
  retriever reads pinned cards at their pinned version from the
  read-only registry cache.
- **F6 · Two skill formats.** The proposal keeps Thetis's `SKILL.md`
  (TOML: brief, when_to_use, tags, children, universal) and takes the
  Agent Skills standard (YAML: name, description). DECIDED-HERE: the
  cards contract accepts both and maps `description` to both Thetis
  fields; the Thetis extras live under Agent Skills `metadata`.
- **F7 · Fusion weight is contradictory in the source.** Code default
  0.0, shipped config 0.7, one skill says fusion lost, the bench says a
  non-significant gain. DECIDED-HERE: 0.7 as a setting; the held-out gold
  decides; not a package constant.
- **F8 · The retrieval bench is not in the tree.** `07-keep.md` lists
  `scripts/retrieval-bench/` to lift verbatim; it was reverted in
  `86eb3383` and exists only in history and on `bench-results`. Recover
  it from `git show 6f3b15d2:scripts/retrieval-bench/` before porting.
- **F9 · Task mutation can destroy the query.** Substituting names and
  paths in a first message may remove the words the skill matches on.
  DECIDED-HERE: gold pairs mark mutable spans; the mutator respects them.
- **F10 · Self-scored gold.** SkillRet's author wrote the ranker and the
  gold; ADR 0004 forbids a package scoring itself but says nothing about
  gold sets. DECIDED-HERE: gold grows from the turn log (first message →
  fetched skill → task passed) and author-written pairs retire to the
  public half.
- **F11 · Statistical power.** 36 queries, 18 held out, cannot resolve
  the effects Thetis measured. Gate on `skill_lift`; show nDCG ungated
  until the derived gold passes ~150 pairs.
- **F12 · Universal cap across packs.** Thetis capped universal skills at
  20 in one directory; with many packs nobody enforces the sum.
  DECIDED-HERE: the retriever logs and keeps the first 20 in profile
  order; the proper place is a check at review that counts across the
  candidate profile.
- **F13 · Token attribution needs a tokenizer.** The stage row wants
  tokens per `context` contributor; a stage has no tokenizer.
  DECIDED-HERE: stages report bytes; the host converts using the
  provider's reported usage ratio for the turn.
- **F14 · Skill authoring tools are gone and nothing replaces the lint
  loop.** Thetis returned lint diagnostics in `skill_write`'s result.
  With authoring as `work/` edits, the type checker's verdict replaces
  the compiler's but nothing runs skill lint. DECIDED-HERE: the
  `contract/skill-cards` conformance test is the lint, and it runs at
  publish; during `work/`, the retriever's `index` logs diagnostics into
  the conversation.
