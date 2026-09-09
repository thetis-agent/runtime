# ADR 0011 · Providers are stream adapters behind the door

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Amends:** ADR 0008 (the door's scope), contract/llm draft
**Supersedes:** the draft rule that the door "relays the provider's stream verbatim"

## Context

The operator pointed out a missing seam: nothing abstracts the model
providers. The draft's door relayed the provider's stream verbatim and
placed cache breakpoints by vendor, which put vendor knowledge in the
host and vendor wire formats in the core. Thetis had `llm.rs` (2,454
lines) speaking OpenAI-compatible SSE to OpenRouter and to two local
llama-server units, `cache.rs` with per-vendor breakpoint rules, and
`context_window.rs` probing llama-server's `/props` for the window. A
change in an OpenAI contract version, a new provider, or a local model
server each meant kernel code.

The same problem on the person-facing side was solved by gateways: a
contract at the boundary, adapters as packages. Providers are the same
boundary facing the other way.

## Decision

1. **A provider is a package** that `provides: { "service/llm-provider.<name>": "1.x" }`
   under `contract/provider` and runs at `deployment` scope as a `spawn`
   in its own sandbox, receiving its key from the host at start per
   ADR 0009. Examples: `provider-openai-compatible` (OpenRouter, OpenAI,
   llama-server, vLLM; the wire format most servers speak),
   `provider-anthropic`, `provider-google`, and `provider-llama`, which
   also spawns llama-server itself from a model file setting and
   requires `cap/gpu`. The host names none of them.
2. **The contract is a stream in both directions**, line-delimited JSON
   events over the service's socket. Request events: `begin` (model,
   options, cache policy), `message` (one per message, so a large
   context is never buffered whole), `tool` (one per definition), `end`.
   Response events: `start`, `delta.text`, `delta.tool_call` (id, name,
   argument fragment), `usage` (in, out, cached read, cached write),
   `stop` (reason), `error`. Nothing vendor-shaped crosses it.
3. **A provider reports capabilities per model** on `describe`: context
   window, max output, tools, images, seed, cache mode (`explicit`,
   `implicit`, `none`), and its own idea of cost. This replaces probing
   `/props` in the host: the local adapter probes its own server.
4. **Cache placement moves to the adapter.** The door sends a cache
   *policy* on `begin` (pin the prefix through message N; anchors at a
   stride); the adapter places the vendor's markers or does nothing if
   the vendor caches implicitly. The byte-identical-prefix rule is still
   enforced by the core; where the markers go is vendor knowledge.
5. **The door keeps** the key (resolved by scope), the meter and the
   per-person limits, the log row, the pinned model for bench runs, and
   the routing of a model name `provider.<name>/<model>` to the provider
   that serves it. It does not parse content. It copies events and
   reads only `usage` and `error`.
6. **The core consumes `contract/provider` events, never a vendor's.**
   `delta.text` becomes `token`; `delta.tool_call` fragments are
   assembled by the core into calls; `stop` closes the iteration.
7. **Embeddings stay a separate service** (ADR 0008); a provider package
   may also provide `service/embed` if its vendor offers one.

## Alternatives considered

**Adapters inside the host, chosen by configuration**, like the sandbox
runner. Lost: the runner is the boundary itself and cannot be a
package, but a provider is an ordinary service the boundary already
knows how to run; keeping it a package lets a person add a provider by
publishing and a reviewer adopt it, and keeps the host at zero vendor
names.

**One OpenAI-compatible format as the contract.** Lost: it is a
vendor's contract with versions of its own, which is the problem being
solved; the normalized stream is smaller than any vendor's and stable
by our rules, not theirs.

**Buffered request, streamed response.** Lost: a 200k-token context
buffered in the door on every turn is the chattiest hop in the system.

## Consequences

Good: a new provider or a vendor's contract change is a package
version; local models are the same shape as hosted ones; the door drops
to routing, keys and metering; the core has one input format; the
comparison benchmark can pin any provider.

Bad: one more process per provider at deployment scope; the first
adapter must be written before milestone A can talk to a model, so
`provider-openai-compatible` and the mock provider are in milestone A;
`usage` normalization across vendors is a real piece of work and the
row's `cost` is the adapter's estimate until the meter learns the
vendor's prices.

## Revisit

If a vendor's feature cannot be expressed as an event (a new content
kind), it is a minor of `contract/provider`; if the request side needs
vendor-specific options, they travel in `begin.options` under the
provider's name and the door never reads them.
