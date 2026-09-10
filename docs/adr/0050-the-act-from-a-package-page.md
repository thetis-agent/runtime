# ADR 0050 · The act may be driven from a package page

**Status:** Accepted by the operator · 2026-09-10
**Deciders:** the operator; this session
**Amends:** ADR 0018 §4 (the confirmation line on the kernel's own origin). ADR 0014 §4 was already amended by 0018 and is not reached by this record.

## Context

ADR 0018 §3 put the review page in the web UI package: diff, note,
checks, scores, unmet requirements and who runs it are a gateway's to
display. Its §4 kept the act itself in the kernel behind one line that
the kernel's own origin renders and no package serves, because "the
reviewer's own page may have been rewritten by a loop that wants its
version adopted". `kernel/socket/origin.ts` implements that as an
`Origin` check, a `__Host-thetis` `SameSite=Strict` cookie no package
origin can send, and `POST` with a JSON content type; `Act.#guard`
refuses on `origin !== 'kernel'`.

Designing the package explorer surfaced what that costs. A person with
the role to promote a release cannot promote it from the page that
shows them the release: they are sent to a second origin to read a
string and carry it back. Against a person who holds the permission the
split buys nothing — they pass through it by design — and it is what
makes one product read as two.

The operator's decision is that the fence is not what protects a
release. Publication and repository access do. What has to survive is
that the act is always explicit and always recorded.

## Decision

1. **`Act.#guard` accepts a package origin.** The `origin !== 'kernel'`
   clause is dropped. Every remaining guard stays, and together they are
   the whole of the protection: a role above `user`; a baseline equal to
   the current one, else `baseline-moved`; evidence for that exact
   digest and baseline whose gate passed; a confirmation code bound to
   person, digest and baseline, single-use and expiring; `#busy`
   serialisation of the transaction; and an observed journal row naming
   the person, the digest and the baseline.
2. **`default.prepare` and `default.set` are offered on the package
   socket**, beside the session methods, gated by role as every other
   operation there is. Nothing is removed from `origin.ts`: the kernel's
   own origin keeps both calls, so a reviewer who wants the trusted line
   can still ask for it.
3. **Explicitness moves into the act, not the origin.** A package page
   driving the act must show the digest, the baseline and the gate
   result it is about to commit, and must require a distinct confirming
   action after showing them. `prepare` issuing a code and `set`
   consuming it remains the mechanism; when one actor makes both calls
   the code is a nonce, and the confirming action is what "explicit"
   now means.
4. **The recursive case is accepted, not solved.** A package that can
   make both calls can promote its own release without a person having
   seen the line. That is recorded here rather than prevented.

## Consequences

Good: one surface. The reviewer acts where the evidence already is. The
kernel keeps every guarantee that never depended on which origin asked —
the role, the gate, the baseline compare-and-swap, the single-use code
and the observed row — and `origin.ts` remains available unchanged for
anyone who wants the stronger path.

Bad: ADR 0018's answer to "a loop that can rewrite the reviewer's page
would otherwise approve itself" is withdrawn and nothing replaces it.
The compensating controls named in the decision are publication and
repository access, and they do not cover every path by which a package
reaches a profile. A work overlay (`lib/profile/work-overlay.ts`) mounts
a person's own source tree over the release with no registry and no
review, watched and rebuilt by `WorkQueue`, so an agent that can write
`/work/<gateway>` can change the page that drives the act. Work overlays
require a person-owned environment, so the exposure is bounded to a
person holding a promoting role who runs an agent with write access to
their own work tree — which is the ordinary development case, not an
exotic one.

## Alternatives considered

**Keep `prepare` on the kernel origin and allow `set` from a package.**
The button and the whole flow move into the UI, and the code still comes
from a line no package can render, so a person still sees the digest
they are promoting. Lost: the operator asked for the fence removed
rather than narrowed, and a hop to another origin for one string is the
split this record undoes.

**Re-authenticate instead of confirming a code.** Lost: it proves the
person is present, which the session already proves, and not that they
saw this digest and this baseline.

**Leave ADR 0018 §4 standing and document the friction.** Lost: the
friction is the product, and the guarantee it defends is already
reachable by anyone with the role.
