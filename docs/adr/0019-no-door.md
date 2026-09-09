# ADR 0019 · No door: keys live on providers, usage is formless counters

**Status:** Accepted · 2026-09-09; §4 and §5 corrected by ADR 0020 the same day
**Deciders:** the operator; this session
**Supersedes:** the `door` part of the kernel (ADR 0011 §5, ADR 0017 §3, ADR 0018); `contract/llm`
**Amends:** ADR 0009 §2 (resolution by caller), ADR 0014 §1 (what is observed)

## Context

The kernel kept a door: the one path from an environment to a model,
holding the provider key, choosing it by the caller's scope, metering
tokens and cost, writing the observed row, pinning the model for bench
runs, and copying the provider's stream. The operator asked why it
still existed when a provider could hold its own key, and observed that
the meter was an opinion about what a call is rather than counters.

Both objections hold. ADR 0009 already delivers a secret to a
registered spawn; a provider is a registered spawn. And nothing the
kernel guarantees depends on it knowing what a token is.

## Decision

1. **The provider holds its key.** A deployment-scope provider requires
   `secret/<vendor-key>` at deployment scope and receives it at start. A
   person on their own key runs their own provider instance at person
   scope, in their own sandbox, with their own secret, which is theirs
   to expose. The kernel holds no model key of its own.
2. **Scope resolution is routing.** Which provider instance a run may
   call is decided when the run starts, by the boundary, as the set of
   service sockets mounted into the sandbox: the person's instance if
   one exists, else the project's, else the deployment's. No fallback
   at call time; a failed instance fails the turn with its reason.
3. **The core speaks `contract/provider` directly** over the mounted
   socket. `contract/llm` is deleted. The kernel is not in the stream.
4. **Usage is formless.** A provider emits `usage: { [counter]: number }`
   with whatever names it has, `cost` among them if it can compute one.
   A deployment-scope provider reports each call's counters to the
   kernel with the caller's run token; the kernel appends them to the
   log as provider-reported, reviewed-code facts, without interpreting
   them. A person-scope provider's counters are candidate-reported.
5. **A budget is a rule over a counter name**, written by an
   administrator: `cost ≤ N per person per day` for deployment-scope
   providers. The kernel enforces it by refusing to mount the socket
   for the rest of the window and writing the reason into the
   conversation. A person-scope provider has no budget; it is the
   person's own money.
6. **The bench pin moves to the evaluator.** The evaluator's profile
   names the provider instance and model the suite runs on; the
   result's identities carry both. The kernel no longer overrides a
   model name.
7. **Attribution.** A provider learns who is calling from the run token
   presented on its socket and may ask the kernel `token.whois`; the
   kernel never forwards the stream to find out.

The kernel is identity, the boundary, secrets, and generations. About
1,300 lines.

## Alternatives considered

**Keep the door as a pure copy with formless counters.** Lost: a copy
that reads nothing is a hop that does nothing; the counters can be
reported by the provider directly.

**Keys in the kernel, delivered per call.** Lost: the key then travels
on every request to the same reviewed process that could have held it.

## Consequences

Good: the kernel loses its last vendor-shaped part and one contract;
the stream has one hop fewer on the turn path; a new model kind is a
provider with different counter names and no kernel change; per-person
keys are per-person provider instances, which is also what makes them
sandboxed.

Bad: usage for the gate is provider-reported rather than
kernel-observed; a release that changes the provider is scored on the
candidate's own counters, and the vendor's bill is the only check on
them; per-person provider instances cost one process per person on
their own key.
