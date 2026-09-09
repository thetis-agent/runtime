# Design · `tools-files`

In-process file tools over the three spaces, with Thetis's spill for
oversized results. Ported from `crates/thetis/src/hostfs.rs`, `spill.rs`
and the `filesystem_tools()` definitions in
`agents/agent-core/src/tools.rs`. Written inside the seventh draft and
ADR 0001–0009; decisions the proposal did not make are marked
DECIDED-HERE and collected in §6.

## 1. Stages

One module, two stages: `offer` and `call`. No `init` is needed; the
roots come from the `call` context (§3). The package handles both
events; it provides neither, since neither is a singleton.

### The `offer` answer

The proposal names four fields (`schema`, `readOnly`, `endsTurn`,
`group`) and no shape. DECIDED-HERE: one entry per tool,

```json
{ "name": "read_path", "description": "...", "schema": { JSON Schema for the arguments },
  "readOnly": true, "endsTurn": false, "group": "files" }
```

The seven tools, ported with their Thetis descriptions:

| Tool | Arguments | `readOnly` |
| --- | --- | --- |
| `read_path` | `path`, `offset` (line, from 1), `limit` (lines) | true |
| `list_path` | `path` | true |
| `find_files` | `glob`, `path?`, `max_results?` | true |
| `search_files` | `pattern`, `path?`, `glob?`, `mode` (content, files, count), `max_results?` | true |
| `edit_path` | `path`, `old_text`, `new_text`, `replace_all?` | false |
| `write_path` | `path`, `contents` | false |
| `delete_path` | `path`, `recursive?` | false |

`endsTurn` is false on all seven. `group` is `files` on all seven; the
proposal's attention grouping is a stage-side hint, never a permission.

### The `call` request and answer

DECIDED-HERE, since the proposal gives `call` no shape:

```
call.request: { conversation, turn, id, name, args, mode: "agent" | "read-only",
                roots: [ { path, mode: "ro" | "rw", space } ], budget: { resultBytes } }
call.answer:  { id, ok: true, text, spilled?: { path, total, shown } }
            | { id, ok: false, error: { code, message } }
```

Calls are not streamed; a file tool's result is one string. `budget.
resultBytes` replaces Thetis's `max_tool_output_bytes` (32,768) and is
set by the core from the context budget, so the tool never guesses.

Error codes: `outside-roots`, `protected`, `not-found`, `not-unique`
(edit), `read-only-mode`, `args-invalid`, `io`. The message is one
sentence in the shape the requirements model uses: what was asked,
why it was refused, what would work.

### Spill

Ported unchanged from `spill.rs`: head three quarters of the body,
tail one eighth, cut on line boundaries, the recovery instruction last.
DECIDED-HERE: the spill file lands in the person's space at
`spaces/people/<user>/tool-output/<tool>-<millis>.txt`, never in a
project or company space, so a spill cannot leak one space's content
into another that other members read. The path is what `read_path`
and `search_files` accept, and the answer carries `spilled` so the turn
log records `spill_rate` without parsing text.

## 2. `package.json`

```json
{
  "name": "tools-files",
  "version": "1.0.0",
  "description": "Read, search, edit, write and delete files in the spaces you can reach.",
  "main": "index.ts",
  "stages": ["offer", "call"],
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/tools": "^1"
  },
  "provides": {}
}
```

Two contracts. `contract/turn-events` (from `core`) carries the
`offer` and `call` shapes above; this package is the first to need them
written down. DECIDED-HERE: `contract/tools` is a second package
carrying the tool-entry schema (`name`, `description`, `schema`,
`readOnly`, `endsTurn`, `group`), the error-code list, the `spilled`
shape, and a conformance test that calls every offered tool with
schema-generated invalid arguments and expects `args-invalid`, and with
a path outside the roots and expects `outside-roots`. The reason for a
separate contract: the shapes of `offer` and `call` payloads are the
core's, but what a *tool entry* must satisfy is shared by every tool
pack and by the semver floor, and 0006 says a contract with a
conformance test is how a provider proves itself. This package
provides nothing named; it is a handler.

No `spawn`, no `skills`, no settings, no secrets, no capabilities.

## 3. The sandbox and what the tool still checks

Under ADR 0005 the runner mounts exactly the person's space, their
projects' spaces (rw), the company space (ro or rw by policy), the
environment directory and `/packages/<name>@<version>/` (ro). Nothing
else exists inside the process. The roots are therefore not
configuration the tool reads; they are the mount list, handed to the
tool on every `call` as `roots` (DECIDED-HERE: by the core, from the
run description), so the tool can say *which* roots exist in its
error rather than discovering `ENOENT`.

What the tool still does, ported from `hostfs::resolve`:

- Trims, rejects an empty path and a drive prefix.
- Resolves a relative path against the first `rw` root (the person's
  space), normalises `.` and `..` without touching disk, canonicalises
  an existing path or the parent of a new one, and checks the result
  starts with a root. Inside a namespace a symlink cannot reach outside
  the mounts, but it can reach from a project space into the company
  space or from `rw` into `ro`; the check keeps the error honest and
  keeps the tool correct under the `none` runner.
- Refuses a write to an `ro` root with `outside-roots` naming the mode.
- Keeps a protected list, DECIDED-HERE fixed rather than configured:
  `.git`, `state`, `harness`, `conversations`, `work` under the
  environment root cannot be deleted or overwritten through these
  tools. As in Thetis, this is a courtesy against accidents, not a
  boundary; the boundary is the mount list.

The error the model sees for a path outside:
`/etc/passwd is outside the spaces you can reach (people/bob rw,
projects/atlas rw, company ro).` One sentence, the same shape every
time, naming what would work.

## 4. Read-only mode

`call.request.mode` is `read-only` when the conversation's mode is
read-only. In `offer`, the three mutating tools are omitted. In `call`,
a request for `edit_path`, `write_path` or `delete_path` is refused
with `read-only-mode`: *`write_path` is not offered in this mode; use
read_path to inspect instead.* Both, because the proposal keeps
Thetis's design intent 7: withhold at offer and refuse at dispatch.
The core also filters, so this is defence in depth, not the
enforcement.

`delete_path` additionally honours a per-role denial from `auth`
(Thetis's `allow_delete`) that arrives as `mode: "no-delete"`;
DECIDED-HERE that this is a second mode value rather than a setting, so
the tool never reads policy from its own environment.

## 5. Measurement

From the `call` rows alone, no gold: `call_valid` (arguments pass the
schema), `call_error` by code, `call_latency`, `spill_rate` (rows with
`spilled`), and result bytes. `outside-roots` and `protected` errors
are the interesting ones: a rising rate on a task family means the
model is reaching for paths the space model does not give it.

`tool_lift` per tool by paired ablation on tasks whose gold set names
it. A task's gold set names tools by `package/name@major`, DECIDED-HERE
`tools-files/read_path@1`, so a rename is a major and the gold set
breaks loudly rather than silently matching nothing. Every coding and
harness task in the suite lists `read_path`, `edit_path` and
`search_files`; withholding them is the ablation arm, and their lift
is expected to be the largest in the suite, which makes them the
control tools the comparison's control-task gate uses.

`offer_f1` counts these tools as offered whenever the package is in
the profile and the mode allows, so they contribute to precision on
tasks that need none of them; the `files` group exists so an attention
stage can withhold them on such tasks, and `offer_tokens` for the seven
schemas (about 900 tokens) is the cost that stage saves.

Under ADR 0004 the checks run in a clean host environment on the
published commit, so the conformance test's outside-roots case is run
against a sandbox with a known mount list, and the test is the
contract's, not this package's.

## 6. FINDINGS

1. **`offer` and `call` have no shapes.** Every tool pack will invent
   them. DECIDED-HERE: the entry, request and answer shapes in §1;
   they belong in `contract/turn-events` and must be written before any
   tool pack publishes, as the first exercise found for `retrieve`.
2. **No contract for a tool entry.** ADR 0006 tests providers against
   contracts, but a tool pack provides nothing named, so nothing tests
   its entries. DECIDED-HERE: `contract/tools` with the entry schema,
   error codes, `spilled`, and a conformance test; the semver floor's
   `offer` diff reads this schema.
3. **Result budget is unspecified.** Thetis had `max_tool_output_bytes`
   in kernel config; a stage has no config. DECIDED-HERE:
   `call.request.budget.resultBytes` from the core, derived from the
   context budget.
4. **The roots reach the tool by no stated path.** ADR 0005 gives the
   runner the mount list; nothing gives it to a stage. DECIDED-HERE:
   the core passes `roots` on every `call`, so errors can name what
   exists.
5. **Where a spill lands is unspecified, and the obvious answer leaks.**
   Thetis wrote to the shared workspace. DECIDED-HERE: the person's
   space only.
6. **Read-only mode reaches a stage by no stated field.** DECIDED-HERE:
   `call.request.mode`, also carrying a `no-delete` value for the role
   denial Thetis had as `allow_delete`; a tool must never read policy
   from settings in its own environment.
7. **The protected list has no owner.** In Thetis it was configuration.
   DECIDED-HERE: fixed in the package for the environment's own
   directories; not a boundary.
8. **How a gold set names a tool is unspecified.** DECIDED-HERE:
   `package/name@major`.
9. **`group` has no registry.** Chunk 2 lists `group` in the entry and
   nothing says what values exist or who ranks them; Thetis's
   `groups.rs` was hard-coded in the agent. Not decided; an attention
   stage that consumes `group` is a later package, and until it exists
   the field is a label.
10. **Symlink semantics inside a namespace are untested.** The tool
    keeps the canonicalise-then-check rule, but whether a symlink from
    an `rw` mount into an `ro` mount resolves, fails, or is invisible
    depends on the runner. The contract's conformance test must include
    that case per runner; not decided here.
11. **Streaming.** `call` is assumed non-streaming; a tool that must
    stream (a long search) has no path. Not decided; no file tool needs
    it.
