# Design · `tools-mcp-notion`

An MCP client that exposes an external server's tools through `offer`
and `call`. Notion is the worked example: Thetis had eleven `notion-*`
crates, each a copy of a 700-line client (`tools/notion-page-get/src/notion.rs`
opens with "This file is duplicated verbatim into every notion-* tool
crate"). Notion now ships an MCP server, so the successor writes no
Notion code at all.

Sources: MCP specification 2026-07-28, *Server › Tools* (tool shape
`name`, `title`, `description`, `inputSchema`, `outputSchema`,
`annotations`; `tools/list` with `cursor`, `ttlMs`, `cacheScope`;
`tools/call` result `content[]`, `structuredContent`, `isError`;
protocol errors as JSON-RPC errors versus execution errors as
`isError: true`; "clients MUST consider tool annotations untrusted
unless they come from trusted servers"; name prefixing for aggregating
clients) and *Basic › Transports* (stdio: newline-delimited JSON-RPC over
a client-launched subprocess; Streamable HTTP: POST per message; the
`_meta.io.modelcontextprotocol/*` protocol-version fields). The
`ToolAnnotations` schema: `readOnlyHint` (default false),
`destructiveHint` (default true), `idempotentHint` (false),
`openWorldHint` (true).

## 0. Three packages, not one

Requirements are static in `package.json`. A generic "any MCP server"
package cannot declare `secret/notion-token`, so a connector is one
package per server, built on a library:

| Package | Exports | Job |
| --- | --- | --- |
| `mcp-client` | none | the JSON-RPC client library: framing, `_meta`, pagination, cancel, timeouts |
| `notion-mcp-server` | `spawn` | the vendored Notion server (npm code enters the registry once, through review, per rule 3); `provides: service/mcp-notion` |
| `tools-mcp-notion` | `stages` | this design: `init`, `offer`, `call` against `service/mcp-notion` |

Splitting server from client is what lets a benchmark swap the server
(§5) and lets the secret live with the process that needs it.

## 1. Stages

**`init(profile)`.** Resolves `service/mcp-notion` to an endpoint (a
unix socket path for stdio-framed servers, or a URL), sends
`tools/list` with the protocol `_meta`, follows `nextCursor`, and
stores the list as `state/tools-mcp-notion/list.json` with its SHA-256.
Subscribes to `notifications/tools/list_changed` if the server
declares `listChanged`; on notification, re-lists into a *new* file
and swaps the pointer. No list is fetched during a turn.

**`offer`.** For each server tool, one offered tool:

| Offered field | From |
| --- | --- |
| `name` | `notion.` + server `name` (the spec's disambiguation rule; server names are not unique across servers) |
| `description` | `title` if present, then `description`, truncated at a setting (default 1,024 chars) |
| `schema` | `inputSchema` verbatim, marked `derived` |
| `readOnly` | `annotations.readOnlyHint === true` **and** the server is in the setting `mcp.trusted` ; otherwise `false`. Untrusted annotations are treated as mutating, so a read-only mode withholds every tool of an untrusted server |
| `endsTurn` | `false` always; MCP has no such concept |
| `group` | `notion`, one group per server |
| `destructive` | `annotations.destructiveHint !== false`, trusted servers only; see F3 |

**Pinning against a changing list.** `offer.request` carries the
conversation's `pinned` tool hashes (F1). The stage serves a pinned tool
from the list file whose hash matches, even after the server dropped
it; a `call` to such a tool returns an execution error, "`notion.x` no
longer exists on the server; start a new conversation to see the
current tools". New tools appear only in new conversations. The list
hash is a row in the turn log, so a remote change is visible even
though no version changed.

**`call`.** §3.

## 2. `package.json`

```json
{
  "name": "tools-mcp-notion",
  "version": "1.0.0",
  "description": "Notion's tools, through its MCP server",
  "exports": { "stages": "./index.ts" },
  "requires": {
    "core": "^1",
    "contract/turn-events": "^1",
    "contract/mcp-service": "^1",
    "mcp-client": "^1",
    "service/mcp-notion": "^1"
  },
  "provides": {},
  "settings": {
    "mcp.trusted": { "kind": "list", "default": [] },
    "mcp.call_timeout_ms": { "kind": "int", "default": 30000 },
    "mcp.description_chars": { "kind": "int", "default": 1024 }
  }
}
```

The server package:

```json
{
  "name": "notion-mcp-server",
  "version": "1.4.0",
  "exports": { "spawn": "./spawn.ts" },
  "requires": {
    "contract/mcp-service": "^1",
    "secret/notion-token": "*",
    "cap/network.egress": "*",
    "vendor-notion-mcp-server": "1.4.0"
  },
  "provides": { "service/mcp-notion": "1.4.0" },
  "spawn": [ {
    "id": "notion",
    "cmd": "node", "args": ["/packages/vendor-notion-mcp-server@1.4.0/bin/cli.js"],
    "env": { "NOTION_TOKEN": "secret/notion-token" },
    "scope": "person",
    "network": "egress",
    "health": { "rpc": "ping" },
    "restart": "on-failure"
  } ]
}
```

`scope: person` is forced by ADR 0009: a `deployment` service receives
only deployment secrets, and the token is the person's. The client runs
in-process in the person's environment; the server is a `person`-scope
subprocess with its own egress (F4). `contract/mcp-service` defines
what a `service/mcp-*` provider hands over: `{ transport: "stdio-socket"
| "http", endpoint, protocolVersion }` and the conformance test is
`tools/list` returning a deterministic order.

## 3. The `call` path

1. The core dispatches `call { name: "notion.search", args, turn,
   conversation }` to the handler that offered it (the core refuses a
   name it did not offer).
2. The stage validates `args` against the pinned `inputSchema`
   (2020-12). Invalid: return an execution error naming the field; this
   is `call_valid = false` in the log and costs no network.
3. `tools/call` over the endpoint with a fresh JSON-RPC id, the
   `_meta` fields, and a timer at `mcp.call_timeout_ms`; on expiry send
   `notifications/cancelled` (stdio) or close the stream (HTTP) and
   return "timed out after 30 s; the server may still be working".
4. Result mapping: `content[]` text items are joined; `structuredContent`
   is appended as fenced JSON; image and audio items become artifacts
   in the person's space with a record in the conversation and are
   replaced by their path (F5); `resource_link` items are returned as
   the URI. `isError: true` is returned as a tool error the model can
   act on; a JSON-RPC error is returned as a tool error marked
   `protocol: true`, and a 429-shaped execution error keeps the
   server's text (Notion's says to wait).
5. Size: the core spills any `call` result over the setting
   `call.spill_bytes` (default 32 KiB) to the person's space and hands
   the model head, tail and path (Thetis's `spill.rs`); the package does
   nothing (F6). Thetis's Notion client cut markdown at 18,000
   characters itself; that logic is gone with the crates.
6. Log row: tool, package version, list hash, `call_valid`, ok or
   error kind, duration, bytes, spilled.

`endsTurn` is never set, so a call never ends the turn; the model
continues.

## 4. Semver floor with derived schemas

The offered schemas are `derived` (ADR 0007 §6), so `tools-mcp-notion`'s
floor diffs only its own code and settings. A remote change therefore
never bumps this package; it is visible as the list hash in the log and
caught by `tool_lift` and `regressions`. For the vendored server, the
publish check snapshots `tools/list` to `tools.json` in the package,
and the floor diffs that snapshot: a removed tool or a narrowed
`inputSchema` is a major, an added tool a minor, description text a
patch. A hosted server with no package (F2) has no floor at all; its
list hash is the only record.

## 5. Measurement (ADR 0004)

Numbers this package produces from its own rows, no gold needed:
`call_valid`, `call_error` by kind (validation, execution, protocol,
timeout), `call_latency`, `spill_rate`, `offer_tokens` (Notion's server
lists about twenty tools; their schemas are the cost every turn).
Numbers that need host-held gold on suite tasks: `offer_f1`,
`select_at_1`, `tool_lift` (the whole package withheld).

An MCP benchmark package (MCPMark or MCP-Universe, both state-checked)
needs exactly the split in §0: it publishes `bench-mcp-notion`, which
`provides: service/mcp-notion` from a fixture server pointed at a bench
workspace under a `deployment` secret, and a scorer that reads the
workspace's final state through the same server. The bench profile is
the default profile with the server provider swapped; the client under
test is unchanged; the scorer is idempotent; the package never sees the
tasks. `invariance` runs the mutated task against the same fixture.
Benchmaxing specific to this package: a client that rewrites arguments
it has seen fail before is tuning toward the suite; the mutated
variants and the held-out two thirds cover it, and the list hash in
the log makes a server swapped for the run visible.

## 6. FINDINGS

1. **`offer` has no pin path.** ADR 0007 §5 says the `offer` schemas are
   pinned but only defines `pinned` on `retrieve.request`. A handler
   cannot honour a pin it is not given. DECIDED-HERE: `offer.request`
   carries `pinned: { name, hash }[]`; a handler must serve a pinned tool
   from its own cache or answer that it is gone. `contract/turn-events`.
2. **Hosted servers with OAuth have no path.** Notion's hosted MCP uses
   Streamable HTTP with OAuth; ADR 0009 sets a secret by a host page,
   and nothing does an OAuth exchange or a refresh. Not decided; the
   host needs an OAuth-capable secret kind, and it is a new ADR. This
   design uses the vendored stdio server with a static integration
   token.
3. **The tool contract has no `destructive` and no confirmation.** MCP
   says clients SHOULD confirm sensitive operations; the proposal has
   `readOnly`, `endsTurn`, `group` and no human-in-the-loop for a call.
   DECIDED-HERE: `offer` carries `destructive: boolean`; the core logs
   it and a read-only mode withholds it; confirmation is a gateway
   concern left open.
4. **Network mode is per run, not per spawn.** ADR 0005 gives a run one
   `network` mode. A person-scope server needs egress; the person's
   environment process should not get it for free. DECIDED-HERE: a
   `spawn` entry has its own `network`, granted only if the package
   requires `cap/network.egress`; the runner starts services in a
   child namespace. Amends ADR 0005 §2.
5. **`call.answer` is text-only in every design so far.** MCP returns
   images, audio, resource links. DECIDED-HERE: non-text items become
   artifacts in the person's space with a conversation record, and the
   answer carries their paths. `contract/turn-events`.
6. **Spill is unowned.** Thetis spilled in the host; the proposal's
   `spill_rate` row implies it exists but no chunk says who spills.
   DECIDED-HERE: the core spills any `call` result over a setting, so no
   package reimplements it.
7. **Untrusted annotations.** The spec says annotations from untrusted
   servers are untrusted; the proposal's `readOnly` filter would let a
   server declare itself read-only and escape a read-only mode.
   DECIDED-HERE: `readOnly` is honoured only for servers in
   `mcp.trusted`, an environment setting; otherwise every MCP tool is
   mutating. The proposal should say so for any derived `readOnly`.
8. **A generic connector cannot exist.** Requirements are static per
   package, so "connect to any MCP server" is a template, not a
   package. DECIDED-HERE: one client package per server plus a shared
   `mcp-client` library and a `contract/mcp-service`. The proposal
   should say packages are per instance when requirements differ.
9. **`provides` for a service delivered over stdio.** `service/` says "a
   package whose spawn runs it, or a setting that names an address";
   a stdio server has no address until the runner assigns a socket.
   DECIDED-HERE: the runner exposes a stdio spawn as a unix socket in
   the environment directory (the transport page's "custom transports
   SHOULD reuse the stdio framing" case) and hands its path to
   requirers as `provided[service/mcp-notion].endpoint`.
10. **Health for a stdio service.** `spawn.health` is "a URL or a
    command"; an MCP server answers `ping` over JSON-RPC.
    DECIDED-HERE: `health: { rpc: "ping" }` as a third form.
11. **Vendoring npm code.** The Notion server and its dependency tree
    enter the registry as one vendored package by rule 3; nothing says
    how a vendored package is built or that its lockfile hash is the
    package's hash. Not decided; a note for the registries chunk.
12. **Two secrets, two packages.** The token belongs to the server
    package, not the client. A person who installs `tools-mcp-notion`
    without `notion-mcp-server` gets the one-sentence gap naming the
    provider, which is correct and the first time the model was seen
    to work end to end for a real integration.
