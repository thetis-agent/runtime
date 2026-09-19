# 15 Web gateway

The browser interface is three packages and the door:

| Part | Package | Where it runs | Function |
|---|---|---|---|
| The door | `@thetis/door` | The host process, started by `thetis serve` | Binds the one host port (`config.door`). Routes `/login`, `/logout`, and `/` to the login target and `/<person>/...` to that person's gateway socket. Copies bytes. Never authenticates. |
| The login target | `@thetis/gateway-login` | The system userspace fence, on `run/login.sock` | Exchanges a password for a token, sets the cookie, sends the browser to `/<person>/`. Signs out. |
| A person's gateway | `@thetis/gateway-web` | That person's own fence, on `run/web.sock` | Serves the page and the API under `/<person>/`. Holds that person's authority and nobody else's. |

One gateway process per person costs one Node process per person. What it buys: a bug in a gateway reaches one person; a person can replace their own gateway package; a gateway binds a unix socket, never a port, so the fence keeps its private network namespace.

## 1. Functions

| Function | How |
|---|---|
| Sign in and sign out | A password per user, set by an operator with `thetis users passwd` or by an admin in the control panel. The login target sets a cookie; the person's gateway checks it with the kernel. See section 9. |
| List conversations | The sidebar, grouped as Today, Yesterday, This week, and Earlier, most recent first. A row shows the name, when it was last active, the last message, and a facts line: turns, what the replies cost, and the model when one was chosen. Search filters as you type. |
| See which conversations are working | A working row carries a pulsing dot, the current step under a moving sheen (`Starting`, `Thinking`, `Writing a reply`, or the tool's name), a count of tool calls, the cost so far, and a clock that counts up. The group heading counts the working rows, the tab title shows `(N)`, and the favicon gets a dot. A stopped or failed turn leaves its reason on the row until the next turn. |
| Name a conversation | Click the title in the chat bar, or Rename in the row menu. Enter keeps the name; Escape or clicking away drops it. An empty name restores the first message as the title. |
| Choose a model | The pill in the composer lists the default and every model the person's providers serve, with a filter box. The choice is kept per conversation and shown in the chat bar and the sidebar. The reply's footnote names the model that answered. |
| Archive a conversation | The archive button in the chat bar, or the row menu. Archived rows move to a section at the foot of the sidebar with a count. The button, the menu, or the Undo action of the toast restores them. |
| Start a conversation | The `+` button, or a message sent with no conversation open. |
| Send a message | The composer. Enter sends. Shift+Enter adds a newline. |
| See the reply as it streams | Text appears under a caret. Consecutive tool calls sit in one run with a count and a tally of names; each card shows the tool, a gist of its arguments, how long it took, and a status pill. The result closes the card. A long run restored from the record starts folded. A reply carries a footnote: model, cache share, tokens in and out, cost. The chat bar shows the current step and the conversation's spend while a turn runs. |
| See a turn that runs in another tab, or after a reload | The page receives the turn in progress when it connects. See section 6. |
| See the plan | This UI comes with `@thetis/tools-plan` (section 11): the gateway draws nothing of it by itself. A `todo_*` call draws no tool card. It draws one quiet line (`plan: t-2 → active · 1 of 4 done`) and updates the chip `todo 1/4` in the chat bar, green when every item is done or dropped. The chip and the **Todo** button in the rail open the Todo dock: "1 of 4 done", one row per item with a ✓ ● ○ mark, the text, the note, and the id, active in the warning colour, done and dropped struck through. A person can tick a row through its checkbox; the row is disabled until the package answers with the plan it wrote. The plan is rebuilt from the last `todo_*` result in the record when a conversation is reopened. |
| Answer the model's questions | This UI comes with `@thetis/tools-plan` too. An `ask_user` call is drawn as a form in place of a tool card: options as radios or checkboxes, a "Something else" text option, free text when there are no options, Skip per question, one Submit. Submit sends the answers as one user message through the composer's path and locks the card; the card stays locked when the conversation is reopened. See [20-tools.md](20-tools.md) section 4. |
| Stop a turn | The Stop button. The turn ends with the note "Turn stopped." Text streamed before the stop is kept. |
| See a subagent's work | A `spawn_subagent` call draws no tool card. It draws an agent block in the conversation: a dot, the label the model gave (or the first words of the task), the task, and the state (`starting`, `working`, `done`, `failed`, `stopped`). The child's own rows stream inside the block, drawn like the conversation's own. When the child ends, the block shows its tool calls, cost and tokens, and how long it took, folds itself, and quotes the reply. The sidebar lists the open conversation's subagents under its row, with the step while one works; any other working row counts its agents. See section 12. |
| Open a subagent in a tab | The glyph on the block or on its sidebar row. The tab shows the child's transcript at full size with "Show in conversation" as the way back. A subagent's tab has no composer. |
| Stop a subagent | Stop on a running block, or on the child's tab. Stopping the conversation stops its subagents too. |
| Manage packages, search the marketplace, and, for admins, people, models, activity, and the configuration | **Control panel** in the sidebar's ≡ menu. See [17-control-panel.md](17-control-panel.md). |

There is no delete and no file upload.

## 2. Install and run

```sh
thetis users add alice
thetis users passwd alice --password secret   # or: echo secret | thetis users passwd alice
thetis serve                                   # the door, the login target, and one gateway per person
```

The defaults install `@thetis/gateway-login` into the system userspace and `@thetis/gateway-web` into every person's userspace (`systemPackages`, [09-configuration.md](09-configuration.md)). At boot `thetis serve` creates and seeds the userspace of every active user and starts their services, so `/alice/` answers before alice's first visit. A user added while the daemon runs gets the same at once.

Open `http://127.0.0.1:8777/login`. `thetis serve` stops on Ctrl+C. It closes every fence, which stops every service.

`thetis uninstall @thetis/gateway-web --user alice` stops alice's gateway when a `serve` process runs in the same kernel, and removes the package; the door then answers `/alice/` with `503`.

### 2.1 Deployment on this host

`deploy/thetis-runtime.service` runs `thetis serve` as a systemd service under the checkout's user, with `Delegate=yes` so the fences get their limits. The file is a template: its `User`, `Group`, `WorkingDirectory` and `ExecStart` lines are placeholders. Copy it once to a fresh host and adapt those four lines before enabling it:

```sh
sudo cp deploy/thetis-runtime.service /etc/systemd/system/
sudoedit /etc/systemd/system/thetis-runtime.service      # User, Group, WorkingDirectory, ExecStart
sudo systemctl daemon-reload
sudo systemctl enable --now thetis-runtime.service
```

**Caution:** on a host that already has the unit, never copy the template over the deployed one. Diff the repository's unit against `/etc/systemd/system/thetis-runtime.service` and carry the change across by hand, keeping the four host-specific lines; the deployed unit is hand-adapted and the template's paths would break it on the next restart. See [25-restart.md](25-restart.md) section 4.3.

To move an existing deployment from the old single gateway to the door, run `deploy/migrate-to-door.sh` once. It installs the unit, restarts, removes the old gateway from the system userspace, installs the login target there, and installs a gateway for every existing person.

Public TLS for `thetis.example.com` terminates at the Caddy on `10.0.0.10`, which forwards to this host at `10.0.0.20:8777`. The configuration is `door: { "host": "10.0.0.20", "port": 8777 }` and `packages["@thetis/gateway-login"]: { "secure": true }`. From this host, check through Caddy directly, because the route through the public address times out from inside the network:

```sh
curl --resolve thetis.example.com:443:10.0.0.10 https://thetis.example.com/login
```

## 3. Configuration

```json
"door": { "host": "127.0.0.1", "port": 8777 },
"packages": {
  "@thetis/gateway-login": { "secure": false }
}
```

| Key | Default | Meaning |
|---|---|---|
| `door.host` | `127.0.0.1` | The bind address of the door. |
| `door.port` | `8777` | The port of the door. |
| `@thetis/gateway-login`.`secure` | `false` | Adds `Secure` to the cookie. Set it when TLS terminates in front of the door. |

`@thetis/gateway-web` has no configuration. It listens on `<userspace>/run/web.sock` and serves under `/<user>/`, both from `THETIS_USER`.

**Caution:** `door.host: "0.0.0.0"` exposes the door to the network. The login cookie travels in clear text over HTTP. Put a TLS terminator in front of the door and set `secure` to `true`.

## 4. Files

A gateway keeps UI state only: which conversations the person archived, the name and the model they chose for a conversation, and the usage each reply reported, keyed by the reply's index in the conversation. A recorded usage also carries `model` when the person had chosen one. The file is `home/gateway-web/state.json` in the person's own userspace. The usage is recorded after a turn ends without an error; the transcript shows it as a header over the reply (`cached 96% · 2.5k in · 4 out · $0.0100`). The header reads the fields `cache_read_tokens`, `prompt_tokens`, `completion_tokens`, and `cost` by name. See [16-prompt-cache.md](16-prompt-cache.md) section 7.1. Credentials and tokens are the kernel's, in the private store namespaces `auth/credentials` and `auth/tokens`, which no fence can read.

## 5. HTTP routes

The door serves `/login`, `/login/assets/*`, `/logout`, and `/` from the login target, and everything under `/<user>/` from that user's gateway. A path whose first segment is not a known, active person is `404`; a person whose gateway is not running is `503`. The routes below are the gateway's, relative to `/<user>`; the page uses `<base href="/<user>/">` and relative URLs.

| Method and path | Effect |
|---|---|
| `GET /` | The app page. Redirects to `/login` without a valid cookie. |
| `GET /login` | The sign-in page, from the login target. |
| `POST /login` | Form fields `id`, `password`, `next`. Calls `auth.login`. On success: sets the cookie and redirects to `next`. On failure: redirects to `/login?error=refused`. With `Content-Type: application/json` the route answers JSON instead. |
| `POST /logout` | Calls `auth.logout`. Clears the cookie. Redirects to `/login`. |
| `GET /assets/<file>` | Static files from `packages/gateway-web/assets`. |
| `GET /api/me` | `{ user, role }`. |
| `GET /api/sessions` | `SessionSummary[]`. Sorted by `updatedAt`, newest first. Subagent sessions are excluded; a summary's `cost` includes what the conversation's subagents reported, at any depth. |
| `POST /api/sessions` | Creates a session. Answers `201 { id }`. |
| `GET /api/sessions/<id>` | The session record with `status`, `archived`, `turn`, `usage`, `model`, `title`, and `children`. `turn` is the turn in progress, or `null`. `usage` maps a conversation index to the usage of that reply. `children` is one `ChildRecord` per session whose `parent` is `<id>`, in creation order. A subagent's own id works here too, and `POST …/cancel` on it stops the subagent. |
| `GET /api/models` | `{ model, models }`: the configured default and the models the person's providers serve, from the kernel's `models` method. |
| `POST /api/sessions/<id>/model` | Body `{ model }`. Keeps the model for the conversation; every later turn is sent with it. An empty string restores the default. |
| `POST /api/sessions/<id>/title` | Body `{ title }`. Names the conversation. An empty string restores the derived title. |
| `/api/panel`, `/api/packages*` | The control panel's built-in Packages section. See [17-control-panel.md](17-control-panel.md) section 3. |
| `GET /api/ui`, `GET /ext/<scope>/<name>/<path>`, `POST /api/ext/<scope>/<name>/<verb>`, `GET /api/ext/<scope>/<name>/<verb>/stream` | What installed packages add to the page. See section 11. |
| `POST /api/sessions/<id>/send` | Body `{ text }`. Starts a turn with the conversation's model, when one was chosen. Answers `202 { session, startedAt, model }`. Answers `409` when a turn is running. |
| `POST /api/sessions/<id>/cancel` | Stops the running turn. Answers `{ cancelled: boolean }`. |
| `POST /api/sessions/<id>/archive` | Body `{ archived: boolean }`. |
| `GET /api/events` | The event stream. See section 6. |

```ts
interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;   // the start of the running turn, when one runs
  turns: number;
  title: string;       // the name the person gave, else the first user message, one line, at most 60 characters
  named: boolean;      // true when the person named it
  preview: string;     // the last message, one line, at most 120 characters
  archived: boolean;
  status: "idle" | "running";
  model?: string;      // the model chosen for the conversation; absent means the default
  cost?: number;       // the sum of the `cost` the replies reported, subagents included; absent when none did
}

interface ChildRecord {
  id: string; parent: string; createdAt: string; updatedAt: string; turns: number;
  status: "idle" | "running";
  label: string | null;   // from the parent's `[subagent <id> <label>]` result; null before that result exists, or when no label was given
  task: string;           // the child's first user message, or the input of its running turn
  conversation: Message[];
  usage: SessionUsage;    // the child's own, by conversation index, as for a conversation
  cost?: number;          // the child's replies, its own subagents included
  turn: RunningTurn | null;
}
```

The label is read from the parent's saved conversation and from the `tool.result` events of the parent's turn in progress, so it is present as soon as `spawn_subagent` returned, before the parent's turn ends. While the child still runs there is no result yet, and `label` is `null`; the page takes the label from the spawn call's own arguments then.

Every `/api/*` route and every `/ext/*` route needs the cookie. The gateway calls `auth.authenticate` with the token on each request. A missing, expired, or revoked token answers `401`. A session of another user answers `404`. A `POST` with the header `Sec-Fetch-Site: cross-site` answers `403`.

Kernel error codes map to status codes: `not-found` 404, `unauthorized` 403, `busy` 409, `invalid` 400. Other errors answer `500`.

## 6. The event stream

`GET /api/events` is a Server-Sent Events stream. One browser tab holds one stream. The stream carries every turn event of the signed-in user, for every session.

The first message is a `snapshot`:

```
event: snapshot
data: { "user": "alice", "running": [ { "session": "s_…", "turn": "t_…", "input": "…", "startedAt": "…", "events": [ { "seq": 1, "event": { … } } ] } ] }
```

`running` lists the turns in progress with the input text and every event so far, subagents' turns included. An entry of a subagent's turn carries `parent`, the session that spawned it. A page that connects mid-turn draws the input and the events, then continues with the live messages.

Each later message is one turn event:

```
event: turn
data: { "session": "s_…", "turn": "t_…", "seq": 7, "event": { "type": "text", "delta": "…" }, "input": "…" }
```

`seq` counts from 1 inside one turn. The page ignores a message with a `seq` it has already drawn for the same turn. `input` is present on `turn.start` only. It carries the user's message, so a tab that did not send it can draw it; for a subagent it is the task. Every message of a subagent's turn carries `parent`:

```
event: turn
data: { "session": "s_child", "parent": "s_…", "turn": "t_…", "seq": 1, "event": { "type": "turn.start", … }, "input": "the task" }
```

A conversation's own messages have no `parent` field. The page routes a message by walking parents to the conversation that owns it.

The server sends a comment line every 20 seconds to keep the connection open. The browser reconnects by itself. Every connection starts with a new snapshot.

## 7. How a turn runs

`TurnHub` in `src/turns.ts` runs turns in the background:

1. `POST /api/sessions/<id>/send` calls `kernel.sessions.send(session, text, onEvent, user)` over RPC. The kernel refuses a busy or unknown session at once; the RPC rejects with that code and the route answers `409` or `404`.
2. On the first event the hub records `{ session, input, startedAt, events: [] }` and the route answers `202`.
3. The hub numbers each event, buffers it, and sends it to every stream of the user.
4. On `turn.end` the hub forgets the turn. When the RPC rejects after the turn started, the hub sends an `error` event with the code `gateway` and then `turn.end`.

Turns the hub did not start reach it too. At construction the hub calls `kernel.sessions.watch` once ([06-sessions-and-users.md](06-sessions-and-users.md) section 4), a call that settles only when the fence closes, and from then on every turn event of every session of the person arrives with its session, its parent and, on `turn.start`, its input. A turn the hub started itself is ignored on that path, because `send` already delivers it: the hub notes the session as its own before it calls `send`, since the watch reports the first event before `send` does. Any other turn, a subagent's or one sent from the command line, opens a running turn on its `turn.start`, is numbered, buffered and sent to the streams like the hub's own, and ends on its `turn.end` through the same bookkeeping, so the child's usage is recorded under the child's id. An event of a turn whose start the hub never saw is dropped. On an older kernel without `sessions.watch` the call rejects, the rejection is logged, and the hub works as before.

The buffer lives in memory in the system userspace agent. A restart of `thetis serve` ends the turns in progress; the kernel saves what each turn had produced.

## 8. Source

| File | Content |
|---|---|
| `src/index.ts` | `startService(env)`: listens on `run/web.sock` for the user in `THETIS_USER`, returns `{ stop }`. `stop` closes every open connection, because an event stream never ends on its own and an uninstall would otherwise wait for it. |
| `src/server.ts` | `createGateway(kernel, store, { user, base, env })`: routes under `base`, the cookie check, static files, the event stream. `kernel` is a `KernelClient`. |
| `src/panel.ts`, `src/http.ts` | The control panel routes and the HTTP helpers. See [17-control-panel.md](17-control-panel.md). |
| `src/ui.ts` | `validateUi`, `composeUi`, `serveExt`, `runCommand`, `openStream`: the extension routes of section 11. |
| `src/static.ts` | `serveFile` and the table of file types the page may load. Used for `/assets` and `/ext`. |
| `src/turns.ts` | `TurnHub`. |
| `src/store.ts` | `GatewayStore`: archive flags, names, chosen models, and per-reply usage. `ArchiveStore` is the former name. |
| `src/client.ts` | `clientFromRpc(rpc)`: the `KernelClient` shape over a raw RPC function, for tests and in-process hosts. |
| `assets/` | The browser code. Plain ECMAScript modules. No build step, no dependency. |
| `packages/gateway-login/src/server.ts` | `createLogin(kernel, { secure })`: `/login`, `/logout`, `/`, and the login page's assets. |
| `packages/door/src/index.ts` | `createDoor({ loginSocket, socketFor })`: the reverse proxy on the host port. |

Browser modules: `app.js` wires the store, the views, the event stream, the chat bar chips, and the favicon; it registers a subagent from every stream message that carries `parent` before anything draws it, and keeps the child's outcome and cost once its turn ends. `lib/store.js` holds `user`, `sessions`, `current`, `tabs`, `running`, `pending`, `activity`, `agents` (child id → parent, label, task, outcome, cost, with `agentsOf`, `isAgent` and `rootOf`), `choices`, `creating`, `connection`, `panel`. `lib/activity.js` reduces every session's turn events into what it is doing now (the step, the tool call count, the cost, the number of subagents at work, when it started) and formats durations, costs, and tokens; a child's events also touch its parent's record, and `countWorking` counts conversations, not their children; its `SHEEN_MS` must equal `--sheen` in `theme.css`, because a working row's sheen is phase-locked to wall time so a redraw does not restart it. `lib/picker.js` is the pill-and-list control the composer uses for the model. `lib/api.js` wraps `fetch` and `EventSource` with paths relative to the page's `<base>`; a `401` sends the page to `/login`. `lib/markdown.js` builds DOM nodes and never uses `innerHTML`. `views/sessions.js` (the grouped list, the subagent rows under the open conversation, the ticking clocks, rename, the archive), `views/tabs.js` (one pane per open conversation or subagent, the routing of each stream message to its pane and to the block in every open ancestor's pane, `reveal`), `views/transcript.js` (messages, tool runs, footnotes, the hook that offers each tool row to the registered renderers first, and the agent blocks with their nested instances, section 12), and `views/composer.js` (the box, the model pill, stop; disabled on a subagent's tab) are the conversation views; `views/panel*.js` and `lib/panel-ui.js` are the control panel. The todo dock, the todo chip, the `plan:` lines, and the `ask_user` form are not in this package: `@thetis/tools-plan` carries them in its `ui/` directory (section 11).

The page is served with a Content Security Policy that allows only same-origin scripts, styles, and connections. Inline scripts do not run. `index.html` carries `<base href="{{base}}/">`; the server fills the placeholder with the person's prefix.

Inline **styles** have one door, and it is held open for one response only. Each page is served with a fresh nonce: it goes into `style-src` and into `<meta name="csp-nonce">`, both filled from the same value, so the policy and the page can never disagree. Code the gateway served with that page may stamp the nonce on a stylesheet it writes; anything else is still refused. The reason is `@thetis/terminal`: a terminal emulator writes about 55 KiB of palette, font metrics and cursor rules at runtime, generated per terminal from the theme, which cannot be shipped as a file. `'unsafe-inline'` would have bought the same thing by giving up the rule for every stylesheet on the page, including one an attacker managed to inject. A nonce that repeated between responses would be worth no more than `'unsafe-inline'`, so a test asserts that two visits get different ones.

## 9. Trust model

- The door is host code. It routes by the first path segment and copies bytes. It never reads the cookie.
- The login target is package code in the system userspace, the only fence the kernel lets call `auth.login`. It sees passwords once, on the way to the kernel, and never a conversation.
- A person's gateway is package code in that person's fence. It reaches the kernel through the fence's RPC as that person. It cannot name another person, and the kernel answers `auth.authenticate` only for a token of that person, so a copied or guessed prefix changes nothing: bob's cookie at `/alice/` is a `401`.
- The kernel does not check roles for session calls. For the control panel the gateway checks the role, and the kernel checks it again on every operator method, against the fence's own user. See [17-control-panel.md](17-control-panel.md) section 2.
- Passwords are set by an operator on the host or by an admin in the control panel. There is no self-service registration or password change.

## 10. Tests

`packages/gateway-web/test/gateway.test.ts` starts a real kernel with the echo provider fixture, then one gateway per person (`alice`, `bob`, and the admin `root`) on unix sockets over each person's own RPC handler, the login target over the system handler, and the door in front. The cases run through the door: redirects and refusals without a cookie and for a stranger; login refused and accepted, with `next` kept inside the person's prefix; a suspended person and a password change; create, list, send, and the stream of one turn; `409` on a busy session and cancel; the snapshot for a page that connects mid-turn; archive and restore; the models list, a chosen model reaching the kernel and the list, and a name replacing the derived title; isolation, including bob's cookie at alice's gateway; refusal of a cross-site `POST`; logout; and the control panel cases of [17-control-panel.md](17-control-panel.md) section 7. `test/ui.test.ts` covers section 11 with the fixtures `ui-good`, `ui-bad`, and `ui-dup` under `packages/host/test/fixtures`: composition and its refusals, the file route, the command checks in order, and the stream route of section 11.5 — three items and an `end`, a throw as an `error`, the refusals, and a client that lets go, which the fixture records so the test can read that its `signal` was aborted. The last case of `gateway.test.ts` installs `@thetis/gateway-login` into the system userspace and `@thetis/gateway-web` into alice's, boots the supervisor, and drives the same path through a real door into the fences, then checks that uninstall stops alice's gateway. `npm test` runs all of them.

The browser code has no automated test. Check it by hand with a throwaway data directory: `THETIS_HOME=.devhome thetis init`, set `door.port`, add people, `thetis serve`, sign in, open the control panel as an admin and as a user.

## 11. Extensions

A package can add to the page. It declares what it adds in the `ui` field of its manifest. The gateway reads the field from `kernel.packages.list()` on each request. The kernel never reads it. See [05-packages.md](05-packages.md) section 1.2. The browser side of this seam is `assets/lib/ext.js`; this section covers the server. `@thetis/tools-plan` is the example that ships: its `ui/` holds the Todo dock, the `todo n/m` chip, the transcript renderers for `todo_*` and `ask_user`, and its two commands `plan` and `mark` ([20-tools.md](20-tools.md) section 3). The CLI gateway ignores the field.

### 11.1 The declaration

```json
"thetis": {
  "type": "tool",
  "ui": {
    "dir": "ui",
    "entry": "index.js",
    "style": "index.css",
    "dock":     [ { "id": "todo", "label": "Todo", "icon": "M5 5h10v10H5z", "hint": "The plan", "wide": false } ],
    "panel":    [ { "id": "people", "label": "People", "note": "Who can sign in.", "role": "admin" } ],
    "chips":    [ { "id": "todo" } ],
    "commands": [ { "verb": "plan", "export": "uiPlan", "label": "Read the plan" } ]
  }
}
```

| Key | Meaning |
|---|---|
| `dir` | The directory of browser files, relative to the package root. Default `ui`. It must not leave the package. |
| `entry` | An ES module, relative to `dir`. The page imports it and calls its default export `install(ext)`. Optional. It must be a `.js` file inside `dir`. |
| `style` | A stylesheet, relative to `dir`. The page links it once. Optional. It must be a `.css` file inside `dir`. |
| `dock`, `panel`, `places`, `sidebar`, `chips`, `composer`, `shelf`, `statusbar` | Slot entries. Each entry has an `id` that matches `^[a-z][a-z0-9_-]{0,31}$`. It can have `label`, `icon`, `hint`, `note`, `wide`, `role`, and `order` (default 100). |
| `commands` | The verbs the package's own page may send. `verb` matches the same pattern as an id. `export` names a function export of the package's `main`. `role` is the least role that may send it. Default: any signed-in person. |
| `commands[].stream` | `true` makes the verb a stream: the export is a `UiStream`, the page subscribes to it instead of sending it, and the two are different routes. Default `false`. See section 11.5. |

The types are `UiDecl`, `UiEntryDecl`, and `UiCommandDecl` in `@thetis/contracts`.

### 11.2 Composition

`GET /api/ui` answers `{ extensions, refused }`. `extensions` has one entry per package with a valid `ui`, in install order:

```json
{ "package": "@alice/ui-good", "version": "0.1.0", "base": "ext/@alice/ui-good/", "entry": "index.js", "style": "index.css",
  "dock": [ { "id": "good", "label": "Good", "order": 100 } ], "panel": [], "places": [], "sidebar": [], "chips": [ { "id": "good", "order": 100 } ],
  "composer": [], "shelf": [], "statusbar": [], "commands": [ "echo" ], "streams": [ "tail" ], "hidden": [ "panel:people" ] }
```

The rules:

- A package without `ui` is skipped.
- Every value is checked. Only the fields of section 11.1 cross to the browser. A string that is missing, empty, or too long, an id that does not match the pattern, an entry or verb declared twice in one package, a `dir`, `entry`, or `style` that leaves its directory or does not exist: each one refuses the package.
- A `dock`, `places`, `sidebar`, `chips`, `composer`, `shelf`, or `statusbar` id belongs to the first installed package that declares it. A later package that declares the same id is refused. Panel ids are namespaced by package in the browser, so two packages may both declare `people`.
- A refusal is `{ package, message }`. The package is left out. The rest still composes.
- A verb declared with `stream: true` is listed in `streams` and not in `commands`, so the page knows which of the two routes it may use for it.
- Entries and commands with a `role` above the person's role are left out. The entries left out are named in `hidden` as `<slot>:<id>`, so the page can tell an entry hidden from this person from one the package never declared: a module's registration for a hidden entry is ignored without a console message, because the module cannot know the person's role. Commands are listed by verb only. The export names and the roles stay on the server.

### 11.3 Files

`GET /ext/<scope>/<name>/<path>` serves the file at `<store>/node_modules/<scope>/<name>/<dir>/<path>`. The route answers `404` when the package is not installed here, when its `ui` is refused, when the path leaves `dir`, when the file does not exist, and when the extension is not `.js`, `.css`, `.svg`, `.json`, or `.md`. The types are the ones `/assets` serves, plus `.md`. The response carries `Cache-Control: no-cache`. The route needs the cookie.

The store is `env.store` of the service. An in-process gateway can set `GatewayOptions.store` instead.

An extension module receives the seam `ext` (`assets/lib/ext.js`), bound to its own package. Two parts of it serve a command that not every person may send: `ext.can(verb)` answers whether the package declares the verb and the person's role clears it, which is how a page hides a control instead of offering one the gateway would refuse; and `ext.ui.pickDirectory` is the shell's directory picker, whose listing the package supplies (see [17-control-panel.md](17-control-panel.md) section 6).

### 11.4 Commands

`POST /api/ext/<scope>/<name>/<verb>` with a body `{ session?, args? }`. The checks run in this order:

| Step | Refusal |
|---|---|
| The package is installed here, its `ui` is valid, and it declares `verb`. | `404` |
| The person's role clears the command's `role`. | `403` |
| `session`, when given, names one of the person's own sessions. | `404` |
| `args`, when given, is an object. | `400` |
| The package's `main` exports the named function. | `500` |
| The export answers within 30 000 milliseconds (`GatewayOptions.commandTimeoutMs`). | `504` |
| The answer, as JSON, is at most 262 144 bytes. | `502` |

The gateway imports `main` from the store the way the userspace agent does: the file URL with `?v=<modification time>`, so a changed file is a new module. It calls the export with `(args, env)`. `env` is a `UiCommandEnv`: the `StepEnv` the service was started with (`cwd`, `root`, `store`, `shared`, `exec`, `readFile`, `writeFile`, `kernel`) plus `user`, `role`, and `session` when one was named. The handler runs in the person's own fence, as the person, with the authority the package's tools already have.

`env.config` is the effective configuration of the package that declared the command, as its steps and tools receive it: the gateway asks the kernel with `kernel.config.effective(name)` on every call, never cached, so a `config.set` reaches the next command. A package whose configuration cannot be read answers `500`. `env.storage()` in a command is **the gateway's** namespace, not the command package's ([26-storage.md](26-storage.md) section 7).

The result: a string becomes `{ text }`. Nothing becomes `{}`. An object is passed as `{ text?, data? }`; other fields are dropped. A thrown error answers `400 { error }` with its message.

### 11.5 Streams

A verb declared with `stream: true` is not sent, it is subscribed to. `GET /api/ext/<scope>/<name>/<verb>/stream` is a Server-Sent Events stream in the shape of `/api/events` (section 6). The arguments ride in the query, because an `EventSource` sends no body.

| Query | Meaning |
|---|---|
| `args` | URL-encoded JSON, an object. At most 4096 characters. `400` when it is longer, is not JSON, or is not an object. |
| `session` | A session id, checked to be one of the person's own, as for a command. |

The checks are the ones of section 11.4, in the same order and from the same code, with one more right after the first: the verb must be declared for the route being used. A `POST` to a streaming verb answers `400`, and a `.../stream` on one that is not declared streaming answers `400`.

| Event | Data |
|---|---|
| `item` | One value the export yielded, as JSON. |
| `end` | `{}`. The iterable finished. |
| `error` | `{ message }`. The iterable threw. |

The server sends a `: keep-alive` comment every 20 seconds, as on `/api/events`.

The export is a `UiStream` in `@thetis/contracts`: `(args, env) => AsyncIterable<unknown>`. `env` is a `UiStreamEnv`, the `UiCommandEnv` of section 11.4 plus `signal`, an `AbortSignal`. When the browser lets go the gateway aborts that signal and calls `return()` on the iterator, so a handler stops on whichever of the two it watches. Nothing else stops it: this route has no command timeout and no answer-size cap, because the package decides how long its stream runs and how much it says.

In the browser, `ext.subscribe(verb, { args, session, onEvent, onClose })` opens the stream and returns the stop function. It refuses a verb the package did not declare as a stream, the way `ext.request` refuses an undeclared command, and `ext.can(verb)` answers for both lists. `onEvent(value)` receives each item. `onClose(error)` is called once, with `null` after `end` and an `Error` after `error` or when the gateway refused the subscription. Nothing but the stop function closes the stream, so a view calls it when it goes.

### 11.6 Trust

The three routes need the cookie of the person the gateway serves. A command runs the code of a package that person installed, or an admin installed for them, in that person's fence. The gateway checks the declared role before the kernel sees anything; the kernel checks the fence's own user again on every operator method, as in [17-control-panel.md](17-control-panel.md) section 2. A package serves files only from under its own `dir`. It cannot name another package: its page gets `base` and its own verbs, nothing else.

### 11.7 Shipped extensions

These packages add to the page through section 11.1. Each one is a plain ECMAScript module with no build step; only `@thetis/ui-marketplace` has a dependency, on the `@thetis/marketplace` library. Every person gets them (`systemPackages["*"]`, [09-configuration.md](09-configuration.md)).

| Package | What it fills |
|---|---|
| `@thetis/ui-tools` | The **Tools** dock (wide). One section per installed package: the name, the version, the count, the description, and a card per tool with its name, its description, its required parameters, and a badge, `reads only` or `changes files`. A filter narrows the cards by name or description in the page. The section **Turned off right now** lists the declared tools that the conversation's last call did not receive (the harness records the call's tool names in `harness["@thetis/harness-core"].lastCall`), so what a project withholds shows after the first turn. Before any call the section says so. The page gets the list from the command `tools`, whose export `uiTools` reduces `env.kernel.packages.list()` to names and declarations. The badge is a guess from the tool name: `read_*`, `search_*`, `find_*`, `get_*`, `list_*`, and `todo_read` read; every other tool is shown as one that changes something. |
| `@thetis/ui-context` | The **Context** dock (wide): what the model received on the last call of the open conversation. The subtitle reads `turn N · <model> · <chars> chars`. Two tabs: **Request** lists the model, the time, the count of tools offered with their names as pills, and the count of messages in the exchange; **Prompt** shows the system prompt as rendered markdown in a scrolling block, with a **Copy** button (the clipboard, or the text selected when the clipboard is not available). The page gets the record from the command `context`, whose export `uiContext` reads `env.kernel.sessions.inspect(env.session)` and answers `{ turns, lastCall }`, where `lastCall` is the record `@thetis/harness-core` writes after each call ([04-pipeline.md](04-pipeline.md) section 10), or null before the first one, shown as "Nothing has been sent in this conversation yet." The dock asks when the page opens, when the open conversation changes, and when a turn of it ends; never while drawing. No usage tab: nothing reliable to show yet. |
| `@thetis/ui-skills` | The **Skills** dock (wide, order 110, after Tools and Context): the skills the open conversation can reach and which are in force ([23-skills.md](23-skills.md)). The sections: **Loader** (the package that wrote `harness["@thetis/skills"]` on the last turn, or the installed one before its first turn, or "No skill loader is installed" naming the three), **Always in force** (the universal skills), **Retrieved for this conversation** (the pinned cards with `score` and `how`, when any), **Loaded in this conversation** (the bodies the model asked for, when any), **Switched off by the project** (`skills.disable` of the conversation's project, nested skills included, shown at once through the library's `excludedFor`), **Left out for the budget** and **Notes** when the loader wrote any, and the **Catalogue**: every skill by id with a search box that ranks the rows by BM25 in the page (`ui/rank.js`, the library's algorithm copied for the browser and held to it by a test), so no keystroke sends a request. Every row opens the skill's text (`renderBody`, rendered through `ext.markdown`) in the dock with a `← Skills` button back. Two commands: `skills`, whose export `uiSkills` merges the loader's state from `env.kernel.sessions.inspect(env.session)` with `excludedFor` and the catalogue from `loadSkills(env, env.kernel.packages.list())` (without a session, the catalogue alone), and `skill { id }`, whose export `uiSkill` answers the rendered text. It depends on `@thetis/skills`. The dock asks once per conversation and once more when a turn of it ends, like the Tools dock. |
| `@thetis/ui-admin` | The admin sections of the control panel: **People**, **Models**, **Configuration**, **Mounts**, **Activity**, **Workspaces**, **Overview**, each a `panel` entry with `role: "admin"` and an `order` that sorts it after the built-in **Packages** (order 10). Twenty commands, every one `role: "admin"`, each a thin wrapper over `env.kernel.operator.call(...)` with the argument checks in front (`users`, `user-create`, `user-role`, `user-status`, `user-password`, `user-remove`, `models`, `config`, `config-list`, `config-show`, `config-set`, `config-unset`, `config-reload`, `journal`, `mounts-list`, `mounts-set`, `mounts-browse`, `fence-reload`, `status`, `restart-request`). A user has the package too and sees none of it: `api/ui` drops the entries and verbs above the role, the gateway answers `403` to a verb sent anyway, and the kernel refuses an operator method from a fence whose user is not an admin. See [17-control-panel.md](17-control-panel.md). |
| `@thetis/ui-marketplace` | The **Marketplace** place: the item in the sidebar's ≡ menu after **Control panel**. Opened plain it is the gallery (a search box, one chip per package type, a note on the registries, a card per package with its name, description, version, registry and the badges Only me, Everyone, Available, update to *v*); opened with `{ name }` it is that package's page (the README copy rendered by `ext.markdown`, the facts, what it brings, and the actions the role allows). Fifteen commands over the index in `env.shared`, `env.kernel.packages` and `env.kernel.config`: `search`, `show`, `install`, `remove`, `delete`, `update`, `config-show`, `config-list`, `config-set`, `config-unset` for everyone (the four `config-*` act on the person's own layer), and `install-everyone`, `install-for`, `remove-for`, `promote`, `people` with `role: "admin"` over `env.kernel.operator.call`. It depends on `@thetis/marketplace` for `readIndex`, `search`, `readReadme` and `behind`. See [18-marketplace.md](18-marketplace.md) section 9. |

## 12. Subagents on the page

A subagent is a session of its own whose `parent` is the conversation that spawned it. Its turn events reach the page on the same stream as everyone else's, each message stamped with `session` and `parent` (section 6), and `GET /api/sessions/<id>` lists a conversation's children (section 5). The page draws nothing special for them beyond what this section describes; an older server that sends neither `parent` nor `children` gets the page as it was.

### 12.1 The block

A `tool.call` named `spawn_subagent` closes the open tool run and places, at message level, a `details.agent` open and `is-running`:

```html
<details class="agent is-running" open data-call="<call id>" data-agent="<child id, once bound>">
  <summary class="agent-head">
    <span class="agent-dot"></span>
    <span class="agent-label">research</span>          <!-- args.label, else the first words of the task -->
    <span class="agent-gist" title="<task>">…</span>    <!-- the task, clipped -->
    <span class="agent-meta"></span>                   <!-- once ended: "12 tool calls · $0.03 · 48k tok" -->
    <span class="agent-took"></span>                   <!-- once ended: the duration -->
    <span class="agent-state">starting</span>          <!-- starting | working | done | failed | stopped -->
    <span class="agent-actions">
      <button class="agent-open" title="Open in a tab">…</button>
      <button class="agent-stop" title="Stop this subagent" hidden>Stop</button>  <!-- shown while working -->
    </span>
  </summary>
  <div class="agent-brief"><div class="agent-brief-text">the whole task</div></div>  <!-- clipped to four lines -->
  <div class="agent-body"></div>                       <!-- the nested transcript -->
  <!-- on the spawn result: a "stopped" or "error" section, like a tool card's result; a plain reply is quoted only when it differs from the child's last row -->
</details>
```

The block is bound to its child by the child's `turn.start`: the first unbound block whose task equals the message's `input` takes it, else the first unbound block, else a block is minted at the end of the transcript. The spawn's `tool.result` binds by id when the block is still unbound (its first line is `[subagent <id> <label>]`, never shown), settles the state from the second line (`stopped: …` and `error: …` are the tool's own words for a stopped and a failed child; a result that is an error as a whole names no child and the block binds by task), fills the duration, quotes the result under the body unless it is the reply the child's last row already shows, and folds the block. The child's own events drive the state word (`working` on `turn.start`; `stopped` on an `error` with the code `cancelled`, `failed` on any other; `done` on `turn.end`), count its tool calls and sum its usage for the meta line, and fold the block when the child ends. Stop posts `/api/sessions/<child>/cancel`. The block's buttons stop the click, so they never toggle the fold.

The child's rows are drawn by a nested transcript instance on `.agent-body`: the same bubbles, tool runs and notes as the conversation's, scaled down, without faces, and without the child's user rows, since the brief above is that message. A nested instance has no jump button and no scroll following of its own (the pane follows the newest row as usual), and offers nothing to the registered renderers: an `ask_user` inside a child is a plain tool card, so no form there can send to the conversation. A grandchild's block is nested in its parent's, at any depth. Each block refuses a message it has drawn, by turn and sequence, because a reconnect replays the running turn.

### 12.2 Replay

On open and on reload the record's `children` are indexed by id. A recorded `spawn_subagent` result draws the block for its child, folded, with the label from the record and the meta from the child's recorded usage and tool count; a child still running is drawn open and live. A finished block keeps its child record and builds its rows on the first open of the fold, so a conversation with many finished children costs nothing until one is looked at; a block whose record did not travel with the conversation (a grandchild's) fetches it then. A spawn that ended in an error without naming its child is matched to the unreferenced child with the same task.

### 12.3 A subagent's tab

The glyph on a block or a sidebar row opens the child as a tab (`.tab.is-agent`: the label in mono, a state dot that stays, its cost as a note). The pane's bar shows the dot, the label, the state word, the step and the spend while it works, **Show in conversation** (the conversation's tab, with the block opened, scrolled to the centre and flashed), and **Stop** while it works. Its transcript is restored from `GET /api/sessions/<child>`; its user rows are drawn as its brief. The composer is disabled with "A subagent has no composer. Talk to its conversation." and hides Send; Stop stays and cancels the child. The page title and the sidebar's current row follow the conversation while a child's tab is active.

### 12.4 The sidebar

Under the row of the open conversation, one row per subagent, in creation order, indented behind a rail with an elbow into each: a dot, the label, and `working · <step>` while it works, then `done`, `failed` or `stopped` and the cost. Clicking a row shows the child: its own tab when one is open, else its block in the conversation, revealed and flashed. The glyph at the end opens it in a tab. Any other working conversation counts its subagents among its facts (`2 tool calls · 1 agent · $0.03`). The clocks tick in place; a subagent's rows are only rebuilt when something about them changes.
