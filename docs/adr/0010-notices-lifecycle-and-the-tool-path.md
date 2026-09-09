# ADR 0010 · Notices between turns, the stage lifecycle, and the tool path

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, from the second design exercise (`design/findings-tools.md`)
**Amends:** ADR 0005 §2 and §6 (token delivery, network per spawn); ADR 0004 §3 (where the scorer runs; `ok` versus outcome)

## Context

Three tool packs, in-process file tools, an MCP client with a
per-person secret, and stateful shells, were designed against the
proposal and the first contract drafts. They found the `offer` and
`call` shapes unwritten, spill owned by nobody and placed in three
different directories, derived `readOnly` trusted by default, no way for
a background command to reach the model before the person's next
message, no stage lifecycle beyond `init`, the per-run token inherited
by every child a shell starts, and the sandbox's one network mode
shared by the environment and the services it spawns.

## Decision

1. **A `notice` event.** A stage may emit between turns through
   `ctx.emit`. The core appends notices to `history` at the next turn
   boundary. A notice with `wake: true` starts a person-less turn only
   if the conversation allows waking. A `call` that cannot finish within
   its deadline answers `pending: { handle }` and the handler later
   emits one notice per handle. This is the loop's only change since
   the first draft: input → agent → response → repeat, where a notice is
   an input the system gave itself, visible in the log as such.
2. **The core spills**, once for every handler, over a setting
   (32 KiB) into `spaces/people/<user>/tool-output/`, never into a
   project or company space, so a spill cannot move content between
   spaces. The answer carries `spilled` so `spill_rate` is a row.
3. **Mode reaches the handler.** `offer.request` and `call.request`
   carry `mode: { readOnly, deny }`; a handler never reads policy from
   its own settings. A `derived` tool's `readOnly` is treated as false
   unless the source is marked trusted in an environment setting, and
   the core logs which applied. `ToolDef.destructive` exists;
   confirmation before a destructive call is a later minor.
4. **`offer.request` carries the pin.** A handler keeps offering a
   pinned tool from its cache and answers `gone` on call, so the pinned
   prefix holds even when a remote server's list changes.
5. **Stage lifecycle:** `init(profile, ctx)` with `ctx = { emit,
   settings, provided, spaces, state }` and `shutdown()` with a bounded
   wait before the process group is killed. Children a stage starts are
   stage state: they inherit nothing, die on a restart, and one line
   says so in the conversation.
6. **The token and socket are inherited file descriptors**, close on
   exec, never an environment variable or a file. A `spawn` entry
   declares its own `network` within the package's required `cap/
   network.*` and runs in its own network namespace; the environment
   process stays `network: none` by default.
7. **Packages are per instance when requirements differ**; a library
   package with no exports is legal; a vendored package builds from its
   lockfile in the clean host environment with no scripts and its hash
   covers the lockfile. `init`'s `provided` hands a requirer
   `{ endpoint, version, transport }`; the runner gives a stdio spawn a
   unix socket; `spawn.health` may be `{ rpc: "ping" }`.
8. **Settings are declared** in `package.json` under `settings: { name:
   { kind, default, help } }`; `requires: { setting/x }` is for another
   package's. The host reports `cap/os.<name>`, `cap/arch.<name>`,
   `cap/gpu`, `cap/network.egress`.
9. **Measurement:** `ok` is the handler's verdict; domain outcomes go in
   `data` columns the ToolDef declares. A gold set names a tool as
   `package/name@major` and may mark it `required`, which ablation skips
   and reports as `required_by`. The scorer runs in a second sandbox and
   the task's checks are mounted only there.
10. **OAuth-backed secrets** need a host-run exchange and refresh and
    are out of the first version; vendored stdio servers with static
    tokens until then.

## Alternatives considered

**A `contract/tools` package** (the files designer). Lost: a tool pack
provides no name to test against, and the shapes belong with the events
that carry them; the conformance section of `turn-events` tests
handlers.

**Handlers spill for themselves.** Lost: three designers put it in
three places, which is the argument.

**Polling for background results** (the terminal designer's fallback).
Lost: it spends a turn per poll; a notice costs nothing until it fires.

**Token in the environment.** Lost: a shell's child inherits it.

## Consequences

Good: the tool path is written end to end; a background command reaches
the model; a remote server cannot escape read-only mode by declaring
itself safe; children cannot impersonate their environment; a spill
cannot leak across spaces.

Bad: `turn-events` 1.0 is larger than the first draft; the core owns
spill and the notice queue; a per-instance package for each MCP server
means one package per integration, which is the cost of static
requirements.

## Revisit

Confirmation for destructive calls when a gateway wants it; OAuth when
a hosted MCP server is required; streaming call results when a tool
needs them.
