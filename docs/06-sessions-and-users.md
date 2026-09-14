# 06 Sessions and users

## 1. Users

A user is an identity. `UserStore` in `src/users.ts` keeps the records in `$THETIS_HOME/users.json`.

```ts
interface UserRecord {
  id: string;                        // matches ^[a-z][a-z0-9-]{0,31}$
  role: "system" | "admin" | "user";
  status: "active" | "suspended";
  createdAt: string;                 // ISO 8601
}
```

### 1.1 Roles

| Role | Rights |
|---|---|
| `user` | Can create and use sessions. Can install `@<own id>/*` packages. |
| `admin` | All rights of `user`. Can install `@thetis/*` packages into any userspace. |
| `system` | The user `_system` only. Owns the system userspace. Cannot be changed or removed. |

**Note:** Over the fence RPC, identity is the fence: a call acts as the userspace's own user, and no argument can name another user. The CLI trusts `--user` on the control socket. A network gateway runs in the person's own fence and resolves the login cookie with `auth.authenticate`, which the kernel answers only for that person. The kernel checks the role for operator methods and for `@thetis/*` installs: see [12-security.md](12-security.md) section 4.

### 1.2 The system user

`UserStore` creates `_system` on first start. The system userspace holds the system providers. `setStatus`, `setRole`, and `remove` reject `_system`.

### 1.3 Operations

| Method | Effect | Errors |
|---|---|---|
| `create(id, role = "user")` | Adds a user. | Invalid id. Duplicate id. |
| `authorize(id)` | Returns the user when it exists and is active. | Unknown user. Suspended user. Code `unauthorized`. |
| `setStatus(id, status)` | Sets `active` or `suspended`. | Unknown user. System user. |
| `setRole(id, role)` | Sets `admin` or `user`. | `system` role. System user. |
| `remove(id)` | Deletes the record. | System user. |
| `list()`, `get(id)` | Read. | None. |

### 1.4 Suspension

A suspended user cannot create sessions, send turns, inspect sessions, or list sessions. Every session API call runs `authorize` first. Existing sessions and files are kept. `unsuspend` restores full access.

### 1.5 Removal

`Kernel.removeUser(id)`:

1. Deletes the user record.
2. Closes the user's fence.
3. Removes the user's entries from the package registry.
4. Deletes the userspace directory.

**Caution:** Step 4 deletes all sessions and packages of the user. There is no undo.

## 2. Userspaces

`UserspaceLayout` in `packages/lib/src/userspace-layout.ts` gives the paths:

```
$THETIS_HOME/userspaces/<user id>/     root
  home/                                 working directory of the agent and the tools
  store/node_modules/                   installed packages
  store/src/                            git clones
  sessions/<session id>.json            session records
```

`SessionApi.userspaceFor(user)` creates the directories on first use and seeds the system packages. `ServiceSupervisor.ensure(id)` does the same at boot for every active user and when an operator creates a user, so a person's gateway runs before their first visit.

```
  run/                                  unix sockets of this userspace's services
```

## 3. Sessions

A session is one conversation with its harness state. `SessionApi` in `packages/kernel/src/sessions/api.ts` writes each session through a `JsonDirStore` to `<userspace>/sessions/<id>.json`.

```ts
interface SessionRecord {
  id: string;             // s_<12 hex characters>
  user: string;
  parent?: string;        // set for subagents
  createdAt: string;
  updatedAt: string;
  turns: number;
  conversation: Message[];
  harness: HarnessState;
}
```

The kernel writes the file at the end of every turn, also after an error. Writes are atomic: the kernel writes a temporary file and renames it.

## 4. The session API

`SessionApi` in `src/sessions/api.ts` is the only surface for gateways. Every method authorizes the user first.

| Method | Returns | Notes |
|---|---|---|
| `create(userId, { parent? })` | `SessionRef` | `parent` must be an existing session of the same user. |
| `send(userId, sessionId, input)` | `AsyncIterable<TurnEvent>` | `input` is a string or `Message[]`. A string becomes one `user` message. |
| `ask(userId, sessionId, input)` | `Promise<string>` | Runs `send` to the end. Returns the last assistant text. Throws on an `error` event. |
| `cancel(userId, sessionId)` | `boolean` | Stops the running turn of the session. Returns `false` when no turn runs. See [04-pipeline.md](04-pipeline.md) section 5.1. |
| `inspect(userId, sessionId)` | `SessionRecord & { status }` | `status` is `running` or `idle`. |
| `list(userId)` | `SessionRef[]` | Sorted by creation time. |

`SessionRef` is `{ id, user, parent?, createdAt, updatedAt, turns }`.

### 4.1 Concurrency

A session runs at most one turn at a time. A second `send` on a running session fails with the code `busy`. Different sessions of the same user can run in parallel. They share one fence process. The agent handles requests concurrently.

`cancel` stops the running turn. The `send` iterator receives an `error` event with the code `cancelled` and then `turn.end`. The session is idle again when `turn.end` arrives.

### 4.2 Ownership

A session is reachable only by its owner. `inspect` and `send` look for the session file in the caller's own userspace. A session id of another user gives the error `unknown session`.

## 5. Subagents

A subagent is a session with a `parent`. It lives in the same userspace as its parent. It sees the same files and the same packages. It runs its own pipeline with its own conversation and harness.

Two ways create a subagent:

- The tool `spawn_subagent` in `@thetis/tool-exec`. It creates a child session, sends the task with `sessions.ask`, and returns the final reply.
- Package code through `env.kernel.sessions.create(parentId)` and `env.kernel.sessions.ask(childId, text)`.

The child session persists after the reply. A later call with the same id continues the child conversation.

**Note:** A subagent turn runs inside a tool call of the parent turn. The parent fence request waits. The default request timeout is 600000 milliseconds. A long subagent task must fit in that time, or `requestTimeoutMs` must be raised.

## 6. Turn input and history

The runner appends the input messages to the saved conversation before the first step. Steps see the input as `ctx.turn.input` and at the end of `ctx.conversation`.

The full conversation is saved. Only `call.messages` is limited, by the `trimHistory` step of `@thetis/harness-core`. A step that must see everything reads `ctx.conversation`.

## 7. Authentication

`AuthService` in `src/auth.ts` holds the identity a network gateway checks. It lives in the service plane. The file is `$THETIS_HOME/auth.json`, written with mode `0600`.

| Method | Effect |
|---|---|
| `setPassword(id, password)` | Stores an scrypt credential (N 16384, r 8, p 1, 64-byte key, 16-byte salt). Revokes every token of the user. The user must exist. The system user is refused. |
| `hasPassword(id)` | True when a credential exists. |
| `login(id, password)` | Returns `{ token, user }` or `undefined`. The work is the same for an unknown user. A suspended user is refused. |
| `authenticate(token)` | Returns the active user of a token, or `undefined` when the token is unknown, older than 30 days, or the user may not act. |
| `logout(token)` | Revokes the token. |

The CLI sets passwords: `thetis users passwd <id>`. Package code reaches `auth` through RPC from the system userspace only. See [03-fence.md](03-fence.md) section 6. A gateway exchanges a password for a token, keeps the token in a cookie, and calls `authenticate` on each request.
