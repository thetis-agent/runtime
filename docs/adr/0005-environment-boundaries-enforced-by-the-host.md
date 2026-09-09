# ADR 0005 · Environment boundaries are enforced by the host, through a sandbox runner

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Supersedes:** the sixth and seventh drafts' "containers as an ops option" and "the file tools enforce this"

## Context

The operator read the seventh draft and asked whether one user could
halt everyone else, whether a person's agent could tamper with spaces
outside its own, and whether the boundary should be a container or
hypervisor and whether that could be a package. The answers on the
draft as written were: yes through resource exhaustion and through
localhost; yes, because the boundary was a stage the person's own agent
can rewrite; and no, it cannot be a package, because a package runs
inside the boundary it would define.

Thetis had the same soft boundary and said so (`docs/plans/multi-user.md`
§2.5: per-name denials are advisory; `SETUP.md`: the workspace remains
shared between accounts). The round-one and round-two critics made
containers an ops option to stay light. The operator's requirement is
that boundaries hold regardless of tool design or safeguards.

## Decision

1. **The host never runs an environment, a deployment-scope gateway, or
   a service in its own security context.** `envs` starts every one of
   them through a **sandbox runner**: a host component with one
   interface and several implementations, chosen in host configuration
   by an administrator with a pull request. It is not a package and
   cannot be selected by a profile.
2. **The runner interface is the spaces model.** A run is described by
   the mounts it may see and their modes, its resource limits, and its
   network mode:
   ```
   run(target, {
     mounts: [ {envs/<user>, rw}, {spaces/people/<user>, rw}, {spaces/projects/<p>, rw}…, {spaces/company, ro|rw}, {registry cache, ro} ],
     limits: { memory, cpu, pids, disk },
     network: none | egress | mount,
     sockets: [ the host's session and llm sockets, with a per-run token ]
   })
   ```
   Nothing outside the mount list exists inside the run. The file tools
   remain, as a convenience with good error messages; they are no longer
   the boundary.
3. **Runners:** `bwrap` (Linux namespaces and cgroups through bubblewrap;
   no daemon, no root; the default), `podman` (rootless containers from
   an image, for deployments that want one), `microvm` (Firecracker or
   equivalent, for hostile tenants), and `none`, which prints a warning
   at every start and is refused when more than one account exists.
   Each adapter builds a command line; each is a few hundred lines.
4. **Resources are limited per run, not only memory:** CPU share, pid
   count, disk quota on the environment directory and the person's
   space, and a spend and request rate at the `llm` door per person. A
   run that exceeds a limit is stopped and the reason is written into
   the person's conversation.
5. **Person-scope services listen on unix sockets inside the environment
   directory, never on TCP.** Only a deployment-scope gateway or service
   with a `mount/` or `service/` provision may bind a port, and only
   inside its own network namespace, exposed by the host.
6. **Every run gets a per-run token for the host's sockets.** A process
   cannot present itself as another environment.
7. **Deployment-scope processes keep Thetis's circuit breaker.** A
   version that fails health never takes over (start, probe, switch,
   stop); a version that takes over and then dies repeatedly is replaced
   by the previous default automatically and the incident is written to
   the metrics page.
8. **Shared spaces are shared by design and are recoverable, not
   protected.** A member can damage a project space. The host snapshots
   spaces on a schedule and at every default change and keeps them for a
   configured period.

## What can still happen, stated plainly

- A person can destroy their own environment and their own space. That
  is the design; `env reset` and the snapshot restore it.
- A member of a project can damage that project's space. Snapshots
  recover it.
- A reviewed default version can be bad for everyone until the breaker
  or a person undoes it. Review and the breaker are the defence.
- A kernel exploit escapes a namespace runner. The `microvm` runner
  exists for deployments where that matters.

## Alternatives considered

**Containers as an ops option** (drafts six and seven). Lost because a
boundary that can be off is a boundary that will be off, and the
operator's requirement is that it holds regardless.

**Docker as the runner.** Lost as the default because it needs a daemon
and a socket that is root-equivalent; it is admissible through the
`podman` adapter's interface for a deployment that already runs it.

**The sandbox as a package.** Lost because a package runs inside the
boundary. A person's profile choosing its own fence is no fence.

**A per-environment unix user and groups only, no namespaces.** Lost
because localhost is shared: a person could connect to another's
person-scope services. Kept as the mechanism inside the `bwrap` runner
for file ownership.

## Consequences

Good: the questions in the context all become no. Spaces are enforced
by the mount list. Resource exhaustion is bounded per run. A person's
rewritten tools reach nothing new. The design holds for one user and
for hostile tenants by changing one configuration line.

Bad: the host grows by the runner adapters, a few hundred lines each.
Startup of an environment gains the namespace setup, tens of
milliseconds with bubblewrap. Deployments on platforms without
namespaces run `none` and are told so at every start. Services that
assumed TCP on localhost must use unix sockets.

## Revisit

When a deployment hosts tenants who are adversaries of one another,
`microvm` becomes the default. When a runner adapter exceeds five
hundred lines, the interface is wrong.
