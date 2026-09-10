# ADR 0038 · Per-person public sockets for the web surface, and `session.whois`

**Status:** Accepted · 2026-09-09
**Deciders:** the operator, explicitly approved in this session
**Amends:** `docs/00-proposal.md` §8 (how a deployment process binds a port)

## Context

§8 says a gateway is a stage that faces the network through `mount`, an
identity check, and `assets`, and that "only a `deployment` process with a
`mount/` or `service/` provision binds a port, and the kernel exposes it."
`gateway-web` already exists at person scope with `mount//ws` and carries the
wire; it has no `assets` and no port. Nothing implements the second half of
that sentence.

It cannot be built as written. The kernel is already over its 1,300-line
budget and holds no HTTP front of any kind; giving it one to "expose" a port
moves work into the one process every guarantee depends on. A deployment-scope
front that reaches into each person's socket to splice their traffic was
considered next and refused: `kernel/boundary/runtime.ts:265` forbids a target
mounting a person-scope service it does not own — `service.target.scope ===
'person' && service.target.owner !== target.owner` is refused `forbidden`.
Letting one deployment-scope process reach every person's `gateway-web` socket
means weakening that check. That is a boundary guarantee, not a wiring detail,
and the operator was not asked to trade it away for this.

## Decision

1. **Each person's `gateway-web` target serves the lifted web surface itself.**
   It keeps the wire and gains `assets/`, serving both over the same public
   unix socket every scoped target already exposes at
   `runs/public/current.sock` — the mechanism `docs/headless-startup.md`
   already documents for the person-scoped CLI targets. No new package and no
   deployment-scope process reaches into a person's sandbox; the boundary rule
   at `runtime.ts:265` is untouched.
2. **The operator's reviewed TLS endpoint maps by static rule, one per
   account.** `/login` proxies to the `gateway-login` target's public socket;
   `/<person>/` proxies to that person's `gateway-web` public socket, with the
   prefix stripped before the request reaches it. This is what "the kernel
   exposes it" becomes: public socket paths under known targets, fronted by
   TLS the operator already runs — never a port the kernel itself opens, and
   never one process crossing into another person's sandbox.
3. **D2 — the kernel gains `session.whois({ sessionToken }) → { person,
   role }`,** a capability-gated minor addition to `contract/kernel-socket`
   wrapping the existing `identity.resolveSession`. `gateway-web` calls it on
   every HTTP request and at WebSocket upgrade to check the `thetis_session`
   cookie. The kernel answers a person-scope caller only when the token names
   that run's own person; a token naming anyone else, or no one, is refused
   `forbidden`. A deployment-scope caller (`gateway-login`, resolving whoever
   just signed in) may resolve any token. Conformance id `KS-023`. The URL
   prefix is routing chosen by the proxy's static rule; it is never authority
   — each person's own run rechecks identity against what the kernel says, not
   against what the path claims, so a guessed or copied prefix changes nothing.
4. **`gateway-login` serves the sign-in page and redirects by kernel identity.**
   `GET /login` renders the form; a successful `POST /login` redirects to
   `/<person>/`, where `<person>` is the value the kernel returned for the
   asserted identity, never a value the gateway or the browser supplied.
   `thetis_session` is set with `Path=/` so the same cookie reaches every
   account's prefix; each `gateway-web` target still checks it against its own
   person before trusting it.
5. **D3 — cookie separation is unchanged.** `thetis_session` is the surface's
   cookie; `__Host-thetis` remains the trusted kernel origin's own, set only by
   the kernel's own origin, and is never read or set by `gateway-web` or
   `gateway-login`.
6. **D4 — the lifted UI adapts to the existing wire, unchanged:** the only wire
   change on `hello` is replying with a `user` frame.
7. **A broken environment is served by the person's own `gateway-web` target,**
   which is its own sandbox and stays up when that person's environment fails,
   using `env.status` and `env.reset`, already on the negotiated wire. This
   matches proposal §10's requirement that such status and reset "does not
   need the person's environment to start" (ADR 0018 §6) without adding
   another process to serve it.

## Alternatives considered

**A deployment-scope `gateway-front` splicing bytes to each person's socket**
(the shape first proposed for this record). Lost: it needs an exception in the
boundary rule at `runtime.ts:265` that lets one deployment-scope target mount a
person-scope service it does not own, which is a guarantee, not a convenience;
it is also one more process and one more package for what a person's own
target can serve itself.

**Forge `Origin` against the trusted kernel origin's `POST /session`** from a
gateway's own page, avoiding a second identity check entirely. Lost: a
browser's `Origin` check exists to stop exactly this; using it as a service's
credential turns a client-side defence into a security boundary it was never
built to be.

**A kernel-side HTTP front** that serves assets and terminates the browser's
connection itself, since the kernel already owns one origin. Lost: the kernel
is over its line budget before this addition, and ADR 0019 already moved the
kernel out of every stream it isn't itself a party to; a browser's chat traffic
is exactly such a stream.

## Consequences

Good: no new package, no new deployment-scope process, and no exception to the
boundary rule that separates person sandboxes; `gateway-web`'s existing wire
and isolation (KS-004) are unchanged; a person's own run authenticates its own
session against the kernel rather than trusting the URL that reached it;
status and reset for a broken environment stay available because the target
serving them is not the environment that broke.

Bad: a person's id appears in the URL path (`/alice/`, `/bob/`). The proxy
needs one static rule per account, so adding an account is a proxy-
configuration edit and a new target — a generation switch — not something the
runtime discovers on its own. `session.whois` adds roughly 20 lines against
the kernel's budget.

## Revisit

When the kernel exposes mounts by some mechanism of its own, or when accounts
can be added to a running deployment without a generation switch.
