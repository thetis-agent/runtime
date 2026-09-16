# 24 Terminal

`@thetis/terminal` gives a person long-lived shell sessions inside their own fence. A session is a real pty running their shell. It keeps its working directory, its environment and its shell state between commands. Five tools let the model work in it. The shelf of the web gateway shows the same session live, and the person can type into it. Source: `packages/terminal`.

The package is `type: "tool"` with a `service` and a `ui`. It adds nothing to the kernel. It has no runtime dependency except the terminal emulator vendored under `ui/vendor/` (section 5.5).

It replaces the `exec` tool of `@thetis/tool-exec` ([20-tools.md](20-tools.md) section 3.2), which was deleted on 2026-09-16.

## 1. Where every part runs

| Part | Runs in | Function |
|---|---|---|
| The service, export `startTerminals` | The userspace agent process | Holds the session table. Spawns each shell. Pumps its output into a ring buffer. Listens on `<root>/run/term.sock`. Closes every session when the fence closes. |
| The five tools | The same process | `shell`, `shell_read`, `shell_send`, `shell_interrupt`, `shell_sessions`. They reach the service over the socket. |
| The eight `ui` commands | The person's gateway process | `sessions`, `open`, `write`, `interrupt`, `resize`, `close`, `rename`, and the stream `watch`. They reach the same socket. |
| `ui/index.js`, `ui/shelf.js`, `ui/screen.js` | The browser page | The shelf entry `terminal`, the statusbar chip, and one live subscription for the whole page. |

A service starts with the fence and stops with it ([05-packages.md](05-packages.md) section 13). A `ui` command runs in the **gateway** process, not in the agent process ([15-web-gateway.md](15-web-gateway.md) section 11.4). Two processes, one fence, one filesystem.

### 1.1 The socket, and why module state cannot replace it

The two processes cannot share a variable. Module state does not serve even inside one of them: both the agent and the gateway import a package's `main` as a file URL with a modification-time query, so a reinstall hands a tool a different module instance from the one the service is running in. A unix socket under the userspace root is the only place the two can meet. `@thetis/gateway-web` already listens on `run/web.sock`, so the pattern and its permissions are proven ([03-fence.md](03-fence.md) section 3.8).

The socket is `<root>/run/term.sock`, mode `0600`. The service removes a stale one before it listens and removes its own when it stops. It takes no user argument, as the operator channel does not: the socket is inside one person's userspace, so the only processes that can reach it are that person's own. The isolation is structural, not a check.

The protocol is newline-delimited JSON. A request is `{ i, op, ... }`. An answer is `{ i, ok: true, result }` or `{ i, ok: false, error }`, where `error` is the sentence the host threw. A connection that has subscribed also receives unsolicited event lines, which carry `ev` and no `i`. `lib/client.js` is the one client, used by the tools and by the `ui` commands. When nothing is listening it says so in words a person can act on: the terminal service is not running in this workspace, so either the fence is still opening or the package is not installed for this person.

| Op | Arguments | Answer |
|---|---|---|
| `list` | `conversation?` | Every session's state, or only that conversation's. |
| `open` | `name?`, `cwd?`, `conversation?` | The new session's state. |
| `run` | `id?`, `conversation?`, `cmd`, `cwd?`, `timeoutMs?`, `background?`, `consumer?` | The command's answer (section 4.1) with `id`, `name` and the session's state. |
| `read` | `id`, `consumer?`, `waitMs?` | What arrived since that consumer last looked. |
| `write` | `id`, `text`, `submit?`, `settleMs?`, `consumer?` | What arrived in the settle after the write. |
| `interrupt` | `id`, `consumer?` | The same, after the interrupt character. |
| `resize` | `id`, `rows`, `cols` | `{ applied, deferred, rows, cols, reason? }`. |
| `close` | `id` | The closed session's state. |
| `rename` | `id`, `name` | The renamed session's state. |
| `subscribe` | `from?`, `consumer?` | `{ sessions }`, then events on this connection. |

`consumer` is a cursor key (section 3). A key that starts with `ui:` is a browser: its answers are not capped, because it is streaming the same bytes anyway, and a `write` from it is the person's typing rather than the agent's. Every other key is an agent's. Who typed is read from that key and never claimed by the caller.

Without an `id`, `run` uses the conversation's `main` session and opens it if there is none. Session names are `main` for the first session of a conversation, then `2`, `3`, and so on.

## 2. The session model

### 2.1 A pty, not pipes

The shell runs under `script -qfc "<shell>" /dev/null`. `script` is util-linux and is on the read-only `/usr` every fence gets; the fence's `--dev /dev` gives it `/dev/pts` and `/dev/ptmx` ([03-fence.md](03-fence.md) section 3.6). That gives a real terminal: line editing, job control, colour, and programs that behave as they do for a person. `TERM` is `xterm-256color`. A new pty is 24 rows by 120 columns.

The part no pipe can give is the interrupt. `shell_interrupt` writes one `0x03` to the pty. The line discipline delivers SIGINT to the **foreground process group only**, so the runaway dies and the shell that owns the session lives.

### 2.2 The marks that frame a command

A shell's output is one stream that never ends, so the only way to know where one command's output stops is to have the shell say so. The package writes a per-session bash init file, `<root>/run/term-<id>.rc`, mode `0600`, deleted when the session closes, and starts the shell as `<shell> --rcfile <that file> -i`. The file sets the pty size, sources the person's own `~/.bashrc` when it is readable, and then wraps the prompt. `PROMPT_COMMAND` is appended to, never replaced: one function goes on the front to capture `$?` before the person's own hook can clobber it, and one on the back to emit the marks, with the person's hook in between. Both of bash's shapes for `PROMPT_COMMAND`, the string and the array, are handled.

The marks are the escapes every modern terminal already uses for this.

| Mark | Escape | Says |
|---|---|---|
| Prompt start | `OSC 133;A` | A prompt is being drawn. |
| Command start | `OSC 133;B` | The prompt ended; what follows is the command line. |
| Command executed | `OSC 133;C` | Parsed, no effect here. |
| Command finished | `OSC 133;D;<status>` | The command ended with this exit status. |
| Working directory | `OSC 7;file://<host><path>` | The directory is now this. Emitted **before** the finish mark, so a reader waiting on the finish has it. |
| Alternate screen | `CSI ?1049h` / `CSI ?1049l` | A full-screen program took the terminal, or gave it back. |

`lib/marks.js` parses them back out. Two rules shape the parser. It never modifies the stream, so the marks stay in the bytes the browser's emulator consumes; only the text handed to the agent is cleaned. And it is strict: a candidate is a mark only when its whole body matches a shape the package emits, so an escape a program printed itself is not read as one. An escape split across two chunks is held until the rest arrives. An OSC body over 4096 characters or a CSI over 64 is abandoned as not one of ours.

Three things follow.

1. **Every command is framed, not only the agent's.** The prompt emits the marks whoever typed the command.
2. **The framing is invisible.** An OSC escape is consumed by the emulator, so the person's transcript stays clean. The agent's text has the escapes, the prompt region between the prompt-start and command-start marks, and the echo of the command the package itself wrote cut out of it.
3. **Busy and idle are observed, not guessed.** A session is running a command because a submit went in through this package and no finish mark has come back out. It is idle because the marks say a prompt is up. An exit status is reported only when a mark carried it.

Nothing is written into the gap between a command ending and the next prompt appearing: the shell is still running `PROMPT_COMMAND` there, and a command written into that gap is echoed twice.

### 2.3 What an unframed shell degrades to

A shell that is not bash gets no init file. `--rcfile` is bash's spelling, and guessing another shell's would be a way to break a person's login shell rather than to frame it. A bash whose rc fights the prompt hard enough is the same case. Either way the session is **unframed**, and it says so rather than pretending.

An unframed session is run the way the legacy host ran every command: `; printf '%s\t%s\t%s\n' '__thetis_mark_<id>__' "$?" "$PWD"` is appended to the command line the package sends, and the marker line it prints is found in the text and cut out of what the agent is handed. So an unframed session still reports the exit status and the working directory of **the commands the package sent**, and claims nothing at all about a command the person typed. Its state word stays `unframed` even when it is idle, because there is no mark that says a prompt is up.

A new session is given 2000 milliseconds to prove it carries the marks before the first command is written. Only a shell that never will pays that in full.

## 3. One ring buffer, many cursors

Each session holds a ring of the last 262144 characters of output and a counter that only goes up. Every consumer holds an offset into that counter: the agent one per session, each open browser one. **Nothing consumes.** A read moves that consumer's cursor and no one else's.

A consumer the session has never seen starts at the oldest character still held, so its first read is everything that survives rather than nothing.

A consumer whose offset has fallen off the back of the ring is told. Every answer carries `dropped`, the number of characters that consumer lost between where it was and the oldest character still held. It is never handed a hole in silence. Ring buffers lie by default; this one is made to say so.

The buffer itself is never edited. The bytes in it are the bytes the person's emulator gets, marks and all. The text handed to the agent is a cleaned copy: the escapes removed, a carriage return taken as an overwrite so a progress bar collapses to its last state, the remaining control characters dropped, and the hidden regions cut out — the prompt, the echo of the command, the marker line of an unframed shell, and any command this package sent for its own reasons, such as the `stty` of a resize.

Two numbers are called `dropped` and they are not the same. In an answer it is what **that consumer** lost. In a session's state, which is what the shelf row draws from, it is the ring's own floor: how much the ring has thrown away since the session opened.

## 4. The five tools

The session a tool works in is this conversation's own, opened by the first call that needs one. There is no `terminal_open`: a tool call that only prepares to work is a call the model pays for twice.

| Tool | Arguments | In the ordinary case | In the unhappy ones |
|---|---|---|---|
| `shell` | `cmd`, `session?`, `cwd?`, `timeoutMs?`, `background?` | Runs the command and waits for the finish mark. The exit status, what it printed, and a note when the working directory moved. | An empty `cmd` is refused. A command still running when the wait runs out is **not killed**: the answer says it is still running and `shell_read` collects the rest. `background: true` asks for that on purpose and answers after 400 ms. A `cwd` that cannot be entered is the whole answer, and the command is not run. A session already busy is refused with what to do: collect with `shell_read`, answer with `shell_send`, or stop with `shell_interrupt`. A closed session is refused by name. |
| `shell_read` | `session?`, `waitMs?` | What arrived since this conversation's last read, and whether the command has finished and with what status. | Waits for something new, or for a running command to end, whichever comes first, then answers; `waitMs` defaults to 0. A session that does not exist is refused by name, with `shell_sessions` as the way to see the open ones. |
| `shell_send` | `text`, `session?`, `submit?` | Writes raw input — a passphrase, a `y`, a commit message, a line for a REPL — and answers with whatever the session printed in the 400 ms after. | `text` is required; it may be empty with `submit` to send a bare newline. On a framed shell a submit starts a command and the session knows whose. On an unframed one nothing is claimed, because there is no mark to say when it ended. |
| `shell_interrupt` | `session?` | Writes the interrupt character, waits 400 ms, and answers with what the shell printed. The command ends; the session lives. | Nothing to interrupt is not an error: the answer is the settle's output and the session's state. |
| `shell_sessions` | `close?` | This conversation's sessions: the name, where each one is, what it is busy with and for how long, and whether the person is watching. The host answers each session's whole state, the same record the shelf draws a row from. | `close` closes that session instead of listing. A name that does not exist is refused by name. |

Two facts are in the tool descriptions because the model cannot deduce either: the session is **shared with the person, who can see it and type in it**, and the file tools are the cheaper and safer way to read or change a file ([20-tools.md](20-tools.md) section 2). What the person typed reaches the model only as output in its next read. It is never pushed into the prompt.

### 4.1 The fields behind an answer

A `run`, `read`, `write` or `interrupt` answers with these. The tools render them.

| Field | Meaning |
|---|---|
| `output` | The cleaned text since this consumer's cursor, capped at 30000 characters for an agent. |
| `exit` | The status the finish mark carried, or `null` while the command is still running. Never guessed. |
| `running` | Whether a command is still out. |
| `cwd`, `moved` | Where the session is now, and whether this call moved it. |
| `dropped` | How many characters this consumer lost off the back of the ring. |
| `id`, `name`, `session` | Which session answered, and its whole state. |

The cap keeps the head and the tail and says how much of the middle is missing: `...[N characters not shown; the middle of the output]...`. A truncation that does not say so is the same failure as a ring buffer that hands over a hole. A browser's answer is not capped, because it is streaming the same bytes anyway.

## 5. The shelf

The package declares `shelf: [{ "id": "terminal", "label": "Terminals" }]` and `statusbar: [{ "id": "terminal", "order": 100 }]` ([15-web-gateway.md](15-web-gateway.md) section 11.1). The shelf is the bottom dock: it shortens the conversation rather than covering it. Its stylesheet is scoped under `.tm-`.

The page holds one `watch` subscription for the whole page, opened by `ui/index.js` at install and never stopped while the page lives ([15-web-gateway.md](15-web-gateway.md) section 11.5). It is one subscription and not one per view, because the chip counts shells while the shelf is closed and a screen keeps filling while nobody is looking, so opening the shelf must cost no request. Every value is written to be replayed: an output chunk carries the session's counter, and a chunk at or below the counter the page has already written is dropped, so a reconnect costs nothing and loses nothing.

The shelf opens by itself the first time a session in the open conversation starts a command, once per page load. It never takes the focus from the composer. A person who closes it is not reopened.

### 5.1 The state words

The state word is computed on the server, in one word, and this page only says it in plain words and offers the repair. Nothing in the page derives a state from output, from a clock or from a command line, so the page, the prompt and the command line cannot disagree.

| State | The row says | The row offers |
|---|---|---|
| `idle` | the working directory, with the home shown as `~`, or `no working directory` | Close |
| `busy` | `the agent is running cargo test · 14s` | Interrupt |
| `busy-quiet` | `running cargo test · no output for 20s` | Interrupt |
| `person` | `you are running vim` | Interrupt |
| `fullscreen` | `a full-screen program has the terminal` | Interrupt |
| `unframed` | `this shell does not report exit codes` | — |
| `closed` | `closed · exit 130`, or `closed` when no status was carried | Reopen |

The command in those sentences is the command line as it was submitted, whatever it is, or `a command` when the session has none recorded. `busy` names who holds the prompt and `busy-quiet` does not. The clock reads `14s` under a minute, `3m 20s` under an hour, and `2h 05m` above it. A word this page does not know reads `the workspace calls this "<word>", which this page does not know` and offers nothing, so a newer service cannot make the page lie.

The order the service resolves them in is closed, fullscreen, person, busy or busy-quiet, unframed, idle. A running command that has printed nothing for 5000 milliseconds is `busy-quiet` rather than `busy`.

Seven words, and no eighth. There is no `waiting` for a command that has stopped at a prompt: there is no way to know that without guessing what a program meant by printing nothing, and a guessed state is the thing this design is against. `busy-quiet` says what is observed and the person decides what it means.

### 5.2 What is a fact about a row, not a state

A fact can be true of an idle session as much as a busy one, so it is a line under the row and never a word in it.

| Line | When |
|---|---|
| `some output was dropped` | The session's ring has thrown something away. |
| `opened by "<conversation title>"`, or `opened by another conversation` | The session belongs to a conversation other than the open one. |
| `the program now running keeps the old size; the next one starts at this one` | A resize was deferred (section 7). |
| `the shell was not told the new size: <reason>` | The resize was refused. |

### 5.3 The head, the pane and the chip

The head carries one sentence when a row is running something or is closed — `2 of 3 shells are running something. 1 is closed.` — a **Reconnect** button that appears only when the stream is not live, and a **+** that opens a shell in the open conversation. When the stream is down the head says `Not live: <reason>. What the rows say may be out of date.`, and the page retries by itself after a second, doubling to thirty.

The pane on the right holds the chosen session's screen. A session with no screen yet says `This shell has printed nothing yet.`; no session at all says `No shell is open. The + above opens one in this conversation.`; a closed one repeats its row's sentence and says to reopen it from its row.

**The input is always enabled, including while the agent holds the prompt.** That is how a person answers the question the agent's command asked. When the agent holds it the pane says `What you type reaches the agent's command: <command>.` A terminal that quietly swallows keystrokes is a failure; one that quietly redirects them would be worse. Keystrokes are held for 15 milliseconds so a paste is one request, and sent one batch at a time so they arrive in the order they were typed. A batch the gateway did not take is said out loud in the corner, never dropped in silence.

The statusbar chip reads `2 shells · 1 busy` and opens the shelf. It is hidden when there are no shells and the stream is live, because then there is nothing to say. When the stream is down with no shells it reads `shells · not connected`.

### 5.4 Renaming

A row's name is a button; clicking it makes it an input. Enter renames, Escape cancels, and a redraw while a name is being typed is held back so the field is not taken away mid-word. A person can rename a session. The model cannot.

### 5.5 The emulator

`ui/screen.js` is the only file in the package that names the emulator. Everything else speaks of a screen: a thing with an element, that takes bytes and gives back keystrokes.

The emulator is `@xterm/xterm` 6.0.0, MIT, vendored under `ui/vendor/` with its `LICENSE`. It is the first third-party runtime file in the repository, about 337 KiB of JavaScript and 7 KiB of CSS. It is imported lazily by the first session that appears, so a person who never opens a shell never fetches it. `/ext/` serves `.js` and `.css` already ([15-web-gateway.md](15-web-gateway.md) section 11.3), which is why `lib/xterm.mjs` is vendored under the name `xterm.js`.

The reason for vendoring rather than writing one: the terminal is writable, so `less`, `git rebase -i`, `htop` and `vim` are things people will run in it, and every hand-rolled attempt at an emulator turns a build log into a screenful of escape soup. The colours are read from the page's own variables, so a terminal looks like the page it sits in, in whichever scheme is in force. An emulator that fails to load is said in the pane, and the row still works: the shell is still running and the tools still reach it.

The screen belongs to the session, not to the view. Closing the shelf takes the element out of the page and leaves the emulator and its scrollback alone, so opening it again costs no request and loses no output. A closed session keeps no screen.

## 6. Limits and configuration

Every constant is in `packages/terminal/lib/host.js` and `packages/terminal/lib/session.js`, and `test/host.test.js` holds the first three to these values.

| Limit | Value | Configurable |
|---|---|---|
| Sessions per person | 8 | `sessions` |
| Ring buffer per session | 262144 characters | `bufferBytes` |
| One agent answer | 30000 characters, head and tail kept | — |
| Default wait for `shell` | 120000 milliseconds | `waitMs` |
| Idle close | 30 minutes | `idleMinutes` |
| Closed sessions kept on the list | 4 | — |
| Idle reaper interval | 30000 milliseconds, or the idle time when that is shorter, never under 250 | — |
| `busy` becomes `busy-quiet` | 5000 milliseconds with no output | — |
| Settle after `shell_send` and after an interrupt | 400 milliseconds | — |
| Grace for a new session to prove it is framed | 2000 milliseconds | — |
| Wait for the prompt before writing the next command | 2000 milliseconds | — |
| Wait for a `cwd` change | 5000 milliseconds | — |
| Wait for the `stty` of a resize | 1000 milliseconds | — |
| Grace for a finish mark that arrived after its output | 50 milliseconds | — |
| Between SIGTERM and SIGKILL on close | 300 milliseconds | — |
| A new pty | 24 rows, 120 columns | — |
| OSC body, CSI | 4096 and 64 characters before a candidate is abandoned | — |

The counted unit of the buffer is characters of the decoded stream, not raw bytes: the stream is decoded once on arrival, so a multi-byte character can never be split by a cursor.

`config.packages["@thetis/terminal"]`, all optional, read in `startHost` and nowhere else ([09-configuration.md](09-configuration.md) section 4):

| Key | Default | Meaning |
|---|---|---|
| `shell` | `/bin/bash` | The program the pty runs. Anything but bash runs unframed (section 2.3). |
| `sessions` | `8` | Open sessions per person. The refusal names the limit and says to close one. |
| `bufferBytes` | `262144` | The ring buffer per session. |
| `idleMinutes` | `30` | Close a session after this long with no attached browser and nothing running. `0` disables the reaper. |
| `waitMs` | `120000` | The default wait of `shell`, when the call names no `timeoutMs`. |

The configuration is per person, because `config.packages` is read per fence. There is no `enabled` key: a person who should not have a terminal does not have the package installed.

The idle reaper closes a session only when nothing is running, no browser is watching, and nothing has happened in it — no output, no write, no read, no browser attaching or leaving — for the whole idle time. The watcher count is the number of browsers subscribed to this workspace's stream, not to one session, so one open page keeps every session alive.

## 7. What it deliberately cannot do

| Not done | Why |
|---|---|
| Remote sessions over ssh, and a host registry | That crosses the fence's egress policy and its authority model, and is a feature in its own right rather than part of a terminal. A person who wants it runs `ssh` inside a session. |
| A session that survives the fence closing | A `mounts.set`, a reinstall or a daemon restart closes the fence, and everything in it stops. Reattaching would mean a process outside the fence holding a shell inside it, which inverts the model. The shelf says the session closed and with what status, and offers to open a new one with the same name in the same directory. |
| A session shared between two people | A session lives in one fence. Two people are two fences. |
| A transcript on disk, or one kept across reloads | Section 8. A reconnecting browser gets the ring buffer, which is the last screenful and a bit, and is told when that is not the whole story. |
| A shell as the way to read and edit files | The file tools are cheaper and safer, and the tool descriptions say so ([20-tools.md](20-tools.md) section 2). |

**Resize, and the one honest limitation.** Node cannot set a pty's window size without a native module, and this repository has no third-party runtime dependency outside the vendored emulator. So a resize is an `stty rows R cols C` written on the session's own tty, which can only be done when nothing is running. A resize asked for while a command is running is deferred to the next prompt and answers `applied: false` with the reason, and the shelf puts that in the row. The consequence, said in the page rather than hidden: **a full-screen program that is already running keeps its old size.** It learns the new one when it next starts. Everything else — wrapping, `less`, a new `vim` — is correct. The `stty` the package sends for its own reasons is hidden from the agent's transcript.

### 7.1 A cancelled turn does not kill the command

Stopping a turn stops the turn. The command it started keeps running in the session, because the session
outlives the turn and nothing in the fence tells a running shell that the conversation lost interest.

This differs from `exec`, where every call was its own child process and stopping the turn took the
process with it. The consequence is visible rather than hidden: the next `shell` call in that conversation
lands on the same session and is refused, naming the command that holds it and the three ways out —
`shell_read` to collect it, `shell_send` to answer it, `shell_interrupt` to end it. A person watching the
shelf sees the row still running, with Interrupt in it.

The alternative would be to kill whatever is running whenever a person presses Stop, which would throw
away a build that was nearly done because someone stopped the model from talking about it.

## 8. Security

| Question | Answer |
|---|---|
| What can the shell reach? | Exactly what the fence can: the home read and write, the shared directory read only, and each mount with the mode it was granted. This is the same reach `@thetis/tools-files` computes with a path check, but here it is structural — bubblewrap, not a check in a tool ([12-security.md](12-security.md) sections 2 and 10). |
| Is a writable browser terminal an escalation? | No. A person who can open their gateway can already run any command in that fence through the agent's tools. It is a new path to authority the person already had, not a new authority, so it is guarded the same way: the login cookie, the door's routing of `/<person>/` to that person's gateway, the person's own fence, and the declared role of each command — any signed-in person, for their own sessions only ([15-web-gateway.md](15-web-gateway.md) section 11.6). |
| Can an admin's terminal reach the host? | No more than their fence does. An admin's authority over the host is the operator channel, which the kernel checks per call. A shell in their fence is still in a fence. |
| Where does the transcript live? | In the agent process's memory, and nowhere else. It is not written to disk and not sent to the journal. A shell transcript holds whatever was pasted into it, and a passphrase typed into a session must not outlive it. The service writes one line to the agent's log when a session opens and one when it closes, with no command text. The journal gets nothing. |
| Egress? | The fence's. A session inherits the private network namespace and the egress the fence was given. It has no path the agent does not have. |
| The socket? | `<root>/run/term.sock`, mode `0600`, inside the userspace, so only that fence's processes can see it. It takes no user argument, as the operator channel does not. |
| The stream? | `GET /api/ext/@thetis/terminal/watch/stream`, guarded as `/api/events` is. `Sec-Fetch-Site` does not apply to it, because an `EventSource` sends no header and the browser refuses a cross-origin one before the gateway sees it. See [12-security.md](12-security.md) section 5 and [15-web-gateway.md](15-web-gateway.md) section 11.5. |

## 9. Tests

`packages/terminal/test/*.test.js`, plain `node --test` files that spawn real shells, run by the root `npm test`:

| File | Content |
|---|---|
| `marks.test.js` | The parser: each mark with its offsets, a finish with no status, the working directory with its host and path apart and a percent-encoded path, BEL and ST terminators, an escape split across two chunks and one split a character at a time, the escapes a program prints itself that must not be read as marks, the alternate screen both ways. The init file: the four marks, the person's rc sourced, `PROMPT_COMMAND` appended to in both of bash's shapes, a quoted rc path. The legacy marker: the status and directory it reports, that it is not found in the echo of the command carrying it, and the id made safe for a regular expression. |
| `session.test.js` | The exit status the shell reported, a `cd` carried to the next command, a `cwd` that does not exist as the whole answer, a command that outruns its wait and is collected later, a second command refused while one is out, an interrupt that leaves the session alive, a ring that drops and says so, an unframed shell that reports only its own commands, each state word, a command the person typed making the session theirs, a full-screen program taking the terminal and giving it back, a deferred resize applied at the next idle, a resize at idle hidden from the agent, independent cursors, the raw buffer keeping the marks the agent's text lost, a closed session refusing to be written to, and a subscriber seeing output with the offset it arrived at. |
| `host.test.js` | The socket path and its mode, a command over the socket, the names `main`, `2`, `3`, the session limit and its refusal, `list` scoped to a conversation, a session and an op refused by name, two consumers with independent cursors, a subscriber's snapshot and its events, a replay from an offset, the watcher count, the idle reaper with and without a browser attached, closing the host closing every session, the wording when nothing is listening, rename, who typed read from the cursor key, a deferred resize, the answer cap, and that an agent's answer is capped where a browser's is not. |

The gateway's own suite covers the seam this package is the first to use: a streaming verb that yields and ends, a browser that lets go aborting the export, the two refusals that keep a command and a stream apart, and the style nonce that the page and the policy must agree on.

There is no automated test of the browser side itself. It is checked by hand, with steps 53 to 61 of `packages/gateway-web/test/BROWSER.md`, which walk the chip, colour, a person's command and its interrupt, the agent's command watched live, a full-screen program, a deferred resize, a closed session that keeps its transcript, and a workspace that stops answering.
