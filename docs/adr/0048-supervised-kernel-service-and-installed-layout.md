# ADR 0048 · Supervised kernel service and the installed layout

**Status:** Accepted · 2026-09-10
**Deciders:** the operator, on this plan; runtime implementers
**Amends:** `docs/headless-startup.md`'s launch line and `docs/ci-delivery.md`'s asset list
**Preserves:** GN-002, GN-007, ADR 0012 §4 and §6, ADR 0018, implementation note 0028–0030, ADR 0037

## Context

There is no installer. `scripts/` holds development tooling only, no `v*` tag has
ever been cut, and nothing consumes a published release. The documented operator
path is a hand-written seed and a bare `kernel/main.ts` launch
(`docs/headless-startup.md`), so the only way to change a running kernel's code
is to kill the process — the restart AGENTS.md forbids. The kernel's own upgrade
transaction already exists and is tested (`lib/maintenance/index.ts`,
`kernel/generations/maintenance.ts`, GN-007), but nothing in production drives
it: `Maintenance.start` has exactly one caller, a test.

The ask is a `curl | sh` installer that stands up a working deployment and an
updater that watches the runtime repository's tags. Both meet existing rules. A
package cannot apply an update: rule 6 makes the mount list the boundary, so no
package can write the code prefix, reach a control socket, or start and stop a
process. And the *default profile* — the pins everyone runs — moves only by a
reviewer's act with evaluator evidence (proposal §9, ADR 0018), which no timer
may press.

## Decision

**A supervisor is the service; the kernel is its child.** The unit runs
`kernel/supervisor-main.ts`, a six-line entry over `lib/maintenance/supervisor.ts`.
The supervisor holds the deployment lock, builds the kernel `Revision` from the
release's published `kernel-pins.json`, calls `Maintenance.start`, and serves a
0600 control socket accepting `status`, `upgrade`, `undo` and `stop`. Every
kernel start after the first is a GN-007 transaction, so no restart happens
outside the generation machine. Authority for `upgrade` and `undo` is an
administrator session resolved by the *running kernel*: the supervisor asks the
child `whois` over the existing maintenance IPC, and
`kernel/generations/maintenance.ts` decides. The kernel gains no knowledge of an
installer, an updater or a release; the supervisor and the updater are `lib/`
code.

**Layout.** Code and configuration under a prefix, state on one bounded volume:
`/opt/thetis/{bin,node/<v>,releases/<tag>,current,etc}` root-owned and read-only to
the service user; `/var/lib/thetis/` owned by `thetis` at 0700 holding the seed root,
the supervisor's runs, the registry, cache, profile, discovery, spaces,
`updates/` and the control socket; `/etc/thetis/master.key` 0400 root. FHS
separates add-on code from variable state, the state filesystem's enforced
capacity *is* the declared quota (`lib/sandbox-runner/index.ts` compares
`statfs` against every `maximumBytes`), and code must not eat that quota.
`--state` may be pointed inside the prefix for a single-tree install.

**A system service by default.** `thetis.service` with `User=thetis`,
`Delegate=yes`, `LoadCredential=master:/etc/thetis/master.key`, boot start and
journald logs. `--service user` remains available and `--service none` runs the
supervisor in the foreground for tests and containers. Debian's `user@.service`
delegates `memory` and `pids` but not `cpu`, and
`lib/sandbox-runner/cgroup.ts` requires all three, so user mode still needs one
root-written drop-in; a bounded persistent volume needs root regardless.
`delegate()` therefore accepts an explicitly named `.service` cgroup root as
well as a `run-*.scope`.

**The master key stays root's.** 32 bytes from `/dev/urandom` at
`/etc/thetis/master.key`, 0400 root, delivered by `LoadCredential=`; the unit's
`ExecStart` opens `$CREDENTIALS_DIRECTORY/master` as descriptor 3 and the
supervisor's `descriptors()` reopens it for every kernel launch, because a
descriptor's offset advances after the kernel's 32-byte read. The seed says
`keyFd: 4`, since the maintenance child receives the key after its IPC channel.
`--key-store tpm2` uses `systemd-creds encrypt --with-key=tpm2` where
`systemd-creds has-tpm2` succeeds. The key never enters configuration, the
environment or a sandbox, and the probe kernel never receives it.

**Releases are signed and bound to their tag.** `vMAJOR.MINOR.PATCH` annotated
tags, one GitHub Release per tag, with three additions to the existing assets:
`kernel-pins.json` (the `snapshot()` tree hash of each kernel code pin, so the
supervisor's `Revision` hashes are published rather than self-computed),
`SHA256SUMS.sig` (`ssh-keygen -Y sign -n zero-release`, verified against an
`allowed_signers` file embedded in the installer and installed under `etc/`), and
a `node` object in `provenance.json` naming the exact Node version and tarball
hashes. Discovery is the git smart-HTTP advertisement
`GET <repo>.git/info/refs?service=git-upload-pack`, bounded to 1 MiB — the
runtime library's tags, with no API token and no JSON. A release whose
`provenance.runtime.commit` differs from the commit its tag peels to is refused.

**One bounded volume, provisioned as a loop image.** `fallocate` + `mkfs.ext4` +
a `.mount` unit ordered before the service, with `RequiresMountsFor=`. The
installer writes `quotaBytes` and every `maximumBytes` in the recipe as the
image's byte size, so the `statfs` rule passes exactly. `--no-mount` accepts an
existing bounded mountpoint after checking `stat -f` capacity — this is how the
tests run. `--state-layout split` provisions a second small image for the seed
root and the supervisor's runs.

**Undo is one command.** `thetis undo` reads the supervisor's generation view,
builds the previous release's `Revision` from its retained `releases/<tag>`
directory (ADR 0012 §6 keeps the previous binary) and runs the same transaction:
generation `n+2` whose pins equal `n`'s, invariant 5 of `docs/design/generations.md`.
The store snapshot travels with the transaction, so state and code return
together as ADR 0012 §4 requires. Release directories are retained; nothing
deletes the current or previous release.

**The updater is host-side and never makes a default.** `thetis update` in
`lib/update/*`, driven by `thetis-update.timer` → `thetis-update.service` under
`ProtectSystem=strict` with `ReadWritePaths=` limited to `releases/` and
`updates/`. It checks, stages, verifies and notifies; an administrator applies. The
`--auto-update fixes|improvements` policy that would let the timer apply is
refused with one sentence naming ADR 0049, which states what such a policy would
cost and is left Proposed. The updater adds no kernel line, no deployment
process and no egress inside the deployment. `default.prepare` and `default.set`
remain unreachable to it, as to every package.

## Alternatives considered

`ExecStart=kernel/main.ts` keeps the service simple and loses the guarantee: every
kernel upgrade becomes a `systemctl restart`, a restart outside the generation
machine, and `docs/headless-startup.md` would keep documenting it.

A user service avoids root at install time and loses boot start without a logged-in
session, systemd credentials at rest, and the `cpu` controller unless root
intervenes anyway; a bounded persistent volume needs root in either case.

A key file inside the state volume readable by `thetis` avoids the credential
plumbing and loses the separation that matters: a deployment-scope process that
escaped its sandbox would read the store's key alongside the store.

An updater *package* was the literal ask and cannot apply anything — it cannot
write the prefix, reach the control socket, or start or stop a process (rule 6,
AGENTS.md). Its staged bytes would be re-verified by the host anyway, and route P
would add a deployment process, a second Internet path from inside the deployment
(ADR 0029) and a package the review page must treat like a provider. The package
therefore ships without egress, reading the host updater's status file and
providing `service/update-status` for the CLI's `status` line.

btrfs qgroups or ext4 project quotas avoid a loop image and lose portability;
`statfs` reports the parent filesystem's size unless the quota is a mount. A
tmpfs loses persistence.

Signing with a detached GPG key would need a new tool on every host;
`ssh-keygen -Y` is already present wherever OpenSSH is, and is recorded in
`docs/platform-dependencies.md` beside `flock`.

## Consequences

Good: a kernel release is applied by the transaction the design already
describes, with the probe, the connected-client-major check and the restore path
intact; the operator's path is one command and one document; a staged release is
signature-verified, tag-bound and artifact-verified before any code is copied;
the code prefix and the state volume have separate owners and separate quotas.

Bad: the supervisor is one process outside the generation machine, so upgrading
the supervisor itself is a service restart that stops the kernel with it — it
therefore holds no policy, stays small, and `thetis update` prints that a service
restart is required rather than performing one (risk R4). Idle RSS gains a second
Node process. The default layout puts the journal on the same image as the
spaces, so a space that fills the image also starves `observed.jsonl` — ADR 0012
§7's recovery reserve is not provisioned by default, and `--state-layout split`
is offered rather than chosen. Whoever controls the installer's URL controls its
trust root, as with every `curl | sh` installer. And no release can be published
while the kernel-size gate is red, so the public one-liner waits for the first
green `v0.1.0` or for a separate operator decision about pre-1.0 deliveries.

## Revisit

When the supervisor needs to change while a kernel serves — that wants either a
second supervisor generation or an exec-into-place handover, and is its own
record. When a second bounded volume becomes the default, or when release
signing moves to a hardware-held key.
