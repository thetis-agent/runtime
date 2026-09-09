# Design · `skills-l1`

Skill matching by the model, per the Agent Skills standard: level 1 (name
and description of every skill) is always in the prompt, level 2 (the
`SKILL.md` body) is loaded by a tool the model calls, level 3 (bundled
files) is read on demand with the file tools.

Sources used: the specification at agentskills.io/specification
(frontmatter fields and limits, the three tiers with their token
guidance, "keep `SKILL.md` under 500 lines"); the integration guide at
agentskills.io/integrate-skills (the `<available_skills>` catalog, the
dedicated-tool activation pattern with the `name` parameter constrained
to an enum, structured wrapping with `<skill_content>` and
`<skill_resources>`, deduplicating activations, and exempting skill
content from compaction); PrimeAgent's implementation in
`packages/coding-agent/src/core/skills.ts` (the catalog XML at line 456,
`disable-model-invocation` at line 76) and `docs/skills.md` (lenient
validation, precedence, `skills/` directory in packages). Written
against `00-proposal.md` (seventh draft, stages) and ADRs 0001, 0002,
0004, 0005, 0006.

## 1. Stages and events

`skills-l1` exports three stages and answers three events. It provides
`stage/retrieve`, so it is a drop-in replacement for `retriever-local`:
the profile swaps one provided name and nothing else changes.

### `retrieve` (provided; replaces the default)

Assumed request, from `contract/retrieve@1`:

```
{ v: "1", conversation: id, query: string, k: number, pinned?: { skills: {pack: version}, catalogHash } }
```

Assumed response:

```
{ v: "1", entries: [ { id, name, description, location, body?: string, universal?: boolean } ], pinned: { skills, catalogHash } }
```

`skills-l1` ignores `query` and `k`. It answers with every top-level
skill's `name`, `description` and `location`, no `body`, and with `body`
for the four skills marked `universal` in the corpus (their bodies are
always in context: 1,961 + 7,816 + 661 + 669 bytes, about 2,800
tokens). On the first turn of a conversation it computes `catalogHash`
over the ordered `(pack@version, name, description)` triples and returns
it as `pinned`; on later turns it answers from the pinned set even if a
skill pack has since changed, so the prompt stays byte-identical.

### `context`

Assumed payload: `{ v, system: [ { id, text } ], messages: [ { role, content, tags? } ], pinned }`.

The stage appends one system section, id `skills-catalog`, in the
pinned-skills region (the proposal says harness notes enter *after* the
pinned skills, so this region exists):

```
The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call load_skill with the skill's
name to load its full instructions. Resolve a skill's relative paths against
its directory and use absolute paths in tool calls.
<available_skills>
  <skill><name>careful-surgery</name><description>…</description><location>/packages/skills-thetis@3.1.0/skills/careful-surgery/SKILL.md</location></skill>
  …
</available_skills>
```

followed by the universal bodies wrapped in `<skill_content name=…>`.
It then re-injects, as protected messages tagged `skill_content`, the
body of every skill loaded earlier in this conversation, read from prior
`call` results in `messages`, so compaction cannot drop them (the guide's
"exempt skill content from pruning"). Deduplication: a `load_skill` call
for a skill already present returns a one-line "already loaded" result.

### `offer` and `call`

`offer` adds one tool:

```
{ name: "load_skill", description: "Load a skill's full instructions by name.",
  schema: { type: "object", properties: { name: { type: "string", enum: [pinned catalog names] } }, required: ["name"] },
  readOnly: true, endsTurn: false, group: "skills" }
```

`call` for `load_skill` returns the body with frontmatter stripped,
wrapped:

```
<skill_content name="rpg">
…body…
Skill directory: /packages/skills-thetis@3.1.0/skills/rpg
<skill_resources><file>SKILL.md</file><file>combat/SKILL.md</file>…</skill_resources>
</skill_content>
```

Children (Thetis `children`, up to 65 under `torchship`) are listed as
resources, not catalogued: the catalog stays at 17 entries and the model
reads a child with the file tools when the parent body points at it.
Unknown name: refused with the enum. `disable-model-invocation: true`
hides a skill from the catalog and the enum.

No other events. Level 3 needs no stage: the skill directories are in
the registry cache, which the sandbox mounts read-only (ADR 0005), and
the file tools read them by the absolute `location`.

## 2. `package.json`

```json
{
  "name": "skills-l1",
  "version": "1.0.0",
  "description": "Skill matching by the model: catalog in the prompt, bodies loaded by a tool. Agent Skills standard.",
  "main": "index.ts",
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/retrieve": "^1",
    "contract/skills-pack": "^1",
    "setting/skills.catalog_scope": "*"
  },
  "provides": {
    "stage/retrieve": "1.0.0"
  },
  "stages": ["retrieve", "context", "offer", "call"]
}
```

`setting/skills.catalog_scope` is `top-level` (default) or `all`; `all`
puts every `SKILL.md` in the catalog (138 entries, about 8,600 tokens).

Contracts it needs:

- `contract/retrieve@1`: the request and response above. Not written
  anywhere yet; sketched here.
- `contract/skills-pack@1`: how a skills pack exposes its data. A pack
  `provides: { skills/<pack>: version }` and ships a `skills/` directory
  of skill directories, each with a `SKILL.md` in the standard's YAML
  frontmatter (`name`, `description`, optional `metadata`, optional
  `disable-model-invocation`). The conformance test validates every
  `SKILL.md` leniently as the guide prescribes (missing description
  skips the skill; a name that mismatches its directory warns).
- Mapping of the Thetis corpus: TOML `name` (a title, "Thetis
  internals") becomes `metadata.title`; the standard `name` is the
  directory name; `description` is `brief` plus a space plus
  `when_to_use` (7,486 bytes over 17 skills, about 440 characters each,
  under the 1,024 limit; the longest brief alone is 176); `tags` and
  `related` go to `metadata`; `universal` to `metadata.universal`;
  `children` disappears, since nested directories are discovered.

## 3. The tool contract

`load_skill` is `readOnly: true`: it changes nothing, so read-only mode
offers it and dispatches it. `endsTurn: false`: the model continues in
the same turn with the body in context. `group: "skills"`: attention
grouping only, never permission. The enum is the guide's guard against
hallucinated names.

## 4. Byte-identical prompt

Pinned per conversation: the catalog (`catalogHash` over pack versions,
names and descriptions), the universal bodies, and the `load_skill`
enum, since the tool schema precedes the system prompt in the provider's
cache prefix. A skill pack version that changes a description after a
conversation began is not visible in that conversation; the next
conversation gets it. This holds the proposal's rule 7 with one
extension: the pin covers `offer` as well as `context`.

Token cost per turn against the real corpus, catalog scope `top-level`:

| Part | Bytes | Tokens (≈ bytes/4 + tags) |
| --- | ---: | ---: |
| 17 names + descriptions | 7,486 | ~1,900 |
| XML and instruction block | ~1,200 | ~350 |
| 4 universal bodies | 11,107 | ~2,800 |
| **Level 1 total, cached after turn one** | | **~5,000** |
| A loaded body, worst case (`rpg` children excluded) | 24,913 | ~6,200, over the standard's 5,000 recommendation |

Scope `all` adds ~6,700 tokens and 121 entries the model must scan.

## 5. Measurement (ADR 0004)

The primary number is `skill_lift`, paired: the suite's skill-tagged
tasks run on the default (`retriever-local`) and on the candidate
(`skills-l1`), same model, seeds and mutated variants; a pass is the
task's test. Per skill, lift is with the skill present in the catalog
minus withheld. That is a fair comparison: both arms are judged only by
what tasks pass.

The `call` rows give a second number for free: `skill_hit@1`, whether
the model's first `load_skill` in a task named the task's gold skill,
and `skill_loaded_none`, tasks where it loaded nothing (the analogue of
Thetis's tag router routing nothing for 58% of queries). These are
comparable to a retriever's `hit@1` only as "first choice correct". nDCG
is not defined for the model's choice, which is a set of zero to a few
loads with no ranking, so `skill_ndcg` stays a retriever-only number
and the review page must not place the two side by side as if they were
one scale. Two costs are also fair to compare: `skill_tokens` per turn
(level 1 is ~5,000 cached tokens against a retriever's k bodies) and
`turn_iterations` (a load is one extra model round trip).

Tamper surface: the catalog is data from installed packages; the stage
never sees the suite; the enum constrains what can be loaded; the gold
skill per task lives in the host.

## 6. FINDINGS

1. **The stages model has no data export for skills.** Round four says a
   skills pack is "a stage that answers `context` from `SKILL.md`
   files". A matcher cannot see another stage's files. A pack must
   expose data, as `spawn` already does. DECIDED-HERE: `contract/skills-pack`:
   a pack `provides: { skills/<pack>: version }` and ships a `skills/`
   directory; the matcher reads it. The proposal's exports sentence
   needs `skills` (data) beside `stages` and `spawn`.
2. **`contract/retrieve` is named and never defined.** The core requires
   `stage/retrieve` and chunk 2 says it is "answered with skill texts",
   which presumes a ranker. DECIDED-HERE: the response allows entries
   without `body`, and carries `pinned`, so a model-driven matcher is a
   valid provider. The contract package must exist before either
   retriever can be published (ADR 0006 refuses a name with no contract).
3. **The byte-identical rule covers the wrong surface.** Rule 7 pins
   "retrieved skills"; the provider's cache prefix is tools, then
   system, then messages, so a changing `offer` schema busts the cache
   just as a changing skill does. DECIDED-HERE: the pin covers the
   `load_skill` enum. Rule 7 should say "everything before the first
   user message".
4. **`context` has no protected messages and no re-injection path.**
   The standard requires skill content to survive compaction; the
   proposal's compaction is a projection with no notion of protected
   content. DECIDED-HERE: the stage re-injects loaded bodies each turn,
   tagged, at the cost of re-sending them. The `context` payload needs
   a `tags` or `protected` field the compaction stage honours.
5. **The semver floor punishes derived schemas.** ADR 0006 makes a
   removed enum value a major bump. `load_skill`'s enum is derived from
   installed packs; removing a skill would make `skills-l1` a major.
   DECIDED-HERE: a schema field marked `derived` is excluded from the
   floor; the change belongs to the pack that removed the skill.
6. **The universal flag has no standard equivalent.** Four Thetis skills
   are always in context. The standard has no such tier. DECIDED-HERE:
   `metadata.universal: "true"` and the bodies are pinned into level 1,
   which is 2,800 of the 5,000 tokens. `skill-creator` alone is 7,816
   bytes and should lose the flag.
7. **Children have no catalog policy.** 138 `SKILL.md` files, 65 under
   one skill. The standard discovers nested directories as skills;
   cataloguing all of them costs ~8,600 tokens. DECIDED-HERE: top-level
   only by default, children as level-3 resources, a setting to change
   it. The proposal never says how a hierarchy is disclosed.
8. **Name collisions across packs are unspecified.** Two packs with a
   skill `concise`. DECIDED-HERE: later in profile order wins and the
   turn log gets a warning row. The singleton rule is per provided
   name, and skills are not provided names.
9. **`location` inside the sandbox is unspecified.** The model needs an
   absolute path the file tools can read. DECIDED-HERE:
   `/packages/<name>@<version>/skills/<skill>/SKILL.md`, the registry
   cache mount. ADR 0005 should fix that mount path.
10. **User-explicit activation has no event.** The guide wants `/skill`
    or `$skill` handled by the harness. There is no `input` field for
    it. Not decided; a gateway convention is needed (an `activate`
    list on `input`, or a `call` the gateway injects).
11. **Frontmatter is TOML in Thetis, YAML in the standard.** The corpus
    does not load unconverted. DECIDED-HERE: the pack conformance test
    accepts only the standard; conversion is a one-time script, and the
    mapping in §2 is the spec for it.
12. **Comparison fairness.** `skill_ndcg` and `skill_hit@1` are not the
    same scale; only `skill_lift`, `skill_tokens` and `turn_iterations`
    compare the two matchers honestly. 06-metrics lists `skill_hit@1`
    under retrieval as if any provider produced it; it should say which
    number each provider can produce.
13. **A worst-case body exceeds the standard's guidance** (24,913 bytes)
    and there is no lint in the pipeline for it; the pack conformance
    test should warn over 500 lines, as `skills-ref validate` does.
