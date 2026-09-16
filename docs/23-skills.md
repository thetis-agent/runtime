# 23 Skills

A skill is a directory with a `SKILL.md`: a name, a description, and a body the model can read. `@thetis/skills` is the format and the library. A loader is a package that decides what the model sees of the skills on each turn. Three loaders exist, one installed at a time, and the benchmark compares them. `@thetis/skills`, `@thetis/skills-thetis` and `@thetis/skills-hybrid` are in the default `systemPackages["*"]`. Source: `packages/skills`, `packages/skills-all`, `packages/skills-l1`, `packages/skills-hybrid`. Plan: `docs/plans/skills.md`.

## 1. The format

```
skills/
  concise/
    SKILL.md
  packages/
    SKILL.md              # the skill "packages"
    references/install.md # a file beside SKILL.md, one level deep
    forks/
      SKILL.md            # a nested skill, id "packages/forks"
```

`SKILL.md` starts with YAML frontmatter between `---` lines. The library reads a subset of YAML with a hand parser: `key: value` lines, one `metadata:` block with two-space indent, `[a, b]` lists, `- item` lists, and quoted strings. A block scalar (`>` or `|`), an anchor, a flow map, or a value that spans lines is refused with an error. An unknown key is a warning and is ignored.

| Field | Rule |
|---|---|
| `name` | Required. Equal to the directory name. `^[a-z0-9][a-z0-9-]{0,63}$`. |
| `description` | Required. At most 1024 bytes. What it does, then when to use it, in the words a person would use to ask. This line and the name are all that retrieval sees. |
| `metadata.title` | Optional display title. The brief shows it. |
| `metadata.tags` | Optional. At most 32 lowercase words. Indexed. |
| `metadata.universal` | `"true"` puts the body in every prompt. At most 8 per person. |
| `metadata.related` | Optional ids. Shown on the card. Never ranked on. |
| `metadata.version` | Optional integer. |

The body is everything after the frontmatter. It is markdown of at most 64 KiB. The id is the path under `skills/` with `/` between levels. The depth is at most 3. A skill may not be named `references`, `scripts` or `assets`. A relative link in the body must resolve inside the skill's directory or the pack; one that does not is a warning.

A skill with an error is left out of the prompt. The loader names it in `notes`. A skill with only warnings is kept.

## 2. The sources

The library reads skills from two places, in this order. A later source wins on an equal id.

| Order | Source | Detail |
|---|---|---|
| 1 | Installed packages that declare `thetis.skills` | The field is a directory relative to the package root, usually `"skills"`. A package of type `skill` usually has nothing else. Any type may declare the directory. The kernel records the field and does not read it. |
| 2 | The person's `skills/` under the home | The model writes a skill of its own here with the file tools. |

A project switches skills off. `projects/<id>.json` holds `skills.disable`, a list of ids ([22-projects.md](22-projects.md) section 2). The library reads the session's project through `projects/sessions.json`, the way `@thetis/projects` does, and leaves those ids out of the prompt and of `skill_fetch`. A switched-off parent takes its nested skills with it.

## 3. The library: `@thetis/skills`

`@thetis/skills` is a `skill-type` package: plain ECMAScript, no build step, no dependencies. Nothing runs at import. A loader imports it the way `@thetis/ui-marketplace` imports `@thetis/marketplace`, and must be installed beside it.

| Export | Does |
|---|---|
| `parseSkill(text, { id })` | Frontmatter and body to `{ id, name, description, title, tags, universal, related, version, body, contentHash, problems }`. `contentHash` is sha256 over name, description and tags. A body edit does not move it. |
| `loadSkills(env, packages)` | Every skill from the sources of section 2, deduplicated, sorted by id, with `source: { package?, path, dir }`, `children` and `resources`. `packages` is `ctx.packages` in a step, or the list from `env.kernel.packages.list()` in a tool. Parsing is cached per process by the mtime and size of each `SKILL.md`. |
| `lint(skills)` | The rules of section 1 as `{ id, level: "error" \| "warning", message }`, plus the universal cap, related ids that name nothing, and a child without a parent. |
| `excludedFor(env, session)` | The ids the session's project switched off, or an empty set. |
| `selectSkills(env, packages, session)` | `{ all, skills, universal, excluded, problems, notes }`: what a loader works from. |
| `tokens(text)`, `bm25Index(skills)`, `bm25Search(index, query, k)` | Okapi BM25, k1 1.2, b 0.75, over name, description and tags. Ties by id. Deterministic. |
| `fuse(dense, lexical, weight)` | Weighted reciprocal rank fusion, K 60. `weight` is the dense share. |
| `absorb(skills, ranked)` | A child whose parent is also in the pool is absorbed into the parent. The parent keeps the better score. |
| `promote(skills, ranked, limit)` | The parent of a lone child is added at 0.99 of the child's score. The pool is cut to `limit`. |
| `closest(skills, name, n)` | The nearest ids to a misspelt name. |
| `brief(skill)` | One line: the id in backticks, the title in parentheses when there is one, a dash, then the first sentence of the description, at most 160 characters. |
| `card(skill)` | The brief, then `Use when:` with the rest of the description, `Nested:` and `Related:` lines. |
| `renderBody(skill)` | The body, then `Skill directory:` and the files beside `SKILL.md`. |
| `fetchSkill(args, env)` | The `skill_fetch` tool. |
| `importCorpus(ctx, self)` | The bench importer every loader reuses. See section 6. |
| `claim(ctx, self, importRecord, claim)` | Writes under `harness["@thetis/bench"]` and keeps what is there. |
| `readMap(env)`, `corpusIds(map, ids)` | The corpus id map the importer left, and skill ids back to corpus ids. |
| `STATE` | `"@thetis/skills"`. The harness key every loader writes under. |

The library declares one tool:

| Tool | Arguments | Returns |
|---|---|---|
| `skill_fetch` | `id` (required), `file`, `offset` | The body of a skill, or one of the files beside it, in slices of 24000 characters. A footer says how to read on: `[characters 1-24000 of 51234; read on with offset 24000]`. An unknown id is refused with the closest ids. |

The brief looks like this:

```
`packages` — Installs, forks and promotes packages.
`agent-management` (cap.ai-agents.agent-management) — Create, manage, and orchestrate AI agents.
```

## 4. The loaders

Each loader is a `loader` package with one `prompt` step and two `bench` steps. Each opts into `skill-recall@1` and `assembly-cost@1` with `peerGroup: "skills"` and `corpus: "caps@1"`. Install one at a time. A loader that finds another loader's state in `harness` adds one note and still runs.

### 4.1 `@thetis/skills-all`

Every body in the prompt. The order is universal skills first, then by id. Whole skills only, until `config.budget` bytes (default 98304) are spent. The first skill that does not fit ends the fill. `dropped` names it and the rest. The prompt block is `# Skills` with one `## <id>` section per skill.

Bench claim: `direct` the injected ids, `offered` nothing, `reach: "direct"`, `budgetBytes`, `droppedForBudget`.

### 4.2 `@thetis/skills-l1`

The catalogue. `# Skills you can load` holds one brief per top-level skill. `# Skills always in force` holds the bodies of universal skills. `# Skills loaded in this conversation` holds the bodies the model loaded on earlier turns.

The tool `load_skill({ name })` returns a body once per conversation. A second call answers `already loaded`. The tool records each load in `skills-l1/loaded/<session id>.json` under the home, with the content hash. The prompt step reads that file and puts the bodies back into the prefix. The prefix changes once per load and is stable between loads.

The v2 design gave the tool an `enum` of the known names. A manifest is static and this runtime has no dynamic tool schema, so the enum cannot be built at declare time. The tool validates the name and answers a miss with the closest ids.

Bench claim: `direct` the universal and loaded ids, `offered` the catalogue, `reach: "catalogue"`.

### 4.3 `@thetis/skills-hybrid`

The loader for zero, and the default for everyone. The prompt carries three blocks:

| Block | Content |
|---|---|
| `# Skills` | One brief per top-level skill, always, in id order. One line says that a brief is a pointer, that `skill_search` finds a skill and that `skill_fetch` reads one. |
| `# Skills always in force` | The bodies of universal skills, as `skills-l1` shows them. |
| `# Skills retrieved for this conversation` | The cards of the pinned set, or their bodies when `pinBodies` is true, with one line telling the model to fetch before relying on a card. |

On the first turn of a conversation the first user message, cut to 2000 characters, is the query. The dense score is the cosine between the query's vector and each skill's vector; the text embedded is the name, the description and the tags, never the body. The lexical score is BM25. The two lists, 50 deep each, are fused by weighted reciprocal rank fusion with `fusionWeight` as the dense share, a child in the pool is absorbed into its parent, the parent of a lone child is promoted, and the first `pinLimit` are pinned. A universal skill is never pinned. Each pinned entry records `how` it got there: `dense`, `lexical` or `parent-of-match`.

The pin is stored in `harness["@thetis/skills"].pinned` by id and content hash and reused on every later turn without re-ranking, so the prompt prefix stays where the first turn put it. A pinned skill whose content hash changed is shown from its new text in the same place, with a note. One whose id vanished is dropped, with a note. The state also carries `ranked`, the top 10 of the same ranking, and `mode`, `dense` or `lexical`.

The tool `skill_search({ query, k })` ranks the same way for one query and answers one brief per hit with its `how` and score, without pinning anything. `k` is 5 by default and at most 20. A universal skill is not a result. `skill_fetch` from the library reads a body.

`config.packages["@thetis/skills-hybrid"]`:

| Key | Default | Effect |
|---|---|---|
| `fusionWeight` | 0.7 | The dense share in the fusion. 0 is lexical only, 1 is dense only. |
| `pinLimit` | 6 | How many skills are pinned. 0 pins nothing. |
| `pinBodies` | false | Pin bodies instead of cards. Costs bytes, saves a round trip. |
| `embeddings.baseUrl` | `https://openrouter.ai/api/v1` | An OpenAI-compatible endpoint. The request is `POST <baseUrl>/embeddings` with `{ model, input, dimensions }`. |
| `embeddings.apiKey` | `${OPENROUTER_API_KEY}` | The key. The kernel interpolates the reference from the environment of the daemon; the fence never sees the variable. The default is in the kernel's default `packages` block. |
| `embeddings.model` | `openai/text-embedding-3-small` | The embedding model. |
| `embeddings.dimensions` | 1536 | The vector size. |

The vectors of the skills are cached under the home at `skills-hybrid/vectors.json`, an object keyed `model|dimensions|contentHash` with arrays of numbers rounded to 6 decimals. A turn embeds only the skills the cache lacks, 64 texts per request, 20 seconds per request, and writes the cache with every key no live skill has removed. The query's vector is never cached. A body edit does not move the content hash, so it does not cost an embedding.

Without a key, when the endpoint refuses, or when a request times out, the ranking is lexical for that turn: every `how` is `lexical`, `mode` is `lexical`, and one line in `notes` says why. Nothing else changes and the step never throws. The key appears in no note, no error and no file.

In the bench there is no key. The package ships `bench/vectors/<corpus sha256>.json`: `{ model, dimensions, corpus, skills: { [contentHash]: vector }, queries: { [sha256 of the query text]: vector } }`, the vectors of every corpus record and of every task query of `skill-recall@1`, produced once by `scripts/embed-corpus.mjs` from the runtime root with `OPENROUTER_API_KEY` in the environment (`set -a; . ./.env; set +a; node packages/skills-hybrid/scripts/embed-corpus.mjs`). The script imports the corpus through `importCorpus`, so the content hashes are the ones a run looks up. The importer copies the skill vectors into the cache under the home, and the step looks a query up in the file before it would call the network. A run is therefore deterministic and free. A corpus, a model or a dimension the file does not match falls back to lexical.

Bench claim: `direct` the universal ids, plus the pinned ids when `pinBodies` is true; `offered` every other corpus id; `reach: "search"`; `ranked` the top 10 in corpus ids; `scores` the fused scores of those 10.

## 5. The harness state

Every loader writes what it did for the turn under `harness["@thetis/skills"]`:

```js
{ loader: "@thetis/skills-l1", universal: ["concise"], pinned: [{ id, contentHash, score, how }], loaded: ["packages"], catalogue: ["…ids…"], dropped: [], excluded: [], notes: [] }
```

| Field | Content |
|---|---|
| `loader` | The package that wrote the state. |
| `universal` | The ids whose bodies are always in the prompt. |
| `pinned` | The retrieved set with score and `how`. Empty for `skills-all` and `skills-l1`. |
| `loaded` | The ids the model loaded with `load_skill`. |
| `catalogue` | The ids the prompt names. For `skills-all`, the injected ids. |
| `dropped` | The ids left out for the budget. |
| `excluded` | The ids the project switched off. |
| `notes` | One line per skill left out for an error, the project switch, and another loader when one is installed. |

`@thetis/skills-all` also writes `injected`, `budget` and `used`. The dock `@thetis/ui-skills` reads this state for the open conversation and draws it beside the catalogue ([15-web-gateway.md](15-web-gateway.md) section 11.6); `@thetis/projects` lists every skill with a switch that writes `skills.disable` ([22-projects.md](22-projects.md) section 5).

## 6. The bench

Every loader runs `skill-recall@1` and `assembly-cost@1` ([21-benchmarks.md](21-benchmarks.md)). The importer and the adapter are `bench`-phase steps, so they never run on an ordinary turn.

The importer is `importCorpus` from the library. It writes `bench/corpus.json` as `skills/<id>/SKILL.md` under the home, so a loader under the bench sees ordinary skills and nothing else. It is idempotent by the corpus sha256; `bench/imported.json` is the marker. The corpus frontmatters use YAML the format does not read, so the importer generates a frontmatter from the record's fields and keeps the text after the record's own frontmatter verbatim, canary included.

| Record field | Skill |
|---|---|
| `id` (`cap.ai-agents.agent-management`) | The directory is the last segment, `agent-management`. `metadata.title` is the corpus id, so a brief names the record and the bench can verify a catalogue claim by finding the id in the prompt. |
| `description` | `description`, verbatim. |
| `tags` | `metadata.tags`, lowercased, spaces to hyphens. |
| `body` after its frontmatter | The body, verbatim. |

`bench/map.json` maps corpus ids to skill ids. A loader's claim goes through the map, because a claim must name corpus ids. The bench then finds a body by its canary and a catalogue entry by its corpus id, as for the reference arms.

Under `assembly-cost@1` there is no corpus. The importer does nothing, and the loader finds no skills.

## 7. Limits

| Limit | Value |
|---|---|
| Description | 1024 bytes |
| Body | 64 KiB |
| Tags | 32 |
| Depth | 3 |
| Universal skills per person | 8 |
| Brief | 160 characters of description |
| `skill_fetch` slice | 24000 characters |
| `skills-all` budget | `config.budget`, default 98304 bytes |
| `skills-hybrid` query | 2000 characters of the first user message |
| `skills-hybrid` pool | 50 dense and 50 lexical candidates before fusion |
| `skills-hybrid` embedding request | 64 texts, 20 seconds |

Other limits:

- A skill is read from the filesystem on every turn. The parse is cached; the directory walk is not.
- `skills-l1` lists only top-level skills. A nested skill is reached through its parent or `skill_fetch`.
- A loader knows another loader only through the harness state. Two loaders installed together both run.
- The dock searches the catalogue by BM25 in the page; it calls no `skill_search`, so with the hybrid loader the dock's ranking is lexical while the loader's is fused.

## 8. Tests

`node --test` files under each package's `test/`, run by the root `npm test`:

| File | Content |
|---|---|
| `packages/skills/test/frontmatter.test.js` | The YAML subset, and what is refused. |
| `packages/skills/test/skill.test.js` | Every rule of section 1, the set rules of `lint`, the brief, the card, the body. |
| `packages/skills/test/rank.test.js` | BM25 determinism across index orders and ties, fusion, absorb, promote, closest. |
| `packages/skills/test/load.test.js` | `loadSkills` over a temporary directory with a package pack and a home, the cache, `excludedFor` with a projects fixture, `selectSkills`, `skill_fetch`, the slice rule. |
| `packages/skills/test/bench.test.js` | `importCorpus` idempotence and the id map, the generated frontmatter, the claim spread. |
| `packages/skills-all/test/inject.test.js` | The prompt block and the state, the budget, the project switch, the notes, the claim. |
| `packages/skills-l1/test/catalogue.test.js` | The prompt blocks and the state, `load_skill` once per conversation and its re-injection, the refusals, the claim. |
| `packages/skills-hybrid/test/hybrid.test.js` | Fusion determinism and the `how` labels, the pin reused across turns and after a pack update, the lexical fallback without a key or with a refused call, the vector cache and its pruning, batching, the bench vector file and the seeding, the claim, `skill_search`. |

`node bin/thetis.js bench verify packages/skills-all`, `packages/skills-l1` and `packages/skills-hybrid` check the bench declarations.
