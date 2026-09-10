# contract/kernel-socket · 1.0.0

Formerly `contract/host-socket`; renamed with ADR 0017. Its methods are
the kernel calls: the unit of delegation to packages.

Ships with the kernel. Governs every message between an environment (or a
deployment-scope gateway or service) and the kernel: line-delimited JSON
over a unix socket the run inherits at start as a file descriptor,
with a per-run token delivered on the same descriptor. Neither the
socket path nor the token is ever in the run's environment variables
or on its disk; the core's spawn wrapper marks the descriptor
close-on-exec, so a stage's child inherits nothing.

## Connect

```ts
{ v: "1", token: string, capabilities: string[] }          // client → kernel
{ v: "1", capabilities: string[], person: string, project?: string, scope: "person" | "deployment" }   // kernel → client
```

Each side lists the capabilities it supports; a method not in both
lists is not called. This is the compatible / capability-gated /
incompatible rule: a new method is a capability (minor); a changed
method shape is a major. Both directions are tested: old client against
new kernel, new client against old kernel.

## Methods

Request `{ id, method, params }`, response `{ id, result }` or `{ id,
error: { code, message } }`, note `{ note, params }` one-way. Unknown
fields ignored everywhere. Two logical channels on one socket: control
(`cancel`, `health.probe`, `run.stop`) has priority over bulk
(provider streams over their own sockets are not on this socket); frames are bounded (ADR 0015 §9).

| Method | Direction | Scope rule |
| --- | --- | --- |
| `session.list`, `session.create`, `session.submit`, `session.subscribe`, `session.cancel` | client → kernel | only the person the token names; a gateway passes the person its `identity` returned and the kernel checks it against the gateway's scope |
| `usage.report` | provider → kernel | a call's final usage counters with the caller's run token; appended to the log uninterpreted, labelled by the provider's scope (ADR 0019) |
| `token.whois` | service → kernel | the person and scope behind a run token presented on a service socket |
| `session.whois` | client → kernel | the person and role behind a `thetis_session` token; a capability-gated addition wrapping `identity.resolveSession`. A person-scope caller may resolve only a token naming that run's own person; a deployment-scope caller may resolve any (ADR 0038, KS-023) |
| `profile.get` | client → kernel | the resolved package list and paths for this run |
| `install`, `snapshot`, `prune`, `results.submit` | package → kernel | the delegation calls of ADR 0017: install verifies the hash against the pin; snapshot and prune act on kernel-owned directories; results carry their identities |
| `package.register` | client → kernel | a package's `init`-time `{ requires, provides, spawn }`; matched like static requirements; refused by name outside the package's envelope (ADR 0016) |
| `secret.has` | client → kernel | whether `secret/<name>` resolves for this caller; never the value |
| `health.probe` | kernel → client | must answer within the probe budget |
| `turn.report` | client → kernel, note | the core's stage rows, summarized once per turn, labelled candidate-reported in the log (ADR 0014); tokens are not sent one by one |
| `env.updated` | kernel → client, note | the profile changed; the core writes the one-line notice into the conversation at the next turn boundary |
| `run.stop` | kernel → client | a limit was exceeded or a restart is due; the reason is in params; the client runs every stage's `shutdown()` inside the bounded wait |
| `run.children` | client → kernel, note | the pids of children a stage owns, so the kernel can end them with the run |

## Conformance

For a client: connects on the inherited descriptor with the token or
is refused; ignores unknown notes; answers `health.probe`; does not
call a method outside the negotiated set; a child process it spawns
cannot open the socket (tested by the runner adapter).

For the kernel: refuses a session call for a person the token does not
name; refuses `log.append`; never returns a secret value; the bench
token's `llm.complete` ignores `model`.

## Change rules

New method: minor, gated by capability. Changed params or result shape
of an existing method: major. A new note type: minor.
