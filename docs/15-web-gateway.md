# 15 Web gateway

The package `@thetis/gateway-web` provides a browser interface. The entry point is `bin/thetis-web.js`. Run it from `<root>` with `node bin/thetis-web.js <command>` or `npm run web -- <command>`.

The gateway runs on the host, in the same way as the command-line gateway. It boots a kernel in its own process and talks to it through the session API and the public kernel object. It does not run in a userspace. See section 8 for the consequences.

## 1. Functions

| Function | How |
|---|---|
| Sign in and sign out | A password per user. A cookie holds the login. |
| List conversations | The sidebar. Most recent first. Search filters as you type. |
| Archive a conversation | The row menu. Archived rows move to a section at the foot of the sidebar. The menu restores them. |
| Start a conversation | The `+` button, or a message sent with no conversation open. |
| Send a message | The composer. Enter sends. Shift+Enter adds a newline. |
| See the reply as it streams | Text appears under a caret. A tool call opens a card. The result closes it. |
| See a turn that runs in another tab, or after a reload | The page receives the turn in progress when it connects. See section 5. |
| Stop a turn | The Stop button. The turn ends with the note "Turn stopped." Text streamed before the stop is kept. |

Subagent sessions are not listed. There is no rename, no delete, no model picker, and no file upload.

## 2. Commands

### 2.1 `serve`

```
thetis-web serve [--host <addr>] [--port <n>]
```

Starts the server. The defaults are `127.0.0.1` and `8777`. The configuration entry `packages["@thetis/gateway-web"]` can set `host` and `port`. The flags override it.

```json
"packages": {
  "@thetis/gateway-web": { "host": "0.0.0.0", "port": 8777 }
}
```

The server stops on `SIGINT` or `SIGTERM`. It closes every fence before it exits.

**Caution:** `--host 0.0.0.0` exposes the gateway to the network. The login cookie is sent in clear text over HTTP. Put a TLS terminator in front of the gateway and set `THETIS_WEB_SECURE=1`, so the cookie carries the `Secure` flag.

### 2.2 `passwd`

```
thetis-web passwd <user> [--password <text>]
echo 'secret' | thetis-web passwd <user>
```

Sets the password of a user. The user must exist: create it first with `thetis users add <id>`. Without `--password`, the command reads one line from standard input. A new password revokes every login of that user.

## 3. Files

The gateway keeps its own state in `$THETIS_HOME/gateway-web/`. The kernel does not read these files.

| File | Content |
|---|---|
| `accounts.json` | One scrypt credential per user: `{ salt, hash }`. Parameters: N 16384, r 8, p 1, 64-byte key. |
| `tokens.json` | Login tokens: `{ user, createdAt }`. A token expires after 30 days. |
| `state.json` | `{ archived: { <user>: [<session id>] } }`. |

The files are written atomically with mode `0600`.

## 4. HTTP routes

| Method and path | Effect |
|---|---|
| `GET /` | The app page. Redirects to `/login` without a valid cookie. |
| `GET /login` | The sign-in page. |
| `POST /login` | Form fields `id`, `password`, `next`. On success: sets the cookie and redirects to `next`. On failure: redirects to `/login?error=refused`. With `Content-Type: application/json` the route answers JSON instead. |
| `POST /logout` | Revokes the token. Clears the cookie. Redirects to `/login`. |
| `GET /assets/<file>` | Static files from `packages/gateway-web/assets`. |
| `GET /api/me` | `{ user, role }`. |
| `GET /api/sessions` | `SessionSummary[]`. Sorted by `updatedAt`, newest first. Subagent sessions are excluded. |
| `POST /api/sessions` | Creates a session. Answers `201 { id }`. |
| `GET /api/sessions/<id>` | The session record with `status`, `archived`, and `turn`. `turn` is the turn in progress, or `null`. |
| `POST /api/sessions/<id>/send` | Body `{ text }`. Starts a turn. Answers `202`. Answers `409` when a turn is running. |
| `POST /api/sessions/<id>/cancel` | Stops the running turn. Answers `{ cancelled: boolean }`. |
| `POST /api/sessions/<id>/archive` | Body `{ archived: boolean }`. |
| `GET /api/events` | The event stream. See section 5. |

```ts
interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;   // the start of the running turn, when one runs
  turns: number;
  title: string;       // the first user message, one line, at most 60 characters
  preview: string;     // the last message, one line, at most 120 characters
  archived: boolean;
  status: "idle" | "running";
}
```

Every `/api/*` route needs the cookie. A missing or expired cookie answers `401`. A session of another user answers `404`. A `POST` with the header `Sec-Fetch-Site: cross-site` answers `403`.

Kernel error codes map to status codes: `not-found` 404, `unauthorized` 403, `busy` 409, `invalid` 400. Other errors answer `500`.

## 5. The event stream

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

## 6. How a turn runs

`TurnHub` in `src/turns.ts` runs turns in the background:

1. `POST /api/sessions/<id>/send` calls `sessions.send`. The kernel refuses a busy or unknown session at once.
2. The hub records `{ session, input, startedAt, events: [] }` and answers `202`.
3. The hub reads the event iterator. It numbers each event, buffers it, and sends it to every stream of the user.
4. On `turn.end` the hub forgets the turn. When the iterator throws, the hub sends an `error` event with the code `gateway` and then `turn.end`.

The buffer lives in memory. A gateway restart forgets the turns in progress. The kernel finishes them anyway and saves the session.

## 7. The browser code

The assets are plain ECMAScript modules. There is no build step and no dependency.

| File | Content |
|---|---|
| `assets/index.html`, `app.css`, `theme.css` | The page, the components, and the design tokens. The tokens follow the system light or dark setting. |
| `assets/login.html`, `login.css`, `login.js` | The sign-in page. |
| `assets/app.js` | Wires the store, the views, and the event stream. Keeps the drawn `turn` and `seq` of the open conversation. |
| `assets/lib/store.js` | One observable state object: `user`, `sessions`, `current`, `running`, `pending`, `creating`, `connection`. |
| `assets/lib/api.js` | `api(path, { method, body })` and `connect({ onSnapshot, onTurn, onStatus })`. A `401` sends the page to `/login`. |
| `assets/lib/markdown.js` | Renders assistant text. Builds DOM nodes. Never uses `innerHTML`. |
| `assets/lib/dom.js`, `avatar.js`, `toast.js` | Helpers. |
| `assets/views/sessions.js` | The sidebar. |
| `assets/views/transcript.js` | The conversation. `restore(record)` draws saved messages and the turn in progress. `applyEvent(event, input)` draws one live event. |
| `assets/views/composer.js` | The text box, Send, and Stop. |

The page is served with a Content Security Policy that allows only same-origin scripts, styles, and connections. Inline scripts and styles do not run.

## 8. Trust model

- The gateway authenticates every request with the cookie and maps it to one user id. It calls the session API with that id only.
- The gateway runs on the host with the kernel's rights. It is trusted code, like the command-line gateway. It is not a package that runs in a fence. ARCHITECTURE.md section 8.1 intends a system gateway to run in the system userspace behind a `host` publish. That needs `service` packages and port publishing, which do not exist yet. See [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md).
- The kernel does not check roles for gateway calls. An admin and a user get the same interface.
- Passwords are set by an operator on the host. There is no self-service registration or password change.

## 9. Tests

`packages/gateway-web/test/gateway.test.ts` starts a real kernel with the echo provider fixture and the HTTP server on a random port. It covers: redirects and refusals without a cookie; login failure and success; a suspended user's cookie; create, list, send, and the stream of one turn; `409` on a busy session and cancel; the snapshot for a page that connects mid-turn; archive and restore; isolation between two users; refusal of a cross-site `POST`; logout. `npm test` runs it with the kernel tests.

The browser code has no automated test. Check it by hand: `thetis-web serve`, sign in, send a message, stop a turn, reload during a turn, archive a conversation.
