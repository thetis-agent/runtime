# 15 Web gateway

The package `@thetis/gateway-web` provides a browser interface. It is a `gateway` package with a `service` declaration. It is installed like any package and runs inside the system userspace. It reaches the kernel only through the fence's RPC. See [03-fence.md](03-fence.md) section 6.

## 1. Functions

| Function | How |
|---|---|
| Sign in and sign out | A password per user, set by an operator with `thetis users passwd`. A cookie holds the login token. The kernel owns both. See [06-sessions-and-users.md](06-sessions-and-users.md) section 7. |
| List conversations | The sidebar. Most recent first. Search filters as you type. |
| Archive a conversation | The row menu. Archived rows move to a section at the foot of the sidebar. The menu restores them. |
| Start a conversation | The `+` button, or a message sent with no conversation open. |
| Send a message | The composer. Enter sends. Shift+Enter adds a newline. |
| See the reply as it streams | Text appears under a caret. A tool call opens a card. The result closes it. |
| See a turn that runs in another tab, or after a reload | The page receives the turn in progress when it connects. See section 5. |
| Stop a turn | The Stop button. The turn ends with the note "Turn stopped." Text streamed before the stop is kept. |
| Manage packages, search the marketplace, and, for admins, people, models, and the configuration | The **Control panel** link in the sidebar footer. See [17-control-panel.md](17-control-panel.md). |

Subagent sessions are not listed. There is no rename, no delete, no model picker, and no file upload.

## 2. Install and run

```sh
thetis users add alice
thetis users passwd alice --password secret   # or: echo secret | thetis users passwd alice
thetis install @thetis/gateway-web             # into the system userspace; needs an operator on the host
thetis serve                                   # starts every installed service and waits
```

Open `http://127.0.0.1:8777`. `thetis serve` stops on Ctrl+C. It closes every fence, which stops every service.

`thetis uninstall @thetis/gateway-web` stops the server when a `serve` process runs in the same kernel, and removes the package. See [08-cli.md](08-cli.md).

While `thetis serve` runs, `thetis install` and `thetis uninstall` reach it through the control socket, so the service starts or stops at once. See [08-cli.md](08-cli.md).

### 2.1 Deployment on this host

`deploy/thetis-runtime.service` runs `thetis serve` as a systemd service under the checkout's user. Install it once:

```sh
sudo cp deploy/thetis-runtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thetis-runtime.service
sudo systemctl disable thetis-web.service    # the previous front door, which also binds 8777 at boot
```

Public TLS for `thetis.example.com` terminates at the Caddy on `10.0.0.10`, which forwards to this host at `10.0.0.20:8777`. The configuration for that is `{ "host": "10.0.0.20", "port": 8777, "secure": true }`. From this host, check through Caddy directly, because the route through the public address times out from inside the network:

```sh
curl --resolve thetis.example.com:443:10.0.0.10 https://thetis.example.com/login
```

## 3. Configuration

```json
"packages": {
  "@thetis/gateway-web": { "host": "127.0.0.1", "port": 8777, "secure": false }
}
```

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | The bind address. |
| `port` | `8777` | The port. The manifest declares `publish: [{ port: 8777, to: "host" }]`. The kernel records this and does not act on it. The fence shares the host network, so the port is reachable on the host. |
| `secure` | `false` | Adds `Secure` to the cookie. Set it when TLS terminates in front of the gateway. |

**Caution:** `host: "0.0.0.0"` exposes the gateway to the network. The login cookie travels in clear text over HTTP. Put a TLS terminator in front of the gateway and set `secure` to `true`.

## 4. Files

The gateway keeps UI state only: which conversations each user archived, and the usage each reply reported, keyed by the reply's index in the conversation. The file is `home/gateway-web/state.json` in the system userspace. The usage is recorded after a turn ends without an error; the transcript shows it as a header over the reply (`cached 96% · 2.5k in · 4 out · $0.0100`). The header reads the fields `cache_read_tokens`, `prompt_tokens`, `completion_tokens`, and `cost` by name. See [16-prompt-cache.md](16-prompt-cache.md) section 7.1. Credentials and tokens are the kernel's, in `$THETIS_HOME/auth.json`, which no fence can read.

## 5. HTTP routes

| Method and path | Effect |
|---|---|
| `GET /` | The app page. Redirects to `/login` without a valid cookie. |
| `GET /login` | The sign-in page. |
| `POST /login` | Form fields `id`, `password`, `next`. Calls `auth.login`. On success: sets the cookie and redirects to `next`. On failure: redirects to `/login?error=refused`. With `Content-Type: application/json` the route answers JSON instead. |
| `POST /logout` | Calls `auth.logout`. Clears the cookie. Redirects to `/login`. |
| `GET /assets/<file>` | Static files from `packages/gateway-web/assets`. |
| `GET /api/me` | `{ user, role }`. |
| `GET /api/sessions` | `SessionSummary[]`. Sorted by `updatedAt`, newest first. Subagent sessions are excluded. |
| `POST /api/sessions` | Creates a session. Answers `201 { id }`. |
| `GET /api/sessions/<id>` | The session record with `status`, `archived`, `turn`, and `usage`. `turn` is the turn in progress, or `null`. `usage` maps a conversation index to the usage of that reply. |
| `/api/panel`, `/api/packages*`, `/api/marketplace*`, `/api/admin/*` | The control panel. See [17-control-panel.md](17-control-panel.md) section 3. |
| `POST /api/sessions/<id>/send` | Body `{ text }`. Starts a turn. Answers `202`. Answers `409` when a turn is running. |
| `POST /api/sessions/<id>/cancel` | Stops the running turn. Answers `{ cancelled: boolean }`. |
| `POST /api/sessions/<id>/archive` | Body `{ archived: boolean }`. |
| `GET /api/events` | The event stream. See section 6. |

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

Every `/api/*` route needs the cookie. The gateway calls `auth.authenticate` with the token on each request. A missing, expired, or revoked token answers `401`. A session of another user answers `404`. A `POST` with the header `Sec-Fetch-Site: cross-site` answers `403`.

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
| `src/index.ts` | `startService(env)`: reads the configuration, starts the server, returns `{ stop }`. |
| `src/server.ts` | `createGateway(kernel, store, opts)`: routes, cookie, static files, the event stream. `kernel` is a `KernelClient`. |
| `src/turns.ts` | `TurnHub`. |
| `src/store.ts` | `GatewayStore`: archive flags and per-reply usage. `ArchiveStore` is the former name. |
| `src/client.ts` | `clientFromRpc(rpc)`: the `KernelClient` shape over a raw RPC function, for tests and in-process hosts. |
| `src/panel.ts`, `src/http.ts` | The control panel routes and the HTTP helpers. See [17-control-panel.md](17-control-panel.md). |
| `assets/` | The browser code. Plain ECMAScript modules. No build step, no dependency. |

Browser modules: `app.js` wires the store, the views, and the event stream. `lib/store.js` holds `user`, `sessions`, `current`, `running`, `pending`, `creating`, `connection`. `lib/api.js` wraps `fetch` and `EventSource`; a `401` sends the page to `/login`. `lib/markdown.js` builds DOM nodes and never uses `innerHTML`. `views/sessions.js`, `views/transcript.js`, and `views/composer.js` are the conversation views; `views/panel*.js` and `lib/panel-ui.js` are the control panel.

The page is served with a Content Security Policy that allows only same-origin scripts, styles, and connections. Inline scripts and styles do not run.

## 9. Trust model

- The gateway is package code. It runs inside the system userspace fence, like a system provider. It cannot read `$THETIS_HOME`.
- The kernel gives the system userspace two rights that no other fence has: `auth.*` methods, and an `as` argument that names the user a session call acts for. The gateway uses `as` only with the user id that `auth.authenticate` returned for the request's cookie. This is the system gateway of ARCHITECTURE.md section 8.1.
- The kernel does not check roles for session calls. For the control panel the gateway checks the role, and the kernel checks it again on every operator method. See [17-control-panel.md](17-control-panel.md) section 2.
- Passwords are set by an operator on the host or by an admin in the control panel. There is no self-service registration or password change.

## 10. Tests

`packages/gateway-web/test/gateway.test.ts` starts a real kernel with the echo provider fixture. Fourteen cases drive the server in-process through `createRpcHandler` for the system userspace: redirects and refusals without a cookie; login failure and success; a suspended user and a password change; create, list, send, and the stream of one turn; `409` on a busy session and cancel; the snapshot for a page that connects mid-turn; archive and restore; isolation between two users; refusal of a cross-site `POST`; logout; and the four control panel cases of [17-control-panel.md](17-control-panel.md) section 7. The last case installs `@thetis/gateway-web` into the system userspace, boots the supervisor, signs in and runs a turn through the service inside the fence, and checks that uninstall stops it. `npm test` runs all of them.

The browser code has no automated test. Check it by hand: `thetis serve`, sign in, send a message, stop a turn, reload during a turn, archive a conversation.
