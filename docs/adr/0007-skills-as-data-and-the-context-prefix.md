# ADR 0007 · Skills packs are data; context has core-ordered sections; the pin covers the prefix

**Status:** Accepted · 2026-09-09; §8 superseded by ADR 0008 the same day
**Deciders:** the operator; this session, from the design exercise in `design/`
**Amends:** ADR 0005 §2 (mount path, retention), ADR 0006 §3 (derived fields)
**Supersedes:** round four's sentence "a skills pack is a stage that answers `context`"

## Context

Three subagents designed three skill packages against the seventh
draft: attach everything, the Agent Skills level-1 design with a load
tool, and Thetis's matcher as a `stage/retrieve` provider. They made
37 decisions where the proposal was silent and contradicted each other
on the seams: three names for the skills contract, an `index` event or
none, packs as data or as stages. `design/findings.md` reconciles them.
The exercise found that round four's "a skills pack is a stage that
answers `context`" cannot be built: a matcher cannot see another
stage's files, and taken literally the skill text enters the prompt
twice.

## Decision

1. **A skills pack is data.** `package.json` has three exports:
   `stages`, `skills` (a directory), and `spawn`. A pack `provides:
   skills/<pack>`. Skill ids are unique across a profile; a duplicate is
   refused at install naming both packs. One contract, `contract/skills`,
   covers the pack layout, the frontmatter (the Agent Skills standard
   only: `name`, `description`, `metadata`; children by directory), the
   card shape, and the `retrieve` messages. Its conformance test is the
   skill lint, run at publish and, under `work/`, by `init` into the
   conversation. It warns over 500 lines. The universal cap of 20 is
   checked at install across the profile.
2. **No `index` event.** A stage module may export `init(profile)`,
   called once at process start with the resolved package list and
   paths, and again after a `work/` restart. A retriever reads `skills/`
   directories from the installed profile.
3. **`retrieve` is the singleton.** `retrieve.request` carries
   `{ conversation, turn, query, k, budget, model, pinned? }`, with
   `budget` computed by the core as the window minus reserve minus what
   is already pinned. `retrieve.answer` carries `{ entries: [ { id, pack,
   version, path, contentHash, universal, body? } ], dropped }`. Entries
   without `body` are legal, so a model-driven matcher is a valid
   provider. `provides: stage/<event>` is a singleton only for events
   `contract/turn-events` lists as such; every other event is handled by
   any number of stages, in profile order, declared by export.
4. **`context` has named sections in an order the core fixes:**
   `system`, `skills`, `harness`, `history`. A stage appends to a
   section and cannot reorder. The core renders the `retrieve` answer
   into `skills` with one fixed wrapping from `contract/turn-events`; a
   retriever has no `context` stage. `history` entries may carry
   `protected: true`, which compaction keeps; a loaded skill body is
   protected. The pinned prefix is outside the compactor's reach and
   inside the window budget.
5. **The pin covers everything before the first user message:**
   `system`, `skills`, and the `offer` schemas. The core writes `pinned:
   { id, pack, version, contentHash }[]` to the conversation after the
   first `retrieve` and passes it back on every later turn; a retriever
   given `pinned` serves exactly that set. `input` may carry `activate:
   [id]` for explicit activation, added to the pin as forced entries.
6. **Semver floor, amended.** A schema field marked `derived` (an enum
   built from installed data) is excluded from the floor; the change
   belongs to the pack that changed the data. A skills pack's floor
   diffs its `skills/` listing: a removed id is a major, an added id a
   minor, a body-only change a patch. Content changes are caught by
   `skill_lift`.
7. **Sandbox, amended.** The registry cache is mounted read-only at
   `/packages/<name>@<version>/` in every sandbox, so a path the model
   reads is stable across environments. A version pinned by a live
   conversation is kept, not only one pinned by a profile.
8. **`contract/llm` v1 has `complete` and `embed`,** both metered by the
   host's door, the key never leaving the host. A bench row records
   whether `embed` was available.

## Alternatives considered

**An `index` event.** Lost: it is lifecycle, not a turn event, and a
data export makes it unnecessary.

**"Later pack wins" on duplicate skill ids.** Lost: it hides a mistake;
a refusal naming both packs is the one-sentence gap the requirements
model already produces.

**Accepting both frontmatter formats.** Lost: two parsers to tune; the
standard was already taken in 07 and 10; one conversion script runs
once.

**Retrievers rendering their own `context` block.** Lost: a retriever
could then prompt-engineer its wrapper, and the byte-identical prefix
would depend on it.

## Consequences

Good: the three packages are a one-name swap of `stage/retrieve` except
that `skills-l1` also handles `offer` and `call`, which the comparison
accounts for; the prefix is expressible and pinned; a pack cannot leak
text into the prompt by a second path; the skill lint returns.

Bad: `contract/turn-events` and `contract/skills` must be written
before any skills package can publish; the core gains the section
renderer and the pin record; `package.json` has a third export the
round-four "only stages" sentence said it would not.

## Revisit

When a second event needs a singleton, list it in `contract/turn-events`
and say why. When a data export other than `skills` is needed, this
record is the precedent.
