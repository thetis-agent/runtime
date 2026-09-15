# 04 Pipeline

A turn is one pass through the pipeline of a session. The pipeline is a list of steps. The kernel builds the list from configuration and installed packages.

## 1. Phases

The configuration field `phases` gives the phase order. The default is:

```
history -> prompt -> tools -> call -> after
```

The configuration field `callPhase` names the phase that contains the built-in provider call. The default is `call`.

The kernel does not give meaning to phase names. Packages declare steps against phase names. The intended use is:

| Phase | Intended use |
|---|---|
| `history` | Compact, trim, or rewrite the conversation. Set `call.messages`. |
| `prompt` | Build `call.system`. Inject memory or skills. Set `call.model` or `call.params`. |
| `tools` | Attach tools to `call.tools`. |
| `call` | Steps that must run just before the provider call. The built-in call runs last in this phase. |
| `after` | Read the model output. Write memory. Update `harness`. |

## 2. Enumeration

`Enumerator.enumerate(userspace, session, packages)` returns the step list.

### 2.1 Default plan

When `config.enumerator` is not set, the kernel builds the plan itself:

1. For each phase in `config.phases`, in order:
   1. For each installed package, in install order:
      1. For each declared step whose `phase` equals the current phase: add `{ package, export, id: "<package>#<step id>", phase }`.
   2. When the phase equals `config.callPhase`: add the built-in call step.

The built-in call step is `{ package: "@thetis/kernel", export: "provider-call", id: "provider-call" }`. The constant `BUILTIN_CALL` in `src/pipeline/enumerator.ts` defines it.

### 2.2 Package enumerator

Set `config.enumerator` to `{ "package": "@alice/my-enumerator", "export": "enumerate" }` to replace the default plan. The kernel sends the operation `enumerate` into the user's fence with:

```ts
{ session: { id, user, parent? }, packages: PackageQuery, phases: string[] }
```

The function returns an array of step references. The kernel validates each reference:

- A reference to the built-in call is accepted as is.
- Any other reference must name an installed package. That package must declare a step with the same `export`. Otherwise the turn fails with the code `enumerator`.
- The result must be an array. Otherwise the turn fails with the code `enumerator`.

**Note:** A package enumerator is package code. It runs in the fence. It can only schedule steps that exist in its own userspace.

## 3. The step contract

A step is an exported async function of a package. The manifest declares it under `thetis.steps`.

```ts
type Step = (ctx: PackageStepContext) => Promise<StepResult | void>;

interface PackageStepContext {
  session: { id: string; user: string; parent?: string };
  turn: { id: string; input: Message[] };
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageQuery;          // has(name), get(name), list(type?)
  env: StepEnv;                    // see 03-fence.md section 4.2
  config: Record<string, unknown>; // config.packages[<this package>]
}

type StepResult = { conversation?: Message[]; call?: ProviderCall; harness?: HarnessState };
```

Rules:

- Return only the variables you change. Return nothing to change nothing.
- Return complete values. The kernel replaces the variable. It does not merge. To add one field to `call`, return `{ call: { ...ctx.call, system: "..." } }`.
- Do not mutate `ctx` in place and return nothing. The kernel does not read the mutated `ctx`. It reads only the return value.
- The context is a copy. It crosses the fence as JSON. Functions and class instances in the variables do not survive.

## 4. Validation of mutations

`PipelineRunner.apply` checks each result before it changes the variables.

| Field | Rule | Failure code |
|---|---|---|
| result | Must be an object or null. | `step` |
| `conversation` | Must be an array. Each element must have a `role` of `system`, `user`, `assistant`, or `tool`, and a string `content`. | `step` |
| `call` | Must be an object with a string `model` and an array `messages`. `tools` becomes `[]` when it is not an array. `params` becomes `{}` when it is missing. | `step` |
| `harness` | Must be an object and not an array. | `step` |

An invalid result ends the turn with an `error` event. The variables keep the values from before that step.

## 5. The turn algorithm

`PipelineRunner.runTurn(userspace, session, input, emit)`:

1. Create a turn id `t_<12 hex>`.
2. Read the installed packages.
3. Build the initial context:
   - `conversation` = the saved conversation plus the input messages;
   - `call` = `{ model: config.model, messages: [], tools: [], params: {} }`;
   - `harness` = the saved harness.
4. Emit `turn.start`.
5. Enumerate the plan.
6. For each step: emit `step.start`; run the step; apply the result; emit `step.end` with the duration in milliseconds.
   - The built-in call runs in the kernel.
   - Any other step goes to the fence as the operation `step`. The payload `ctx.config` is `config.packages[<step package>]` or `{}`.
7. On any error: emit `error` with the message and the error code. Stop the loop.
8. Always: save `conversation` and `harness` to the session file. Increase `turns` by one. Emit `turn.end`.

**Note:** The kernel saves the session even after an error. The input messages and any messages added before the error are kept.

### 5.1 Cancel

`runTurn` receives an `AbortSignal` from `SessionApi.send`. `SessionApi.cancel` aborts it. The turn then stops at the next checkpoint:

- before each step;
- inside the provider call: the fence request is cancelled, so the stream stops;
- before each tool call.

The turn ends with an `error` event of code `cancelled`, then `turn.end`. Text that the provider streamed before the cancel is kept as a partial `assistant` message in the conversation.

### 5.2 What a stopped or failed turn keeps

Whatever the provider call did before it stopped stays in the conversation: every assistant message, every tool call, and every tool result so far. Text streamed before the stop becomes a partial `assistant` message. A tool call that never ran gets a `tool` message `error: the turn was stopped before this tool ran` (or `failed`), so the record is still a conversation the provider accepts on the next turn. A provider refusal in the middle of a long turn therefore costs the next turn a retry, not the work already done.

## 6. The built-in provider call

`ProviderCallStep.run(userspace, ctx, emit)` is the only step the kernel runs itself.

1. Copy `ctx.conversation` into a local list.
2. Build `call` from `ctx.call`. When `call.messages` is empty, use a copy of the conversation. Otherwise keep `call.messages` as the steps built it.
3. Resolve a provider for `call.model`. See [07-providers.md](07-providers.md).
4. Repeat until the model answers without a tool call:
   1. Send `call` to the provider. Collect text deltas and tool calls. Emit `text`, `tool.call`, and `usage` events.
   2. When the provider emitted an `error` event, fail with the code `provider`.
   3. Build the assistant message `{ role: "assistant", content, toolCalls? }`. Append it to the conversation and to `call.messages`. Emit `message`.
   4. When the message has no tool calls, stop.
   5. For each tool call, in order: run the tool (section 7). Append the tool message to the conversation and to `call.messages`.
5. Return `{ conversation, call }`.

The step does not change `harness`.

## 7. Tool execution

A tool call from the model has `{ id, name, args }`. The kernel finds the `ToolSpec` with the same `name` in `call.tools`. The spec carries `package` and `export`.

- When no spec matches, the tool result is `error: unknown tool: <name>`.
- Otherwise the kernel sends the operation `tool` into the user's fence with `{ package, export, name, args, session, config }`. `config` is `config.packages[<tool package>]` or `{}`.
- A string result is used as is. Any other value is JSON-encoded. `undefined` becomes `null`.
- When the tool throws, the result is `error: <message>`.

The kernel emits `tool.result` and appends `{ role: "tool", content: result, toolCallId: id, name }`.

Tool results never end the turn. The model sees the error text and can react.

## 8. Turn events

`sessions.send(user, session, input, opts?)` returns an `AsyncIterable<TurnEvent>`. `opts.model` sets the initial `call.model` for the turn instead of `config.model`; steps may still change it. The events are:

| Type | Fields | When |
|---|---|---|
| `turn.start` | `turn`, `session` | Before enumeration. |
| `step.start` | `step` | Before each step. |
| `step.end` | `step`, `ms` | After each step. |
| `text` | `delta` | For each text chunk from the provider. |
| `tool.call` | `call: { id, name, args }` | When the provider emits a tool call. |
| `tool.result` | `id`, `name`, `result` | After the tool ran. |
| `message` | `message`, `usage?` | After each assistant message is complete. `usage` repeats the last `usage` the provider reported for that message. |
| `usage` | `usage` | When the provider reports token usage. |
| `error` | `message`, `code?` | When the turn fails. At most one per turn. `code` is the `KernelError` code, for example `provider`, `cancelled`, `step`. |
| `turn.end` | `turn`, `session` | Always, last. |

## 9. Message shapes

```ts
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; // assistant only
  toolCallId?: string;  // tool only
  name?: string;        // tool only
}

interface ProviderCall {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  params: Record<string, unknown>;   // passed to the provider as extra fields
  hints?: Record<string, unknown>;   // never sent to the API; a provider reads the keys it understands
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  package: string;   // the package that runs the tool
  export: string;    // the export in that package
}
```

## 10. The default harness steps

The package `@thetis/harness-core` provides three steps. They are the reference implementation of each phase.

| Step | Phase | Behavior |
|---|---|---|
| `systemPrompt` | `prompt` | Appends the guide text, the installed package list with each package's description, the content of `home/THETIS.md`, and `harness.notes` to `call.system`. |
| `attachTools` | `tools` | Adds every tool declared by every installed package to `call.tools`. The first package with a given tool name wins. |
| `recordCall` | `after` | Writes what the provider received to `harness["@thetis/harness-core"].lastCall`: `{ model, system, systemChars, tools, messages, at }`, with the whole `system`, the tool names, the count of `call.messages`, and an ISO time. It merges into the key, keeping the other fields there, and returns only `harness`. |

`recordCall` runs after the built-in call, whose result is `ctx.call` with the reply and any tool rounds appended to `messages` (section 6); `model`, `system` and `tools` are therefore the ones that were sent, and `messages` counts the exchange rather than the request alone. It never returns `call`: that is the prefix the provider cache saw, and a record of it must not change it ([16-prompt-cache.md](16-prompt-cache.md) section 8). The whole system prompt is kept because a Context inspector shows it; it is per-session state on disk, which is acceptable.

The package `@thetis/prompt-cache` adds a fourth default step, `cacheHints` in the `call` phase. See [16-prompt-cache.md](16-prompt-cache.md).

**Note:** A package that keeps state in `harness` should use its own name as the key, as `@thetis/harness-core` and `@thetis/prompt-cache` do. Other packages read the key by name and tolerate its absence.
