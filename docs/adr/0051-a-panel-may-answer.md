# ADR 0051 · A contributed panel may act, within a declaration

**Status:** Proposed · 2026-09-11
**Deciders:** the operator; this session
**Amends:** the rule stated in `gateway-web/assets/lib/surface.js` and described in prose by ADR 0038 §1: "panels never touch the socket".

## Context

`contract/surface` let a package contribute an inspector without the web
gateway knowing what it means, and the seam module that makes that
possible states its own rule at the top of the file: a panel reads
frames the surface already received, and sends nothing. Three things
were being protected by that one sentence. A panel cannot invent
traffic. A panel cannot outlive its conversation. A panel cannot see
anything the person could not.

The Context, Tools and Skills inspectors are clean under it because all
three are readers. The rest of the parity list is not. A terminal is a
place a person types. A todo pane is a list a person ticks. An
`ask_user` form is a question a person answers. Each of those is a panel
that has to send, and none of them can be built as a contributed package
while the rule stands — which means each would have to be baked into
`gateway-web`, and the acceptance test `contract/surface` set for a new
panel (an empty `git diff packages/gateway-web`) would be abandoned for
exactly the three features most worth contributing.

Only the first of the three protections is actually at stake. A request
still travels on the connection the person is already signed in to, so
it sees no more than they do; and it is bound to a conversation that
connection has open, so it still cannot outlive it. What has to be
replaced is the guarantee that a panel cannot originate traffic, and the
answer is not to hand panels the socket.

## Decision

1. **A package declares its reach in its own manifest.** The `surface`
   block gains `commands`, an array of `{ verb, label, role? }`
   (`contract/surface` 1.1.0). The verb is a lowercase name; the label
   is what the person is doing, in their words; the role is the least
   role that may send it, defaulting to any signed-in person. The
   declaration is reviewed with the package and read once, when the
   gateway composes its panels, so a panel's reach is fixed at
   publication and cannot grow at runtime.
2. **The host refuses everything not declared.** `panels.ts` collects
   the declared verbs per contributing package, refusing a malformed
   declaration by name and skipping it, exactly as it already refuses an
   asset served outside a package's own segment — never fatally, because
   a surface that would not start over one bad contributor is worse than
   a missing tab beside a named refusal. `surface-request.ts` then
   checks, per request: the package contributed a panel here; the verb
   is in that package's list; the signed-in role clears whatever the
   declaration asked for; the conversation is one this connection has
   open. Every one of those is a host check. None is a client check.
3. **The request travels as a call the contributing package answers.**
   The gateway forwards it down the environment stream it already holds
   for that conversation (`lib/session/client.ts`), as
   `session.request` on the environment's public endpoint. The
   environment turns it into the `callRequest` the package's own `call`
   hook already speaks and returns the `callAnswer` it already returns,
   with no file roots, a fixed result budget and a deadline. Nothing new
   had to be invented for a package to reply, and the kernel is not on
   the path at all.
4. **The answer returns to the panel that asked, and to no other.** The
   reply frame carries the request's own id and the surface module
   settles only that promise. A panel cannot name a package other than
   its own: `surface.js` reads the calling module's served path, which
   is `/surface/<package>/…` by the same schema rule that fixes where a
   contributor's assets may sit.
5. **The pool is bounded per connection,** like `settings.pendingIdentity`:
   past the cap a request is refused rather than queued.

## Consequences

Good: a terminal, a todo pane and an `ask_user` form become ordinary
contributed packages, and `gateway-web` stays a thing that serves and
routes rather than a thing that knows what a todo is. The published
panel API grows by exactly one function; the socket, the store and
`views/*` stay unreachable from a package. The two protections that were
never about traffic — a panel cannot outlive its conversation, a panel
cannot see what the person could not — are now enforced by the route
rather than by the absence of one, which is stronger: the request is
refused by the environment if it names a conversation the stream is not
reading.

Bad, and it must be written down: a contributed panel can now originate
traffic. A compromised package reaches further than it did, because it
can drive its own `call` hook without the model having chosen to call
it, and it can do so whenever a person has its panel on screen. The
compensating controls are the same set ADR 0050 leaned on — the declared
verb list, the role check, the per-conversation binding, and package
review at publication — plus the bound on how many requests a connection
may have outstanding. They do not cover the work-overlay path ADR 0050
named: an agent that can write `/work/<package>` can change both the
panel and the declaration it is checked against. That exposure is
bounded to a person running an agent with write access to their own work
tree, which is the ordinary development case, and it is not made worse
here than 0050 already made it.

Also bad: the environment checks that the named package has a `call`
hook and that the stream holds that conversation, but it does not
re-read the `surface` block, so the declared verb list is enforced in
the gateway alone. The gateway is the only thing mounted on that
endpoint and it is already permitted to submit turns on the person's
behalf, so this buys nothing an attacker with that mount does not
already have; it is recorded because "checked on the host" should not be
read as "checked twice".

## Alternatives considered

**Give panels the socket.** Lost: everything. A panel could send any
frame the surface speaks, including `send` and `turn-cancel` for a
conversation it is not on screen for, and the three protections become
one comment asking contributors not to.

**Let a panel post a turn instead of a request.** A terminal command
becomes a message; the package reads it back through `observe`. Lost:
the conversation fills with instructions to a package rather than with
the conversation, the person sees their own tick of a checkbox as a
message they sent, and there is no reply channel — the panel would have
to watch for a frame and guess which of its requests it answers.

**Put the verb list in profile settings rather than the manifest.**
Lost: review. A profile is configuration a person edits; a manifest is
reviewed with the code it belongs to, and the whole value of the
declaration is that a panel's reach is fixed at the moment somebody read
the panel.

**Route through the kernel as a new session method.** It would put the
role check where the roles live. Lost: the kernel grows a transport it
has no opinion about, against ADR 0017's rule about what the kernel is
for and against its line budget; and the per-conversation binding stops
being structural, because a kernel-routed request arrives with no stream
attached and the environment would have to consult a list of open
conversations instead of answering on the one it is already reading.

**Reach the package over its own tool-service endpoint (`ToolClient`).**
It is the existing mechanism for "call a package's service". Lost:
`gateway-web` would have to declare `service/<name>` in its own envelope
for every contributor, which is a static list in the file whose diff is
supposed to stay empty when a panel is added — the discovery-by-readdir
that makes a contributed panel possible has no counterpart in envelope
declaration.

**Let the panel name its own package in the request.** Simpler code.
Lost: one contributed panel could send another contributor's declared
verbs, so the review that fixes a package's reach would fix the wrong
package's. Reading the caller's served path costs a stack frame and
removes the question.
