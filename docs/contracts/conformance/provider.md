# Conformance · contract/provider 1.0.0

Subjects: **A** a provider package; **M** the mock provider (must pass
the same suite); **C** the core as the client.

| Id | Subject | Given | When | Then |
| --- | --- | --- | --- | --- |
| PR-001 | A | the service socket | `describe` | answers within the probe budget; validates against `#describeResponse`; every model has `cache` and `contextWindow` |
| PR-002 | A | a request with `cache.prefixThrough = N` sent twice | begin…end | the vendor request bytes for messages 0..N are identical both times (captured by the adapter's own test tap) |
| PR-003 | A | a stream | response | `usage` arrives before `stop`; `usage.counters.cost` is present and ≥ 0 |
| PR-004 | A | `cancel` mid-stream | response | `stop.reason = "cancel"` within the deadline; no further events |
| PR-005 | A | unknown fields in `begin`, unknown keys in `options` | begin | ignored; the response validates |
| PR-006 | A | a model with `tools: true` and a tool definition | response | `delta.tool_call` fragments share a `callId`, the first carries `name`, concatenated `args` parse as JSON matching the tool's schema |
| PR-007 | A | a model with `reasoning: true` | response | `delta.reasoning` events precede `delta.text`; if `opaque` is emitted, sending it back in the next `message` is accepted by the vendor (adapter's own test) |
| PR-008 | A | the vendor returns 401 | response | `error.code = "auth"`; no retry |
| PR-009 | A | the vendor returns 429 | response | `error.code = "rate-limit"`; no retry |
| PR-010 | A | a budget rule `cost ≤ N per person per day` handed at start, and a call that would exceed it | begin | `error.code = "budget"` with the rule's name, before any vendor request |
| PR-011 | A | a call completes | after `stop` | `usage.report` reaches the kernel with the run token and the same counters |
| PR-012 | A | a run token the kernel does not know | begin | refused with `auth`; nothing reaches the vendor |
| PR-013 | A | `deployment` scope | start | the key was delivered as an environment variable at spawn and is not readable from any mount |
| PR-014 | M | the whole suite | run | passes; the mock scripts each case |
| PR-015 | C | a `usage` event | model.end | `usage` equals the last `usage.counters` |
