# Install and update Thetis

The installer creates a supervised kernel, bounded persistent storage, an
administrator account and an hourly update check. It downloads and verifies the
release's exact Node runtime; Node and npm are not installation prerequisites.
The host still needs the Linux boundary tools listed below.

## Install

Download the release installer and review it, then run it as root for a system
service:

```sh
curl -fsSL https://github.com/thetis-agent/runtime/releases/latest/download/install.sh -o install.sh
less install.sh
sudo sh install.sh
```

The equivalent piped form is:

```sh
curl -fsSL https://github.com/thetis-agent/runtime/releases/latest/download/install.sh | sudo sh -s --
```

The installer prompts on the terminal for the prefix (default `/opt/thetis`), state
root (default `/var/lib/thetis`), service mode (default `system`), public HTTPS origin,
an OpenRouter model id, administrator id (default `admin`), provider API key and
a password entered twice with echo off. API key and password entry are hidden.
The code prefix's parent must exist. Code and state must be separate canonical
paths without symlinks, spaces, shell metacharacters or overlapping roots.

A release's installer embeds that release's tag and public signing identity.
It verifies the signed asset list, all asset hashes and the annotated tag's
runtime commit. It downloads the exact Node archive from `nodejs.org`, verifies
its digest against signed provenance before executing it, and verifies every
kernel pin and execution artifact before creating the installation. The checkout and release installers carry the published public trust root; local
fixtures supply `--allowed-signers`.

For a noninteractive installation, provide `--yes`, `--origin`, `--model`, an
already open password descriptor via `--password-fd`, and a separate API-key
descriptor via `--api-key-fd`. There is no default password.
Passwords must have at least six characters. Only the salted scrypt account
record is stored; passwords never enter arguments, environment variables, the
seed, installation choices or logs.

## Connect a model

Interactive installs ask for an OpenRouter model id and its API key. The installer
looks up the model's advertised capabilities and token prices, validates tool
support, and configures both the provider and your environment before the first
boot. It limits context to at most 32,768 tokens and output to 4,096 tokens.
Reservations include published cache rates and every pricing tier reachable
within that context window.
`--daily-budget` sets the per-person dollar ceiling (default 10); one full request
must fit that ceiling. Each request reserves its maximum cost before network I/O.

The key travels over a hidden terminal or inherited descriptor, never an argument
or environment variable. The kernel secret store encrypts it with the installation
master key. Back up that key and the state together.

Other OpenAI-compatible endpoints use `--provider-config /path/provider.json`
and `--api-key-fd`. The file contains non-secret settings:

```json
{
  "endpoint": "https://provider.example/v1/chat/completions",
  "dailyBudget": 1,
  "model": {
    "id": "your-model",
    "contextWindow": 4096,
    "maxOutput": 512,
    "tools": true,
    "images": false,
    "seed": false,
    "cache": "implicit",
    "price": { "in": 1, "out": 2 }
  }
}
```

Replace the example capabilities and prices with your provider's published values.
Prices are USD per million tokens. This bootstrap path supports text models with
tools and implicit or no caching. `--demo` explicitly selects the scripted offline
provider instead; it never pretends to connect a real model.

## Start chatting

For a system installation:

```sh
sudo /opt/thetis/bin/thetis chat --message "Hello"
sudo /opt/thetis/bin/thetis status
```

The chat command prints the answer and conversation id. Continue with
`chat --conversation ID --message "Another question"`.
User/foreground installations run it as their owning account. No public proxy is
needed for this host-local command. A foreground installation must first start
its supervisor as shown below.

## Choices

| Flag | Meaning and default |
| --- | --- |
| `--prefix <path>` | Code directory, `/opt/thetis` |
| `--state <path>` | Short state root, `/var/lib/thetis`; `<state>/g` must fit in 18 bytes |
| `--state-size <bytes>` | State capacity ceiling, `4294967296`; decimal bytes, at least 64 MiB |
| `--state-layout one\|split` | One state volume, or reserved volumes: `kernel` 256 MiB, `supervisor` 1 GiB and `g` 2 GiB; at least 4 GiB total |
| `--no-mount` | Use an existing directory on a filesystem whose enforced capacity fits the declared ceiling |
| `--service system\|user\|none` | Dedicated system service, current account's user service, or foreground setup |
| `--service-name <name>` | Unit and credential namespace, `thetis`; choose a distinct name for a second installation |
| `--user <name>` | System service account, `thetis` |
| `--operator <id>` | Administrator id |
| `--password-fd <n>` | Read the administrator password from this descriptor |
| `--model <id>`, `--api-key-fd <n>` | Real OpenRouter model and secret input |
| `--provider-config <file>` | Non-secret settings for another compatible provider |
| `--daily-budget <USD>` | Per-person daily model budget, 10 |
| `--demo` | Explicit offline, scripted provider |
| `--origin <https-origin>` | Public package origin, without a path |
| `--kernel-origin <https-origin>` | Separate trusted origin; defaults to `https://kernel.<public-host>` |
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
| `--allow-root` | Accepted for compatibility; sudo needs no extra opt-in |

A completed install rerun is a no-op. Another version must go through `thetis
update`. An incomplete prefix, nonempty state directory or existing master key
is refused for inspection; the installer does not overwrite accounts, format
an existing image or replace a key.

An existing service unit is also protected. To install a second instance, choose
a distinct prefix, state, service name and service account. A personal deployment
name is an explicit choice, never a product-wide default.

## Host and service modes

The installer requires Linux x64 or arm64, working unprivileged bubblewrap user
namespaces, unified cgroup v2, `/dev/net/tun`, `slirp4netns`, `unshare`, git,
flock, GNU tar, gzip, xz, sha256sum, ssh-keygen, coreutils and a POSIX shell. HTTPS
downloads use curl or wget. Provisioned volumes additionally require fallocate,
mkfs.ext4 and systemd. Service credentials require systemd 252 or newer.
Writable deployment filesystems must have enforced capacity; a directory on an
unbounded host filesystem does not satisfy the sandbox quota check.

On Debian/Ubuntu, install the host tools before running the installer:

```sh
sudo apt-get update
sudo apt-get install -y bubblewrap slirp4netns uidmap util-linux git openssh-client curl ca-certificates xz-utils e2fsprogs
```

On Ubuntu, AppArmor may restrict unprivileged user namespaces. Configure a narrow
host policy for the installed sandbox launcher as described in the platform guide;
the installer reports a failed boundary check and does not disable host security.

System mode creates a dedicated account and installs `thetis.service`,
`thetis-update.service`, `thetis-update.timer` and the required mount units. Split
mode makes the supervisor depend on all reserved mounts before it starts. It gives
`thetis.service` `Delegate=yes`, writes root-owned code and configuration, and
hands the root-only `/etc/thetis/master.key` to the supervisor with
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
/opt/thetis/node/current/bin/node --no-experimental-strip-types \
  --import /opt/thetis/current/lib/artifacts/register.mjs \
  /opt/thetis/current/kernel/supervisor-main.ts /opt/thetis/etc/seed.json \
  --release /opt/thetis/current --state /var/lib/thetis --installation /opt/thetis \
  --credential /opt/thetis/etc/master.key
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

`sudo /opt/thetis/bin/thetis status` prints exact login, web and kernel-origin socket paths. Configure
an HTTPS reverse proxy to route `/login` to the login socket and the person's
path to their web socket, including WebSocket upgrades. Keep the trusted kernel
origin on its separately reviewed origin. See [headless startup](headless-startup.md)
for the proxy boundary and origin checks.
For a concrete same-host or remote-TLS setup, see [browser proxy configuration](proxy.md).

Public target sockets use `<state>/live/targets/<digest>/runs/public/current.sock`.
`live` is an atomically replaced host alias to the serving private store. These
proxy paths stay stable through update, undo and restart (implementation note 0052). Actual
private stores remain short per-generation directories under `g` (implementation note 0050).
Whole deployment exports have a separate 65,536-entry bound; individual code
pins keep their 10,000-entry limit (implementation note 0053).

## Update and undo

Use the absolute launcher path unless you have added `<prefix>/bin` to PATH:

```sh
/opt/thetis/bin/thetis status
/opt/thetis/bin/thetis update --check
sudo /opt/thetis/bin/thetis update --apply
sudo /opt/thetis/bin/thetis undo
sudo /opt/thetis/bin/thetis prune-releases
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
sudo sh install.sh --prefix /opt/thetis --uninstall --dry-run
sudo sh install.sh --prefix /opt/thetis --uninstall
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
