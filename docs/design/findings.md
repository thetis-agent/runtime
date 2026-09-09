# Findings · what three designs found wrong or missing in the proposal

Reconciled from the FINDINGS sections of `skills-all.md`, `skills-l1.md`
and `skills-thetis.md`. Where the designers conflicted, one resolution
is recommended with its reason. "Needs ADR" marks a change to an
accepted decision.

## 1. Skills data exposure

**They decided:** `all`: a content package has no stage; a
`contract/skills-corpus` with `provides: skills/<id>` per skill. `l1`: a
`skills` data export beside `stages` and `spawn`; `contract/skills-pack`
with `provides: skills/<pack>`. `thetis`: packs answer an `index` event
with cards; `contract/skill-cards`.

**Resolution:** a skills pack is data, not a stage. `package.json` gains
`skills: "./skills"` as a third export beside `stages` and `spawn`, and
the pack `provides: skills/<pack>`. Skill ids must be unique across the
profile; a duplicate is refused at install with the one-sentence gap
naming both packs (not "later wins", which hides a mistake). One
contract, `contract/skills`, covers the pack layout, the frontmatter,
the card shape and the retrieve messages, because a runtime needs all
of them together and three names for one thing is how they drift.
Reason: round four's "a skills pack is a stage that answers `context`"
cannot be built; a matcher cannot see another stage's files, and built
literally the text enters the prompt twice. **Changes chunk 2. Needs
ADR** (it amends round four's "only stages").

## 2. The retrieve contract and the index event

**They decided:** `all`: `retrieve.request` carries `budget` and
`model`. `l1`: entries may omit `body`; the response carries `pinned`.
`thetis`: an `index` event at environment start, answered with cards.

**Resolution:** no `index` event. Because packs are data (seam 1), a
retriever reads `skills/` directories from the installed profile
directly; what it needs is a lifecycle hook, not a turn event: a stage
module may export `init(profile)`, called once at process start with the
resolved package list and paths, and again after a `work/` restart.
`retrieve.request`: `{ conversation, turn, query, k, budget, model,
pinned? }`; `budget` is the window minus reserve minus what is already
pinned, computed by the core. `retrieve.answer`: `{ entries: [ { id,
pack, version, path, contentHash, universal, body? } ], dropped: [id] }`.
Entries without `body` are legal, so a model-driven matcher is a valid
provider. **Changes chunk 2 and `contract/skills`.**

## 3. Context sections, ordering, protection, compaction

**They decided:** `all`: the core renders the retrieve answer into a
pinned-skills block. `thetis`: `context` has named sections in a fixed
order. `l1`: messages need a `protected` tag that compaction honours,
for loaded bodies.

**Resolution:** all three, together. `context` carries named sections
in an order the core fixes: `system`, `skills`, `harness`, `history`. A
stage appends to a section; it cannot reorder. Everything before
`history` is the prefix. The core itself renders the `retrieve` answer
into `skills` with one fixed wrapping from `contract/turn-events`, so a
retriever has no `context` stage and cannot prompt-engineer its wrapper.
`history` entries may carry `protected: true`, which the compaction
stage keeps; a loaded skill body is protected. The pinned prefix is
outside the compactor's reach and inside the window budget. Reason: a
flat list in profile order cannot express the byte-identical prefix
that rule 7 requires. **Changes chunks 2 and 6. Needs ADR** (same
record as seam 1).

## 4. Pinning: who, where, what surface

**They decided:** all three: the core writes the first `retrieve` answer
to the conversation JSONL and replays it; old versions are read from
the registry cache. `l1` adds that the pin must cover the `offer`
schemas, since the provider's cache prefix is tools, then system.

**Resolution:** the core writes a `pinned` record `{ id, pack, version,
contentHash }[]` after the first `retrieve` and passes it back on every
later turn; a retriever given `pinned` serves exactly that set. The pin
covers everything before the first user message: `system`, `skills`,
and the `offer` schemas. A tool whose schema derives from data (the
`load_skill` enum) is pinned with it. Rule 7 is rewritten: "everything
before the first user message is pinned per conversation; the prompt
stays byte-identical until the conversation ends." Rule 9's one line
also names skill packs that changed. **Changes chunk 13 rules 7 and 9.**

## 5. Singleton stages versus handlers

**They decided:** `thetis`: `provides: stage/<event>` only for events
the core requires exactly one answer to; handling is not providing. The
others assumed the same without saying it.

**Resolution:** adopt it. `contract/turn-events` lists which events are
singletons (`retrieve`; the core adds others when it requires one
answer). Every other event is handled by any number of stages, in
profile order, declared by exporting the stage. **Changes chunks 2 and
3; `contract/turn-events`.**

## 6. The semver floor and derived schemas

**They decided:** `l1`: a schema field marked `derived` is excluded from
the floor. `thetis`: `context` handlers are invisible to the floor, so a
pack that changes what it injects is caught only by lift. `all`: a
removed skill is a major for the pack.

**Resolution:** a field marked `derived` (an enum built from installed
data) is excluded from the floor; the change belongs to the pack that
changed the data. For a skills pack the floor diffs the `skills/`
directory listing: a removed id is a major, an added id a minor, a
body-only change a patch. Content changes are caught by `skill_lift`,
which is what lift is for. **Amends ADR 0006 §3.**

## 7. Sandbox mount paths and cache retention

**They decided:** `l1`: `/packages/<name>@<version>/` read-only. `all`:
the cache keeps every version a live pin references; rule 14's deletion
must respect live pins.

**Resolution:** both. ADR 0005 fixes the registry-cache mount at
`/packages/<name>@<version>/`, read-only in every sandbox, so a
`location` the model reads is stable across environments. Rule 14
becomes "deleted unless a profile or a live conversation pins it".
**Amends ADR 0005; changes rule 14.**

## 8. Frontmatter format

**They decided:** `all`: Thetis's TOML unchanged. `thetis`: accept both,
map `description` to `brief` and `whenToUse`. `l1`: the Agent Skills
standard only, one conversion script.

**Resolution:** the standard only: YAML `name` (directory name),
`description` (Thetis's `brief` plus `when_to_use`, ≤ 1,024 bytes),
`metadata` for `tags`, `related`, `universal`, `title`; children by
directory. One conversion script, run once. The conformance test warns
over 500 lines, as the standard's validator does. Reason: 07-keep and
10-prime-agent already took the standard; a dual parser is two code
paths to tune, and the corpus's own `skill-creator` at 7.8k bytes marked
universal is the kind of thing a single validator catches. The
universal cap (20) is checked at install across the profile. **Changes
chunk 2 and 07-keep.**

## 9. The `llm` contract and embeddings

**They decided:** `thetis`: `contract/llm` v1 includes `embed`, metered;
absent it, BM25 only.

**Resolution:** adopt. The host's `llm` door provides `service/llm` under
`contract/llm` with `complete` and `embed`, both metered, the key never
leaving the host. A bench row records whether `embed` was available.
**Changes chunk 10.**

## 10. Measurement

**They decided:** `all`: `context_tokens` by stage must be a row that can
move; the model decides the package's fate and that is uninformative on
a small window. `l1`: say which number each provider can produce;
`hit@1` and `nDCG` are not one scale. `thetis`: mutation must respect
card vocabulary; the gold set was self-scored; 36 queries have no power;
tokens need a tokenizer the stage lacks; the universal cap; the lint
loop is gone.

**Resolution**, all into 06 and `comparison.md`: the skills table names
which numbers each provider produces and shares only `skill_lift`,
`skill_tokens`, `offer_tokens`, `turn_iterations`, `suite_cost`,
`cache_hit_turn2`, `invariance`, `end_by_limit`; tags come from ablation
on `retriever-none`, pairs from the log, authored gold retires; the
mutator keeps a card-vocabulary stoplist; k = 5 for retriever changes
and the MDE is shown; `nDCG` is ungated below 150 pairs; stages report
bytes and the host converts with the turn's usage ratio; `budget` and
`dropped` are rows; the control-task gate stops tagged lift bought with
control harm; the `contract/skills` conformance test is the skill lint,
run at publish and, during `work/`, by `init` into the conversation.
**Changes 06.**

## 11. Smaller items

- User-explicit activation (`/skill x`) has no path: `input` gains an
  optional `activate: [id]`, which the core adds to the pin as forced
  entries. Changes `contract/turn-events`.
- The retrieval bench is not in the working tree; recover it from
  `git show 6f3b15d2:scripts/retrieval-bench/` before porting. Changes
  07-keep.
- The fusion weight is a setting (0.7), decided by held-out gold, never
  a constant.
- A package whose viability depends on the window cannot say so as a
  requirement; correct: the lift on the pinned model says it, and the
  page names the model.

## What needs an ADR

One record, 0007: skills packs as data exports; one `contract/skills`;
`context` as core-ordered sections with a `protected` flag and the core
rendering `retrieve` into `skills`; the pin surface as everything before
the first user message; `stage/<event>` singleton only where the core
says so. Two amendments: 0005 (mount path, retention by live pin) and
0006 (`derived` fields; data-directory floor for packs).
