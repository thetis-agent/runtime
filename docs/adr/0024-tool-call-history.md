# ADR 0024 · Preserve assistant tool calls as normalized content

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation engineer, preserving provider round trips
**Amends:** contract/provider 1.0.0 content; contract/turn-events content by reference

## Context

The provider emits fragmented tool calls and the core sends tool results
on the next iteration. The supplied content schema has no representation
for the assistant's original call id, name and arguments in that next
request or in persisted history. A tool result alone cannot reconstruct
its originating request. Dropping that request makes a complete tool
conversation impossible for providers that require paired calls and
results; encoding it as prose loses the wire semantics.

## Decision

Publish contract/provider 1.1.0 with one additional content kind:
`{ type: "tool_call", id: string, name: string, args: string }`.
`args` preserves the assembled JSON bytes, including malformed arguments
that receive an invalid-args tool response. The core persists the assistant
message with these contents before executing its calls. Providers map
this normalized content to their vendor's assistant-call representation.
The turn-events contract references this content and advances to 1.1.0.

The new definition lives in the executable contract schema and generated
types. The copied 1.0 design schemas remain unchanged as the baseline;
this record documents the extension. Packages implementing tool replay
require the 1.1 contract. This follows the provider contract's change
rule that a new content kind is a minor change.

## Alternatives considered

Infer calls from results: the arguments and sometimes the tool name are
missing. Put vendor-shaped calls into message extensions: loses the
normalized boundary and schema-derived types. Keep transient calls only:
reopening the conversation loses the assistant request.

## Consequences

Good: call ids, arguments and reasoning survive both subsequent iterations
and conversation reloads. Bad: a 1.0 reader cannot consume this new content
kind and must use the 1.1 contract before participating in tool replay.
No existing content shape is changed and no boundary, secret rule, gate
or act is removed. The missing wire behavior is supplied rather than
silently encoded outside the schema.

## Revisit

When the provider contract next changes its message representation.
