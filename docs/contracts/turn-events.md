# contract/turn-events · 1.0.0

Ships with `core`. Governs the stream of events that is one turn, the
order the core runs them in, which events have exactly one provider,
the shape of every payload, the lifecycle of a stage, and what a
handler must pass to be a handler. Revised after the tool exercise
(`design/findings-tools.md`).

## The envelope

```ts
interface Event<T extends string, P> {
  type: T;
  conversation: string;
  turn: number;           // 1-based per conversation
  iteration: number;      // 1-based per turn; 0 for input, retrieve, notice, end
  seq: number;            // monotonic per turn
  payload: P;
}
```

Each event has one hook type, and a handler can do only that:
`observe` (`input`, `token`, `output`, `end`: read only), `append`
(`context`: add to a section), `answer` (`offer`: add definitions),
`own` (`call`: the handler that offered the tool answers it), `single`
(`retrieve`: the one provider answers), `emit` (`notice`: a stage
speaks between turns). Any stage may additionally `observe` any event,
read-only, after its actor has run; a gateway or a trace package sees
the whole chain this way. No handler rewrites another's work, inserts
events, or reorders them (ADR 0015 §6).

## Order

```
turn:      (input | notice) → retrieve → [ iteration ]+ → output → end
iteration: context → offer → (model, emitting token*) → call*
```

A turn begins with a person's `input` or, when a queued `notice` asks
to wake and the person's setting allows it, with that `notice`. The
core runs the model between `offer` and `call`; it is not a stage. An
iteration ends with no calls (the answer), a call whose tool has
`endsTurn`, the iteration limit, a cancel, or a crash. The core checks
the context size at the top of every iteration.

## Stage lifecycle

A package declares what it handles by exporting from `index.ts`:

```ts
export const stages: {
  init?:     (profile: ResolvedProfile, ctx: StageContext) => Promise<void>;
  shutdown?: () => Promise<void>;
  observe?:  (event: Event<any, any>) => void;   // read-only, every event, run after the event's actor; synchronous and cheap      // before a turn-boundary restart; bounded wait, then the process group is killed
  input?, retrieve?, context?, offer?, call?, token?, output?, notice?, end?: Stage<…>;
};
interface StageContext {
  emit: (n: Notice) => void;           // queue a notice for the next turn boundary
  settings: Record<string, unknown>;   // this package's declared settings, resolved
  provided: Record<string, { endpoint?: string; version: string; transport?: string }>;  // each service/ this package required
  spaces: { path: string; mode: "ro" | "rw"; space: string }[];
  state: string;                       // this package's state directory
}
```

`init` runs once at process start and again after a work restart. A
stage may own child processes; they are stage state, not services:
they inherit no socket and no token, and a restart ends them, after
which the core writes one line into the conversation naming the stage.

## Handlers and singletons

`retrieve` is the only singleton: exactly one package in a profile
`provides: { "stage/retrieve": "1.x" }` and only its handler runs. Every
other event runs every handler that declares it, in profile order,
which is the resolver's dependency order. The list of singletons is
part of this contract; adding one is a minor if the core previously ran
zero handlers for it, a major otherwise.

## Payloads

### `input`

```ts
interface Input {
  text: string;
  attachments: { name: string; mime: string; bytes: number; hash: string; path: string }[];  // inside the person's space
  activate?: string[];     // skill ids the person named explicitly
  project?: string;        // the conversation's project, if attached
}
```

A gateway emits it. Nothing else changes it.

### `notice`

```ts
interface Notice {
  source: string;          // package@version, set by the core from the emitter
  tool?: string;           // the tool whose pending call this completes, if any
  handle?: string;         // the handle that call returned
  content: Content[];      // what the model will see
  wake: boolean;           // ask for a turn with no person input
}
```

A stage emits a notice between turns through `ctx.emit`. The core
queues it; at the next turn boundary each queued notice becomes a
`tool` message in `history` tagged with its source. If any queued
notice has `wake: true` and the setting `conversation.wake` is on for
the person, the core starts a turn with the notices as its first
event; otherwise they wait for the next `input`. A notice never
interrupts a turn in flight.

### `retrieve`

```ts
interface RetrieveRequest {
  query: string;           // the core's default is the input text; a stage before retrieve may change it
  k: number;
  budget: number;          // tokens: window − reserve − already pinned, computed by the core
  model: string;
}
// retrieve runs on turn 1 and on a refresh (ADR 0013); the stored prefix serves the turns between
interface RetrieveAnswer {
  entries: SkillEntry[];   // contract/skills; body optional
  dropped: string[];       // ids that fit the query but not the budget
}
```

The core renders `entries` into the `skills` section with one fixed
wrapping (below). The provider has no `context` handler.

### `context`

```ts
interface Context {
  sections: {
    system:  Message[];    // the base prompt; stages may append, never replace
    skills:  Message[];    // rendered by the core from retrieve; read-only to stages
    harness: Message[];    // the person's notes, memories, briefs
    history: Message[];    // the conversation, projected through compaction
  };
  budget: { window: number; reserve: number; used: number };
}
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: Content[];
  protected?: boolean;     // compaction keeps it
  source: string;          // package@version that produced it; "core" for the core
  toolCallId?: string;     // on tool messages
}
type Content =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; hash: string; path: string }
  | { type: "resource"; path: string; bytes: number }           // a file the file tools can read
  | { type: "artifact"; path: string; mime: string; hash: string; bytes: number };  // recorded in the conversation; served by a gateway
```

Appends to a section are ephemeral: assembled for this iteration and
never written to the conversation. A stage that wants something kept
emits a `notice`. The core appends the turn's `input` to `history`
before `context` runs, so a stage can read the latest message there.

Sections are concatenated in this order and the result is the prompt.
Everything before `history` is the prefix the pin covers. A stage
appends to a section; it cannot reorder sections or edit another
stage's messages. The fixed wrapping for `skills` is one system message
per entry: a heading line `# skill: <id> (<pack>@<version>)` followed
by the body, or by the description when the entry has no body.

### `offer`

```ts
interface OfferRequest {
  mode: Mode;
  pinned?: { name: string; source: string; schemaHash: string }[];   // from turn 2
}
interface Mode {
  readOnly: boolean;       // the conversation's mode
  deny: string[];          // per-name denials from the role, as package/name
}
interface OfferAnswer { tools: ToolDef[]; }
interface ToolDef {
  name: string;            // unique across the profile; a duplicate is refused at install
  description: string;
  schema: JsonSchema;      // the arguments, JSON Schema 2020-12
  readOnly: boolean;       // changes nothing
  endsTurn: boolean;       // the turn ends after this call
  destructive?: boolean;   // default false for own tools; true for a derived tool whose source does not say otherwise
  source: string;          // package@version
  derived?: boolean;       // the schema comes from installed data or a remote list
  trusted?: boolean;       // a handler may set it only from an environment setting; see below
  data?: JsonSchema;       // the domain columns this tool reports in CallAnswer.data, e.g. exit, stillRunning
}
```

Every handler appends its tools. A handler given `pinned` must offer
each pinned tool it is the source of, from its own cache, even if the
tool no longer exists at its source; a later `call` to it answers
`gone`. After the last handler the core: treats `readOnly` as `false`
on any def with `derived: true` unless `trusted: true`, and logs it;
drops tools with `readOnly: false` when `mode.readOnly`; drops tools in
`mode.deny`; records the offered set; on turn 1 pins the schema
hashes with the prefix; on later turns logs any def whose hash differs
from the pin and keeps the pinned one.

### `call`

```ts
interface CallRequest {
  id: string;
  name: string;
  args: unknown;           // already validated against the offered schema by the core
  mode: Mode;
  roots: { path: string; mode: "ro" | "rw"; space: string }[];   // the sandbox's mount list, so errors can name what exists
  budget: { resultBytes: number; deadlineMs: number };
}
interface CallAnswer {
  id: string;
  ok: boolean;             // the handler's own verdict; a command that ran and exited non-zero is ok: true
  content: Content[];      // what the model sees; non-text items are artifacts in the person's space
  data?: Record<string, unknown>;   // domain columns per ToolDef.data
  error?: { code: ErrorCode; message: string };   // ok: false
  pending?: { handle: string };     // the work continues; a notice with this handle follows
  endsTurn?: boolean;      // end the turn on this call even if the def did not
}
type ErrorCode =
  | "not-offered" | "invalid-args" | "deadline" | "gone"             // set by the core or the handler
  | "read-only-mode" | "denied" | "outside-roots" | "protected"     // policy and boundary
  | "not-found" | "not-unique" | "io" | "protocol" | "execution";    // the handler's own
```

The core dispatches a `call` only to the handler that offered `name`.
A call to a name not in the offered set is refused with `not-offered`
and the name of the tool that replaced it if one is known. Arguments
that fail the schema are refused with `invalid-args` and never reach a
handler. A handler that misses `deadlineMs` gets `deadline`. A handler
that cannot finish inside the deadline returns `ok: true` with
`pending` and later emits a `notice` carrying the handle; the core
records the call as pending in the log until the notice arrives.

**Spill.** The core, not the handler, spills: if `content` exceeds
`resultBytes` (from the setting `call.spill_bytes`, default 32 KiB),
the full content is written to `spaces/people/<user>/tool-output/
<turn>-<id>.txt`, the model receives head, tail and the path, and the
log row carries `spilled`. `resultBytes` is handed to the handler so
it can trim on a sensible boundary; the core enforces regardless. A
spill never lands in a project or company space.

### `model.begin`, `model.event`, `model.end`

```ts
interface ModelBegin { provider: string; model: string; request: ProviderRequestEvent[]; }   // the normalized request exactly as sent: begin, message*, tool*, end
interface ModelEvent { event: ProviderResponseEvent; }      // every response event verbatim: start, delta.text, delta.reasoning, delta.tool_call, usage, stop, error
interface ModelEnd { stop: string; usage: Record<string, number>; }
```

Emitted by the core around every model exchange; observe-only. This is
what a gateway shows as the call chain. The vendor's wire bytes are the
provider's business and are not events. The core batches `model.event`
for observers as it batches tokens for the socket.

### `token`

```ts
interface Token { text: string; }
```

Emitted by the core while the model streams. Observed by gateways and
the log; a handler may not change it.

### `output`

```ts
interface Output {
  message: Message;        // the assistant's final message of the turn
  usage: { in: number; out: number; cached: number; cost: number };
}
```

### `end`

```ts
interface End {
  reason: "answer" | "limit" | "cancel" | "crash" | "restart";
  iterations: number;
  compactions: number;
  pending: string[];       // handles still outstanding
}
```

Observed by gateways, the log, and the harness refine stage.

## The pin

After turn 1 the core writes into the conversation:

```ts
interface Pinned {
  skills: PinnedEntry[];   // { id, pack, version, contentHash }
  offer: { name: string; source: string; schemaHash: string }[];
  systemHash: string;
}
```

and passes the relevant part in every later `retrieve` and `offer`
request. The pin covers everything before the first user message.

## Conformance

**A `stage/retrieve` provider:** given `pinned`, the entries are
exactly the pinned set in pinned order; given a budget, the bodies fit
it and `dropped` lists the rest; the same request twice gives the same
answer; unknown request fields are ignored.

**Any handler of `offer` and `call`:** every offered def validates
against `ToolDef`; every `call` answer carries the request id and
validates; a schema-invalid argument set (generated by the test from
the def's schema) never reaches the handler, and the handler, fed one
directly, answers `invalid-args`; a path outside `roots` answers
`outside-roots` naming the roots; a tool with `readOnly: true`, run in
a sandbox with every mount read-only, does not fail; a symlink from an
`rw` root into an `ro` root is tested per runner adapter and must not
permit a write; a handler given a `pinned` def it no longer has still
offers it and answers `gone` on call; a handler with children leaves
none after `shutdown()`.

**Any handler of `context`:** sections are not reordered; other
stages' messages are unchanged; appended messages carry `source`.

**A `notice` emitter:** a notice carries `source` set by the core, and
`content` validates; an emitter that returned `pending` emits exactly
one notice per handle.

**The core:** the order above; the read-only and deny filters; the
derived-untrusted rule; the not-offered refusal; the pin written after
turn 1 and honoured after; the spill; notices appended at the boundary
and a wake only when the setting allows; children killed after
`shutdown()`'s wait.

## Change rules

Adding an optional payload field, a new `Content` type, a new
`ErrorCode`, or a new event that ran zero handlers before: minor.
Removing or renaming a field, changing a section's order, making a
non-singleton a singleton, or changing the meaning of `ok`: major.
Fields under `data` are the handler's and are excluded from this
contract's floor; a def with `derived: true` is excluded from the
handler package's floor (ADR 0007 §6).
