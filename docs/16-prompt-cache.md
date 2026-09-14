# 16 Prompt cache

Prompt caching lets a provider reuse the unchanged prefix of a request across turns. A cached token reads at about a tenth of the input price on Anthropic models. In a long conversation the prefix is most of the request, so caching is the largest cost lever Thetis has.

The package `@thetis/prompt-cache` in `packages/prompt-cache` implements it. The package has two parts:

- A **library**. It resolves a policy from configuration, plans where breakpoints go, writes them into a wire body, and normalizes usage. `@thetis/provider-openrouter` uses it. A future provider for another API uses it too.
- A **step** in the `call` phase. It advises the provider with a hint and records prefix diagnostics in the harness.

The provider owns the policy. The provider runs in the system userspace with the operator's credentials, and the operator pays for every request. A hint from a user's fence can tune the policy. It cannot turn caching off unless the operator allows that. See section 4.

The kernel knows nothing about caching. It carries `call.hints` to the provider and `usage` on the `message` event to the gateways. Both are generic. See [04-pipeline.md](04-pipeline.md).

## 1. How a provider cache works

Three facts decide the design. They come from the Anthropic documentation and from the OpenRouter documentation.

1. **A cache is a prefix match.** The provider renders `tools -> system -> messages`. A breakpoint writes one entry that covers everything up to and including its block. A change of one byte at position N invalidates every entry at or after N.
2. **Vendors differ in kind.** Anthropic and Alibaba cache nothing unless the request marks where. OpenAI, DeepSeek, Grok, Moonshot, Groq and Z.AI cache long prefixes on their own. Google Gemini caches implicitly on recent models; an explicit mark there bills a write plus storage. A mark on a vendor that caches on its own only bills writes.
3. **A read looks back at most 20 positions.** A later request hashes its prefix at each breakpoint and walks back at most 20 positions to find an entry. A run of consecutive tool results counts as one position. A turn that adds more than 20 positions overshoots a lone mark at the end of the previous request, and the next request reads nothing.

Limits on Anthropic models:

| Limit | Value |
|---|---|
| Breakpoints per request | 4 |
| Lifetimes | `5m` (default) and `1h` |
| Write price | 1.25x input for `5m`; 2x input for `1h` |
| Read price | 0.1x input |
| Minimum cacheable prefix | Model dependent, 512 to 4096 tokens. A shorter prefix is silently not cached. |
| Order of lifetimes | A `1h` entry must come before every `5m` entry. |

A read refreshes the lifetime of the entry. Requests that share a prefix and start less than 5 minutes apart keep a `5m` entry warm for as long as they continue.

## 2. Strategy per vendor

The step reads the vendor from the model id. `anthropic/claude-sonnet-5` has the vendor `anthropic`. A bare id is its own vendor.

| Vendor | Strategy | Effect |
|---|---|---|
| In `explicitVendors` (default `["anthropic"]`) | `breakpoints` | The provider writes `cache_control` markers. |
| Any other vendor | `automatic` | The provider sends the request unchanged. The vendor caches on its own. |
| Any vendor, `enabled: false` | `off` | No markers. |

`overrides` change the strategy or the knobs for one vendor or one model. See section 6.

## 3. Where the breakpoints go

`planBreakpoints` in `src/plan.ts` chooses up to four positions, in prefix order:

1. **The system prefix.** It holds the tools and the system prompt. It does not change within a conversation. It is the cheapest and most reliable hit. It gets the lifetime `systemTtl`.
2. **Two anchors.** They sit on multiples of `anchorStride` positions. They do not move while the conversation grows around them. When a turn adds more than 20 positions, the next request still finds an anchor within the lookback window.
3. **The final message.** It writes the newest prefix. The next request reads almost all of it back.

Positions count consecutive `tool` messages as one position, in the same way the provider does.

A marker needs content to sit on. An assistant message that only carries tool calls has no content. The plan then moves the marker to the previous message that has content. An empty message is never converted into an invalid one.

When the plan has more positions than the budget, the newest positions win. An older prefix is the one most likely still covered by an entry the lookback can reach.

## 4. The policy and the hint

### 4.1 The policy

`resolvePolicy(config, model)` in `src/policy.ts` builds the policy the provider acts on:

```ts
{
  version: 1,
  strategy: "breakpoints" | "automatic" | "off",
  ttl: "5m" | "1h",         // lifetime of the conversation breakpoints
  systemTtl: "5m" | "1h",   // lifetime of the system prefix breakpoint
  anchorStride: 8,
  maxBreakpoints: 4,
  affinity?: "thetis:<16 hex>"  // a stable token per user, from the hint
}
```

`config` is the provider's own `cache` object. See section 6.

### 4.2 The hint

The step attaches a sparse hint to the call. The hint names only what the step's configuration names for this model, plus the affinity token:

```ts
call.hints.cache = { version: 1, ttl?: ..., systemTtl?: ..., anchorStride?: ..., maxBreakpoints?: ..., strategy?: ..., affinity?: ... }
```

`call.hints` is never sent to the API. A provider reads the keys it understands. See [04-pipeline.md](04-pipeline.md) section 9 and [07-providers.md](07-providers.md) section 1.

The hint crosses the fence from the user's userspace to the provider's userspace. The provider validates it with `readHint`. A malformed field is dropped. The provider then combines it with its policy with `applyHint(policy, hint, mode)`. The mode is the provider's `cache.hints` setting:

| Mode | Effect |
|---|---|
| `ignore` | The policy is used as is. |
| `tune` (default) | The hint can set `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, and `affinity`. Every knob is clamped. The strategy stays the operator's. |
| `override` | The hint can also set the strategy. |

## 5. The wire adapters

| Function | Body | Markers |
|---|---|---|
| `applyOpenAiCompatible(body, policy)` | OpenAI chat completions, as OpenRouter takes it | `cache_control` on the last content part of a message. A string content becomes one `text` part. Works on `system`, `user`, `assistant`, and `tool` messages. |
| `applyAnthropicMessages(body, policy)` | The native Anthropic Messages API | `cache_control` on the last `system` block and on the last content block of a message. A user message made only of `tool_result` blocks is one tool position. |

Both return the number of markers written. Both leave the body unchanged for the strategies `automatic` and `off`.

**Note:** OpenRouter forwards markers on `tool` and `assistant` messages to Anthropic. It does not forward a marker on a tool definition in `tools`. The OpenAI-compatible adapter therefore never marks a tool definition. The system prefix marker covers the tools.

## 6. Configuration

### 6.1 The provider

`config.packages["@thetis/provider-openrouter"].cache` holds the policy:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` sets the strategy `off` for every model. |
| `ttl` | `"5m"` or `"1h"` | `"5m"` | Lifetime of the conversation breakpoints. |
| `systemTtl` | `"5m"` or `"1h"` | `"1h"` | Lifetime of the system prefix breakpoint. Lifted to `1h` when `ttl` is `1h`. |
| `anchorStride` | number | `8` | Positions between anchors. `0` disables anchors. |
| `maxBreakpoints` | number | `4` | Clamped to 4. |
| `explicitVendors` | string[] | `["anthropic"]` | Vendors that get the strategy `breakpoints`. |
| `overrides` | object | `{}` | Per-vendor or per-model settings. A key matches a vendor name or a prefix of the model id. The longest matching key wins. Values: `strategy`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`. |
| `hints` | `"ignore"`, `"tune"`, `"override"` | `"tune"` | What a hint from the harness may change. See section 4.2. |
| `affinity` | boolean | `true` | Send the affinity token of the hint as the OpenRouter `user` field. |

Example:

```json
"packages": {
  "@thetis/provider-openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "cache": {
      "ttl": "1h",
      "overrides": {
        "anthropic/claude-opus": { "anchorStride": 4 },
        "google": { "strategy": "breakpoints", "ttl": "5m" }
      }
    }
  }
}
```

All keys are optional. With no `cache` object the defaults apply.

### 6.2 The step

`config.packages["@thetis/prompt-cache"]` takes the same keys as the provider except `hints`, plus:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `diagnostics` | boolean | `true` | Record prefix fingerprints in the harness. Log a divergence. |
| `affinity` | boolean | `true` | Put the affinity token in the hint. |

A key that is not set is not in the hint. With an empty configuration the hint carries only the affinity token, and the provider's policy applies unchanged. A user can install a package of their own that sets `call.hints.cache`, within the provider's `hints` mode.

### 6.1 Choose a lifetime

Choose by the gap between requests that share the prefix:

| Gap | Lifetime |
|---|---|
| Under 5 minutes: continuous chat, tool loops | `5m`. Every request refreshes it. It is cheaper. |
| 5 to 60 minutes: a user who replies after a break | `1h`. The 2x write pays off after three reads. |
| Over an hour | Neither. Accept the cold write. |

The default keeps the system prefix for an hour and the conversation for five minutes. A user who comes back after twenty minutes re-writes the conversation and reads the system prefix.

## 7. Diagnostics

The usage numbers say that a prefix broke. The fingerprint says where.

At each turn the step hashes the head (model, system prompt, tool list) and each message of `call.messages`. It stores the hashes in `harness["@thetis/prompt-cache"]`:

```ts
{
  head: string,           // 12 hex characters
  messages: string[],     // one hash per message
  turns: number,
  divergences: number,
  last?: { kind: "head" | "rewrite" | "truncate", at?: number, turn: number }
}
```

At the next turn the step compares. The previous call must be a prefix of the current one. When it is not, the step counts a divergence, records it in `last`, and logs one line to the agent's `stderr`:

```
prompt-cache: turn 7: message 3 changed; the prefix is re-written from there
```

| Kind | Cause |
|---|---|
| `head` | The model, the system prompt, or the tool list changed. The whole prefix is re-written. |
| `rewrite` | A step changed a message at index `at`. |
| `truncate` | A step cut the history to `at` messages. |

Use `thetis sessions show` or `/inspect` in `chat` to read the record.

### 7.1 Usage events

`@thetis/provider-openrouter` reports cache accounting in every `usage` event. The kernel repeats the usage of a reply on the `message` event of that reply. The CLI prints one line under each reply. The web gateway shows a header over each reply and keeps it for a reopened transcript. Both read the fields by name; neither imports this package.

| Field | Meaning |
|---|---|
| `cache_read_tokens` | Tokens served from the cache. |
| `cache_write_tokens` | Tokens written to the cache. |
| `cache_read_ratio` | `cache_read_tokens / prompt_tokens`, rounded to three decimals. |
| `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost` | As reported by OpenRouter. |
| `reasoning_tokens` | When the model reports it. |

`normalizeUsage` in `src/usage.ts` also maps the native Anthropic names `cache_read_input_tokens` and `cache_creation_input_tokens` to the same fields.

A healthy conversation shows `cache_read_tokens` close to `prompt_tokens` on every turn after the first, and `cache_write_tokens` close to the size of the last exchange. `thetis send` and `thetis chat` print the line under each reply. `--verbose` prints the raw event too.

## 8. Rules for package authors

A cache rewards an append-only prefix. Package code that builds the call must follow these rules. The diagnostics of section 7 report a violation as a `head` or `rewrite` divergence on every turn.

- **Keep the system prompt frozen within a session.** Do not put the time, a random id, or a per-turn value into `call.system`. Put per-turn context at the end of `call.messages`.
- **Do not change the tool list or the model mid-conversation.** Both invalidate the whole prefix.
- **Append to the conversation. Do not edit it.** Do not delete a failed tool round from the middle. A stale result costs 0.1x as a cached read. Removing it re-writes the suffix at 1.25x. A `history` step that must shed context must cut at a stable point and keep the cut for many turns.
- **Serialize deterministically.** Do not build tool schemas from unordered sets.
- **A fork must reuse the parent's prefix.** A subagent that copies its parent's `system` and `tools` byte for byte reads the parent's cache.

## 9. Sticky routing

OpenRouter can serve one model from several upstream providers. A cache lives on one of them. Two settings help:

- The affinity token of the hint becomes the OpenRouter `user` field. It is `thetis:` plus 16 hex characters of a hash of the user id. The user id is not sent. `cache.affinity: false` on the provider stops it.
- `config.packages["@thetis/provider-openrouter"].defaults` adds fields to every request. Pin the upstream with `{ "provider": { "order": ["anthropic"], "allow_fallbacks": true } }` to keep a conversation on one provider's cache.

## 10. Verification

The live check on 2026-09-13 through OpenRouter with `anthropic/claude-sonnet-5`:

| Request | `cache_read_tokens` | `cache_write_tokens` |
|---|---|---|
| System prefix, first request | 0 | 9308 |
| Same prefix, second request | 9308 | 0 |
| A marker on a `tool` message | 9308 | 343 |
| A marker on an `assistant` message | 9308 | 86 |
| A marker on a tool definition | 0 | 0 |

## 11. Future work

- **A native Anthropic provider.** `applyAnthropicMessages` is ready. The provider resolves its own policy, applies the hint, and calls it.
- **Keep-alive.** A request with `max_tokens: 0` refreshes an entry at read price. A service package can send one just before a `5m` entry expires for sessions with a user who is still present.
- **Cache diagnostics of the API.** Anthropic offers server-side diagnosis behind a beta header. The client-side fingerprint in section 7 covers the same question today.
- **Mid-conversation system messages.** Newer Anthropic models accept a `system` role message inside `messages` that leaves the cached prefix intact. OpenRouter's handling is not verified.
