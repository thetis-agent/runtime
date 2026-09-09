# contract/provider · 1.0.0

Ships with the first provider package. Governs the stream between the
core and a model provider (ADR 0011, 0019). The provider holds its own
key; the kernel is not in the stream. Line-delimited JSON
in both directions over the adapter's unix socket. Nothing vendor-shaped
crosses it.

## `describe`

```ts
{ v: "1", method: "describe" }
→ { v: "1", models: ModelCap[] }
interface ModelCap {
  id: string;              // as the provider names it
  contextWindow: number; maxOutput: number;
  tools: boolean; images: boolean; seed: boolean;
  cache: "explicit" | "implicit" | "none";
  price?: { in: number; out: number; cachedRead?: number; cachedWrite?: number };   // per million tokens, the adapter's knowledge
}
```

## Request stream (core → provider)

```ts
{ type: "begin", id, model, options: { maxTokens?, temperature?, seed?, stop? }, cache: { prefixThrough: number; anchorStride?: number }, vendor?: Record<string, unknown> }
{ type: "message", role, content: Content[] }          // one event per message, in order; Content from contract/turn-events
{ type: "tool", name, description, schema }             // one per tool definition
{ type: "end" }
{ type: "cancel", id }
```

The core sends the cache policy; `cache.prefixThrough` names the message index through which the prefix
is pinned; an adapter for an `explicit` vendor places its markers at the
last system message, at anchors every `anchorStride` messages, and at
the final message; an `implicit` or `none` adapter ignores it. `vendor`
is opaque to the door and keyed by the provider's name.

## Response stream (provider → core)

```ts
{ type: "start", id, model }
{ type: "delta.text", text }
{ type: "delta.reasoning", text?, opaque? }                 // thinking; opaque is what the vendor needs returned on the next turn
{ type: "delta.tool_call", callId, name?, args: string }   // fragments; the core assembles by callId
{ type: "usage", counters: { cost: number; [name: string]: number } }   // cost is reserved, in the deployment's currency unit; every other name is the provider's own
{ type: "stop", reason: "end" | "tool_calls" | "length" | "cancel" }
{ type: "error", code: "provider" | "auth" | "rate-limit" | "budget" | "context" | "deadline", status?, message }   // budget: a rule the kernel handed the provider at start would be exceeded (ADR 0020)
```

A deployment-scope provider also reports each call's final `usage`
counters to the kernel with the caller's run token (`usage.report` on
the kernel socket); the kernel appends them uninterpreted. The core turns `delta.text` into `token`, keeps `delta.reasoning` as a
`reasoning` content in history and returns its `opaque` in later
`message` events, assembles
`delta.tool_call` into `call` requests, and closes the iteration on
`stop`.

## Conformance

For an adapter: `describe` answers within the probe budget; a request
with a pinned prefix twice produces byte-identical vendor requests for
the prefix; `usage` arrives before `stop`; `cancel` ends the response
within the deadline with `stop.reason = "cancel"`; unknown request
fields and unknown `options` keys are ignored; the mock provider passes
the same suite. Under ADR 0019 there is no door: the kernel neither sees
nor rewrites provider content. The evaluator supplies its pinned model
through the request configuration; the core's model.end row has the last
`usage` (PR-015).

## Change rules

A new content kind or response event: minor. A changed shape of
`begin`, `message`, `delta.*`, `usage` or `stop`: major. A new `cache`
mode: minor.
