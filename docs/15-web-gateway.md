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
| See the plan | A `todo_*` call draws no tool card. It draws one quiet line (`plan: t-2 → active · 1 of 4 done`) and updates the chip `todo 1/4` in the chat bar, green when every item is done or dropped. The chip opens the plan: mark, text, note, and id per item, active in the warning colour, done struck through. The plan is rebuilt from the last `todo_*` result in the record when a conversation is reopened. |
| Answer the model's questions | An `ask_user` call is drawn as a form in place of a tool card: options as radios or checkboxes, a "Something else" text option, free text when there are no options, Skip per question, one Submit. Submit sends the answers as one user message and locks the card; the card stays locked when the conversation is reopened. See [20-tools.md](20-tools.md) section 4. |
| Stop a turn | The Stop button. The turn ends with the note "Turn stopped." Text streamed before the stop is kept. |
| Manage packages, search the marketplace, and, for admins, people, models, activity, and the configuration | The **Control panel** link in the sidebar footer. See [17-control-panel.md](17-control-panel.md). |

Subagent sessions are not listed. There is no delete and no file upload.

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

`deploy/thetis-runtime.service` runs `thetis serve` as a systemd service under the checkout's user, with `Delegate=yes` so the fences get their limits. Install it once:

```sh
sudo cp deploy/thetis-runtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thetis-runtime.service
```

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

A gateway keeps UI state only: which conversations the person archived, the name and the model they chose for a conversation, and the usage each reply reported, keyed by the reply's index in the conversation. A recorded usage also carries `model` when the person had chosen one. The file is `home/gateway-web/state.json` in the person's own userspace. The usage is recorded after a turn ends without an error; the transcript shows it as a header over the reply (`cached 96% · 2.5k in · 4 out · $0.0100`). The header reads the fields `cache_read_tokens`, `prompt_tokens`, `completion_tokens`, and `cost` by name. See [16-prompt-cache.md](16-prompt-cache.md) section 7.1. Credentials and tokens are the kernel's, in `$THETIS_HOME/auth.json`, which no fence can read.

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
| `GET /api/sessions` | `SessionSummary[]`. Sorted by `updatedAt`, newest first. Subagent sessions are excluded. |
| `POST /api/sessions` | Creates a session. Answers `201 { id }`. |
| `GET /api/sessions/<id>` | The session record with `status`, `archived`, `turn`, `usage`, `model`, and `title`. `turn` is the turn in progress, or `null`. `usage` maps a conversation index to the usage of that reply. |
| `GET /api/models` | `{ model, models }`: the configured default and the models the person's providers serve, from the kernel's `models` method. |
| `POST /api/sessions/<id>/model` | Body `{ model }`. Keeps the model for the conversation; every later turn is sent with it. An empty string restores the default. |
| `POST /api/sessions/<id>/title` | Body `{ title }`. Names the conversation. An empty string restores the derived title. |
| `/api/panel`, `/api/packages*`, `/api/marketplace*`, `/api/admin/*` | The control panel. See [17-control-panel.md](17-control-panel.md) section 3. |
| `GET /api/ui`, `GET /ext/<scope>/<name>/<path>`, `POST /api/ext/<scope>/<name>/<verb>` | What installed packages add to the page. See section 11. |
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
  cost?: number;       // the sum of the `cost` the replies reported; absent when none did
}
```

Every `/api/*` route and every `/ext/*` route needs the cookie. The gateway calls `auth.authenticate` with the token on each request. A missing, expired, or revoked token answers `401`. A session of another user answers `404`. A `POST` with the header `Sec-Fetch-Site: cross-site` answers `403`.

Kernel error codes map to status codes: `not-found` 404, `unauthorized` 403, `busy` 409, `invalid` 400. Other errors answer `500`.

## 6. The event stream

`GET /api/events` is a Server-Sent Events stream. One browser tab holds one stream. The stream carries every turn event of the signed-in user, for every session.

The first message is a `snapshot`:

```
event: snapshot
data: { "user": "alice", "running": [ { "session": "s_…", "turn": "t_…", "input": "…", "startedAt": "…", "events": [ { "seq": 1, "event": { … } } ] } ] }
```

`running` lists the turns in progress with the input text and every event so far. A page that connects mid-turn draws the input and the events, then continues with the live messages.

Each later message is one turn event:

```
event: turn
data: { "session": "s_…", "turn": "t_…", "seq": 7, "event": { "type": "text", "delta": "…" }, "input": "…" }
```

`seq` counts from 1 inside one turn. The page ignores a message with a `seq` it has already drawn for the same turn. `input` is present on `turn.start` only. It carries the user's message, so a tab that did not send it can draw it.

The server sends a comment line every 20 seconds to keep the connection open. The browser reconnects by itself. Every connection starts with a new snapshot.

## 7. How a turn runs

`TurnHub` in `src/turns.ts` runs turns in the background:

1. `POST /api/sessions/<id>/send` calls `kernel.sessions.send(session, text, onEvent, user)` over RPC. The kernel refuses a busy or unknown session at once; the RPC rejects with that code and the route answers `409` or `404`.
2. On the first event the hub records `{ session, input, startedAt, events: [] }` and the route answers `202`.
3. The hub numbers each event, buffers it, and sends it to every stream of the user.
4. On `turn.end` the hub forgets the turn. When the RPC rejects after the turn started, the hub sends an `error` event with the code `gateway` and then `turn.end`.

The buffer lives in memory in the system userspace agent. A restart of `thetis serve` ends the turns in progress; the kernel saves what each turn had produced.

## 8. Source

| File | Content |
|---|---|
| `src/index.ts` | `startService(env)`: listens on `run/web.sock` for the user in `THETIS_USER`, returns `{ stop }`. `stop` closes every open connection, because an event stream never ends on its own and an uninstall would otherwise wait for it. |
| `src/server.ts` | `createGateway(kernel, store, { user, base, env })`: routes under `base`, the cookie check, static files, the event stream. `kernel` is a `KernelClient`. |
| `src/panel.ts`, `src/http.ts` | The control panel routes and the HTTP helpers. See [17-control-panel.md](17-control-panel.md). |
| `src/ui.ts` | `validateUi`, `composeUi`, `serveExt`, `runCommand`: the extension routes of section 11. |
| `src/static.ts` | `serveFile` and the table of file types the page may load. Used for `/assets` and `/ext`. |
| `src/turns.ts` | `TurnHub`. |
| `src/store.ts` | `GatewayStore`: archive flags, names, chosen models, and per-reply usage. `ArchiveStore` is the former name. |
| `src/client.ts` | `clientFromRpc(rpc)`: the `KernelClient` shape over a raw RPC function, for tests and in-process hosts. |
| `assets/` | The browser code. Plain ECMAScript modules. No build step, no dependency. |
| `packages/gateway-login/src/server.ts` | `createLogin(kernel, { secure })`: `/login`, `/logout`, `/`, and the login page's assets. |
| `packages/door/src/index.ts` | `createDoor({ loginSocket, socketFor })`: the reverse proxy on the host port. |

Browser modules: `app.js` wires the store, the views, the event stream, the chat bar chips, and the favicon. `lib/store.js` holds `user`, `sessions`, `current`, `running`, `pending`, `activity`, `choices`, `creating`, `connection`, `panel`. `lib/activity.js` reduces every session's turn events into what it is doing now (the step, the tool call count, the cost, when it started) and formats durations, costs, and tokens; its `SHEEN_MS` must equal `--sheen` in `theme.css`, because a working row's sheen is phase-locked to wall time so a redraw does not restart it. `lib/picker.js` is the pill-and-list control the composer uses for the model. `lib/api.js` wraps `fetch` and `EventSource` with paths relative to the page's `<base>`; a `401` sends the page to `/login`. `lib/markdown.js` builds DOM nodes and never uses `innerHTML`. `views/sessions.js` (the grouped list, the ticking clocks, rename, the archive), `views/transcript.js` (messages, tool runs, footnotes), `views/ask.js` (the `ask_user` form and the tracker that locks open forms when a user message follows), `views/plan.js` (parsing a `todo_*` result, the plan card, and the chip's popover), and `views/composer.js` (the box, the model pill, stop) are the conversation views; `views/panel*.js` and `lib/panel-ui.js` are the control panel.

The page is served with a Content Security Policy that allows only same-origin scripts, styles, and connections. Inline scripts and styles do not run. `index.html` carries `<base href="{{base}}/">`; the server fills the placeholder with the person's prefix.

## 9. Trust model

- The door is host code. It routes by the first path segment and copies bytes. It never reads the cookie.
- The login target is package code in the system userspace, the only fence the kernel lets call `auth.login`. It sees passwords once, on the way to the kernel, and never a conversation.
- A person's gateway is package code in that person's fence. It reaches the kernel through the fence's RPC as that person. It cannot name another person, and the kernel answers `auth.authenticate` only for a token of that person, so a copied or guessed prefix changes nothing: bob's cookie at `/alice/` is a `401`.
- The kernel does not check roles for session calls. For the control panel the gateway checks the role, and the kernel checks it again on every operator method, against the fence's own user. See [17-control-panel.md](17-control-panel.md) section 2.
- Passwords are set by an operator on the host or by an admin in the control panel. There is no self-service registration or password change.

## 10. Tests

`packages/gateway-web/test/gateway.test.ts` starts a real kernel with the echo provider fixture, then one gateway per person (`alice`, `bob`, and the admin `root`) on unix sockets over each person's own RPC handler, the login target over the system handler, and the door in front. The cases run through the door: redirects and refusals without a cookie and for a stranger; login refused and accepted, with `next` kept inside the person's prefix; a suspended person and a password change; create, list, send, and the stream of one turn; `409` on a busy session and cancel; the snapshot for a page that connects mid-turn; archive and restore; the models list, a chosen model reaching the kernel and the list, and a name replacing the derived title; isolation, including bob's cookie at alice's gateway; refusal of a cross-site `POST`; logout; and the control panel cases of [17-control-panel.md](17-control-panel.md) section 7. `test/ui.test.ts` covers section 11 with the fixtures `ui-good`, `ui-bad`, and `ui-dup` under `packages/host/test/fixtures`. The last case of `gateway.test.ts` installs `@thetis/gateway-login` into the system userspace and `@thetis/gateway-web` into alice's, boots the supervisor, and drives the same path through a real door into the fences, then checks that uninstall stops alice's gateway. `npm test` runs all of them.

The browser code has no automated test. Check it by hand with a throwaway data directory: `THETIS_HOME=.devhome thetis init`, set `door.port`, add people, `thetis serve`, sign in, open the control panel as an admin and as a user.

## 11. Extensions

A package can add to the page. It declares what it adds in the `ui` field of its manifest. The gateway reads the field from `kernel.packages.list()` on each request. The kernel never reads it. See [05-packages.md](05-packages.md) section 1.2. The browser side of this seam is `assets/lib/ext.js`; this section covers the server.

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

The types are `UiDecl`, `UiEntryDecl`, and `UiCommandDecl` in `@thetis/contracts`.

### 11.2 Composition

`GET /api/ui` answers `{ extensions, refused }`. `extensions` has one entry per package with a valid `ui`, in install order:

```json
{ "package": "@alice/ui-good", "version": "0.1.0", "base": "ext/@alice/ui-good/", "entry": "index.js", "style": "index.css",
  "dock": [ { "id": "good", "label": "Good", "order": 100 } ], "panel": [], "places": [], "sidebar": [], "chips": [ { "id": "good", "order": 100 } ],
  "composer": [], "shelf": [], "statusbar": [], "commands": [ "echo" ] }
```

The rules:

- A package without `ui` is skipped.
- Every value is checked. Only the fields of section 11.1 cross to the browser. A string that is missing, empty, or too long, an id that does not match the pattern, an entry or verb declared twice in one package, a `dir`, `entry`, or `style` that leaves its directory or does not exist: each one refuses the package.
- A `dock`, `places`, `sidebar`, `chips`, `composer`, `shelf`, or `statusbar` id belongs to the first installed package that declares it. A later package that declares the same id is refused. Panel ids are namespaced by package in the browser, so two packages may both declare `people`.
- A refusal is `{ package, message }`. The package is left out. The rest still composes.
- Entries and commands with a `role` above the person's role are left out. Commands are listed by verb only. The export names and the roles stay on the server.

### 11.3 Files

`GET /ext/<scope>/<name>/<path>` serves the file at `<store>/node_modules/<scope>/<name>/<dir>/<path>`. The route answers `404` when the package is not installed here, when its `ui` is refused, when the path leaves `dir`, when the file does not exist, and when the extension is not `.js`, `.css`, `.svg`, `.json`, or `.md`. The types are the ones `/assets` serves, plus `.md`. The response carries `Cache-Control: no-cache`. The route needs the cookie.

The store is `env.store` of the service. An in-process gateway can set `GatewayOptions.store` instead.

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

The handler does not get the package's configuration. The kernel sends `config.packages[<name>]` only into that package's steps, tools, and service. A handler that needs it reads its own files.

The result: a string becomes `{ text }`. Nothing becomes `{}`. An object is passed as `{ text?, data? }`; other fields are dropped. A thrown error answers `400 { error }` with its message.

### 11.5 Trust

The three routes need the cookie of the person the gateway serves. A command runs the code of a package that person installed, or an admin installed for them, in that person's fence. The gateway checks the declared role before the kernel sees anything; the kernel checks the fence's own user again on every operator method, as in [17-control-panel.md](17-control-panel.md) section 2. A package serves files only from under its own `dir`. It cannot name another package: its page gets `base` and its own verbs, nothing else.
