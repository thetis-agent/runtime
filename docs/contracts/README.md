# Contracts

The first written drafts of the four contracts milestone A needs (`contract/llm` was deleted by ADR 0019). Each
is the content of a `contract/<name>` package (ADR 0006): the messages,
their shapes as TypeScript types with the JSON-schema rules stated in
prose, the change rules, and the conformance tests a provider or handler
must pass. No implementation.

| Contract | Ships with | Governs |
| --- | --- | --- |
| [turn-events](turn-events.md) | `core` | the events of a turn, their order, which are singletons, and every payload |
| [skills](skills.md) | the first skills pack | the pack layout, the frontmatter, the card, and the `retrieve` messages |
| [provider](provider.md) | the first provider package | the normalized stream in both directions between the core and a model provider; usage as named counters (ADR 0019) |
| [kernel-socket](kernel-socket.md) | the kernel | everything between an environment and the kernel: sessions, the door, the log, the profile, health |

Rules common to all four, from ADR 0006: every message carries `v`, the
contract major it was written to; readers ignore unknown fields; a
writer never removes or renames a field without a major; a new optional
field or message is a minor; text is a patch. The kernel computes the
floor from the schema diff.

Drafted 2026-09-09 after the skills exercise; revised the same day
from the tool exercise (`../design/findings-tools.md`): `offer` and
`call` shapes, the handler conformance section, the `notice` event
and stage lifecycle in `turn-events`; connect by file descriptor in
`kernel-socket`. `llm` and `skills` were not touched by the tool
findings.

## Schemas and suites

| Contract | JSON Schema (draft 2020-12) | Conformance suite |
| --- | --- | --- |
| turn-events | [schema/turn-events.schema.json](schema/turn-events.schema.json) | [conformance/turn-events.md](conformance/turn-events.md), TE-001 to TE-032 |
| skills | [schema/skills.schema.json](schema/skills.schema.json) | [conformance/skills.md](conformance/skills.md), SK-001 to SK-015 |
| provider | [schema/provider.schema.json](schema/provider.schema.json) | [conformance/provider.md](conformance/provider.md), PR-001 to PR-015 |
| kernel-socket | [schema/kernel-socket.schema.json](schema/kernel-socket.schema.json) | [conformance/kernel-socket.md](conformance/kernel-socket.md), KS-001 to KS-022 |
| storage | [../../contracts/storage/schema.json](../../contracts/storage/schema.json) | [conformance/storage.md](conformance/storage.md), ST-001 to ST-007 |

[Storage](storage.md) adds the in-process byte-store and append-log API in ADR
0040. Its data types are generated from its schema; the callable interface carries
opaque `Uint8Array` values without introducing a socket protocol.

The schemas are the authority where they and the prose differ; the
prose explains. Every message is `additionalProperties: true` by rule
(readers ignore unknown fields). `$ref`s across contracts use the
`thetis://contract/<name>/<major>` ids.
