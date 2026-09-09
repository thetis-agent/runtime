# ADR 0016 · Configuration is a contract; a package registers at initialization within a declared envelope

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Amends:** ADR 0010 §5 and §8 (`init`, settings); contracts/turn-events, host-socket
**Supersedes:** the rule "packages are per instance when requirements differ" (ADR 0010 §7) as the only option

## Context

Requirements were static in `package.json`. That made "connect to any
MCP server" a template rather than a package, one package per server,
and the same for any connector whose needs depend on how it is
configured. The operator proposed treating configuration as a contract
with a registration step at package initialization.

The risk of dynamic registration is that review loses sight of what a
package will ask for: a secret, egress, a service. The design's
reviewability rests on the review page listing exactly that.

## Decision

1. **Settings are a contract.** `package.json` declares `settings:
   { name: { kind, default?, help, required? } }`. Kinds include the
   ordinary scalars, `secret` (a reference the host resolves; the value
   never enters the settings file or the environment), `service` (an
   address or a provided name), and `list<...>`. The host validates the
   environment's settings against the schema before `init`; a missing
   required setting is the one-sentence gap.
2. **A package may register at `init`.** `init(profile, ctx)` may call
   `ctx.register({ requires, provides, spawn })` once, with concrete
   names computed from its settings: `secret/notion-token-for-<server>`,
   `service/mcp-<server>`, `cap/network.egress`, spawn entries per
   server. The host matches them with the same namespace and the same
   matcher as static requirements.
3. **The envelope bounds registration.** `package.json` declares
   `envelope: { requires: [patterns], provides: [patterns], spawn:
   { scope, network } }`, for example `requires: ["secret/mcp-*",
   "cap/network.egress"]`, `provides: ["service/mcp-*"]`. A registration
   outside the envelope is refused by name and the package is inert. The
   review page shows the envelope; the install shows the concrete set.
   Widening an envelope is flagged at review as new access and is a
   minor bump at least.
4. **The registration SLA.** `init` completes within the probe budget;
   the registration is a pure function of the settings and the profile
   (the same inputs register the same names, checked by running `init`
   twice at publish); it is idempotent across restarts; a failed or
   late `init` leaves the package inert with the gap written into the
   conversation, never the environment down.
5. **Secrets and spawns registered at `init`** follow ADR 0009 and 0010
   unchanged: the host resolves the secret by scope and role policy and
   delivers it only to the registered spawn at start; the spawn runs in
   its own network namespace within the envelope's `network`.
6. **Per-instance packages remain legal** and are still the right shape
   when a server needs its own vendored code; the generic package is
   for servers reached over a transport the package already speaks.

## Alternatives considered

**Unbounded registration.** Lost: a reviewer approves a package and
learns at install that it wants a deployment secret.

**Registration from a declarative mapping in `package.json`** (settings
path to requirement name). Considered; the envelope with code is
simpler to write and the same to review, and it lets the package
compute names the mapping could not.

## Consequences

Good: one MCP package configured with a list of servers; one provider
package configured with a list of endpoints; a RAG package configured
with sources; configuration errors are caught before `init` with a
sentence.

Bad: the host's matcher runs twice, at install and at `init`; `init`'s
determinism is one more conformance test; a person's settings become
part of what the review cannot see, which the envelope bounds but does
not remove.
