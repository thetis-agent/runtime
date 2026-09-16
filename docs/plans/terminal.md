# Plan: terminal

**Date:** 2026-09-16. **Status:** proposed. **Scope:** one new package, `@thetis/terminal`: long-lived
shell sessions inside a person's own fence, five tools over them, and the shelf view that shows them live.
It retires the `exec` tool of `@thetis/tool-exec`. It needs one gateway change, a streaming seam for
extension commands, which every later live view reuses.

**Verdict on the proposal: agree, with three amendments.** The reasons to agree are in section 0. The
amendments: the tool surface is five tools and not the legacy seven (section 3); the remote ssh half of
the legacy feature is left out (section 11); and the browser side is writable, which the legacy one was
not, because the gateway now runs inside the person's own fence and has the authority the legacy host
could not give it (section 7).

---

## 0. Why rebuild it

| Finding | Where |
|---|---|
| The shelf slot exists and is empty. It was specified for this: "the bottom dock under the conversation, **the terminal's home in the canvas**". No package fills it. | `packages/gateway-web/assets/views/shelf.js:1`, `docs/plans/gateway-ui-modular.md:78` |
| The modular plan already names this package as a later consumer of the seam, with the pane list and the commands `open`, `write`, `resize`. | `docs/plans/gateway-ui-modular.md:382` |
| One-shot `exec` cannot hold state. Each call starts in the home with a fresh shell, so a `cd`, a `nvm use`, a virtualenv, an `ssh-agent` or a half-finished rebase is lost between calls. The model pays for the workaround in every command line it writes. | `packages/tool-exec/src/index.ts:11`, `packages/userspace-agent/src/agent.ts:60` |
| One-shot `exec` cannot answer a prompt. A command that asks for a passphrase, a `y`, or a conflict resolution can only time out. | `packages/userspace-agent/src/agent.ts:64` (a timeout, and no stdin) |
| One-shot `exec` is invisible while it runs. A 90-second test suite is a tool card with a spinner; the person sees the output when the model does, and not before. | `docs/15-web-gateway.md` section 1 |
| A long command is lost, not deferred. `exec` kills the process on timeout, so the work is thrown away instead of continuing in the background. | `packages/userspace-agent/src/agent.ts:64` |
| The legacy design proved what the hard part is: a stream from a shell never ends, so each command must be framed. It framed with a marker carrying the exit status and the working directory, because both are only knowable at the moment the command ends. | `/opt/thetis/crates/thetis/src/terminal.rs:1176` |
| The legacy design proved what a naive interrupt costs: signalling the whole process group kills the shell as well as the runaway, so the session is lost by the call meant to save it. Signal the descendants, or write to the pty. | `/opt/thetis/crates/thetis/src/terminal.rs:168` |
| The legacy drawer proved the viewer must not consume the agent's output. It teed every line: once into the agent's buffer, once into the display. | `/opt/thetis/crates/thetis/src/terminal.rs:32` |
| The legacy drawer was read-only, and said why: "there is no host path for writing to a shell's stdin from a browser, and a terminal that swallows keystrokes silently would be worse than one that says it is a view." That reason is gone. | `/opt/thetis/gateways/gateway-web/src/ui/views/terminal.js:21` |
| The legacy view used a real emulator and said why: "every hand-rolled attempt at it turns `cargo build` into a screenful of escape soup." | `/opt/thetis/gateways/gateway-web/src/ui/views/terminal.js:15` |
| A pty works inside the fence. `--dev /dev` gives `/dev/pts` and `/dev/ptmx`; `script -qfc /bin/bash /dev/null` gets a tty and a prompt. Verified in a fence built with the same arguments as `bwrapArgs`. | `packages/sandbox/src/bwrap.ts:35` |

What does not carry over: the legacy shell host lived in the host process, 2,232 lines of it, and held
policy (a text check for a `cd` that leaves the roots, a shell choice per platform, an ssh registry). In
this architecture the fence is the policy, so most of that is deleted rather than ported.

---

## 1. The package

`@thetis/terminal`, `type: "tool"`, one package with three faces. Every part runs inside the person's own
fence. Nothing is added to the kernel.

| Part | Runs in | Function |
|---|---|---|
| `service` | The userspace agent process | Holds the session table. Spawns each shell. Pumps its output into a ring buffer. Listens on `<root>/run/term.sock`. Closes every session when the fence closes. |
| `tools` | The same agent process | Five tools. They reach the host over the socket, not through module state. |
| `ui` | The person's gateway process | The `shelf` entry (the terminal), the `statusbar` chip, and the commands. They reach the same socket. |

The socket is the seam, and it is the reason the package is shaped this way: a tool runs in the agent
process, but a `ui` command runs in the **gateway** process (`docs/15-web-gateway.md` section 11.4). Two
processes, one fence, one filesystem. Module state cannot be shared between them, and must not be relied
on inside one of them either: `loadExport` imports `main` with a modification-time query, so a reinstall
gives a tool a different module instance from the service that holds the sessions. A unix socket under the
userspace root is the only place both processes can meet. `@thetis/gateway-web` already listens on
`run/web.sock`, so the pattern and its permissions are proven.

Files, with estimated lines:

| File | Lines | Holds |
|---|---|---|
| `index.js` | 190 | The service export, the five tool exports, the six ui command exports. Argument checks only; no mechanism. |
| `lib/session.js` | 230 | One session: spawn, the shell integration marks, the ring buffer, the cursors, write, resize, interrupt, close. |
| `lib/host.js` | 180 | The session table, the socket server, the line protocol, subscribe and broadcast, the limits, the idle reaper. |
| `lib/client.js` | 80 | Connect, request, subscribe. Used by the tools and by the ui commands. |
| `lib/marks.js` | 90 | The init file written for a session, and the parser for the two escapes of section 2.2. |
| `ui/index.js` | 120 | `install(ext)`: the shelf registration, the chip, the stream subscription. |
| `ui/shelf.js` | 260 | The session list, the state words, the toolbar, the input. |
| `ui/screen.js` | 110 | The emulator wrapper: load it once, feed it bytes, size it, take the keys. |
| `ui/vendor/` | — | The emulator. See section 4.3. |
| `ui/index.css` | 150 | The shelf, the list, the states. |
| `test/*.test.js` | 320 | Section 9. |

---

## 2. The session mechanism

### 2.1 A pty, not pipes

The shell runs under `script -qfc "<shell>" /dev/null`, which is util-linux and already on the read-only
`/usr` every fence gets. That gives a real terminal: line editing, job control, colour, and programs that
behave as they do for a person. Pipes cannot give that, and the legacy code's own comments show the cost
of pretending otherwise.

What the pty buys that matters most: **an interrupt is a keystroke.** Writing the interrupt character to
the master delivers SIGINT to the foreground process group only, which is exactly the behaviour the legacy
code needed 40 lines of process-group arithmetic to approximate.

### 2.2 Framing: shell integration, not an injected marker

Each session is started with an init file the package writes under `<root>/run/`. It sources the person's
own rc, then wraps the prompt so that the shell announces four things: the prompt has started, the command
line has ended, the command has finished with this status, and the working directory is now this. Those are
the OSC 133 (semantic prompt) and OSC 7 (working directory) escapes that every modern terminal uses for the
same purpose. The shell is then started with that file as its rc.

Three things follow, and each one is a legacy wart removed:

1. **Every command is framed, not only the agent's.** The legacy host appended a marker to the command it
   sent, so it learned the exit status of its own commands and nothing about the person's. The prompt emits
   the mark whoever typed the command, so one mechanism serves both.
2. **The framing is invisible.** The legacy marker was a printed line, which the drawer then showed to
   people. An OSC escape is consumed by the emulator, so the person's transcript is a clean transcript.
3. **Busy and idle are observed, not guessed.** A session is idle when the last mark was a prompt start,
   and busy otherwise. This is the fact the shelf shows and the tool waits on, and it is read rather than
   inferred.

A shell with no such hook (a person's shell set to something else) degrades honestly: the host falls back
to appending the legacy marker to the commands it sends, the session is flagged `unframed`, and the shelf
says so. It does not pretend to know the exit status of a command the person typed.

### 2.3 One buffer, many cursors

Each session holds a ring buffer of the last 256 KiB of output and a monotonic byte counter. Every consumer
holds an offset: the agent has one per session, each open browser has one. Nothing consumes.

A consumer whose offset has fallen off the back of the buffer is told: its next read begins with a line
that says how many bytes were dropped. It is not silently handed a hole. Ring buffers lie by default; this
one is made to say so.

### 2.4 The limits

| Limit | Value | Why |
|---|---|---|
| Sessions per person | 8 | The legacy limit was 4 per conversation. A person's fence is the unit now. |
| Ring buffer | 256 KiB per session | The legacy display buffer was 96 KiB, which is under one screen of a verbose build. |
| One tool answer | 30,000 characters, head and tail kept | The cap `env.exec` already uses (`agent.ts:18`). |
| Default wait for `shell` | 120,000 ms | What `env.exec` waits. The command is **not** killed after it: see 3.2. |
| Idle close | 30 minutes with no attached viewer and no running command | The legacy `idle_timeout_secs`. |
| Transcript on disk | none | Section 7. |

### 2.5 Resize, and the one honest limitation

Node cannot set a pty's window size without a native module, and this repository has no third-party
runtime dependency in any of its 30 packages. So a resize is an `stty rows R cols C` sent on the session's
own tty when it is next idle. The consequence, stated in the UI rather than hidden: **a full-screen program
that is already running does not learn the new size.** It learns it when it next starts. Everything else —
wrapping, `less`, a new `vim` — is correct.

---

## 3. The tools

### 3.1 The surface

Five tools, not the legacy seven. `terminal_open` is gone: a session is opened by the first command that
needs one, because a tool call that only prepares to work is a call the model pays for twice.

| Tool | Arguments | Answer |
|---|---|---|
| `shell` | `cmd`, `session?`, `cwd?`, `timeoutMs?`, `background?` | Runs in this conversation's session, creating it on the first call. The exit status, the output, and a note when the working directory moved or the person typed in the session since the last read. |
| `shell_read` | `session?`, `waitMs?` | What arrived since this conversation's last read. Says whether the command has finished and with what status. |
| `shell_send` | `session?`, `text`, `submit?` | Writes raw input. For a passphrase, a `y`, a REPL. Returns what arrived in the next 400 ms (the legacy `send_settle_ms`). |
| `shell_interrupt` | `session?` | Sends the interrupt character. Ends the command, keeps the session. |
| `shell_sessions` | `close?` | This conversation's sessions: name, working directory, busy with what, for how long, whether the person is watching. `close` ends one. |

Two facts go in the descriptions, because the model cannot deduce either: the session is **shared with the
person, who can see it and type in it**, and the file tools are still the cheaper way to read or change a
file (the legacy description made that point and it held up:
`/opt/thetis/agents/agent-core/src/tools.rs:1261`).

### 3.2 What changes for the model

| Before | After |
|---|---|
| `exec` starts in the home every time. | `shell` starts where the last command left off. |
| A command that asks a question times out. | `shell_send` answers it. |
| A command over the timeout is killed and its work is lost. | It keeps running. The answer says so, and `shell_read` collects the rest. `background: true` asks for that on purpose. |
| Output arrives once, at the end. | Output streams to the shelf while it runs. |

### 3.3 `@thetis/tool-exec`

The `exec` tool is deleted from it. The package keeps `install_package`, `uninstall_package`,
`fork_package`, `delete_package` and `spawn_subagent`, and its description is rewritten to those. The name
stays: renaming a package in `systemPackages` costs every deployment a migration and buys a better noun.
`env.exec` stays in `StepEnv` — it is the mechanism this package does not use (a pty needs `spawn`), and
other code depends on it.

### 3.4 The bench gate

One tool became five, and this repository measures that (`docs/21-benchmarks.md`). `@thetis/terminal`
declares `bench.suites: ["assembly-cost@1", "tool-recall@1"]` and `peerGroup: "tools"`, as `tool-exec`
does. The gate: recall must not fall against the `exec` baseline. If it does, fold `shell_interrupt` into
`shell_send` (the interrupt character as its text) and `shell_sessions` into `shell`, and measure again.
The number decides, not the taste.

---

## 4. The web UI

### 4.1 Where it sits

`shelf: [{ "id": "terminal", "label": "Terminals" }]` and `statusbar: [{ "id": "terminal" }]`. The shelf is
the bottom dock: it shortens the conversation rather than covering it, and the grip and the close belong to
the shell already. The chip reads `2 shells · 1 busy` and opens the shelf.

The shelf opens by itself the first time a session in the open conversation starts a command, once per page
load, and never takes the focus from the composer. A person who closes it is not reopened for the same
session.

### 4.2 What it says

Per the rule in `state-must-be-visible`: the state is computed where the truth is (the host), in one word,
with the repair in the row. Each session row carries one of:

| State | Row says | Action in the row |
|---|---|---|
| `idle` | the working directory | Close |
| `busy` | `the agent is running cargo test · 14s` | Interrupt |
| `busy-quiet` | `running cargo test · no output for 20s` | Interrupt |
| `person` | `you are running vim` | Interrupt |
| `fullscreen` | `a full-screen program has the terminal` | Interrupt |
| `unframed` | `this shell does not report exit codes` | — |
| `closed` | `closed · exit 130` | Reopen |

Seven words, and no eighth. An earlier draft of this table had a `waiting` for a command that has stopped
at a prompt: there is no way to know that without guessing, and a guessed state is the thing this whole
design is against. `busy-quiet` says what is observed instead — the command runs and has printed nothing
for twenty seconds — and the person decides what that means. Dropped output was also a state here; it is a
fact about a row (`dropped > 0`), shown in the row, not a state the session is in.

The shelf head summarises when any row is not `idle`, the way a project's directory list does.

The input is always enabled, including while the agent holds the prompt — that is how a person answers the
question the agent's command asked. When the agent holds it, the input says whose command the keys reach. A
terminal that quietly swallows keystrokes is the failure the legacy view refused to ship, and a terminal
that quietly redirects them would be worse.

### 4.3 The emulator

**Recommendation: vendor `@xterm/xterm` (MIT) under `ui/vendor/`, loaded on the first session.** The
reasons, in order: the legacy code tried the alternative and recorded the result; the terminal is writable
now, so `less`, `git rebase -i`, `htop` and `vim` are things people will actually run in it; and a
hand-written emulator would be the single largest and least interesting file in the package.

What it costs, stated plainly: the first third-party runtime file in the repository (about 280 KiB of JS and
5 KiB of CSS), its `LICENSE` beside it, a line in the package README, and a load on first use so a person
who never opens a shell never fetches it. The `/ext/` route already serves `.js` and `.css`, and the CSP is
`script-src 'self'`, so the UMD build loads from a classic script tag without a change.

`ui/screen.js` is the only file that names it. If vendoring is refused, that file is replaced by a small
renderer for colour and carriage returns, the `fullscreen` state above becomes a notice instead of a
picture, and nothing else in the package changes.

---

## 5. The one gateway change: a streaming seam

An extension command is request and response (`POST /api/ext/<scope>/<name>/<verb>`, a 30-second timeout, a
256 KiB answer). A terminal needs output as it happens. The modular plan assumed this package needed no
gateway change; on inspection it does, and the alternative is a poll four times a second per open session,
which is the wrong thing to build into the one place that is watched for minutes at a time.

| Piece | Change | Lines |
|---|---|---|
| `@thetis/contracts` | `UiCommandDecl` gains `stream?: boolean`. New `UiStream = (args, env) => AsyncIterable<unknown>`, where `env` is a `UiCommandEnv` with a `signal`. | 15 |
| `gateway-web/src/ui.ts` | `composeUi` validates `stream` and lists the streaming verbs as `streams: [verb]`, so the browser can tell one seam from the other. Role filtering as now. | 20 |
| `gateway-web/src/server.ts` | `GET /api/ext/<scope>/<name>/<verb>/stream`, with the arguments and the session in the query: the same five checks as `runCommand`, then the ten-line event-stream block `/api/events` already uses, plus an `AbortController` fired on the request closing. No answer-size cap, no command timeout, a keep-alive comment every 20 seconds. | 55 |
| `gateway-web/assets/lib/ext.js` | `ext.subscribe(verb, { args, session, onEvent, onClose })` returning a stop function. Refuses a verb the package did not declare, as `request` does. | 30 |

The route is a `GET`, so `checkSameSite` does not apply to it; an `EventSource` cannot carry a header. It is
guarded as `/api/events` is: the login cookie, and the door's per-person routing. Worth stating in
`docs/12-security.md` rather than leaving implicit.

Later users of the same seam, none of which need anything more: the journal tail in the control panel, a
live activity feed, a build watcher.

---

## 6. Configuration

`config.packages["@thetis/terminal"]`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` withdraws the five tools and the shelf entry for that person. The legacy `terminal.enabled`. |
| `shell` | `/bin/bash` | The program. An unframed shell is allowed and flagged (2.2). |
| `sessions` | `8` | Sessions per person. |
| `bufferBytes` | `262144` | The ring buffer. |
| `idleMinutes` | `30` | The idle close. `0` disables it. |

Per-person, because `config.packages` is read per fence. An operator can give one person a terminal and
another none.

---

## 7. Security

| Question | Answer |
|---|---|
| What can the shell reach? | Exactly what the fence can: the home read-write, `shared` read-only, and the person's mounts with their modes. This is the same reach `@thetis/tools-files` computes, but here it is structural — bwrap, not a path check. The legacy `escapes_the_roots` text check on `cd` is not ported, because it was compensating for a host that had no fence. |
| Is a writable browser terminal an escalation? | No. A person who can open their gateway can already run any command in that fence through the agent's tools. It is a new path to the same authority, so it is guarded the same way: the login cookie, the door's routing, the person's own fence, and the package's declared role (any signed-in person, for their own sessions only). |
| Can an admin's terminal reach the host? | No more than their fence does. An admin's authority over the host is the operator channel, which the kernel checks per call; a shell in their fence is still in a fence. |
| Where does the transcript live? | In the agent process's memory, and nowhere else. It is not written to disk and not sent to the journal. A shell transcript holds whatever was pasted into it, and a passphrase typed into a session must not outlive it. The journal gets one line per session opened and closed, with no command text. |
| Egress? | The fence's. A session inherits the private network namespace and the egress the fence was given; it has no path the agent does not have. |
| The socket? | `<root>/run/term.sock`, inside the userspace, so only that fence's processes can see it. The host answers only for the user it belongs to; it takes no user argument, as the operator channel does not. |

---

## 8. Phases

| Phase | Changes | Proves | Lines |
|---|---|---|---|
| 0 | The streaming seam: contracts, `ui.ts`, `server.ts`, `ext.js`, gateway tests, docs. Behaviour-neutral for every existing package. | The seam, with a test that streams and one that aborts. | 120 |
| 1 | `@thetis/terminal`: service, host, session, client, the five tools. No UI. | A session-backed `shell` replaces `exec` on the command line and in a conversation. Unit tests. | 700 |
| 2 | `ui/`: the shelf, read-only, live. | The seam end to end; the emulator; the browser test. | 500 |
| 3 | Writable: keystrokes, interrupt, resize, the state words of 4.2, the chip. | The part the legacy view could not have. | 250 |
| 4 | `exec` deleted from `tool-exec`; both benches run; docs; publish to the registry. | No recall regression. The gate in 3.4. | 80 |

Phases 1 and 2 are each usable alone: after 1 the model has a real shell with no window onto it; after 2 the
person can watch and not touch. Nothing is half-built at a phase boundary.

---

## 9. Tests

| Test | What it covers |
|---|---|
| `test/session.test.js` | Spawn, run, exit status, working directory carried over, a command that outruns its wait and is collected later, an interrupt that leaves the session alive, a ring buffer that drops and says so, an unframed shell. |
| `test/host.test.js` | The session limit, two consumers with independent cursors, the idle reaper, close on fence close, a request for another person's session refused. |
| `test/marks.test.js` | The escape parser: prompt start, command start, a finish with a status, the working directory, an escape split across two chunks, an escape inside command output that must not be read as a mark. |
| `gateway.test.ts` | The stream route: a streaming verb, a verb not declared (404), a role above the person (403), an abort when the client closes, `composeUi` listing `streams`. |
| `BROWSER.md` steps 53–62 | Open the shelf; run a command from the composer and watch it appear; type a command and watch the agent's next read report it; interrupt a `sleep 100`; resize and see the notice; a full-screen program; close a session; the chip count; the shelf state words for each row in 4.2. |
| Benches | `assembly-cost@1` and `tool-recall@1` against the `exec` baseline. |

---

## 10. Documentation

| File | Change |
|---|---|
| `docs/24-terminal.md` | New. The session model, the marks, the tools, the shelf, the limits, the configuration. |
| `docs/20-tools.md` | The five tools; `exec` removed from `tool-exec`'s row. |
| `docs/15-web-gateway.md` | Section 11: `stream` in the declaration, the route, `ext.subscribe`, the shelf slot's first user. |
| `docs/12-security.md` | The stream route and its guard; the shell's reach; the transcript that is never written down. |
| `docs/09-configuration.md` | The `@thetis/terminal` block. |
| `docs/13-limitations-and-roadmap.md` | The tool row; the resize limitation; no ssh. |
| `docs/05-packages.md` | Nothing, unless `stream` needs a line in the manifest table. |
| `docs/plans/gateway-ui-modular.md` | The note at line 382 said this package needs no gateway change. Correct it with the reason. |
| `packages/terminal/README.md` | New, and the vendored emulator's licence. |

---

## 11. Left out, and why

| Left out | Why |
|---|---|
| Remote sessions over ssh, and the `ssh_host_*` tools | The legacy feature kept a host registry and opened shells on other machines. That crosses the fence's egress policy and its authority model, and is a feature in its own right, not part of a terminal. A person who wants it can `ssh` inside a session. |
| Sessions that survive the fence closing | A `mounts.set` or a daemon restart closes the fence, and everything in it stops. Reattaching would mean a process outside the fence holding a shell inside it, which inverts the model. The shelf says a session closed and why. |
| A session shared between two people | A session lives in one fence. Two people are two fences. |
| The transcript kept across reloads | 2.3 and section 7: memory only. A reconnecting browser gets the ring buffer, which is the last screenful and a bit, and is told when that is not the whole story. |
| A shell as the way to read and edit files | `@thetis/tools-files` stays the cheaper and safer path, and the tool descriptions say so. |

---

## 12. Open decisions

Each has a default, so none of them blocks phase 0 or 1.

| Decision | Default |
|---|---|
| Vendor `@xterm/xterm`, or write a small renderer (4.3) | Vendor it. One file names it, so the choice is reversible. |
| Five tools or three (3.4) | Five, until `tool-recall@1` says otherwise. |
| Does the person's typing reach the model unasked | No. It is reported in the next `shell` or `shell_read` answer as a note, never pushed into the prompt. |
| Session names | `main` per conversation, then `2`, `3` and so on. A person can rename a row; the model cannot. |

---

## Status (2026-09-16)

Built, in the order of section 8: phase 0 (the streaming seam in `@thetis/contracts`, `gateway-web/src/ui.ts`,
`gateway-web/src/server.ts` and `assets/lib/ext.js`, with `docs/15-web-gateway.md` section 11.5 and
`docs/12-security.md`), then phases 1, 2 and 3 as one package, `packages/terminal`. Phase 4 is not done:
`exec` is still declared by `@thetis/tool-exec`, and the two benches the manifest opts into have not been
run. The reference is `docs/24-terminal.md`.

Sizes, against the estimates of section 1: `lib/session.js` 722 (230), `lib/host.js` 303 (180),
`lib/marks.js` 240 (90), `lib/client.js` 106 (80), `ui/shelf.js` 327 (260), `ui/index.js` 262 (120),
`ui/screen.js` 248 (110), `ui/index.css` 100 (150), `test/*.test.js` 636 (320). `index.js` and the package
README were still being written when this note was added.

Where the built thing differs from the plan:

| Plan | Built | Why |
|---|---|---|
| 1: six `ui` command exports | Eight: `sessions`, `open`, `write`, `interrupt`, `resize`, `close`, `rename`, and the stream `watch`. | The shelf renames rows and lists them; the page needs one stream for the whole page. |
| 2.2: the shell announces four things | Four marks, plus the alternate screen tracked from `CSI ?1049h` / `?1049l`. | `fullscreen` in 4.2 is only knowable that way: prompt marks stop arriving and nothing else says why. |
| 2.2: a mark proves the shell is framed | Only a semantic-prompt mark proves it. `OSC 7` does not. | Plenty of things emit `OSC 7` and say nothing about the prompt; taking it as proof let the first command be written before the shell had a prompt at all. |
| 2.3: 256 KiB of output | 262144 **characters** of the decoded stream. | The stream is decoded once on arrival, so a cursor can never split a multi-byte character. |
| 2.4: no limit named for closed sessions | Four closed sessions stay on the list. | The shelf says `closed · exit 130` and offers a reopen, which needs the row to survive the close. |
| 2.5: the resize is sent when the session is next idle | Deferred to the next **prompt**, and the answer says `{ applied: false, deferred: true, reason }` so the row can say it. | Nothing may be written into the gap between a command ending and the prompt being redrawn: the shell is still in `PROMPT_COMMAND`, and a command written there is echoed twice. |
| 3.1: `shell_send` returns what arrived in the next 400 ms | Unchanged, but `submit` defaults to **true** in the manifest, where the host op defaults to false. | A tool call that sends a passphrase means to press Enter; a raw write is the exception. |
| 4.2: `busy-quiet` after 20 s | After 5 s (`BUSY_QUIET_MS`). The 20 s in the plan's example sentence was the example, not the constant. | Long enough that a compile between files does not flicker, short enough that a wedged command is visible. |
| 4.2: `unframed` is a state | It is, and it **outranks** `idle`: an unframed session says `unframed` whether or not it is busy with the package's own command. | There is no mark that says a prompt is up, so `idle` would be a guess. |
| 4.2: seven words | Seven, and a row for a word the page does not know: `the workspace calls this "<word>", which this page does not know`. | A newer service must not be able to make the page lie. |
| 4.3: about 280 KiB of JS and 5 KiB of CSS | `@xterm/xterm` 6.0.0: 337 KiB of JS, 7 KiB of CSS, `lib/xterm.mjs` vendored as `xterm.js` because `/ext/` serves `.js`. | Measured, not estimated. |
| 6: the key `enabled` | Not read. The keys are `shell`, `sessions`, `bufferBytes`, `idleMinutes`, and `waitMs`, which the plan did not have. | A setting that only records an intention is a trap: a person who should not have a terminal does not have the package installed, which is real state. `waitMs` makes the one number the model pays for most configurable. |
| 7: the socket is inside the userspace | Also `0600` on the socket itself. The `run/` directory is left at the mode it already has. | Tightening `run/` to `0700` would take `run/web.sock` away from the door, whichever service started second. |
| — | Every call carries a `consumer`, a cursor key. A key starting `ui:` is a browser. | It is what tells `person` from `busy` without the caller claiming it, and it is why an agent's answer is capped and a browser's is not. |

Phase 4, and what the browser found (2026-09-16, later the same day):

- `@thetis/terminal` is in `config.systemPackages["*"]`, after `@thetis/tools-plan`.
- `BROWSER.md` has steps 53 to 61: the chip, a shell opened from the page, colour, a person's command and
  its interrupt, the agent's command watched live through `busy` into `busy-quiet`, the alternate screen,
  a deferred resize, a closed session that keeps its transcript, and a workspace that stops answering.
- `exec` is deleted from `@thetis/tool-exec`, which keeps its other five tools, its name, and
  `@thetis/lib/pkg-fs`. `tool-recall@1`'s gold named `tool-exec/exec` for one task, `tr-build` ("Build the
  project and tell me whether it compiles"); that capability moved packages, so the entry now names
  `terminal/shell`. No task was added: writing gold for one's own package is how a suite stops measuring.

**The gate of 3.4 could not be run as written, and the plan was wrong about why.** `tool-recall@1` does not
measure whether the model picks the right tool. Its own description says so: every installed tool is
attached to every query, so recall is one by construction and the number worth reading is the waste. What
the run says instead, per task: `@thetis/terminal` costs 3,523 bytes of tool schema for five tools and
3,429.8 wasted bytes, against 1,715 and 1,638.5 for `@thetis/tool-exec`'s remaining five — the terminal is
the more expensive package to attach, and in the same range as its peers (`tools-plan` 4,460,
`tools-files` 5,644). There is no evidence here for folding five tools into three, and none against it
either. Deciding that needs the end-to-end probe, roadmap item 7 in `docs/13-limitations-and-roadmap.md`.

Five defects the browser found, all fixed: the content security policy refused the emulator's runtime
stylesheet, so a terminal had no colour at all (a per-response style nonce now lets that one stylesheet
through and still refuses every other — `docs/15-web-gateway.md` section 8); the chip hid itself when no
shell was open, which put the button that opens the first shell out of reach; `ext.subscribe` reported a
lost stream only when the browser gave up retrying, so a dead workspace went on looking live; the
emulator's own stylesheet painted a black strip under the last row; and the message for a stream that
ended blamed the package for refusing it when the workspace had simply stopped answering.
