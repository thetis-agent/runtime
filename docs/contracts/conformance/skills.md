# Conformance · contract/skills 1.0.0

Subjects: **K** a skills pack; **P** a `stage/retrieve` provider; **I**
the installer (the kernel's `install` plus the resolver).

| Id | Subject | Given | When | Then |
| --- | --- | --- | --- | --- |
| SK-001 | K | every `SKILL.md` in `skills/` | lint | frontmatter validates against `skills.schema.json#frontmatter` |
| SK-002 | K | a skill whose `name` differs from its directory | lint | refused, naming both |
| SK-003 | K | a `description` over 1,024 bytes | lint | refused |
| SK-004 | K | a body over 500 lines | lint | warning, not refusal |
| SK-005 | K | a path referenced from a body that does not exist in the pack | lint | refused, naming the path |
| SK-006 | K | two skills with one id inside the pack | lint | refused |
| SK-007 | I | two packs in a profile with one skill id | install | refused, naming both packs |
| SK-008 | I | more than 20 `universal` skills across the profile | install | refused, listing them |
| SK-009 | K | the pack's cards | built by the loader | each validates against `#card`; `contentHash` equals sha256 of the file at `path` |
| SK-010 | P | turn 1 with `pinned` absent | retrieve | every `universal` card is in `entries` |
| SK-011 | P | an entry with `body` | retrieve | `body` equals the file body without frontmatter at the entry's `version` |
| SK-012 | P | the SkillRet held-out gold (kernel-held) | retrieve over the gold queries | nDCG@4 is reported with its interval; below 150 pairs it is ungated |
| SK-013 | P | a query mutated by the seeded mutator with the card-vocabulary stoplist | retrieve | the top entry is the same as for the unmutated query in ≥ 90 % of variants (`invariance`) |
| SK-014 | P | a pack version changes between turns | the conversation's next turn | until refresh, `history` entries that cite a skill cite the old `contentHash` (from the stored prefix); after refresh the new |
| SK-015 | K | a pack that ships checks for its own skills | publish | refused: no package scores itself (ADR 0004) |
