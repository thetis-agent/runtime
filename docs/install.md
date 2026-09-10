# Install and update Zero

The installer creates a supervised kernel, bounded persistent storage, an
administrator account and an hourly update check. It downloads and verifies the
release's exact Node runtime; Node and npm are not installation prerequisites.
The host still needs the Linux boundary tools listed below.

**The public installation path requires a published, signed runtime release.**
The kernel size gate is still above its 1,300-line budget. Local signed fixtures
exercise installation and updates without publishing a release or bypassing that
gate. The commands below describe the published asset once that gate is green
and the protected release environment has its signing key configured.

## Install

Download the release installer and review it, then run it as root for a system
service:

```sh
curl -fsSL https://github.com/thetis-agent/runtime/releases/latest/download/install.sh -o install.sh
less install.sh
sudo sh install.sh --allow-root
```

The equivalent piped form is:

```sh
curl -fsSL https://github.com/thetis-agent/runtime/releases/latest/download/install.sh | sudo sh -s -- --allow-root
```

The installer prompts on the terminal for the prefix (default `/opt/zero`), state
root (default `/var/lib/z`), service mode (default `system`), public HTTPS origin,
administrator id (default `admin`) and a password entered twice with echo off.
The code prefix's parent must exist. Code and state must be separate canonical
paths without symlinks, spaces, shell metacharacters or overlapping roots.

A release's installer embeds that release's tag and public signing identity.
It verifies the signed asset list, all asset hashes and the annotated tag's
runtime commit. It downloads the exact Node archive from `nodejs.org`, verifies
its digest against signed provenance before executing it, and verifies every
kernel pin and execution artifact before creating the installation. The checkout
installer has a placeholder trust root; local fixtures supply `--allowed-signers`.

For a noninteractive installation, provide `--yes`, `--origin`, and an already
open password descriptor via `--password-fd`. There is no default password.
Passwords must have at least twelve characters. Only the salted scrypt account
record is stored; passwords never enter arguments, environment variables, the
seed, installation choices or logs.

## Choices

| Flag | Meaning and default |
| --- | --- |
| `--prefix <path>` | Code directory, `/opt/zero` |
| `--state <path>` | Short state root, `/var/lib/z`; `<state>/g` must fit in 18 bytes |
| `--state-size <bytes>` | State capacity ceiling, `4294967296`; decimal bytes, at least 64 MiB |
| `--state-layout one\|split` | One state volume, or reserved volumes: `kernel` 256 MiB, `supervisor` 1 GiB and `g` 2 GiB; at least 4 GiB total |
| `--no-mount` | Use an existing directory on a filesystem whose enforced capacity fits the declared ceiling |
| `--service system\|user\|none` | Dedicated system service, current account's user service, or foreground setup |
| `--user <name>` | System service account, `zero` |
| `--operator <id>` | Administrator id |
| `--password-fd <n>` | Read the administrator password from this descriptor |
| `--origin <https-origin>` | Public origin, without a path |
| `--key-store file\|tpm2` | Master key storage; TPM2 requires a system service and usable TPM2 |
| `--auto-update none` | Check and stage automatically; administrator applies |
| `--release <vMAJOR.MINOR.PATCH>` | Override the installer's pinned tag |
| `--release-url <base>` | Assets at `<base>/<tag>/<asset>`; HTTPS or `file://` |
| `--remote <url>` | Runtime git remote providing annotated release tags |
| `--node-url <base>` | Verified Node archive mirror; HTTPS or `file://` |
| `--allowed-signers <file>` | Explicit release trust root for a local or private delivery |
| `--dry-run` | Print the actual selected provisioning path without writes or password input |
| `--yes` | Use defaults without prompting; still requires origin and password source |
| `--uninstall` | Remove resources recorded for this prefix |
| `--purge-state` | Also remove recorded volumes, state and key |
| `--print-unit <name>` | Print an embedded unit template for review |
| `--allow-root` | Allow installation under sudo from a login shell |

A completed install rerun is a no-op. Another version must go through `zero
update`. An incomplete prefix, nonempty state directory or existing master key
is refused for inspection; the installer does not overwrite accounts, format
an existing image or replace a key.

## Host and service modes

The installer requires Linux x64 or arm64, working unprivileged bubblewrap user
namespaces, unified cgroup v2, `/dev/net/tun`, `slirp4netns`, `unshare`, git,
flock, GNU tar, gzip, xz, sha256sum, ssh-keygen, coreutils and a POSIX shell. HTTPS
downloads use curl or wget. Provisioned volumes additionally require fallocate,
mkfs.ext4 and systemd. Service credentials require systemd 252 or newer.
Writable deployment filesystems must have enforced capacity; a directory on an
unbounded host filesystem does not satisfy the sandbox quota check.

System mode creates a dedicated account and installs `zero.service`,
`zero-update.service`, `zero-update.timer` and the required mount units. Split
mode makes the supervisor depend on all reserved mounts before it starts. It gives
`zero.service` `Delegate=yes`, writes root-owned code and configuration, and
hands the root-only `/etc/zero/master.key` to the supervisor with
`LoadCredential=`. TPM2 mode uses `LoadCredentialEncrypted=`. The supervisor
reopens the credential for each kernel launch; the kernel reads descriptor 4.
Back up that key: losing it loses access to sealed secrets.

The release staging directory permits the service account to add candidates.
Its sticky bit protects root-owned activated releases from rename or removal
by that account. Applying a system-service release requires the host operator
using sudo; it makes the candidate root-owned before activation. The timer
has no write access to the serving link, installation configuration or Node.

User mode requires `--no-mount` and an existing delegation with cpu, memory and
pids controllers available to the user's systemd manager. It installs units in
`~/.config/systemd/user`, removes system-only account and filesystem settings,
and enables both the service and timer through `systemctl --user`. It enables
linger when needed and records whether it did so. A user service's credential
is private to that user at `<prefix>/etc/master.key`; it does not provide the
separation of a root-held system credential. TPM2 is refused in this mode.

Foreground mode writes the same verified installation without starting a
service. Start it inside a delegated cgroup, supplying the private credential:

```sh
/opt/zero/node/current/bin/node --no-experimental-strip-types \
  --import /opt/zero/current/lib/artifacts/register.mjs \
  /opt/zero/current/kernel/supervisor-main.ts /opt/zero/etc/seed.json \
  --release /opt/zero/current --state /var/lib/z --installation /opt/zero \
  --credential /opt/zero/etc/master.key
```

## Layout and proxy

Code lives under `<prefix>/{bin,node,releases,etc}`. `current` selects the host
operator tools and supervisor release. Each release retains signed assets under
`.release/`, separately from its extracted code. The two different `package.json`
files are therefore both preserved. The seed references retained release files.

State includes `kernel`, `supervisor`, `g`, `registry`, `cache`, `profile`,
`discovery`, `initial`, person spaces, `login-state` and `updates`. The supervisor
owns `<state>/supervisor.sock` mode 0600 and records its serving run in
`supervisor/serving.json` beside its observed generation journal.

`zero status` prints exact login, web and kernel-origin socket paths. Configure
an HTTPS reverse proxy to route `/login` to the login socket and the person's
path to their web socket, including WebSocket upgrades. Keep the trusted kernel
origin on its separately reviewed origin. See [headless startup](headless-startup.md)
for the proxy boundary and origin checks.

Public target sockets use `<state>/live/targets/<digest>/runs/public/current.sock`.
`live` is an atomically replaced host alias to the serving private store. These
proxy paths stay stable through update, undo and restart (ADR 0052). Actual
private stores remain short per-generation directories under `g` (ADR 0050).
Whole deployment exports have a separate 65,536-entry bound; individual code
pins keep their 10,000-entry limit (ADR 0053).

## Update and undo

Use the absolute launcher path unless you have added `<prefix>/bin` to PATH:

```sh
/opt/zero/bin/zero status
/opt/zero/bin/zero update --check
sudo /opt/zero/bin/zero update --apply
sudo /opt/zero/bin/zero undo
sudo /opt/zero/bin/zero prune-releases
```

User and foreground installations run these commands as their owning account.
`--password-fd` supplies credentials noninteractively for apply or undo.
`update --apply --release v0.1.1` selects an explicit release. Without that flag,
apply selects the version recorded by the most recent check.

The hourly timer discovers annotated runtime tags, selects a newer release
within the current major, downloads bounded assets, verifies them, and writes
`updates/status.json`. An existing staged directory is reverified. A competing
staging operation is reported as unverified. The default `autoupdate` package
reads the notice through a read-only mount; it has no network or apply authority.

Apply rechecks the tag, signature, assets and code at the supervisor boundary,
authenticates through the installed login target, and asks the running kernel
to resolve the administrator's session. GN-007 drains and freezes writers,
captures state, probes the candidate and every connected client major, then
promotes through the generation machine. A failed candidate restores the serving
kernel. Undo takes the machine's undo edge and restores the previous stopped
store and code in a fresh generation. Restart recovers the serving checkpoint
against observed history instead of returning to the original seed.

`prune-releases` retains live and previous code and stores. It retires obsolete
maintenance workspaces and snapshots under transaction exclusion and coordinates
release deletion with applying updates.

A release changing Node or `lib/maintenance` requires an explicit service
migration; hot apply reports that requirement and leaves the kernel serving.
For a supervisor-only change with the same Node, review and verify the staged
release, stop the service, switch the host `current` link to that release, and
start the service. Recovery keeps the last serving kernel; authenticate and apply
the new kernel after the supervisor is ready. Cross-Node migration requires a
separately reviewed Node installation and compatible retained execution artifacts.
The timer never restarts the service.

Unattended apply policies `fixes` and `improvements` remain refused by
[ADR 0049](adr/0049-pre-authorised-kernel-updates.md). That record is Proposed;
accepting it requires the operator's explicit policy decision and implementation
of its authority. Default-profile promotion remains a separate reviewer act.

## Removal and recovery

```sh
sudo sh install.sh --allow-root --prefix /opt/zero --uninstall --dry-run
sudo sh install.sh --allow-root --prefix /opt/zero --uninstall
```

Uninstall reads the recorded service mode, account, unit directory, key and
volume choices. It stops the correct manager's service and timer. It preserves
state and keys unless `--purge-state` is provided. User/foreground keys are copied
to `<state>/retained-master.key` before their code prefix is removed. Mount units
remain when their retained state volume remains. Purging stops and removes those
mount units and images; only installer-created accounts and linger are removed.
An externally supplied mount stays mounted when purged; its contents are removed.
Stop a foreground supervisor before uninstalling it.

A failed install leaves its incomplete prefix for inspection. Read the service
journal before changing files. A missing or invalid serving checkpoint is a
recovery error, not permission to boot the initial seed. Restore the retained
checkpoint and observed journal together from backup. A `FAILED` generation
requires a reviewed recovery reset; `undo` cannot bypass that state.

## Verification

Automated tests use mandatory bubblewrap, delegated cgroups, bounded temporary
filesystems, signed local release repositories and test-only keys. They exercise
bootstrap without Node on PATH, tamper refusal, installation choices, service
rendering, uninstall, the real installed launcher, administrator authentication,
update, undo, restart and retention. System manager commands and TPM provisioning
are external edges in mode tests. Actual privileged host provisioning and an
external TLS proxy are separate acceptance steps; automated fixture results do
not claim that this host was installed or a public release was published.
