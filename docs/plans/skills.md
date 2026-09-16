# Plan: skills

**Date:** 2026-09-16. **Status:** in progress. **Scope:** a skill format, one shared library, three loader
packages that are measured against each other, one skill package that teaches Thetis, and a dock. No
kernel change: the bench contract the loaders opt into already exists (`docs/21-benchmarks.md`), and the
`skill` and `skill-type` types have been reserved since the architecture document.

---

## 0. What the two earlier implementations learned

The legacy Rust Thetis (`/opt/thetis`) and v2 (`/tank/data/Dev/thetis-agent.v2`) both had skills. The
findings that carry over, with the file that records them:

| Finding | Where |
|---|---|
| A large corpus must cost a **constant** amount of context: only one-line briefs are always present; a body is one tool call away. Four levels: L0 briefs of universal skills, L1 cards of the retrieved set, L2 the body, L3 the files beside it. | `/opt/thetis/crates/thetis/src/skills.rs`, `skills/thetis-internals/skill-system/SKILL.md` |
| Retrieve **once per conversation** on the **first user message**, pin the result in session state, never re-rank on later turns, or the prompt prefix changes and the cache is lost. | `agents/agent-core/src/lib.rs` 689–831; v2 ADR 0013 (the stored prefix) |
| Pin by content hash, not by id: a pack update mid-conversation would otherwise change bytes silently. | v2 `docs/postmortem/09-critiques.md` §6 |
| Index the frontmatter, never the body: "nothing in the body can make a skill retrievable; the fix is always in the frontmatter". No stemming. | `skills.rs::index_text` |
| BM25 alone is free and, on a small corpus, statistically indistinguishable from dense. On 9.5k documents dense beats BM25 by 0.078 nDCG and weighted RRF (dense 0.7, K=60) beats dense by 0.023 (p<0.001). Make the weight a setting. | `/opt/thetis/artifacts/bench-results/README.md`, `skill_index.rs::rank` |
| Absorb a child into a parent that is also in the pool; promote the parent of a lone child at 0.99 of its score. Raises hit@1, lowers nDCG on gold that credits both. | `skill_index.rs::absorb_into_parents`, `promote_parents` |
| The model must be told the brief is a pointer: a skill that is never fetched may as well not exist. Tool descriptions are pushy on purpose. | `agents/agent-core/src/tools.rs` 821–859 |
| Give `load_skill` an enum of the known names so a hallucinated name fails validation instead of loading nothing. | v2 `packages/skills-l1/index.ts` |
| A gold set written by the ranker's author cannot resolve a 0.03 delta with 36 queries. Gold must be imported or derived. | `skills-thetis.md` §4; this runtime's `skill-recall@1` already imports SkillRet |
| v2 never built the embedding service; its "hybrid" retriever ran BM25 only. The dense path needs a vector source that keeps the provider key out of the fence environment. | v2 ADR 0008, `retriever-local/index.ts` |

## 1. The format

A skill is a directory with a `SKILL.md`, in the Agent Skills shape that the bench corpus already uses:

```
skills/
  concise/
    SKILL.md
  packages/
    SKILL.md              # the skill "packages"
    references/install.md # a resource: any file beside SKILL.md, one level deep
    forks/
      SKILL.md            # a child skill, id "packages/forks"
```

`SKILL.md` starts with YAML frontmatter between `---` lines:

| Field | Rule |
|---|---|
| `name` | Required. Equal to the directory name. `^[a-z0-9][a-z0-9-]{0,63}$`. |
| `description` | Required. At most 1,024 bytes. What it does, then when to use it, in the words a person would use to ask. This line and the name are the whole of what retrieval sees. |
| `metadata.title` | Optional display title. |
| `metadata.tags` | Optional, at most 32 lowercase words. Indexed. |
| `metadata.universal` | `"true"` puts the skill's body in every prompt. At most 8 per person. |
| `metadata.related` | Optional ids. Shown on the card, never ranked on. |
| `metadata.version` | Optional integer. |

Everything after the frontmatter is the body, markdown, at most 64 KiB. The id is the path under
`skills/` with `/` between levels; depth at most 3. A skill may not be named `references`, `scripts` or
`assets`. A relative link in the body must resolve inside the skill's directory or the pack.

Where skills come from, in this order, later sources winning on an equal id:

1. Installed packages that declare `thetis.skills` (a directory relative to the package root, usually
   `"skills"`). A package of type `skill` usually has nothing else; any type may declare the directory.
2. The person's own `skills/` directory under the home. This is where the model writes a skill of its own
   with the file tools, and it is what makes the system recursive.

A project (`docs/22-projects.md`) may switch skills off: `projects/<id>.json` `skills.disable` holds ids.
The library reads the session's project the way `@thetis/projects` does and leaves those out.

## 2. The library: `@thetis/skills` (type `skill-type`)

Plain ESM, no build, no dependencies, imported by the loaders and the dock the way `@thetis/ui-marketplace`
imports `@thetis/marketplace`. Nothing runs at import. It contributes one tool of its own so that every
loader shares the same L2:

| Export | Does |
|---|---|
| `parseSkill(text, { id })` | Frontmatter and body to `{ id, name, description, tags, universal, related, version, body, contentHash, problems[] }`. `contentHash` is sha256 over name, description, tags: a body edit does not move it. |
| `loadSkills(env, packages)` | Every skill from the sources of section 1, deduplicated, with `{ source: { package? , path }, children[], resources[] }`. Cached per process by the mtimes of the `SKILL.md` files. |
| `lint(skills)` | The rules of section 1 as `{ id, level: "error" \| "warning", message }`. A skill with an error is left out and named in the prompt's notes. |
| `excludedFor(env, session)` | The ids a project switched off for this session, or an empty set. |
| `tokens(text)`, `bm25Index(skills)`, `bm25Search(index, query, k)` | Okapi BM25, k1 1.2, b 0.75, over name, description and tags. Ties by id. Deterministic. |
| `fuse(dense, lexical, weight)` | Weighted reciprocal rank fusion, K = 60, `weight` the dense share. |
| `absorb(skills, ranked)`, `promote(skills, ranked, limit)` | The parent rules of section 0. |
| `brief(skill)` | The one-line L0/L1 short: `` `id` — description up to the first sentence end, at most 160 characters``. |
| `card(skill)` | The L1 card: the brief, then `Use when:` the rest of the description, `Nested:` and `Related:` lines. |
| `renderBody(skill)` | The L2 text: the body, then `Skill directory:` and the resource list. |
| `fetchSkill(args, env)` | The `skill_fetch` tool: `{ id, file?, offset? }` returns a body or a resource in slices of 24,000 characters with `truncated` and `total`. |
| `importCorpus(ctx, self)` | The bench importer every loader reuses: writes `bench/corpus.json` records as `skills/<id>/SKILL.md` under the userspace home (idempotent, by the corpus sha256), so a loader under the bench sees ordinary skills and nothing else. |
| `claim(ctx, self, importRecord, claim)` | The `harness["@thetis/bench"]` spread of the reference arms. |
| `STATE` | `"@thetis/skills"`: the harness key every loader writes its state under, see section 3. |

The library declares the tool:

```json
"tools": [{ "name": "skill_fetch", "description": "Read the full text of a skill, or one of the files beside it, by id. A brief in the prompt is a pointer, not the content: fetch before relying on a skill.", "parameters": { "type": "object", "properties": { "id": { "type": "string" }, "file": { "type": "string" }, "offset": { "type": "integer" } }, "required": ["id"] }, "export": "fetchSkill" }]
```

## 3. The loaders

Three packages, one installed at a time, each a `loader` with one `prompt` step and the two `bench` steps,
each opted into `skill-recall@1` and `assembly-cost@1` with `peerGroup: "skills"`. Each writes what it
did for the turn under `harness["@thetis/skills"]`:

```js
{ loader: "@thetis/skills-l1", universal: ["concise"], pinned: [{ id, contentHash, score, how }], loaded: ["packages"], catalogue: ["…ids…"], dropped: [], notes: [] }
```

The dock (section 5) reads that. A loader that finds another loader installed logs one note into `notes`
and still runs; the person chooses which to keep.

### 3.1 `@thetis/skills-all`

Every body in the prompt: universal first, then by id, whole skills only, until `config.budget` (default
98,304 bytes) is spent; `dropped` names the rest. The prompt block is `# Skills` with one `## <id>` per
skill. Bench claim: `direct` the injected ids, `reach: "direct"`, `budgetBytes`, `droppedForBudget`.

### 3.2 `@thetis/skills-l1`

The catalogue: `# Skills you can load` with one brief per top-level skill, then the bodies of universal
skills under `# Skills always in force`. Its own tool `load_skill({ name })` with `enum` of the top-level
ids, the body returned once per conversation (a second call answers "already loaded"). Bodies the model
loaded are recorded in `loaded` so the prompt step can put them back into the prefix on later turns of the
same conversation (bytes stable from then on). Bench claim: `direct` universals plus loaded, `offered` the
catalogue, `reach: "catalogue"`.

### 3.3 `@thetis/skills-hybrid` (the one for zero)

The multilayer mechanism:

- **L0/L1 shorts.** `# Skills` lists one brief per top-level skill, always, in id order. Universal bodies
  follow under `# Skills always in force`.
- **Pinned cards.** On the first turn of a conversation the first user message is the query. Dense scores
  are cosine over embeddings of `name + description + tags`; lexical scores are BM25; the two are fused by
  weighted RRF with `config.fusionWeight` (default 0.7 dense). Pool 50, absorb, promote, top
  `config.pinLimit` (default 6). The cards of the pinned set go under `# Skills retrieved for this
  conversation` with the instruction to fetch before relying on one; when `config.pinBodies` is true
  (default false) their bodies go in instead. The pin is stored in `harness` by id and content hash and is
  reused on every later turn: no re-ranking.
- **Search.** Its own tool `skill_search({ query, k })` ranks the same way without pinning, for
  mid-conversation discovery. `skill_fetch` from the library reads a body.
- **Embeddings.** `config.embeddings = { baseUrl, apiKey, model, dimensions }`, defaults
  `https://openrouter.ai/api/v1`, `${OPENROUTER_API_KEY}`, `openai/text-embedding-3-small`, 1536. Vectors
  are cached under the home at `skills-hybrid/vectors.json` keyed `model|dimensions|contentHash`, batch 64,
  pruned of dead keys on write. The query vector is never cached. Without a key, or when the call fails,
  the ranking is lexical and `how: "lexical"` says so; nothing else changes.
- **In the bench.** The package ships `bench/vectors/<corpus sha256>.json`, the vectors of the corpus records
  and of the suite's task queries, produced once by `scripts/embed-corpus.mjs` with the key from the
  environment of whoever runs it. The importer copies that file into the cache, and a query whose vector is
  in the file is not sent anywhere. A run is therefore deterministic and free, and the report's notes say
  which model embedded the corpus. Bench claim: `direct` the pinned ids (with bodies) or universals only
  (cards), `offered` everything else, `reach: "search"`, `ranked` the top 10, `scores`.

Default for everyone: `@thetis/skills-hybrid` joins `systemPackages["*"]` together with `@thetis/skills`
and `@thetis/skills-thetis`; the other two loaders stay in the checkout for the marketplace and the bench.

## 4. The benches and the charts

Every loader runs `skill-recall@1` and `assembly-cost@1`. `@thetis/bench` writes each package's
`bench/<suite>/report.json`, `BENCH.md` and `chart.svg`; the README of each loader embeds the two charts
with `![…](bench/skill-recall-v1/chart.svg)` and says in two sentences what the mechanism trades. The
marketplace copies README images beside the README copy and the package page renders them.

The reference arms under `packages/bench/fixtures/arms/` stay: they are the shapes the contract was proved
on, and the table now has six rows.

## 5. The dock: `@thetis/ui-skills`

A `Skills` dock (order after Tools and Context) for the open conversation: the loader in force, the
universal skills, the pinned cards with their score and `how`, the loaded bodies, what a project switched
off, and the catalogue with a search box that calls `skill_search` when the hybrid loader is installed or
filters the list otherwise. One verb, `skills`, that returns `harness["@thetis/skills"]` of the session and
the catalogue from `loadSkills`. Every row opens the skill's text in the dock.

`@thetis/projects` lists the skills the same way it lists tools, with a switch per skill that writes
`skills.disable`.

## 6. `@thetis/skills-thetis` (type `skill`)

The skills that teach an agent inside Thetis what Thetis is and how to use and change it, written in
ASD-STE100 from `docs/`. One universal skill of a few lines, `thetis`, says what the system is and which
skills to fetch; the rest are fetched: `thetis/using` (sessions, subagents, the file and exec tools, the
plan tools), `thetis/packages` (the manifest, steps, tools, install, forks, promote, services),
`thetis/pipeline` (phases, the three variables, harness state, the prompt cache rules),
`thetis/skills` (this format, how to write and lint one, where it goes), `thetis/projects`,
`thetis/marketplace`, `thetis/web` (the ui field, slots, commands), `thetis/bench`,
`thetis/configuration`, `thetis/fence` (what the sandbox allows, mounts, egress), `thetis/troubleshooting`.
Each description names the questions it answers. Bodies quote the exact commands and manifest shapes and
point at the doc they come from.

## 7. Order of work

1. `@thetis/skills`, `@thetis/skills-all`, `@thetis/skills-l1`, with tests, `docs/23-skills.md`, and the
   docs that list packages and types.
2. `@thetis/skills-thetis` (independent of 1: it needs only section 1).
3. `@thetis/skills-hybrid` with the embedding cache and the script.
4. The bench run with `--write` for the whole `skills` peer group, charts, READMEs.
5. `@thetis/ui-skills` and the project switches.
6. Production: config, install for bitmuse, restart, browser check.
