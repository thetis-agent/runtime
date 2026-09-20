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
| `ui/index.js`, `ui/shelf.js`, `ui/screen.js` | The browser page | The shelf entry `terminal`, the chat-bar chip, and one live subscription for the whole page. |

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

A shell's output is one stream that never ends, so the only way to know where one command's output stops is to have the shell say so. The package writes a per-session bash init file, `<root>/run/term-<id>.rc`, mode `0600`, deleted when the session closes, and starts the shell as `<shell> --rcfile <that file> -i`. The file sets the pty size, reports the shell's own tty path once (section 7), sources the person's own `~/.bashrc` when it is readable, and then wraps the prompt. `PROMPT_COMMAND` is appended to, never replaced: one function goes on the front to capture `$?` before the person's own hook can clobber it, and one on the back to emit the marks, with the person's hook in between. Both of bash's shapes for `PROMPT_COMMAND`, the string and the array, are handled.

The marks are the escapes every modern terminal already uses for this.

| Mark | Escape | Says |
|---|---|---|
| Prompt start | `OSC 133;A` | A prompt is being drawn. |
| Command start | `OSC 133;B` | The prompt ended; what follows is the command line. |
| Command executed | `OSC 133;C` | Parsed, no effect here. |
| Command finished | `OSC 133;D;<status>` | The command ended with this exit status. |
| Working directory | `OSC 7;file://<host><path>` | The directory is now this. Emitted **before** the finish mark, so a reader waiting on the finish has it. |
| Alternate screen | `CSI ?1049h` / `CSI ?1049l` | A full-screen program took the terminal, or gave it back. |
| The shell's tty | `OSC 7770;tty=<path>` | Emitted once by the init file, before the prompt is wrapped. Only `/dev/pts/N` and `/dev/tty*` are believed; the session keeps the path as `tty` in its state, and a resize is an `stty -F` on it. 7770 is a private number no emulator knows, so the emulator drops it. It is not proof that the shell is framed: only the prompt marks are. |

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

The buffer itself is never edited. The bytes in it are the bytes the person's emulator gets, marks and all. The text handed to the agent is a cleaned copy: the escapes removed, a carriage return taken as an overwrite so a progress bar collapses to its last state, the remaining control characters dropped, and the hidden regions cut out — the prompt, the echo of the command, the marker line of an unframed shell, and any command this package sent for its own reasons, which is the typed `stty` of a fallback resize (section 7) and nothing else.

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

## 5. The drawer

The package declares `shelf: [{ "id": "terminal", "label": "Terminals" }]` and `chips: [{ "id": "terminal", "order": 50 }]` ([15-web-gateway.md](15-web-gateway.md) section 11.1). The shelf is the bottom dock under the conversation, and its chrome is the legacy terminal drawer's: it shortens the transcript rather than covering it, animates up when it opens, has a grip to drag its height (300px by default, 140px at least, 72% of the window at most, remembered in `localStorage` under `thetis.shelf.height`), a head with the uppercase title, the package's buttons (**+** opens a shell in the open conversation, the eraser clears the chosen view), collapse and hide. Everything under the head is this package's, scoped under `.term-`, on the `--term-*` tokens of `theme.css`: the terminal is a dark device set into the page in both colour schemes, its greys a touch warmer than the app's, and inside it green is the accent.

The page holds one `watch` subscription for the whole page, opened by `ui/index.js` at install and never stopped while the page lives ([15-web-gateway.md](15-web-gateway.md) section 11.5). It is one subscription and not one per view, because the chip counts shells while the drawer is closed and a screen keeps filling while nobody is looking, so opening the drawer must cost no request. Every value is written to be replayed: an output chunk carries the session's counter, and a chunk at or below the counter the page has already written is dropped, so a reconnect costs nothing and loses nothing.

Two rules decide when the drawer is up. A shell appearing in the open conversation opens it, every time, without a click, and a shell of another conversation opens nothing. Switching conversations closes it and reopens it at once when the new conversation has shells; the chosen row follows to that conversation's first shell. The chip in the chat bar toggles it by hand. Nothing here takes the focus from the composer.

### 5.1 The body

```
div.term-body
├── div.term-panes                   the emulator, first in the DOM
│   └── div.term-pane                the chosen session's screen
└── nav.term-list                    one row per session
    ├── div.term-tab[.is-active][.has-activity][.is-elsewhere][data-id]
    │   ├── button.term-tab-pick     span.term-dot · span.term-tab-label · span.term-tab-sub · span.term-tab-note
    │   ├── button.term-tab-stop     while busy: the interrupt
    │   ├── button.term-tab-info     the details card
    │   └── button.term-tab-kill     close (a popover), or remove a closed row
    └── span.term-empty
div.term-foot                        span.term-cwd · span.term-meta
```

Rows are sorted by conversation — the open conversation's shells and the person's own first, then the rest, which carry `.is-elsewhere` and name their conversation in the sub line — and then by name with numeric collation. The label is the name, or the id when it has none; the sub line is the last segment of the working directory; a closed row says `exited`. The dot is the state: busy (`busy`, `busy-quiet`, `person`, `fullscreen`) pulses in `--term-yellow`, `idle` and `unframed` are `--term-bright-green`, `closed` is `--term-bright-black`. Output arriving in a row that is not chosen makes it `.has-activity` (the label bold and bright) until it is chosen; a replay of the ring buffer is not activity. The chosen row wears the terminal's green wash and a left edge. A second shell appearing does not steal the view: its row brightens instead.

Clicking a row chooses it and focuses the emulator. Double-clicking the label renames: the input takes the label's place, Enter keeps, Escape or leaving the field drops, and a redraw while a name is being typed is held back. A person can rename a session; the model cannot.

The footer carries the chosen shell's full working directory, with the home shown as `~`, and one sentence: `<shell> · <state>`.

| State | The footer says |
|---|---|
| `idle` | `bash · idle` |
| `busy` | `bash · the agent is running cargo test · 14s`, the clock ticking once a second |
| `busy-quiet` | `bash · running cargo test · no output for 20s` |
| `person` | `bash · you are running vim` |
| `fullscreen` | `bash · a full-screen program has the terminal` |
| `unframed` | `shell · this shell does not report exit codes` |
| `closed` | `bash · closed · exit 130`, or `closed` when no status was carried |

The state word is computed on the server, in one word, and this page only says it in plain words and offers the repair. Nothing in the page derives a state from output, from a clock or from a command line, so the page, the prompt and the command line cannot disagree. The command in those sentences is the command line as it was submitted, or `a command` when the session has none recorded. The clock reads `14s` under a minute, `3m 20s` under an hour, and `2h 05m` above it. A word this page does not know reads `the workspace calls this "<word>", which this page does not know`, so a newer service cannot make the page lie. The order the service resolves them in is closed, fullscreen, person, busy or busy-quiet, unframed, idle; a running command that has printed nothing for 5000 milliseconds is `busy-quiet`. Seven words, and no eighth: there is no `waiting` for a command that has stopped at a prompt, because that would be a guess about what a program meant by printing nothing.

When a resize could not be applied to the device (section 7, the typed fallback) the footer adds `size applies at the next prompt`; when the gateway refused it, `the shell was not told the new size: <reason>`. When the stream is not live the footer says `not live: <reason>` in the warning tone with a **Reconnect** link beside it, and the page retries by itself after a second, doubling to thirty; the chip turns `.is-stale`.

### 5.2 The row's controls

The stop square on a busy row is the deliberate Ctrl-C: `interrupt`, delivered to the foreground process group, so the runaway dies and the shell lives. The info button opens the details card, `.term-card`, placed left of the list: Name, Session id, Working directory, Conversation (its title, or `opened by you` for a shell opened from the drawer with no conversation), Shell, State, Command and Running since while it runs, Last exit, Terminal (the pty device the shell reported, or `not reported`), Reports exit codes. Its foot says `What you type here goes to the shell.` A second click on the same button closes it; so do Escape and a click outside; a redraw re-anchors it rather than dismissing it, because a busy shell redraws the list on every command. The trash on a live row opens the popover `Close <name>?` with the consequence spelled out — the shell in that directory and everything it is running will be terminated, and the agent may be using it — and a **Close** button in the error tone; Escape or a click outside cancels. On a closed row the trash removes it from this page's list without asking: the host keeps its record, and the row is back after a reload until the host drops it.

### 5.3 The chip

Every conversation pane's chat bar carries the chip (`.chip.term-chip` in `.chips`): a dot and `N terminals` for the shells of that conversation plus the person's own, or `Terminal` when there are none. It is never hidden, because the button that opens the first shell is inside the drawer and the chip is the way in. The dot pulses in the warning colour while any of them is busy, is green while any is alive, and grey when none is. `.is-on` while the drawer is open; the title says which way the click goes. It lives in the app's chrome, so it keeps the app's colours.

### 5.4 Typing

**The input is always enabled, including while the agent holds the prompt.** That is how a person answers the question the agent's command asked. A terminal that quietly swallows keystrokes is a failure; one that quietly redirects them would be worse. Keystrokes are held for 15 milliseconds so a paste is one request, and sent one batch at a time so they arrive in the order they were typed. A batch the gateway did not take is said out loud in the corner, never dropped in silence. A closed session keeps its picture and stops taking keys: the cursor stops blinking.

### 5.5 The emulator

`ui/screen.js` is the only file in the package that names the emulator. Everything else speaks of a screen: a thing with an element, that takes bytes and gives back keystrokes.

The emulator is `@xterm/xterm` 6.0.0, MIT, vendored under `ui/vendor/` with its `LICENSE`. It is the first third-party runtime file in the repository, about 337 KiB of JavaScript and 7 KiB of CSS. It is imported lazily by the first session that appears, so a person who never opens a shell never fetches it. `/ext/` serves `.js` and `.css` already ([15-web-gateway.md](15-web-gateway.md) section 11.3), which is why `lib/xterm.mjs` is vendored under the name `xterm.js`.

The reason for vendoring rather than writing one: the terminal is writable, so `less`, `git rebase -i`, `htop` and `vim` are things people will run in it, and every hand-rolled attempt at an emulator turns a build log into a screenful of escape soup. The palette is the `--term-*` tokens read back through `getComputedStyle` — every one a plain hex literal, because the emulator parses real colours and a `color-mix()` would arrive unresolved — at 12.5px, a line height of 1.45, 5000 lines of scrollback, and a blinking cursor, since the terminal is writable. A cell is measured the way the emulator measures it, and the pane is divided by that cell; one `resize` is sent when the grid changed. An emulator that fails to load is said in the pane, and the row still works: the shell is still running and the tools still reach it.

The screen belongs to the session, not to the view. Hiding the drawer leaves the emulator and its scrollback alone, so showing it again costs no request and loses no output. A closed session keeps no new screen.

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
| A resize's `stty -F` on the device | 2000 milliseconds before it is given up and the fallback used | — |
| Wait for the typed `stty` of a fallback resize | 1000 milliseconds | — |
| Grace for a finish mark that arrived after its output | 50 milliseconds | — |
| Between SIGTERM and SIGKILL on close | 300 milliseconds | — |
| A new pty | 24 rows, 120 columns | — |
| OSC body, CSI | 4096 and 64 characters before a candidate is abandoned | — |

The counted unit of the buffer is characters of the decoded stream, not raw bytes: the stream is decoded once on arrival, so a multi-byte character can never be split by a cursor.

The configuration of `@thetis/terminal`, every key declared under `thetis.config` with a default, read in `startHost` and nowhere else ([09-configuration.md](09-configuration.md) section 4):

| Key | Default | Who sets it | Meaning |
|---|---|---|---|
| `shell` | `/bin/bash` | anyone, in their own layer | The program the pty runs. Anything but bash runs unframed (section 2.3). |
| `sessions` | `8` | admins only (`scope: "system"`) | Open sessions per person. The refusal names the limit and says to close one. |
| `bufferBytes` | `262144` | admins only (`scope: "system"`) | The ring buffer per session. |
| `idleMinutes` | `30` | admins only (`scope: "system"`) | Close a session after this long with no attached browser and nothing running. `0` disables the reaper. |
| `waitMs` | `120000` | anyone, in their own layer | The default wait of `shell`, when the call names no `timeoutMs`. |

The three limits are declared `scope: "system"`, so a person cannot raise them in their own layer: `configure_package`, **Configure** in the marketplace and `kernel.config.set` refuse them, and only an admin sets them at the system layer (`thetis config set @thetis/terminal sessions 16 --json`, or the Configuration section). `shell` and `waitMs` are a person's own. A change is live: the terminal's service restarts in place with the new values ([05-packages.md](05-packages.md) section 13), and every open shell session in it stops. There is no `enabled` key: a person who should not have a terminal does not have the package installed.

The idle reaper closes a session only when nothing is running, no browser is watching, and nothing has happened in it — no output, no write, no read, no browser attaching or leaving — for the whole idle time. The watcher count is the number of browsers subscribed to this workspace's stream, not to one session, so one open page keeps every session alive.

## 7. What it deliberately cannot do

| Not done | Why |
|---|---|
| Remote sessions over ssh, and a host registry | That crosses the fence's egress policy and its authority model, and is a feature in its own right rather than part of a terminal. A person who wants it runs `ssh` inside a session. |
| A session that survives the fence closing | A `mounts.set`, a reinstall or a daemon restart closes the fence, and everything in it stops. Reattaching would mean a process outside the fence holding a shell inside it, which inverts the model. The shelf says the session closed and with what status, and offers to open a new one with the same name in the same directory. |
| A session shared between two people | A session lives in one fence. Two people are two fences. |
| A transcript on disk, or one kept across reloads | Section 8. A reconnecting browser gets the ring buffer, which is the last screenful and a bit, and is told when that is not the whole story. |
| A shell as the way to read and edit files | The file tools are cheaper and safer, and the tool descriptions say so ([20-tools.md](20-tools.md) section 2). |

**Resize, and the one honest limitation.** Node cannot set a pty's window size without a native module, and this repository has no third-party runtime dependency outside the vendored emulator. But `stty` can, from outside the shell: the init file reports the shell's tty once (`OSC 7770`, section 2.2), and a resize is `stty -F /dev/pts/N rows R cols C` run as a sibling process of the service, with no shell involved. That is an ioctl on the device. Nothing is written into the pty, nothing is echoed, the kernel raises `SIGWINCH` in the foreground process group, and it works whether or not something is running: `vim`, `less` and `top` redraw at once, and a program in the middle of a `sleep` finds the new size when it wakes. Readline redraws its prompt in place when it gets the signal, as it does in any terminal. The answer is always `applied: true`, and `wantRows`/`wantCols` are kept so a reopen starts at the size. Inside a fence the service and the shell share the mount and pid namespaces, so `/dev/pts/N` is the same device for both.

The limitation is the fallback's. A shell that never reported its tty — one that is not bash and so ran no init file, or a bash still starting — is resized the old way: an `stty rows R cols C` typed at the prompt, which can only be done when nothing is running. Asked for during a command, it is deferred to the next prompt and answers `applied: false, deferred: true` with the reason, and the shelf puts that in the row; the program running now keeps its old size and the next one starts at the new one. The typed `stty` is a real command in a real shell: the person sees it, and it is hidden from the agent's transcript. An `stty -F` that fails (the device gone, `stty` missing) takes the same fallback and is logged, not raised.

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
| `marks.test.js` | The parser: each mark with its offsets, a finish with no status, the working directory with its host and path apart and a percent-encoded path, BEL and ST terminators, the shell's tty report as a mark with its path and one outside `/dev` ignored, an escape split across two chunks and one split a character at a time, the escapes a program prints itself that must not be read as marks, the alternate screen both ways. The init file: the four marks, the tty report line, the person's rc sourced, `PROMPT_COMMAND` appended to in both of bash's shapes, a quoted rc path. The legacy marker: the status and directory it reports, that it is not found in the echo of the command carrying it, and the id made safe for a regular expression. |
| `session.test.js` | The exit status the shell reported, a `cd` carried to the next command, a `cwd` that does not exist as the whole answer, a command that outruns its wait and is collected later, a second command refused while one is out, an interrupt that leaves the session alive, a ring that drops and says so, an unframed shell that reports only its own commands, each state word, a command the person typed making the session theirs, a full-screen program taking the terminal and giving it back, a session knowing its own tty, a resize during a command applied at once and seen by the program running, a resize at idle that prints nothing for the agent or the person, a shell without the rc whose resize during a command is deferred to the next idle and whose resize at idle is a typed `stty` hidden from the agent, independent cursors, the raw buffer keeping the marks the agent's text lost, a closed session refusing to be written to, and a subscriber seeing output with the offset it arrived at. |
| `host.test.js` | The socket path and its mode, a command over the socket, the names `main`, `2`, `3`, the session limit and its refusal, `list` scoped to a conversation, a session and an op refused by name, two consumers with independent cursors, a subscriber's snapshot and its events, a replay from an offset, the watcher count, the idle reaper with and without a browser attached, closing the host closing every session, the wording when nothing is listening, rename, who typed read from the cursor key, a resize applied over the socket while a command runs with the row carrying the tty, a deferred resize in a shell without the rc, the answer cap, and that an agent's answer is capped where a browser's is not. |

The gateway's own suite covers the seam this package is the first to use: a streaming verb that yields and ends, a browser that lets go aborting the export, the two refusals that keep a command and a stream apart, and the style nonce that the page and the policy must agree on.

There is no automated test of the browser side itself. It is checked by hand, with steps 53 to 61 of `packages/gateway-web/test/BROWSER.md`, which walk the chip, colour, a person's command and its interrupt, the agent's command watched live, a full-screen program, a resize while something runs, a closed session that keeps its transcript, and a workspace that stops answering.
