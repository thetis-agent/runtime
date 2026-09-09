# Findings · what three tool packs found wrong or missing

Reconciled from the FINDINGS sections of `tools-files.md`,
`tools-terminal.md` and `tools-mcp.md`, against the contract drafts in
`../contracts/` (written before these reported). One resolution per
seam, with its reason and what it changes. "ADR" marks a change to an
accepted decision.

## 1. `offer` and `call` shapes

**They decided:** `files`: request `{ conversation, turn, id, name,
args, mode, roots, budget }`, answer `{ id, ok, text, spilled? }`.
`terminal`: `{ content, spilled? }` plus `callId`, `conversation`,
`turn`. `mcp`: content beyond text, artifacts for images and audio,
protocol versus execution errors.

**Resolution:** the shapes in `contracts/turn-events.md`, now revised:
`CallRequest` gains `mode`, `roots`, `budget.resultBytes`; `CallAnswer`
is `content: Content[]` (text, image, resource, artifact), `error`
with a fixed code list, `spilled`, `data` for domain outcomes, and
`pending` for a handle. No streaming of call results in 1.0; only the
model's `token` streams. **Changes `contract/turn-events`.**

## 2. A `contract/tools` package, or not

**They decided:** `files`: yes, with the entry schema, error codes and a
conformance test. `terminal`: no, it must not exist. `mcp`: neither.

**Resolution:** no. A tool pack provides nothing named, so a contract it
must require is ceremony, and the shapes are the core's. The entry
schema, the error-code list, the `spilled` shape and the handler
conformance test (schema-invalid arguments → `invalid-args`; an
outside path → `outside-roots`; a `readOnly` tool run in an all-read-only
sandbox does not fail) live in `contract/turn-events` as the
*handler* conformance section. ADR 0006's "a provider proves itself"
applies to handlers as "a handler proves itself against the event it
handles". **Changes `contract/turn-events`; no new contract.**

## 3. Spill: who, and where

**They decided:** `files`: the package spills, into
`spaces/people/<user>/tool-output/`. `terminal`: the package, into
`.spill/`. `mcp`: the core spills every `call` result over a setting.

**Resolution:** the core spills, once, for every handler: any answer
whose content exceeds `call.spill_bytes` (default 32 KiB) is written
to `spaces/people/<user>/tool-output/<turn>-<callId>.txt`, and the
model gets head, tail and path. Never a project or company space, so a
spill cannot move content between spaces. `budget.resultBytes` on the
request tells a handler the cap so it can trim on a sensible boundary;
the core enforces regardless. `spill_rate` is then a row for every
tool with no package code. **Changes chunk 7 and `contract/turn-events`.**

## 4. Read-only mode, and `readOnly` from an untrusted source

**They decided:** `files`: `call.mode` with `agent`, `read-only`,
`no-delete`. `terminal`: a shell cannot be proven read-only by
inspecting a string, so `terminal_run` is mutating. `mcp`: a server's
`readOnlyHint` is honoured only for servers in a trusted setting.

**Resolution:** `mode: { readOnly: boolean; deny: string[] }` on both
`offer.request` and `call.request`, where `deny` carries the role's
per-name denials (Thetis's `allow_delete` becomes `deny:
["tools-files/delete_path"]`), so a handler never reads policy from
its own settings. A `ToolDef` with `derived: true` has its `readOnly`
treated as `false` by the core unless the def also carries `trusted:
true`, which a handler may set only from an environment setting the
person controls; the core logs which. The core filters at `offer` and
refuses at `call`; handlers do the same as defence in depth. **Changes
`contract/turn-events`.**

## 5. `destructive` and confirmation

**They decided:** `mcp`: add `destructive`; confirmation is a gateway
concern.

**Resolution:** `ToolDef.destructive?: boolean`, default `false` for
own tools and `true` for a derived tool whose source does not say
otherwise. The core logs it. Confirmation before a destructive call is
not in 1.0: it needs a human in the loop mid-turn, which is a gateway
and a policy question, and it is left open with the field in place so
a later minor can add `call.request.confirmed`. **Changes
`contract/turn-events`; confirmation is an open item.**

## 6. The `offer` pin path

**They decided:** `mcp`: `offer.request` carries `pinned: { name, hash }[]`
and a handler serves a pinned tool from its cache or says it is gone.
`files` and `terminal` did not need it; their defs are static.

**Resolution:** adopt. `offer.request` carries `pinned` and `mode`; a
handler whose pinned def no longer exists still offers it and answers
`call` with `error.code: "gone"` naming the replacement if any. The
core keeps the pinned schema hash and logs a mismatch. This corrects
my draft, which had the core keeping the schema and nobody serving the
call. **Changes `contract/turn-events`.**

## 7. A stage speaking between turns

**They decided:** `terminal`: poll with `terminal_read`; the proposal
needs a `nudge` event and that is an ADR. `mcp`: `tools/list_changed`
is handled in `init`, outside turns. My draft: provisional handle.

**Resolution:** a `notice` event, emitted by a stage through `emit()`
from the context the core hands it at `init`, between turns. The core
queues notices, appends each to `history` as a tool message tagged
with its source at the next turn boundary, and starts a turn with no
person input only if the notice asks (`wake: true`) and the person's
setting `conversation.wake` allows it. This is Thetis's nudge and
PrimeAgent's posted completion, as one shape. A `call` that cannot
finish inside its deadline returns `pending: { handle }` and the same
handler later emits the notice. It changes the loop: an input can come
from the system. **Changes chunk 1 and `contract/turn-events`. ADR.**

## 8. Stage lifecycle

**They decided:** `terminal`: children of the environment process are
stage state, die with it, are killed in a `shutdown()` hook; a restart
writes a line. `mcp`: `init` resolves endpoints and subscribes.

**Resolution:** `stages` exports gain `shutdown()`, called before a
turn-boundary restart with a bounded wait, after which the core kills
the process group. `init(profile, ctx)` receives a context: `emit`,
`settings`, `provided` (resolved endpoints by name), `spaces`, `state`
(the package's state directory). A stage may own children; they are
not services, they inherit no socket and no token (seam 9), and a
restart ends them with one line into the conversation. **Changes chunk
6 and `contract/turn-events`.**

## 9. Token leakage to children; network per spawn

**They decided:** `terminal`: strip `THETIS_*` and the socket path from
a child's environment, better pass the token by file descriptor.
`mcp`: a `spawn` entry has its own `network`, granted only if the
package requires `cap/network.egress`, in a child namespace.

**Resolution:** both, as amendments to ADR 0005. The host passes the
socket and the per-run token as an inherited file descriptor marked
close-on-exec by the core's spawn wrapper, never as an environment
variable, so a child inherits nothing and there is nothing to strip.
A `spawn` entry declares `network`, which must be within the package's
required `cap/network.*`, and the runner starts it in its own network
namespace; the environment process itself keeps `network: none`
unless its own package requires otherwise. **Changes
`contract/host-socket` (connect by fd) and chunk 8. ADR (amends 0005).**

## 10. Per-instance packages, libraries, vendoring

**They decided:** `mcp`: one client package per server, a shared
library package with no stages, a vendored server package with the
secret, `contract/mcp-service`; stdio servers exposed by the runner as
a unix socket; `health: { rpc }`.

**Resolution:** adopt all. A package may export nothing and be a
library; a package is per instance when its requirements differ; a
vendored package is built in the clean host environment from its
lockfile with no scripts, and the package hash covers the lockfile.
`init`'s `provided` map hands a requirer `{ endpoint, version,
transport }` for each `service/` it required; the runner assigns a
unix socket to a stdio spawn. `spawn.health` takes a URL, a command,
or `{ rpc: "ping" }`. **Changes chunks 2, 5 and 8.**

## 11. Settings declarations and the `cap/*` list

**They decided:** `terminal`: a `thetis.settings` block; `mcp`: a
top-level `settings` block; both wanted the host's `cap/*` list.

**Resolution:** top-level `settings: { <name>: { kind, default, help } }`
in `package.json` declares a package's own settings; `requires:
{ setting/<name> }` is for a setting another package or the host must
supply. The host reports `cap/os.<name>`, `cap/arch.<name>`, `cap/gpu`,
`cap/network.egress` in 1.0 and adds names as packages require them.
**Changes chunk 3.**

## 12. Measurement

**They decided:** `files`: gold names tools as `package/name@major`.
`terminal`: `ok` is the package's verdict and domain outcomes are
columns; tasks tag `required` tools, excluded from ablation; two
sandboxes per task, checks only in the scorer's. `mcp`: a benchmark
swaps the server provider, not the client; the list hash is a row.

**Resolution:** adopt all. `CallAnswer.data` carries domain columns the
handler defines in its `offer` schema (`exit`, `stillRunning`);
`call_error` counts only `ok: false`. A task's gold set names
`package/name@major` and may mark a tool `required`, which the
ablation skips and the page reports as `required_by`. The scorer's
sandbox is separate from the model's and the task's checks are mounted
only into the scorer's; ADR 0004 §3 says "clean host environment" and
this makes it two. **Changes 06 and `comparison.md`'s rules; amends
ADR 0004 §3 by clarification.**

## 13. OAuth

**They decided:** `mcp`: not decided; a hosted server needs an OAuth
exchange and refresh the host would have to perform.

**Resolution:** out of 1.0. A secret kind with an exchange the host
runs is a new record; the vendored stdio server with a static token is
the path until then. **ADR, later.**

## 14. Smaller

- `group` is a label until an attention stage consumes it; no
  registry.
- Symlink behaviour across mounts is tested per runner adapter in the
  handler conformance test.
- Remote shells are a separate package requiring egress and a secret;
  the secret reaches only its `spawn`, never a stage's child.
- Confirmation of destructive calls: open (seam 5).

## What needs an ADR

One record, 0010: the `notice` event and system-originated turns
(seam 7), the token by file descriptor and network per spawn (seam 9,
amending 0005), and the two-sandbox clarification of 0004 §3 (seam
12). OAuth secrets are a later record.
