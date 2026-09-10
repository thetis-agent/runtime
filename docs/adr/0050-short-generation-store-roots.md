# ADR 0050 · Short generation store roots for a supervised kernel

**Status:** Accepted · 2026-09-10 — under the operator's authorization of the installer plan
**Deciders:** runtime implementers
**Amends:** ADR 0048's state layout; `lib/maintenance/prepare.ts`'s store location
**Preserves:** GN-007, ADR 0012 §4 and §6, ADR 0025, ADR 0046

## Context

ADR 0048 makes a supervisor the service and the kernel its child, so the live
kernel runs on the private store copy that `lib/maintenance/prepare.ts` makes
for each generation. That copy was nested inside the run workspace:
`<supervisor>/runs/<n>-<uuid>/state`. The kernel then builds every target's
public endpoint at `<kernel root>/targets/<43-character digest>/runs/public/current.sock`,
and `lib/socket/endpoint.ts` refuses a path over 107 bytes — the Linux
`sockaddr_un` limit.

The suffix after the kernel root is fixed at 76 bytes (`/targets/` + a 43-byte
base64url digest + `/runs/public/current.sock`), so a kernel root may be at most
31 bytes. A nested store is `/runs/` + `<n>-<uuid>` + `/state` = 50 bytes on its
own, before any prefix. A supervised deployment with even one public-socket
target therefore could not survive its first update, and with
`/var/lib/zero/supervisor` could not start at all. `test/maintenance.test.ts`
never saw this because its configuration has no targets.

This is a limit the plan did not see, and it blocks D0 as written.

## Decision

`Maintenance`'s configuration gains an optional `stateRoot`. When it is absent
the store stays where it was, nested under the run workspace, so every existing
caller and test is unchanged. When it is present, each generation's private
store is a short sibling directory under it, named `g<n>-<8 hex>` (and
`r<n>-<8 hex>` for a restore), while code, configuration and the private
maintenance socket stay inside `runs/<n>-<uuid>/` exactly as before.

The supervisor sets `stateRoot` to `<state>/g` and refuses at startup, with one
sentence naming the limit, a state root long enough to push a target endpoint
past 107 bytes. With the installed default `/var/lib/zero/g`, the longest kernel
root is `/var/lib/zero/g/g999-1a2b3c4d` at 28 bytes, leaving room for the
76-byte endpoint suffix.

Nothing else moves. The store is still a private per-generation copy, still
produced by `capture` from the stopped kernel's store, still hashed into the
generation record, still the thing a restore re-prepares from, and still
separate from the code pins that `prepare` verifies against their authorized
hashes.

## Alternatives considered

**Shorten the run workspace name** (drop the uuid, or truncate it). Even
`runs/<n>/state` costs 13 bytes and forces the supervisor root under 18 bytes,
which rules out `/var/lib/zero/supervisor`; and dropping the uuid removes the
per-attempt uniqueness that keeps a retried attempt from reusing a
half-prepared directory.

**Truncate the target digest** from 43 characters to 16. It buys 27 bytes,
which is not enough on its own, and it changes the socket path formula
`docs/headless-startup.md` publishes and the operator's proxy rules follow.

**Give the kernel a separate short endpoint root** (a `Deployment.endpoints`
field consumed by `kernel/boundary/runtime.ts`). This is the structurally right
answer and is the one to revisit: it decouples the public socket path from the
generation entirely, so the operator's proxy never has to change. It costs
kernel lines and a schema field, and the kernel budget for this work is spent on
the six-line supervisor entry, so it is not taken here.

**Bind the endpoint through a directory descriptor** (`/proc/self/fd/<n>/…`, the
trick `lib/maintenance/probe.ts` already uses to *connect* to a long path). It
frees the bind side and not the connect side: the operator's TLS endpoint
reaches the socket by absolute path, so the limit still applies to them.

## Consequences

Good: a supervised deployment with public-socket targets is possible at all; the
change is one optional field, is off by default, and removes no guarantee.

Bad: with a supervised kernel a target's public socket path now contains the
generation (`/var/lib/zero/g/g2-1a2b3c4d/targets/…`), so **the operator's TLS
endpoint must be repointed after every kernel update**. That is inherent to
GN-007 for the kernel target — its whole root travels with the transaction — and
it is not inherent to the product: the `Deployment.endpoints` alternative above
removes it. Until that record is written and implemented, `docs/install.md`
states the consequence plainly and `zero status` prints the current socket
paths so the repointing is mechanical. A stable alias for the operator's proxy
is named follow-up work, not done here.

Also bad: retained generation stores accumulate under `stateRoot` exactly as
retained run workspaces do. `zero prune-releases` does not touch them, and
ADR 0046's retirement covers target runs, not maintenance generations.

## Revisit

Immediately, when the kernel budget allows a `Deployment.endpoints` root — that
supersedes the operational cost above and is the reason this record exists.
Also when maintenance generations acquire the retention policy ADR 0046 gave
target runs.
