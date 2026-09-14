# 07 Providers

A provider is a package that sources models. The kernel never talks to a model API. It sends the call into the fence where the provider package runs.

## 1. The contract

```ts
interface Provider {
  models(): Promise<ModelDescriptor[]>;
  call(call: ProviderCall): AsyncIterable<ProviderEvent>;
}

interface ModelDescriptor { id: string; name?: string; provider?: string }

type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: { id: string; name: string; args: Record<string, unknown> } }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string };
```

The manifest declares `"thetis": { "type": "provider", "export": "createProvider" }`. The export is a factory `(config) => Provider`. The agent calls the factory once per distinct `config` and caches the instance.

Rules for `call`:

- Emit `text` for each chunk of assistant text.
- Emit `tool_call` after the arguments are complete. The kernel runs tools after the stream ends.
- Emit `error` and return when the request fails. The kernel ends the turn with the code `provider`.
- Read `call.system`, `call.messages`, `call.tools`, and `call.params`. Pass `params` through to the API as extra fields.
- Read `call.hints` for the concerns you understand. Never send `hints` to the API. Validate every hint: it comes from the user's fence.

Rules for `models`:

- Return the model ids the provider serves.
- Return an entry with id `*` to accept any model id.

## 2. Where a provider runs

A provider runs in the userspace where it is installed:

- A system provider is installed in the system userspace `_system`. It holds the service credentials from `config.packages`.
- A user provider is installed in the user's own userspace. It holds the user's credentials. It can read them from a file in the user's home.

The kernel sends `config.packages[<provider name>]` only to the fence where that provider runs.

## 3. Resolution

`ProviderRegistry.resolve(userspace, model)` in `src/providers.ts`:

1. Build the candidate list: providers installed in the caller's userspace, then providers installed in the system userspace. The first occurrence of a name wins.
2. Fail with the code `provider` when the list is empty.
3. Return the first candidate whose `models()` contains `model`.
4. Otherwise return the first candidate whose `models()` contains `*`.
5. Otherwise fail with the code `provider`: `no installed provider serves model "<model>"`.

The registry caches `models()` per provider and userspace for 300000 milliseconds.

`ProviderRegistry.listModels(userspace)` returns all models of all candidates with the `provider` field set to the package name. The CLI command `models` uses it.

## 4. The OpenRouter package

`@thetis/provider-openrouter` in `packages/provider-openrouter` is the default provider.

### 4.1 Configuration

```json
"packages": {
  "@thetis/provider-openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "baseUrl": "https://openrouter.ai/api/v1",
    "headers": {},
    "defaults": {},
    "cache": {}
  }
}
```

`defaults` holds request fields sent with every call, under `call.params`. Example: `{ "provider": { "order": ["anthropic"], "allow_fallbacks": true } }`.

Set `defaults.max_tokens` (for example `8192`). OpenRouter reserves the model's full output allowance against the account's remaining credits for every request in flight; without a ceiling, a large prompt on a low balance is refused with `402 in_flight_budget_exhausted` although the call would have cost a fraction of that.

`retries` (default `3`) is how many times a transient refusal is tried again: `429`, `408`, `409`, `425`, `5xx`, and a `402` whose body names `in_flight_budget`. The wait honors the `Retry-After` header, else the hint in the body, else a backoff of 1, 2, 4 seconds, capped at 120 seconds. A refusal that is final (`401`, an empty account) is reported at once.

`cache` holds the prompt caching policy. See [16-prompt-cache.md](16-prompt-cache.md) section 6.

`apiKey` falls back to the environment variable `OPENROUTER_API_KEY` of the agent process. The kernel does not pass that variable to the fence. Set the key in `config.packages`, or in `.env` from which the CLI interpolates `${OPENROUTER_API_KEY}` into the config.

### 4.2 Behavior

- `models()` calls `GET /models` and returns every id.
- `call()` posts to `/chat/completions` with `stream: true` and `usage: { include: true }`.
- `call.system` becomes the first message with role `system`.
- An assistant message with `toolCalls` becomes `tool_calls` with JSON-encoded arguments.
- A `tool` message becomes `{ role: "tool", tool_call_id, name, content }`.
- `call.tools` become `{ type: "function", function: { name, description, parameters } }`.
- The body is `{ model, messages, tools, stream, usage, ...defaults, ...call.params }`. The provider then applies the cache policy: `resolvePolicy` from its `cache` config, `applyHint` with `call.hints.cache`, `applyOpenAiCompatible` on the body. It sets the `user` field to the affinity token of the hint when the body has none.
- Streamed tool call fragments are joined by index. The provider emits `tool_call` events after the stream ends.
- `usage` events carry `normalizeUsage` of the OpenRouter usage object: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, `reasoning_tokens`.
- Invalid JSON in tool arguments becomes `{ _raw: "<text>" }`.
- A non-2xx response or an `error` field in a chunk becomes an `error` event.

### 4.3 Dependencies

The package depends on `@thetis/prompt-cache` for the policy, the planner, the wire adapter, and the usage normalization. The dependency is a workspace link. The fence binds `<root>/node_modules` read-only, so the module resolves inside the system fence.

### 4.4 Model ids

Model ids are OpenRouter ids, for example `anthropic/claude-sonnet-5`. The default is in `config.model`. A caller of `sessions.send` can name a model for one turn, which is how the web gateway applies the model a person chose for a conversation. A step can set `call.model` to any id the provider serves.

## 5. Adding a provider

1. Create `packages/<name>/package.json` with `"thetis": { "type": "provider", "export": "createProvider" }`.
2. Implement `createProvider(config)`.
3. For a system provider: add the package name to `systemPackages._system` and add its configuration to `packages` in the config file. Restart the CLI process.
4. For a user provider: install it from a conversation or with `thetis packages install <path> --user <id>`.
5. Set `config.model` or `call.model` to a model id the provider serves.

The test fixture `packages/host/test/fixtures/provider-echo` is a complete minimal provider.
