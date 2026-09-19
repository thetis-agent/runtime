# Plan: subagents on the page

**Date:** 2026-09-19. **Status:** approved, in progress. **Scope:** restore the subagent experience the
legacy gateway had (`/opt/thetis/gateways/gateway-web/src/ui`): a subagent's output streams into the
conversation inside the element of the call that spawned it, the child gets a tab of its own, and the
sidebar nests the children under the conversation that owns them. One kernel seam makes it possible:
the events of every turn of a person, whoever started it, reach that person's gateway.

This document is the contract between the parts. The server side (section 2) and the browser side
(section 3) are built against it in parallel.

---

## 0. What the legacy gateway did, and what is kept

| Legacy behaviour | Kept? | Here |
|---|---|---|
| A child is a session. Its own turn events, tagged with the child id, its label and its parent, are routed to the root conversation. No dedicated subagent event types. | Yes | `sessions.watch` tags every event with `session` and `parent`; the page routes by walking parents. Section 2.1. |
| The transcript folds a child's rows into a `details.agent` block with a pulsing dot, the label, the state, and, once done, `N steps · $cost · tokens`. The block folds itself when the child ends. | Yes | The block is the spawn call's own element: `spawn_subagent` draws an agent block in place of a tool card. Section 3.3. |
| The child's rows are the same node types as the parent's (bubbles, tool cards, notes). | Yes | A nested transcript instance per block. Section 3.3. |
| Two homes per child: the inline block and the child's own tab with "Show in conversation". | Yes | A child opens as a tab; its pane has no composer. Section 3.5. |
| Sidebar rows for the open conversation's children, indented with a rail, a dot, the label and the state; click reveals the block (or focuses the tab). Other rows show `N agents` among the working facts. | Yes | Section 3.6. |
| Replay merges the parent's log with every child's log; folded blocks are built lazily on first open. | Yes | `GET /api/sessions/<id>` carries `children`; a finished block renders its rows on first open. Section 2.4, 3.4. |
| Stop on the parent cascades to the children. | Yes, and it was missing here | `spawn_subagent` cancels its child when its own call is cancelled. Section 2.3. |
| A raw `subagent:spawned …` note in the transcript. | No | The result line `[subagent <id> <label>]` is parsed, never shown raw. |
| One level only: a subagent could not spawn subagents. | No | Nothing forbids it; the page nests blocks by parent, at any depth. |
| No way to stop one child from the page. | Improved | A Stop button on a running block and on a child's tab, over `POST /api/sessions/<child>/cancel`. |

---

## 1. Why the kernel must change, and how little

Today a child turn runs through `sessions.ask` from inside the parent's tool call. `ask` consumes the
child's events and returns the last text. The gateway's `TurnHub` sees only turns it started itself, so
nothing about a child reaches `/api/events`, and `GET /api/sessions` drops every session with a `parent`.

The seam: **`sessions.watch`**. A fence subscribes once and receives every turn event of every session
of its user, whoever started the turn, each stamped with the session id and its parent. The mechanism
(`TurnTaps`) lives in `@thetis/lib`; the kernel holds the authority (`authorize`) and the wiring. The
kernel is at 1392 of 1400 lines; this costs at most 7.

---

## 2. Server side

### 2.1 Contracts

`packages/contracts/src/pipeline.ts`:

```ts
/** One turn event of one session of a person, as `sessions.watch` reports it. */
export interface WatchedTurnEvent {
  session: string;
  /** The parent session, when the session is a subagent. */
  parent?: string;
  /** On `turn.start` only: the text the turn was sent, when it was sent as text. */
  input?: string;
  event: TurnEvent;
}
```

`packages/contracts/src/guest.ts`, `KernelClient.sessions`:

```ts
/**
 * Every turn event of every session of this person, from the moment of the call: turns started by
 * anyone, subagents included. Resolves when the fence closes. A caller that wants the events for as
 * long as it lives calls once and never awaits it.
 */
watch(onEvent: (m: WatchedTurnEvent) => void): Promise<void>;
```

`packages/contracts/src/guest.ts`, `ToolEnv`:

```ts
/** Aborted when the turn is stopped while the tool runs. A tool that started something stops it here. */
signal?: AbortSignal;
```

`packages/contracts/src/fence.ts`:

```ts
/** … `signal` aborts when the fence that asked is gone, so a method that streams for the life of the fence knows when to stop. */
export type KernelRpc = (method: string, args: unknown, emit?: EventSink, signal?: AbortSignal) => Promise<unknown>;
```

### 2.2 Mechanism in lib, authority in the kernel

`packages/lib/src/turn-taps.ts`:

```ts
export type TapMeta = { session: string; parent?: string; input?: string };
export class TurnTaps {
  /** Resolves when `signal` aborts, after the watcher is removed. Without a signal it never resolves. */
  watch(user: string, fn: (m: WatchedTurnEvent) => void, signal?: AbortSignal): Promise<void>;
  /** Wraps an emit: `inner` gets every event, then the user's watchers get it stamped with `meta`. `input` rides on `turn.start` only. A watcher that throws is dropped, not propagated. */
  emitter(user: string, meta: TapMeta, inner: (e: TurnEvent) => void): (e: TurnEvent) => void;
}
```

`packages/kernel/src/sessions/api.ts`: a `taps` field; `send` passes `this.taps.emitter(userId, { session: sessionId, parent: session.parent, input: <the string input, or undefined> }, (e) => queue.push(e))` to the runner; a method `watch(userId, fn, signal?)` that authorizes and delegates. `packages/kernel/src/rpc.ts`: `case "sessions.watch": return k.sessions.watch(us.id, (m) => emit?.(m), signal);` where `signal` is the handler's new fourth argument.

`packages/lib/src/rpc-frames.ts`: `RpcHandler` and `callHandler` take and pass the optional `signal`. `packages/sandbox/src/handle.ts`: one `AbortController` per handle, aborted in `onExit`, passed to `callHandler` in `serveRpc`, so a watch ends when its fence dies and the kernel keeps no dead watcher. The in-process path (`clientFromRpc` in tests) passes no signal: the watch lives as long as the process.

Both client copies (`packages/gateway-web/src/client.ts`, `packages/userspace-agent/src/agent.ts`) gain `sessions.watch`. `packages/userspace-agent/src/agent.ts` passes the request's `signal` into `ToolEnv`.

### 2.3 The tool

`packages/tool-exec`: `spawn_subagent` takes `task` and an optional `label` ("a short name for the subagent, shown to the person, for example `research`"). The result's first line is `[subagent <id>]` or `[subagent <id> <label>]`, then the reply. While `ask` runs, an abort of `env.signal` calls `sessions.cancel(child)`, so stopping the parent stops the child; the listener is removed afterwards. The regex every reader uses: `/^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/`.

### 2.4 The gateway

`packages/gateway-web/src/turns.ts`, `TurnHub`:

- Subscribes once, in the constructor, with `kernel.sessions.watch`; a rejection (an older kernel) is logged and the hub works as before.
- `RunningTurn` gains `parent?: string`. `TurnMessage` gains `parent?: string`, present on every message of a child turn.
- A turn the hub started itself is in a `mine` set (added before `send` is called, removed on finish); its watched events are ignored, because `send` already delivers them.
- A watched `turn.start` of any other turn opens a `RunningTurn { session, parent, input: m.input ?? "", startedAt: now, events: [] }`; later watched events of that session are pushed to it; `turn.end` finishes it through the same path as a hub-started turn (`onEnd`, so usage is recorded for the child too). A watched event for a session with no running turn that is not `turn.start` is dropped.

`packages/gateway-web/src/server.ts`:

- `GET /api/sessions` still lists root sessions only. A summary's `cost` now includes the recorded usage of its children.
- `GET /api/sessions/<id>` gains `children: ChildRecord[]`, the sessions whose `parent` is `<id>`, in creation order:

```ts
interface ChildRecord {
  id: string; parent: string; createdAt: string; updatedAt: string; turns: number;
  status: "idle" | "running";
  /** The label the parent gave, from its `[subagent <id> <label>]` result; null when none. */
  label: string | null;
  /** The child's first user message, or the input of its running turn. */
  task: string;
  conversation: Message[];
  usage: SessionUsage;
  cost?: number;
  turn: RunningTurn | null;
}
```

- The `snapshot` frame's `running` entries carry `parent` for child turns. The `turn` frames carry `parent`.
- `POST /api/sessions/<child>/cancel` already works: the child is the person's own session.

### 2.5 Tests

- `packages/kernel/test`: `watch` reports a turn's events with `session`, `parent` and `input` on `turn.start`; aborting the signal removes the watcher.
- Echo fixture cue: `spawn: <task>` → `tool_call spawn_subagent { task, label: "helper" }`. With `<task>` being `run: echo hi`, the child calls `shell` (when the terminal package is installed) — the gateway test may keep the child to plain text.
- `packages/gateway-web/test/gateway.test.ts`: a `spawn:` turn puts child messages on the parent's stream, `parent` set and `input` on the child's `turn.start`; the parent's `tool.result` matches the regex with label `helper`; `GET /api/sessions/<root>` has one `children` entry with `label`, `task` and the child's conversation; a page that connects while the child runs sees it in the snapshot with `parent`; cancelling the parent while a `slow:` child streams ends the child too (`inspect(child).status` is `idle` within a second and its stream ended with `error` code `cancelled`).

### 2.6 Documentation, server side

`docs/06-sessions-and-users.md` §4 (`watch`) and §5 (label, cancel cascade, no depth limit); `docs/03-fence.md` §6 RPC table (`sessions.watch`, the handler's signal); `docs/15-web-gateway.md` §5 (`children`), §6 (`parent` on frames and snapshot), §7 (watched turns); `docs/13-limitations-and-roadmap.md` (the blocking note stays; the orphaned child is fixed); `docs/20-tools.md` and `packages/skills-thetis/skills/thetis/using/SKILL.md` (`label`, the result line); `packages/tool-exec/README.md`.

---

## 3. Browser side

### 3.1 Store (`assets/lib/store.js`)

```js
agents: new Map(), // child id -> { id, parent, label, task, createdAt, outcome, cost }
                    // outcome: null while never finished, else "done" | "failed" | "stopped"; cost: what its replies reported
```

Helpers: `store.agent(id)`, `store.setAgent(id, patch)` (merges, replaces the map so watchers fire), `store.agentsOf(parent)` (creation order), `store.isAgent(id)`, `store.rootOf(id)` (walks `parent` until a session with none; an unknown id is its own root).

Sources: a session record's `children` (on open and reload), the snapshot's running child turns, and every stream message with `parent`. A child's `label` comes from the spawn call's `args.label` when the transcript binds the block, or from the record. `task` comes from `input` on `turn.start` or the record.

### 3.2 Activity (`assets/lib/activity.js`)

`applyActivity(session, event, startedAt, parent)`. A child's events keep the child's own record as today. They also touch the parent's record: `turn.start` adds one to `agents`, `turn.end` takes one away (never below zero), `usage` adds `cost` to the parent's `cost`. `countWorking()` and the group counts skip sessions that are agents, so the favicon and the title count conversations.

### 3.3 The agent block (`assets/views/transcript.js`)

A `tool.call` named `spawn_subagent` draws no tool card. It closes the open run and places a message-level block:

```html
<details class="agent is-running" open data-call="<call id>" data-agent="<child id, once bound>">
  <summary class="agent-head">
    <span class="agent-dot"></span>
    <span class="agent-label">research</span>          <!-- args.label, else the first words of the task -->
    <span class="agent-gist" title="<task>">…</span>    <!-- the task, clipped like a tool gist -->
    <span class="agent-meta"></span>                   <!-- once ended: "12 tool calls · $0.03 · 48k tok" -->
    <span class="agent-took"></span>                   <!-- once ended: duration -->
    <span class="agent-state">starting</span>          <!-- starting | working | done | failed | stopped -->
    <span class="agent-actions">
      <button type="button" class="agent-open" title="Open in a tab">…</button>
      <button type="button" class="agent-stop" title="Stop this subagent">Stop</button>  <!-- while working -->
    </span>
  </summary>
  <div class="agent-brief">the whole task</div>
  <div class="agent-body"></div>                       <!-- the nested transcript -->
  <!-- on the spawn result: the tool card's result section, label "reply" or "error" -->
</details>
```

Buttons inside a `summary` stop propagation and prevent default. The block is bound to a child when a message with `parent === this transcript's session` and `event.type === "turn.start"` arrives: the first unbound block whose task equals the message's `input` takes it (`data-agent`, `store.setAgent(id, { label })`). When no block matches, a standalone block is minted at the end of the transcript with the label from the task. On the spawn's `tool.result`, the regex binds by id when the block is still unbound, sets `done` or `failed` (a result starting with `error:`), fills `agent-took` and the result section, and folds the block.

The child's rows are drawn by a nested transcript instance on `.agent-body`: `mountTranscript(root, { session: childId, nested: true })`. Nested: no jump button, no follow logic of its own (the outer pane scrolls), events are never offered to the registered renderers (a `todo_*` or `ask_user` call inside a child is a plain tool card, so a form there cannot send to the parent), and the child's user rows are drawn as its brief. The nested instance receives the child's events through `applyChild(message)` on the outer transcript, which finds the block by `message.session`, or, for a grandchild, hands the message to the nested instance whose session is the message's `parent` (any depth). Duplicate delivery is refused per block by `(turn, seq)` as tabs do.

The block's state follows the child's events: `turn.start` → `working`; `error` code `cancelled` → `stopped`, other → `failed`; `turn.end` → `done` unless already failed or stopped; the meta line counts the child's tool calls and sums its `usage` (`cost`, `completion_tokens`) from its own events. `store.setAgent(id, { outcome, cost })` on end.

`revealAgent(id)` opens the block (building its rows first when it was lazy), scrolls it to the centre, adds `is-flashed` for 1200 ms, and returns the block, or null.

### 3.4 Replay (`restore(record)`)

`record.children` is indexed by id. A restored `tool` message of `spawn_subagent` whose result matches the regex draws the block for that child: label from the record, state from the child (`turn` present → working and drawn now; else `done`, or `failed` when the result starts with `error:`), the meta from the child's `usage` and tool count, folded. A finished block keeps its child record and builds its nested rows on the first `toggle` that opens it. After the parent's running turn is replayed, every child with a `turn` that is still unbound binds by task or gets a standalone block. Children with no reference and no turn get nothing.

### 3.5 A child's tab (`assets/views/tabs.js`, `composer.js`)

`tabs.open(childId)` works for an agent id. Its pane's chat bar shows a dot, the label as the title (not a rename button), the state, the spend, a `.chat-parent` button "Show in conversation" (activates the root's tab and reveals the block; opens the root first when it is not open) and, while working, Stop. No archive, no model pill. The tab carries `is-agent`, a state dot and the cost as a note. The transcript is a normal (not nested) instance restored from `GET /api/sessions/<child>`. The composer, when the current pane is an agent, disables the box with the placeholder "A subagent has no composer. Talk to its conversation." and hides Send; Stop stays and cancels the child.

`document.title` and the sidebar's current row follow the root conversation when a child tab is active.

### 3.6 The sidebar (`assets/views/sessions.js`)

Under the row of the current conversation (`store.rootOf(store.current)`), one `.session-agent` row per `store.agentsOf(root)`:

```html
<button class="session-agent is-working" data-agent="<id>" title="…">
  <span class="session-agent-dot"></span>
  <span class="session-agent-label">research</span>
  <span class="session-agent-state">working · shell</span>   <!-- the step while working; done | failed | stopped after; then the cost -->
  <span class="session-agent-open" title="Open in a tab">…</span>
</button>
```

The rail and elbow of the legacy CSS mark the ownership. Click: `onAgent(id)` — a pane for the child exists → activate it; else activate the root's pane and `revealAgent(id)`; nothing found → toast "That subagent's output is not on screen." The open glyph: `onOpenAgent(id)` → `tabs.open(id)`. Any other working row shows `N agents` among its facts from `activity.agents`.

### 3.7 App wiring (`assets/app.js`)

`applyTurn(message)`: when `message.parent` is set, register or update the agent (`parent`, and `task` from `input` on `turn.start`); `applyActivity(session, event, startedAt, parent)`; then `tabs.applyTurn(message)`, which delivers to the pane of `message.session` when open and, for a child, to the pane of `store.rootOf(message.session)` through `transcript.applyChild(message)`. The snapshot registers running child turns the same way. `scheduleList()` after a child's `turn.end` as after a root's.

### 3.8 Styling (`assets/app.css`)

The legacy rules, on the current tokens: `.agent` (measure width, hairline border, accent left edge, radius), `.agent-head` (flex, wash background, hover), `.agent-dot` (pulse while running, error colour when bad), `.agent-label` (mono, accent), `.agent-state`, `.agent-meta`, `.agent-took`, `.agent-brief` (quiet, clipped to a few lines), `.agent-body` (smaller type, no avatars, no measure), `.agent.is-flashed`, `.session-agent*` (indent, rail, elbow, dot, sheen on the step while working), `.tab.is-agent` (mono label, dot, note), the disabled composer. Reduced motion turns the pulses off.

### 3.9 Browser checklist

`packages/gateway-web/test/BROWSER.md` gains the steps: a `spawn:` message draws the block with the label, streams the child's reply inside it, folds it with `done` and the meta; the sidebar row appears under the conversation, working then done; clicking the row reveals and flashes the block; the open glyph opens the child's tab with the disabled composer and "Show in conversation" comes back; Stop on a running block stops the child; a reload restores the folded block, which builds on open.

The pass runs against a `.devhomeN` with the echo provider fixture installed and `model` set to `echo`, so a subagent costs nothing and behaves the same every time.

### 3.10 Documentation, browser side

`docs/15-web-gateway.md` §1 (the functions table: subagents), §8 (the modules), and a new §12 "Subagents on the page" describing sections 3.3 to 3.6 for a reader of the page.
