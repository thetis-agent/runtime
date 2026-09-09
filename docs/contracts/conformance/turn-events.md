# Conformance · contract/turn-events 1.0.0

Subjects: **P** a `stage/retrieve` provider; **H** any handler; **O** any
observer; **C** the core; **G** a gateway (as a stage).

| Id | Subject | Given | When | Then |
| --- | --- | --- | --- | --- |
| TE-001 | C | a profile with no handlers | a turn runs | events occur in the order input, retrieve, context, offer, model.begin, model.event*, model.end, output, end; `iteration` is 0 for input, retrieve, end and 1 for the rest |
| TE-002 | C | a handler that returns an event of a different type | the event runs | the return is refused, the handler's row records `contract-violation`, the turn continues with the original payload |
| TE-003 | C | a handler that reorders `context.sections` | context runs | refused as TE-002 |
| TE-004 | C | two packages providing `stage/retrieve` | install | refused, naming both |
| TE-005 | P | a request with `pinned` absent, `budget` B | retrieve | the sum of returned `body` lengths in tokens ≤ B; `dropped` lists ids that matched but did not fit |
| TE-006 | P | the same request twice | retrieve | byte-identical answers |
| TE-007 | P | a request with unknown fields | retrieve | ignored; the answer validates |
| TE-008 | P | `activate: [id]` | retrieve | `id` is in `entries` regardless of score |
| TE-009 | C | turn 1 completes | the prefix is stored | the conversation file holds one `prefix` object with `rendererVersion`, `systemHash`, `skills`, `offer`, `bytes`; turn 2 does not run retrieve; its `model.begin.request` prefix bytes equal `prefix.bytes` |
| TE-010 | C | a profile change between turns | the next turn | retrieve runs once, a new `prefix` is stored, `history` gains one system line naming the changed packages, `end.reason` is unaffected |
| TE-011 | C | a `context` append by a handler | the turn ends | the appended message is not in the conversation file |
| TE-012 | H | `offer` with `mode.readOnly = true` | offer runs | the core's recorded offered set contains no `readOnly: false` tool |
| TE-013 | C | a model emits a call to a name not offered | call | the handler is not invoked; the tool message carries `error.code = "not-offered"` and, if a pinned tool of that name existed, its replacement's name |
| TE-014 | C | a model emits args failing the offered schema | call | `invalid-args`; the handler is not invoked |
| TE-015 | H | a call with `deadlineMs = 50` and a handler that sleeps 100 ms | call | the core answers `deadline`; a later `notice` with the handler's `pending.handle` is accepted |
| TE-016 | H | a call answer over `budget.resultBytes` | call | `spilled` is present; the file exists under `spaces/people/<user>/tool-output/<callId>`; `hash` matches; the file is complete (atomic) |
| TE-017 | H | a `ToolDef` with `derived: true, readOnly: true` and no trusted mark | offer in read-only mode | the tool is dropped; the row says `derived-untrusted` |
| TE-018 | H | the read-only sandbox | every `readOnly: true` tool is called with valid args | none fails with `io` on a write |
| TE-019 | H | a symlink from an rw mount into an ro mount | `read_path` through it | the runner's documented behaviour (resolve, fail, or invisible) matches the handler's error; recorded per runner adapter |
| TE-020 | H | a pinned tool the handler no longer has | call | `gone` |
| TE-021 | H | `init` run twice with the same settings and profile | init | identical `register` calls, or none |
| TE-022 | H | `init` that exceeds the probe budget | process start | the package is inert; one line in the conversation; the environment is healthy |
| TE-023 | H | `shutdown` with a child process still running | restart | the child is gone after the bounded wait; the row says `killed` |
| TE-024 | H | a handler's child | spawned by the handler | it holds no kernel socket descriptor and no run token in its environment |
| TE-025 | O | an observer that throws | any event | the event proceeds; the observer's row records the throw; no payload changed |
| TE-026 | O | an observer that mutates the payload it was given | any event | the mutation is not visible to the next stage (observers get a frozen copy) |
| TE-027 | C | a model exchange | model.begin | `request` equals what the provider socket received, event for event |
| TE-028 | C | `delta.reasoning` with `opaque` | the next turn | the `reasoning` content is in `history` and its `opaque` is in the next `message` event to the provider |
| TE-029 | C | a `notice` with `wake: true` on a conversation that forbids waking | between turns | appended at the next boundary; no turn starts |
| TE-030 | C | compaction runs over a `protected: true` history entry | context | the entry survives |
| TE-031 | C | a frame over 1 MiB on the kernel socket | any | refused with `frame-too-large`; the turn ends `crash` with that reason |
| TE-032 | G | a gateway that declares `call` | install | refused: `call` is an own hook; a gateway observes |
