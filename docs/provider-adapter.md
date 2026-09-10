# Compatible provider implementation notes

The adapter uses the Chat Completions HTTP wire and local, versioned model
declarations for describe. It reserves the full declared context window
and maximum output at the reviewed prices before HTTP. Explicit caching
requires declared cache read/write prices. OpenRouter requests also carry
the corresponding prompt/completion price ceilings and reject per-request
pricing through `provider.max_price.request = 0`.

Only normalized options and the adapter's reasoning extension reach the
vendor. HTTP redirects and automatic retries are disabled. Error bodies
are discarded, keeping keys and vendor internals out of emitted errors.

SSE is streamed with bounded events. The finish marker is held until usage
and `[DONE]`; repeated finish markers on usage frames are accepted.
Reasoning details are preserved in opaque content and replayed in order.
Explicit cache breakpoints follow the requested anchors; a request above
the configured vendor breakpoint limit is refused before HTTP.

Image transfer is not registered yet, so model declarations must advertise
`images: false`. The runner now supports secret delivery at sandbox spawn;
the service is wired through scoped inherited authority and bounded provider
accounting. Live OpenRouter validation still requires an operator-supplied key. All HTTP tests use a scripted vendor.

Protocol sources checked on 2026-09-09:

- [Streaming and terminal accounting](https://openrouter.ai/docs/api_reference/streaming)
- [Usage and cache counters](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Opaque reasoning replay](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Explicit cache breakpoint limits](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [Routing price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection)
