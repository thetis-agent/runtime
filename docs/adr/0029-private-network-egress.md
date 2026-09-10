# ADR 0029 · Configure egress inside the mandatory network namespace

**Status:** Accepted · 2026-09-09
**Deciders:** the implementation session, preserving the specified network boundary
**Supersedes:** nothing

## Context

ADR 0005 and the proposal require a private network namespace even when a
registered service requires outbound network access. The implemented runner
provides only `none`; a compatible provider therefore cannot reach its
vendor. Sharing the kernel's network namespace would remove the boundary.
The platform provides slirp4netns 1.2.0 with libslirp 4.7.0.

## Decision

Keep bubblewrap as the only sandbox adapter, including its user namespace,
private network namespace, dropped capabilities and disabled nested user
namespaces. Add `none` and `egress` to the immutable run plan, defaulting to
`none`. For egress, hold package execution behind a descriptor barrier while
a kernel-controlled slirp4netns helper configures the private namespace.
Require `--disable-host-loopback`; expose no inbound forwarding or helper
control socket. Supply a read-only resolver configuration for the helper's
private DNS address. Bound helper readiness, output and process lifetime;
account the helper in the run's cgroup and stop it with the run. Refuse
startup if any setup step fails. The kernel still authorizes egress against
the recorded package requirements and declaration.

This is an implementation of the specified egress mode, not a relaxation of
its boundary. No payload starts in the kernel's network namespace. The
helper is a platform boundary tool, not a package-selected service.

## Alternatives considered

Sharing the kernel's network namespace loses isolation. Privileged veth and
firewall provisioning adds a privileged persistent component. Package-owned
network helpers would let the package select its own boundary. These
alternatives are not implemented.

## Consequences

Good: outbound provider traffic works through an explicitly granted private
network while host loopback remains unavailable. Bad: each egress run adds
a platform helper and its resource cost. Egress does not mean an Internet-
only firewall; routable deployment destinations remain reachable unless
external network policy denies them, as the existing egress contract says.
No memory, storage, latency, secret, gate or act guarantee is waived.

## Revisit

If a measured compatibility issue or helper vulnerability requires a different
implementation of the same isolated egress contract.
