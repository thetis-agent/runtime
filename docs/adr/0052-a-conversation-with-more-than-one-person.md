# ADR 0052 · A conversation with more than one person

**Status:** Proposed · 2026-09-11 — not built. This records what it would take, so
the decision is the operator's rather than a surface's.
**Deciders:** the operator; this session
**Would amend:** ADR 0038 §3 (`session.whois` answers a person-scope caller about
its own person only), ADR 0019 §2 (which provider a run may call is decided at
mount time, by owner), `contract/kernel-socket` KS-004 and KS-023,
`contract/turn-events` `message` (`source` names a package, not a person), and
`packages/core/schema.json` (a conversation record has no owner and no members).

## Context

The design canvas has a People pane, and the surface it was drawn from resolves
every turn as `policy(speaker) ∩ ceiling(session)`: a read-only account invited
into a privileged conversation stays read-only inside it. That intersection is
the property that makes inviting safe, and it is what the pane exists to say out
loud, since a transcript looks identical whoever is speaking.

This runtime has neither half of that expression. It has no speaker — a turn
carries no author — and it has no per-conversation ceiling, because a
conversation is not a thing with a policy attached to it. A conversation *is* one
person's environment, and everything it may do is that environment's profile.

That is not a gap in the surface. It is five separate walls in the layers below
it, and each of them is somewhere a decision was already written down.

**The transcript is a mount, not an address.** `gateway-web/wire.ts:130` opens a
subscription through `mounted()`, which resolves exactly one path:
`/services/environment/current.sock` (`lib/session/client.ts:12`). There is no
person in it because there is nothing to vary — a gateway's sandbox holds one
environment socket, its own person's. Which socket that is was fixed when the
target was assembled, and `kernel/boundary/runtime.ts:295` is the rule that fixed
it: `service.target.scope === 'person' && service.target.owner !== target.owner`
is refused `forbidden`. Bob's gateway cannot be handed Alice's environment. ADR
0038 considered precisely this and declined to weaken it, in those words.

**The kernel is not a way around that.** `session.subscribe` is deliberately the
one session method the kernel does not offer
(`kernel/boundary/runtime.ts:311`), because carrying a transcript would put the
kernel back inside a stream it is not a party to, which is what ADR 0019 §3
removed it from.

**Speaking is routed by who is asking, never by which conversation.**
`kernel/boundary/runtime.ts:146` reads a `person` parameter for `session.list`
and for nothing else; every other method goes to `person.id`'s environment. A
`session.submit` from Bob naming a conversation of Alice's reaches *Bob's*
environment and is answered `not-found`. The fan-out added for "Everyone's
conversations" (`lib/socket/sessions.ts`, `listEveryone`) is a survey of running
environments under an `observeOthers` principal, and it is a survey of *lists*
for exactly this reason: it asks each environment under its own name, so each
one's own ownership check still answers the question it was written to answer.

**The gateway refuses a stranger at its own door.** The nearest reachable shape
does not need a new socket at all: the operator's proxy already maps `/<person>/`
to that person's gateway (ADR 0038 §2), so Bob's *browser* can reach Alice's
gateway, which already holds the mount. Two checks stop it, and both are
deliberate. `gateway-web/service.ts:71` refuses any WebSocket whose cookie names
someone other than the target's own person; and before that could even be
relaxed, `kernel/boundary/runtime.ts:40` refuses to tell a person-scope caller
who a token belongs to unless it belongs to that caller's own person — ADR 0038
§3, conformance id KS-023.

**Nothing records who, anywhere.** A conversation record is `id`, `surface`,
`project`, `title`, `preview`, timestamps and `archived`; there is no owner,
because the store *is* the owner, and `listEveryone` stamps `owner` onto rows
precisely because a row does not carry one.

`source` is the near miss, and it is worth being exact about. Every message does
carry one, the core sets it from whatever emitted the message, and it is required
by `contract/turn-events`. But it names the *software*, not the speaker: `core`
for anything the loop wrote, `core-session`, `<stage>@<version>` for a stage's
contribution (`packages/core/dispatcher.ts`). It is not even carried out to the
surface on a person's own turn — `render.ts` projects an `input` envelope to
`{ type, session, kind: 'user', text, attachments?, cursor? }` and reads nothing
else from the payload. Watched on a live wire, that is exactly what arrives:
`{"type":"event","session":"fc395118-…","kind":"user","text":"Who said that?","cursor":14}`.
A second person's message would arrive byte-identical in shape to the first
person's, and the transcript would draw it with the *reader's* own face, because
`transcript.js`'s `faceFor` takes every `user` row's face from `store.user`
unconditionally. So a `who` is not a matter of forwarding a field that is already
there; the field that is there answers a different question, and both the
envelope and the projection would have to gain a new one.

`Identity.access(token, owner, observe)` in `kernel/identity/index.ts:84`
has the shape of an is-this-person-allowed-in-that-conversation check, and has no
caller anywhere in either repository; it would decide authority, which was never
the hard part.

## Decision

Not built. What it would take, in the order the walls stand:

1. **Membership becomes a record.** `SessionInfo` gains `owner` and `members`:
   account id, who added them, when, and nothing else — no permissions, because
   a member's permissions are their account's and are never copied into a
   conversation. `session.create` stamps the owner; two new methods add and
   remove a member; the store enforces a cap the way it caps everything else.
2. **A turn gains an author.** `contract/turn-events`'s `input` payload gains
   `who`, beside the existing `source` rather than instead of it, and the
   environment fills it from the authority that submitted the turn rather than
   from anything the browser said. `render.ts` projects it onto the `user` frame,
   and `transcript.js` takes a row's face from the frame rather than from the
   reader. This is the smaller half and it is useless without the next three —
   but note that until it exists, a transcript is silent about who spoke, so
   anything built on §§3–5 without it would be unattributable by construction.
3. **The kernel learns to name a person other than the caller, for one purpose.**
   `session.whois` (KS-023) would answer a person-scope caller about a token
   naming someone else. That is ADR 0038 §3 reversed, and it is the change with
   the widest blast radius here: today the refusal is what makes the URL prefix
   pure routing and never authority, since a copied prefix cannot be turned into
   an identity anyone will vouch for. Reversing it must be narrowed by the answer
   itself — the kernel would have to check membership before it answers, which
   means the kernel has to be able to read a conversation's members, which means
   membership is no longer purely the environment's.
4. **Alice's gateway serves Bob.** With §3 in hand, `service.ts:71` admits a
   connection whose cookie names a member, and `Wire` stops conflating the run's
   person with the signed-in one: `#identity.person` is the environment's owner
   and is what `hello` reports today. The wire would have to carry both, and
   every command would have to be checked against the signed-in one. No new
   mount, no new process, and `runtime.ts:295` untouched — this is why it is the
   design worth writing down rather than one of the others.
5. **The ceiling has to become real.** Bob's turn would execute inside Alice's
   environment: her spaces, her `mode.deny`, her provider instance and her key
   (ADR 0019 §1), her budget window (ADR 0020 §5). `policy(speaker) ∩
   ceiling(session)` has no implementation and no place to live — the profile is
   assembled per target, per generation, and is not parameterised by speaker.
   Either the core resolves a per-speaker policy at turn time, which puts a
   second person's permissions inside a sandbox built for one, or an invitation
   means Bob acts with Alice's authority, which is not an invitation.

§5 is the one that is not a matter of wiring, and it is why this is a record and
not a patch.

## Alternatives considered

**Mount every member's environment into the inviter's gateway.** Lost: the
exception to `runtime.ts:295` that ADR 0038 refused, and refused for a reason
that has not changed — one target reaching a person-scope service it does not
own is the boundary, not a wiring detail. It also does not work: the transcript
lives in the owner's environment, so the extra mounts point at the wrong stores.

**Carry the stream through the kernel, addressed by person.** Lost: ADR 0019 §3,
and the kernel's line budget (ADR 0017), for a hop that reads nothing. Every byte
of a conversation would pass through the one process every other guarantee
depends on.

**A deployment-scope process that holds every environment socket and splices.**
Lost: the same exception as the first, moved into a new package, plus a single
process that can read every person's transcript — the exact shape ADR 0038 named
and declined.

**Copy the transcript to each member's environment.** Lost: there is then no
conversation, only correspondence — two stores that diverge the moment either
turn fails, with no answer to which one is the conversation. It also spreads a
person's content into sandboxes the kernel was keeping it out of, which is the
security consequence without any of the feature.

**Let the owner delegate: Bob's turns run in Alice's environment under Alice's
authority, marked as Bob's.** Lost: the property the pane exists to state. A
read-only account would not stay read-only; an invitation would lend out the
owner's permissions, her spaces and her provider key. The audit trail would say
Bob and the authority would be Alice's, which is worse than no attribution.

## Consequences

**Security.** The one-line summary is that today a person id in a URL is routing
and cannot become authority, because two independent checks — the kernel's
`session.whois` refusal and the gateway's own cookie check — each refuse a token
naming anyone else. Any build of this removes one of them and narrows the other
to a membership list. That list then becomes an authorization record, and the
first one in this system: every other access decision here is made from the
principal and the target's owner, both of which are fixed when a generation is
installed and reviewed with it. A membership row is written at runtime, by a
person, and read by the kernel. It would need the same care as a secret, and
`session.create`'s and the store's caps are not that care.

Second, and larger: without §5 an invitation is a grant of the owner's
environment — her files, her deny-list, her key, her budget. The reference
surface's own panel says this is not what an invitation means. Building §§1–4 and
leaving §5 would ship a feature whose central promise is false, and the panel
that states the promise would be the thing making it false.

**What is built instead.** A People pane that answers the question honestly for
what exists: this conversation is yours, here is what that means, and here is who
else can see that it exists. The last part is real and is not obvious — an
account with `observeOthers` can list across people (`lib/socket/sessions.ts`),
so a conversation's name and its first line are visible to a reviewer or an
administrator who never gets to read it. That distinction has never been on
screen anywhere, and it is worth a pane on its own. No invite control, no member
rows, no presence: the fan-out can say who has conversations, and nothing in this
runtime can say who is *here*, because nobody else can be.

## Revisit

When a turn can be executed under a policy resolved at turn time rather than at
mount time. §5 is the gate; §§1–4 are a fortnight and a careful review, and are
not worth starting before it.
