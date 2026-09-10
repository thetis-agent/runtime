# Install Zero

One command stands up a working deployment: a supervised kernel, a bounded state
volume, an administrator account, and an updater that watches the runtime
library's release tags. This document is the operator's reference for that
command, for `zero status`, `zero update`, `zero undo`, recovery and removal.

**There is no published release yet.** No `v*` tag has ever been cut, and none
can be published while the kernel-size gate is red — 1,387 counted lines against
a 1,300-line budget at the time of writing (`TODO.md` §2, `docs/ci-delivery.md`);
run `scripts/size.ts` for the current figure. Until the first green
`v0.1.0`, install from a local `file://` release built from
`scripts/release.ts` + `scripts/distribution.ts` output with a throwaway signing
key; the "First install on this host" section below does exactly that. The
public one-liner is written here so its shape is reviewable, not because it
resolves today.

## The one-liner

```sh
curl -fsSL https://get.thetis-agent.dev/install.sh | sh
```

Read it before you run it — that is the point of a short script:

```sh
curl -fsSL https://get.thetis-agent.dev/install.sh -o install.sh
less install.sh
sh install.sh
```

Whoever controls that URL controls the trust root, as with every `curl | sh`
installer. What the script itself guarantees is that the *bytes it downloads*
are the reviewed ones: it embeds the release signing key's `allowed_signers`
line and the exact Node tarball hashes, so a swapped download fails
verification instead of installing (ADR 0048, risk R2).

## What it asks

Every prompt has a flag, `--yes` takes the defaults, and `--dry-run` prints each
privileged step instead of running it.

| Prompt | Default | Flag |
| --- | --- | --- |
| Code prefix | `/opt/zero` | `--prefix <dir>` |
| State volume | `/var/lib/z` | `--state <dir>` |
| State size | `4G` | `--state-size <size>` |
| State layout | `one` | `--state-layout one\|split` |
| Use an existing bounded mountpoint | provision a loop image | `--no-mount` |
| Service | `system` | `--service system\|user\|none` |
| Service account | `zero` | `--user <name>` |
| Administrator account id | `admin` | `--operator <id>` |
| Administrator password | *asked twice, echo off* | `--password-fd <n>` |
| Public origin | *asked* | `--origin https://…` |
| Update policy | `none` | `--auto-update none` |
| Key store | `file` | `--key-store file\|tpm2` |
| Version | the script's pinned tag | `--release <tag>` |
| Release base URL | GitHub Releases | `--release-url <url>` |

Also: `--remote <url>` (where release tags are read from, `https://` or
`file:///`), `--allowed-signers <path>` (overriding the line embedded in the
script), `--print-unit <name>` (print one systemd unit exactly as it will be
installed), `--allow-root`, `--purge-state`, `--uninstall`, `--dry-run`,
`--yes`, `--help`.

Two honest limits of the current script, both printed rather than silent:

- It **checks** that the Node on `PATH` is the exact version the release's
  `provenance.json` names and refuses any other, then copies that Node into the
  prefix. It does not yet download the release's own Node tarball and check it
  against `provenance.node.sha256`. Install Node 24.18.0 first.
- `--service none` keeps its master key at `<prefix>/etc/master.key` mode 0600
  instead of `/etc/zero/master.key` mode 0400, because a foreground install has
  no separate service account for the root-only file to protect it from. Use
  `--service system` for anything real.

The administrator's password is read from the terminal with echo off and
confirmed twice, or from `--password-fd <n>`. It is refused if empty or under
twelve characters. `--yes` with no password source is an error — there is no
default password. The plaintext reaches only `credential(id, password)` and the
resulting `login-state/accounts.json`, which holds a salted scrypt record and
nothing else; it never appears on a command line, in `install.json`, in the
seed, in the journal or on the terminal. `--dry-run` shows that step as
`write accounts.json (1 account)`, without the id.

`--auto-update` accepts only `none`. Any other value is refused with one
sentence naming **ADR 0049**, which is Proposed: it states what a policy that
let the timer press the maintenance command would cost, and waits for the
operator's decision. The policy's code path is built and tested; nothing in the
shipped default behaves as if that record were accepted.

## What it needs from the host

The script checks all of this and refuses with one sentence per failure:

- `x86_64` or `aarch64` Linux, `/bin/sh` = dash, systemd ≥ 252.
- bubblewrap with unprivileged user namespaces enabled, and `bwrap --unshare-user true` working.
- cgroup v2 unified hierarchy, with `cpu memory pids` delegable to the service's cgroup.
- `/dev/net/tun` and `/usr/bin/slirp4netns` for any egress target.
- `git`, `flock`, `cat`, `tar`, `gzip`, `sha256sum`, `ssh-keygen`, and `fallocate` + `mkfs.ext4` unless `--no-mount`.
- Root, once, for six named steps, each printed before it runs and all shown by `--dry-run`.

Versions and hashes are in [platform-dependencies.md](platform-dependencies.md).
Node is installed under the prefix at exactly the version the release's
`provenance.json` names — never the distribution's Node, because
`lib/artifacts/verify.ts` refuses any other (ADR 0037).

## The layout it creates

```
/opt/zero/                       code · root-owned, read-only to the service account
├── bin/zero                     the operator command
├── node/v24.18.0/ · node/current
├── releases/v0.1.0/             the extracted distribution and its release assets
├── current → releases/v0.1.0    what the supervisor was last told to serve
└── etc/  install.json  seed.json  recipe.json  allowed_signers  zero.service
/var/lib/z/                      state · one bounded volume, owned by the service account, 0700
├── kernel/                      the seed store the first generation is copied from
├── supervisor/                  runs/<n>-<uuid>/{code,configuration.json,kernel.sock}  observed.jsonl
├── g/                           each generation's private store (ADR 0050)
├── registry/ cache/ profile/ discovery/ deployment.json
├── initial/ spaces/<operator>/ login-state/accounts.json
├── updates/status.json          the only thing the deployment may read about updates
└── supervisor.sock              0600, the operator command's only way in
/etc/zero/master.key             0400 root:root, 32 bytes
```

`--state` defaults to `/var/lib/z`, not `/var/lib/zero`, and the installer
refuses a longer one. That is not tidiness: the live kernel's root is a
per-generation store under `<state>/g`, and every target's public socket sits
76 bytes below that root, against the 107-byte Linux socket path limit. ADR 0050
explains it and records the cost.

## Sign in

The kernel serves unix sockets; the operator puts a reviewed TLS endpoint in
front of them. The installer prints the three paths and a proxy snippet. They
follow the formula in [headless-startup.md](headless-startup.md), rooted at the
**live generation's** store:

```
/login   → <state>/g/<generation>/targets/<sha256-base64url("login")>/runs/public/current.sock
/<id>/   → <state>/g/<generation>/targets/<sha256-base64url("<id>-web")>/runs/public/current.sock
kernel   → <state>/kernel/origin.sock         (its own origin, its own __Host-thetis cookie)
```

**The generation is in the path, so those rules change after every kernel
update.** `zero status` prints the current root; repointing the proxy is
mechanical, and removing the need for it is the follow-up ADR 0050 names.

Then sign in at `https://<origin>/login` as the id you chose.

## Update

```sh
zero status                       # state, generation, release, socket root, policy
zero update --check               # read the tags, stage, verify, write updates/status.json
zero update --apply --release v0.1.1
zero undo
zero prune-releases
```

`zero-update.timer` runs `zero update --check` hourly with a randomised delay.
Checking is all it does: it reads the runtime library's tags from the git
reference advertisement (bounded to 1 MiB, no API token, no JSON), stages the
highest greater version into `releases/.staging.<tag>`, and promotes it only
after the signature, the checksums, the provenance-to-tag binding, the published
kernel pin hashes and every execution artifact have verified. Then it writes
`updates/status.json` and stops. Nothing changes until a person runs
`zero update --apply`.

`--apply` asks for the administrator's password, exchanges it for a session at
the login target, and sends one command to `supervisor.sock`. From there it is
the kernel's own maintenance transaction (GN-007): drain, freeze, export the
stopped store, copy and hash-verify every code pin, launch the candidate in
probe mode with no writers, probe it against every connected client major, stop
the old kernel, activate, repoint. If anything fails before the old kernel
stops, the old kernel keeps serving. If it fails after, the transaction
re-prepares from the captured snapshot; if that also fails the target is `FAILED`
and `reset` is the documented edge (ADR 0028, ADR 0043) — `zero status` says so
and `zero undo` refuses.

`zero undo` runs the same transaction with the previous release's revision:
generation `n+2` whose pins equal `n`'s, with the store travelling alongside, as
ADR 0012 §4 requires. The previous release directory is kept; nothing removes
the current or previous release, and `zero prune-releases` retires only the
others.

Two things to know before you rely on this:

- **A session does not survive a kernel switch.** Identity sessions live in the
  kernel's memory, and `--apply` replaces the kernel process. `zero undo` after
  an `--apply` asks for the password again. This is correct — the supervisor asks
  the *live* kernel who you are on every command, and never caches a principal.
- **When a release changes the supervisor itself** (`lib/maintenance` in
  `kernel-pins.json`), `zero update` says so and does nothing else: applying it
  needs a service restart, which stops the kernel with it. The supervisor is the
  one process outside the generation machine (ADR 0048, risk R4); it never
  restarts itself.

Inside the product, `packages/autoupdate` shows the same notice on the `status`
page. It reads `updates/status.json` from a read-only mount, has no egress, and
can apply nothing — a package cannot write the code prefix, reach
`supervisor.sock`, or start or stop a process. That is the boundary, not a
missing feature.

## Recover

| Symptom | What to do |
| --- | --- |
| `zero status` says `FAILED` | The kernel stopped mid-transaction. Reset the target through the generation table (ADR 0028); `zero undo` is refused until then. |
| `zero status` cannot reach the socket | The service is down. `systemctl status zero`, then `journalctl -u zero`. The supervisor holds the deployment lock, so a second one is refused rather than admitted. |
| The proxy 502s after an update | The socket root moved with the generation. Read `zero status` and repoint. |
| A staged version will not verify | Nothing was installed. `updates/status.json` records `verified: false`; the signature, the tag binding or the artifacts refused it. |
| The master key is lost | The sealed secrets are unrecoverable. The installer prints this once, at install time: back up `/etc/zero/master.key`. |

## Remove

```sh
sh install.sh --uninstall
sh install.sh --uninstall --purge-state
```

Without `--purge-state` the state volume and `/etc/zero/master.key` are left
alone, so a reinstall finds its store and its secrets. With it, the volume is
unmounted and removed and the key is deleted.

## What is tested, and what is not

`test/installer.test.ts` runs this script inside the mandatory sandbox with
`--prefix <tmp> --state <tmp> --no-mount --service none --yes` and a signed
`file://` release built by `test/release-fixture.ts`. It pins: the ADR 0049
refusal; the state-root limit; `--dry-run`'s exact privileged-step list against a
golden file, and that a dry run writes nothing; that every embedded unit is
byte-identical to its copy under `units/`; that a missing signature, a forged
signature, an altered asset and a tag that resolves to another commit each stop
the install **before any file exists under the prefix**; that a fresh install's
seed validates against the deployment contract with `keyFd: 4` and a registry
seed target; that `accounts.json` validates against the login authority's own
schema and holds exactly one record; that neither the password nor the id
reaches the installer's output; that a rerun is a no-op; and that `--uninstall`
leaves the state alone without `--purge-state`.

What is **not** tested here, because this host allows no privileged action:
provisioning and mounting the loop image, creating the service account, writing
`/etc/zero/master.key`, installing units, `systemctl`, and starting the service.
Those are the section below, for the operator. A supervised kernel actually
starting, updating and undoing *is* tested, separately, by
`lib/maintenance/supervisor.test.ts`.

## First install on this host

**This section is for the operator to run. Nothing in it has been executed** —
this host allows no privileged action, no `/opt` or `/etc` writes, no real
`systemctl`, and no `zero` account, so every automated test runs with
`--prefix <tmp> --state <tmp> --no-mount --service none`. What follows is the
real, privileged path, against a local release rather than a published one.

Build the release and serve it, as your ordinary user, from the runtime checkout:

```sh
cd /tank/data/Dev/thetis-agent/runtime
export THETIS_NODE=/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node

# 1 · the offline registry and profile, then the distribution archive
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/release.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/distribution.ts /tmp/zero-release/v0.1.0

# 2 · a throwaway release signing key (a real release uses the operator's key in CI)
mkdir -p /tmp/zero-release/v0.1.0
ssh-keygen -t ed25519 -N '' -C zero-release -f /tmp/zero-release/release-key
printf 'release@thetis-agent namespaces="zero-release" %s\n' \
  "$(cat /tmp/zero-release/release-key.pub)" > /tmp/zero-release/allowed_signers

# 3 · the remaining assets, then the signed manifest
cp profiles/default/{package.json,profile.lock.json,registry.json,registry.bundle} /tmp/zero-release/v0.1.0/
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/kernel-pins.ts > /tmp/zero-release/v0.1.0/kernel-pins.json
# provenance.json and platform.txt: copy the shapes CI writes (.github/scripts/verify.sh),
# with runtime.commit set to the commit you are installing and node.version to v24.18.0.
cd /tmp/zero-release/v0.1.0
sha256sum thetis-distribution.tar.gz package.json profile.lock.json registry.json \
  registry.bundle provenance.json platform.txt kernel-pins.json > SHA256SUMS
ssh-keygen -Y sign -n zero-release -f /tmp/zero-release/release-key SHA256SUMS

# 4 · serve it on the loopback, in another terminal
cd /tmp/zero-release && python3 -m http.server 8123 --bind 127.0.0.1
```

Then install, as root, from the runtime checkout's `install.sh`:

```sh
sudo sh /tank/data/Dev/thetis-agent/runtime/install.sh \
  --prefix /opt/zero --state /var/lib/z --state-size 4G \
  --service system --user zero \
  --operator admin --origin https://zero.example \
  --release v0.1.0 --release-url http://127.0.0.1:8123 \
  --allowed-signers /tmp/zero-release/allowed_signers \
  --key-store file --auto-update none --allow-root --dry-run
```

Read the printed privileged steps. There should be six, and no file should yet
exist under `/opt/zero`. Then run the same command **without** `--dry-run`, and
answer the two prompts: the administrator id (`admin`) and its password, typed
twice, echo off.

What to observe, in order:

1. Preflight prints nothing and exits into the prompts. A failure is one
   sentence naming the missing thing; fix it and rerun.
2. Verification order in the log: signature, then checksums, then
   `provenance.runtime.commit` equals the tag's commit, then extraction, then
   pins and artifacts. **Nothing under `/opt/zero` before the signature passes.**
3. `/var/lib/z.img` is created, `mkfs.ext4` runs once, and
   `systemctl status var-lib-z.mount` is active before `zero.service` starts.
   `stat -f -c '%S %b' /var/lib/z` should report a capacity equal to the
   `quotaBytes` written into `/opt/zero/etc/recipe.json`.
4. `journalctl -u zero` shows the supervisor's
   `{"ok":true,"value":{"ready":true,…}}` line with its control socket path,
   then the kernel's own `{"ok":true,"value":{"ready":true}}` row.
5. `zero status` answers with `state LIVE generation 1 release …`, the socket
   root, `update policy none`, and the sign-in line.
6. `zero update --check` reports `Zero v0.1.0 is the newest version.` and writes
   `/var/lib/z/updates/status.json`.
7. Sign in through your TLS endpoint at `https://zero.example/login` as `admin`,
   using the proxy rules the installer printed, and complete one turn.
8. `systemctl stop zero` and `systemctl start zero`. The supervisor replays
   observed generation records and probes recovered targets before printing
   ready (ADR 0030). `zero status` should return to `LIVE`.
9. Record the measurements in `docs/implementation-status.md`. **Idle RSS now
   includes the supervisor**, a second Node process with the same heap flags as
   the kernel, so the ADR 0041 figure must be re-measured rather than carried
   over.
10. Strike the "reproducible installation path to `/opt/zero`" item in
    `TODO.md` §3 with the evidence line.

To publish a second version and exercise the update path end to end, repeat
steps 1–3 into `/tmp/zero-release/v0.1.1` with a bumped tag, then
`zero update --check` and `zero update --apply --release v0.1.1`, then
`zero undo`. Expect to sign in again for the undo, and to repoint the proxy
after each — both are recorded above.
