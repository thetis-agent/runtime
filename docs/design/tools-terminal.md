# `tools-terminal` · stateful shell sessions inside the sandbox

Design exercise, second round, 2026-09-09. The port of Thetis's terminal
tools (`crates/thetis/src/terminal.rs`; definitions in
`agents/agent-core/src/tools.rs` lines 1255–1390) as a package under the
seventh draft and ADRs 0001–0009. Where the proposal was silent the
minimum decision is marked DECIDED-HERE and listed in §6.

## 1. Stages and event shapes

One package, three stages: `offer`, `call`, and a lifecycle export
`init(profile)` (ADR 0007 §2) that restores the session table. No
`context` stage.

**`offer`.** Six tools, each with the contract fields from chunk 2.

| Tool | `readOnly` | `endsTurn` | `group` |
| --- | --- | --- | --- |
| `terminal_open { cwd?, name?, env? }` | false | false | `terminal` |
| `terminal_run { id, command, timeout_ms?, background? }` | false | false | `terminal` |
| `terminal_read { id }` | true | false | `terminal` |
| `terminal_send { id, text, submit? }` | false | false | `terminal` |
| `terminal_signal { id, signal }` | false | false | `terminal` |
| `terminal_close { id }`, `terminal_list {}` | false / true | false | `terminal` |

Thetis's `host` argument (ssh to a registered machine) is dropped from
this package: a remote shell is a different boundary and, if wanted, a
different package that requires `cap/network.egress` and a `secret/`.

**`call`.** The core dispatches `{ tool, args, callId, conversation,
turn }` and expects one `result`. Thetis's `run` blocked until a unique
marker echoed after the command, up to a budget, then returned "still
running, use `terminal_read`". PrimeAgent's `bash()` returns a live
handle at once and posts completion back into the session as a message.

The event model of chunk 2 supports the first directly and the second
only in part: a stage may add events *after* the one it handles, on the
same turn, but there is no event a stage can raise between turns.
DECIDED-HERE: `terminal_run` blocks up to `timeout_ms` (default from
`setting/terminal.timeout_ms`, 30 s) and returns
`{ exit?, output, truncated, stillRunning }`. With `background: true` it
returns at once with `stillRunning: true`. Completion of a background
command is *not* pushed; the model polls with `terminal_read`, exactly
as Thetis did. A push would need an `input`-like event a stage can emit
at a turn boundary ("nudge"), which the proposal does not define; see
F1.

**`endsTurn`.** False for all six. A shell command never ends the turn;
a stage that wanted the person to see output before the model
continues would set it, and nothing here does. The core's rule (chunk
2) that it refuses `call` for a tool not offered means `terminal_run` is
uncallable in read-only mode by construction (§4).

Output over the result cap is spilled (Thetis `spill.rs`): the result
carries head, tail, and a path inside the person's space,
`spaces/people/<user>/.spill/<callId>.txt`. DECIDED-HERE: the spill
path is in the person's space, not `state/`, because the file tools
must be able to read it and `state/` is package-private.

## 2. `package.json`

```json
{
  "name": "tools-terminal",
  "version": "1.0.0",
  "description": "Shell sessions that keep their working directory and environment between commands.",
  "exports": { "stages": "./index.ts" },
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/tools": "^1",
    "setting/terminal.timeout_ms": "*",
    "setting/terminal.max_sessions": "*",
    "cap/os.linux": "*"
  },
  "provides": {},
  "thetis": { "settings": {
    "terminal.timeout_ms": { "default": 30000, "help": "How long terminal_run waits before returning with stillRunning." },
    "terminal.max_sessions": { "default": 8, "help": "Open sessions per environment." }
  } }
}
```

`contract/tools` does not exist in the proposal; ADR 0007 defines
`contract/skills` for the `retrieve` messages and leaves `offer` and
`call` inside `contract/turn-events`. DECIDED-HERE: the `offer` and
`call` payloads, the `readOnly`/`endsTurn`/`group` fields, and the
result shape with `spilled` live in `contract/turn-events`, and the
`contract/tools` line above is deleted; it is shown once to record
that three designers in the first exercise assumed a tools contract
nobody wrote.

**A shell is state the stage keeps, not a `spawn` entry.** `spawn` is
for services with an id, a health check and a restart policy, started
when the package loads (chunk 8). A shell is opened on demand by the
model, has no health endpoint, and must die with the environment. The
stage forks `bash --norc` as a child of the environment process, in a
new process group so a timeout signals the pipeline and not the shell,
and keeps a table `{ id, pid, cwd, name, opened, lastCommand }`.

**Limits.** The shell inherits the sandbox (ADR 0005): the pids limit
bounds fork bombs, the CPU share bounds a hot loop, the disk quota
bounds `dd`, the memory limit is the environment's. There is no
per-shell limit, and `max_sessions` is the only knob this package adds.
DECIDED-HERE: a background command that outlives the turn keeps running
until the environment restarts or the model closes it; the stage kills
every session's process group in its shutdown hook.

**What the shell sees.** Exactly the mount list: the environment
directory, the person's space, project spaces, the company space at its
mode, `/packages/<name>@<version>/` read-only. It cannot see other
people's spaces, the host's directories, or the registry repositories.
It cannot reach the host socket, because the socket and the per-run
token are held by the environment process and never exported into a
child's environment. DECIDED-HERE: the stage strips every variable
matching `THETIS_*` and the socket path from the child's environment
and refuses `env` keys that would set them. Secrets never reach the
environment process (rule 5), so there is nothing to strip there.
Network is the sandbox's mode; a shell in a `network: none` run cannot
`curl`, and the tool's description says so.

## 3. Session state across the turn-boundary restart

ADR 0005 §1 and 0007 §2: the environment process restarts at a turn
boundary whenever a `work/` package changes or the profile updates.
Children of that process die with it. Thetis had the same property: its
sessions lived in the worker and a worker restart lost them; the README
promised only that *turns* survive a restart.

DECIDED-HERE: shells do not survive a restart. `init(profile)` reads the
session table from `state/tools-terminal/sessions.json`, finds every
pid gone, and writes one line into the conversation: "terminal sessions
`term-1`, `term-2` were closed by a restart; open again." A background
build that was running is lost, and the line says so. The alternative,
detaching shells with `setsid` so they outlive the process, would leave
a process nothing supervises and nothing can signal after the token
rotates, which is what ADR 0005 forbids. A person who needs a
long-lived process declares it as a `spawn` in a package under `work/`,
which is supervised and survives.

## 4. Read-only mode

`terminal_run`, `terminal_send`, `terminal_signal`, `terminal_open` and
`terminal_close` are `readOnly: false`; `terminal_read` and
`terminal_list` are `readOnly: true`. In a read-only mode the core
withholds the false ones from `offer` and refuses their `call`; the
model can still read and list sessions that a non-read-only
conversation opened. That matches Thetis (`thetis.toml` line 664: "the
terminal is withheld"). A `readOnly: true` `terminal_run` with a command
allow-list was considered and rejected: a shell cannot be proven
read-only by inspecting a string, and the field is a promise the core
enforces, not a hope.

## 5. Measurement

**`call_error`.** A command exiting non-zero is not a tool error; it is
the tool doing its job. DECIDED-HERE: the `call` row carries `ok:
true, exit: N` for any completed command, and `ok: false` only for the
package's own failures: unknown session, session busy, sandbox
refused, spawn failed, timeout with `stillRunning` (recorded as `ok:
true, stillRunning: true`, its own column). `call_error` for this
package measures the package, and `exit != 0` is a separate derived
number, `command_failure_rate`, which is the model's, not the tool's.

**`spill_rate`** is meaningful here more than anywhere: builds and test
runs spill. It is the number that says whether `timeout_ms` and the
result cap are right.

**`tool_lift`** on tasks tagged `terminal`: pass rate with the package
offered minus withheld. Since the harness-task family ("add a tool that
does X", scored by a test the task ships) needs a shell to run the
type checker and tests, withholding it fails every such task, and the
lift is trivially large. DECIDED-HERE: tasks tagged `terminal-needed`
are excluded from the ablation and reported as `required_by`, and lift
is measured only on tasks the file tools could also solve.

**The suite cannot be seen.** Tasks arrive as `input` in a bench
account's sandbox whose mount list holds a copy of the task's working
tree in that account's space and nothing else (ADR 0004 §2–3). The
shell sees that tree. The scorer runs in the host, not in the shell;
a task's `checks/` are mounted read-only only after `end`, into a
scoring sandbox, never into the one the model used. A stage that tries
to find the checks by `find /` finds nothing, because they are not
mounted.

## 6. FINDINGS

1. **No event lets a stage speak between turns.** A background command
   finishing has no way to reach the model until it polls. Thetis had
   nudges; PrimeAgent posts a message. DECIDED-HERE: poll with
   `terminal_read`. The proposal needs a `nudge` event or an `input`
   variant a stage may emit at a turn boundary; it belongs in
   `contract/turn-events` and changes the loop (chunk 1), so it needs an
   ADR.
2. **`offer` and `call` payload shapes are still unwritten.** Every
   designer so far assumed them. DECIDED-HERE: they live in
   `contract/turn-events`, with `readOnly`, `endsTurn`, `group`, a
   result shape `{ content, spilled? }`, and `callId`, `conversation`,
   `turn` on every call. A `contract/tools` package does not exist and
   should not.
3. **`spawn` versus stage-kept processes is undefined.** Chunk 8 says a
   service is "a process a package runs" with health and restart; a
   shell is neither. DECIDED-HERE: on-demand, unsupervised children of
   the environment process are stage state, die with the process, and
   are killed in the stage's shutdown hook. The proposal should say a
   stage may have children and what happens to them.
4. **A stage has no shutdown hook.** ADR 0007 added `init(profile)`;
   nothing symmetric exists. DECIDED-HERE: `shutdown()` on the stage
   module, called before a turn-boundary restart with a bounded wait.
5. **Environment leakage into children.** Nothing says what a child of
   the environment process inherits. The per-run token and socket path
   are in the process; a naive `child_process.spawn` passes them on.
   DECIDED-HERE: the stage strips `THETIS_*` and the socket path. Better:
   the host passes the token by file descriptor, not environment, so
   there is nothing to strip; that is an ADR 0005 amendment.
6. **Sessions across restarts.** ADR 0005/0007 restart the process on any
   `work/` change; nothing says what a stage's children do. DECIDED-HERE:
   they die and a line says so. The proposal should state it in chunk 6
   so package authors know.
7. **`call_error` semantics for tools whose success includes failure.**
   06-metrics treats `ok`/`error` as one bit. DECIDED-HERE: `ok` is the
   package's verdict; domain outcomes (`exit`, `stillRunning`) are
   columns. 06 should say a tool defines its own domain columns in its
   `offer` schema.
8. **`tool_lift` is degenerate for a required tool.** DECIDED-HERE: tasks
   tag tools as `required`, excluded from ablation. 06 and ADR 0004 need
   the `required_by` column.
9. **Spill location.** `spill.rs` wrote to the shared workspace; the
   proposal has spaces and `state/` and names neither for spill.
   DECIDED-HERE: the person's space, `.spill/`, so file tools can read
   it and the sandbox already mounts it.
10. **Where the scorer runs.** ADR 0004 says the host, in a clean
    environment; it does not say the task's checks are unmounted during
    the run and mounted only for scoring. DECIDED-HERE: two sandboxes
    per task, the model's and the scorer's, and the checks exist only in
    the second.
11. **Remote shells.** Thetis's `host` argument and `sshhosts.rs` have no
    place: egress is a sandbox mode and a key is a secret. Not decided
    here; a separate package requiring `cap/network.egress` and a
    `secret/`, which also tests whether ADR 0009 delivers a secret to a
    stage's child (it must not; the child gets it only via `spawn`).
12. **Settings declaration has no home.** `requires: { setting/x }` says
    a setting is needed; nothing says where its default and help text
    live now that `module.toml` is gone. DECIDED-HERE: a `thetis.settings`
    block in `package.json`. Chunk 3 should say so or the requirements
    model has a name with no definition.
13. **`cap/os.linux`** is the first capability anyone has required, and
    the host's `cap/*` list is undefined. DECIDED-HERE: the host reports
    `cap/os.<name>`, `cap/arch.<name>`, `cap/gpu`, `cap/network.egress`.
