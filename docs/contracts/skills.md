# contract/skills · 1.0.0

Ships with the first skills pack. Governs the layout of a skills pack,
the frontmatter, the card a retriever indexes, and the entries a
`retrieve` answer carries (ADR 0007 §1, §3).

## The pack

A package with `"skills": "./skills"` in `package.json` and
`provides: { "skills/<pack>": "<version>" }`. Under `skills/`, one
directory per skill, named by the skill id, holding `SKILL.md` and any
files it references. A child skill is a subdirectory with its own
`SKILL.md`; its id is `<parent>/<child>`. Ids are unique across a
profile; a duplicate is refused at install naming both packs.

## Frontmatter

The Agent Skills standard, YAML:

```yaml
---
name: careful-surgery            # must equal the directory name
description: >-                  # ≤ 1,024 bytes; Thetis's brief plus when_to_use
  Work in small reversible steps when changing your own loop, gateways or
  tools. Use whenever the target of a change is the harness itself.
metadata:
  title: Careful self-modification
  tags: [self-mod, safety, rollback]
  related: [skill-creator]
  universal: "true"              # always in the pinned set; at most 20 per profile
---
```

Anything Thetis carried that the standard does not name goes under
`metadata`. `children` is not a field; children are directories.

## The card

What a retriever indexes; built by the pack loader from the frontmatter.

```ts
interface SkillCard {
  id: string; pack: string; version: string; path: string;   // path is under /packages/<pack>@<version>/skills/
  name: string; description: string;
  tags: string[]; related: string[]; universal: boolean;
  bytes: number; contentHash: string;
  children: string[];
}
```

## The entry

What a `retrieve` answer carries (contract/turn-events).

```ts
interface SkillEntry {
  id: string; pack: string; version: string; path: string; contentHash: string;
  universal: boolean;
  body?: string;           // the SKILL.md body without frontmatter; absent for a model-driven matcher
}
interface PinnedEntry { id: string; pack: string; version: string; contentHash: string; }
```

## Conformance

For a pack: every `SKILL.md` parses; `name` equals its directory;
`description` is present and ≤ 1,024 bytes; ids are unique within the
pack; a body over 500 lines is a warning; more than 20 `universal`
skills across the candidate profile is refused at install; every path
a skill references exists in the pack.

For a `stage/retrieve` provider, in addition to turn-events: every
entry's `contentHash` matches the file at `path` at `version`;
`universal` cards are always in the answer on turn 1; given `pinned`,
the answer is the pinned set.

## Change rules

A removed skill id is a major of the pack; an added id is a minor; a
body-only change is a patch (ADR 0007 §6). A new optional frontmatter
key under `metadata` is a minor of this contract; a new required key is
a major.
