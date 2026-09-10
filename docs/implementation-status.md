# Implementation status

Updated 2026-09-10. This is a current summary, not a chronological test journal.
Historical investigations and measurements remain in git history.

## Implemented

The runtime and independent package repository supply the kernel, sandboxed
environments and services, immutable package registry, evaluator, person-scoped
browser gateway, login, CLI, durable provider budgets, encrypted secrets and
supervised generation recovery.

The installer provisions signed releases, the exact verified Node runtime,
bounded state volumes, a dedicated system service and administrator credentials.
It configures a real model before first boot; the scripted provider requires
explicit `--demo`. Product defaults are Thetis. An independently named personal
installation is an explicit choice.

Distribution pins describe the assembled archive, not unshipped checkout
metadata. Release fixtures use that same production assembly path. Systemd unit
embeddings are generated from the canonical files in `units/`. CI also performs
a privileged installation, terminal chat, service restart, another chat and
recorded uninstall. Publication consumes the exact successful CI candidate.

Routine fixes and configuration details have been consolidated into
[implementation notes](implementation.md). [ADRs](adr/README.md) are reserved for
major architectural changes.

## Verification

The complete sandboxed suite passed: 588 tests, zero failures, cancellations or
skips. Build, strict checks, generated-file freshness, shell checks and workflow
validation also passed. The native system-service smoke passed installation,
chat, restart, chat and purge. The signed installed lifecycle covers browser
login/chat, saved transcripts after restart, update, undo and recovery. An isolated
Chrome check also passed transcript restoration on reconnect and reload, without
duplicate replies or page errors. A separately authorized live-provider
check passed four turns across two accounts with a $0.04 cost ceiling.

Release publication and host-specific browser routing are validated separately
from the offline suite. CI retains its coverage, diagnostics and exact verified
delivery candidate; publication cannot proceed without that successful run.

Current measured kernel size is 1,423 counted lines against 1,500. The latest
coverage-suite performance checks measured 157,421,568 bytes against 512,000,000
and 1,616.71 ms against 2,000. Snapshot worker I/O now avoids redundant thread-pool
round trips while retaining exact copy and artifact verification. No assertion was removed or threshold raised in
this remediation.

## Operational boundaries

- Host-local chat needs no public proxy. Browser access requires the host's TLS
  proxy to route the login and person sockets; the trusted kernel origin remains
  separate. See [installation](install.md).
- Unattended apply remains refused while ADR 0049 is Proposed.
- A release changing Node or the maintenance supervisor requires an explicit
  host service migration, not an automatic hot apply.
- Offline CI uses test-only signing keys and a scripted provider. A real-model
  acceptance check is opt-in and uses an operator-authorized key source.
- Milestone acceptance is separate from an installer or test pass. See
  [remaining work](../TODO.md) for the outstanding specification audit.
