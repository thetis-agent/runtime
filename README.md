# Thetis

A multi-user recursive language model service with a continual harness. The model does its
work by writing code that runs in its own fenced userspace. That code can rewrite the harness
the model runs inside: prompt, tools, memory, subagents.

The kernel runtime is a plain TypeScript library in [`src/`](src/), exported as `@thetis/runtime`.
Its entry point is [`src/index.ts`](src/index.ts); importing it starts no process or server.
The separate `packages/` repository contains extensions and host applications, including the CLI.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the module boundaries and the SOLID, DRY, IoC and DI rules.
Shared DTOs derive from Zod schemas exported through `@thetis/runtime/schemas`.
See [validation](docs/validation.md) for parsing unknown data, extension ownership, and compatibility.

Each core module and extension has a `README.md` describing what it does and what enforces it. The skills in
`packages/skills-thetis/skills/thetis/` are the documentation an agent reads to use Thetis and to change
it: start at `thetis/using`, and at `thetis/developing` for the host-side build, test and guard rules.

## Install

One command puts a whole installation on a Linux machine:

```sh
curl -fsSL https://raw.githubusercontent.com/thetis-agent/runtime/main/deploy/install.sh | bash
```

It runs as the person who will operate Thetis, never as root, and asks for sudo itself for three things:
the OS packages, the prefix under `/opt`, and the systemd unit. `deploy/install.sh` is the script;
`--help` lists every option.

### What it needs and what it checks

Before it changes anything it reports, and where it must, refuses:

| Check | When it fails |
|---|---|
| Linux on x86_64 or arm64 | Stops. The fence is bubblewrap and cgroup v2; nothing else can host it. |
| Not root, not under sudo | Stops. `THETIS_INSTALL_ALLOW_ROOT=1` overrides, for a container with nobody else. |
| sudo available | Without it: installs under `~/.thetis-agent`, skips the OS packages and the service. |
| A known package manager (apt, dnf, yum, pacman, zypper, apk) | Warns; the OS packages are then yours to install. |
| systemd running | Warns; the service step is skipped and `thetis serve` runs it by hand. |
| cgroup v2 | Warns; fences run without memory, pid and cpu limits. |
| User namespaces enabled | Warns; the fence falls back to no sandbox. |
| Docker | Reported only. It is not needed for the install. When the socket is there and usable, fences get it at runtime (`fence.docker: auto`); when it is not, they get none. |
| No `thetis-runtime.service` from another checkout | Stops. Re-run with that installation's `--prefix` to update it, or `--uninstall` first. |

After the OS packages it verifies that git, curl, tar and xz are present, runs bubblewrap once for real
(a pid-namespace unshare; this is what catches a distribution that restricts user namespaces), and
confirms slirp4netns, without which fences share the host network. An existing Node is used when it is
24 or newer; otherwise the latest 24.x release tarball goes under `~/.local/lib` with `node`, `npm`,
`npx` and `corepack` linked into `~/.local/bin`, its sha256 checked against the release's SHASUMS file.

### What it installs

1. OS packages: bubblewrap, slirp4netns, git, curl, ca-certificates, xz, rsync.
2. Node 24, as above.
3. This repository with `packages/` as its submodule at `<prefix>/runtime`; the default prefix is `/opt/zero`.
4. `npm ci` and `npm run build`.
5. `.env` (mode 0600) with `OPENROUTER_API_KEY` and `THETIS_HOME=<prefix>/data`, then `thetis init` and the
   door's address and port written into `thetis.config.json`. `init` refuses a data directory longer than
   73 bytes, where no user id at all would fit: every unix socket of the installation hangs off it, and a
   socket path cannot exceed 107. Past 49 bytes it serves but notes how long a user id it can carry.
6. The first admin with a password: `thetis users add <id> --admin` and `thetis users passwd`.
7. A `thetis` launcher in `~/.local/bin`, and `~/.local/bin` added to `PATH` in your shell's rc file when
   it is not there yet.
8. The systemd unit, below.

It ends by waiting up to 90 seconds for the door to answer on its address and port, then prints
`thetis status`, the sign-in name, the password when it generated one, and the paths.

### The service

`deploy/thetis-runtime.service` is a template: `User=`, `Group=`, `WorkingDirectory=` and `ExecStart=`
are placeholders. The installer writes the installed unit from it with this host's values: the person
running the installer, `<prefix>/runtime`, and the absolute path of the Node it found or installed. Every
other line is kept: `Restart=always` so a restart Thetis asks for comes back, `KillSignal=SIGINT` for a
clean stop, `Delegate=yes` so each fence gets its cgroup limits, the crash-loop brake, and
`RuntimeDirectory=thetis`, which is what makes the daemon require a token on its control socket. It is
installed to `/etc/systemd/system/thetis-runtime.service`, reloaded, enabled and started. On an update
the installer renders the unit again and compares it with the installed one; only a changed unit is
reinstalled. If the unit stops or stays silent the installer prints the last 40 journal lines and
stops. Never copy the template over a deployed unit by hand: it looks installed and fails on the next
restart.

### Options and environment

```
--prefix DIR     runtime at DIR/runtime, data at DIR/data     (default /opt/zero)
--ref REF        branch, tag or commit to install             (default main)
--admin ID       the first admin's user id                    (default $USER)
--host ADDR      the door's listen address                    (default 127.0.0.1; 0.0.0.0 for the network)
--port N         the door's listen port                       (default 8777)
--no-service     skip the systemd unit; run `thetis serve` yourself
--no-deps        do not touch OS packages
-y, --yes        never prompt; take defaults and the environment
--uninstall      remove the unit and the launcher; the checkout and data stay
```

Interactively it asks for the prefix, the admin, the listen address, the port, the OpenRouter key and
the password, reading the terminal even under `curl | bash`. With `-y` it takes `OPENROUTER_API_KEY`
and `THETIS_ADMIN_PASSWORD` from the environment, generates and shows a password when the latter is
unset, and continues without a key, in which case the model cannot answer until one is in
`<prefix>/runtime/.env` followed by `thetis config reload`. Options go after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/thetis-agent/runtime/main/deploy/install.sh | bash -s -- --port 9000 --host 0.0.0.0
```

The other variables: `THETIS_PREFIX`, `THETIS_REF`, `THETIS_REPO`, `THETIS_ADMIN`, `THETIS_DOOR_HOST`,
`THETIS_DOOR_PORT`, `NODE_VERSION` (an exact 24.x), `THETIS_INSTALL_LOG` (where every step's output goes;
the default is a file under `/tmp`, named in the summary).

### Updating and removing

Run the same command again. An existing checkout at the prefix is pulled to `--ref`, the submodule
updated, the build redone, `.env` and the users kept. Then the running daemon is told what changed, and
no more than that: `thetis config reload` re-reads the configuration and `.env`, `thetis reload --all`
puts the package code on disk into every workspace, and a new daemon process is asked for only when the
rendered unit differs from the installed one or `thetis status --json` reports the daemon itself stale.
When daemon code changed, workspace reload is deferred to the new process so the old daemon cannot
reopen fences using an obsolete guest entry path. That restart is the daemon's own,
`thetis restart --yes --reason "install.sh: daemon code updated"`: it
waits for every turn to end, counts down where everyone can see it, and exits so systemd starts it again;
`systemctl restart` is the fallback only when the latch refuses. An update that changes only packages
restarts nothing, and `thetis status` then says every process is on the code on disk. `--uninstall`
disables and removes the unit and the launcher and leaves `<prefix>/runtime` and `<prefix>/data` in
place; `rm -rf` those to remove everything.

The rule behind that: the runtime modules in `src/` and the `gateway-cli` host adapter
carries no user-facing behaviour. It runs steps and moves data, and the only reason for a new process is a
bug of its own. Everything else is a package, and a package change is live on its next call, on
`thetis reload`, or on `thetis config reload`. A feature that seems to need the daemon is a feature in
the wrong package; `src/kernel/README.md` lists the frozen seams.

## Quick start (a development checkout)

```sh
git submodule update --init   # after a fresh clone: packages/ is a submodule
npm install
npm run build
npm test                      # unit + LOC guard + end-to-end through the real fence (no network)

cp .env.example .env          # set OPENROUTER_API_KEY; THETIS_HOME=.thetis keeps data in ./.thetis
node bin/thetis.js init
node bin/thetis.js users add alice
node bin/thetis.js chat --user alice

node bin/thetis.js users passwd alice --password secret
node bin/thetis.js install @thetis/gateway-web
node bin/thetis.js serve         # http://127.0.0.1:8777
```

Inside chat, ask Thetis to change itself, for example: *"Add a tool that counts words and a
prompt step that injects the current time. Install it."* It writes `home/packages/<name>/`,
tests it with the shell, calls `install_package`, and the step and tool are live on the next turn. Nothing
is restarted for that, and nothing ever needs to be: see "Updating and removing".

## Runtime library

`npm run build:runtime` builds only the runtime; it needs no extension source or third-party runtime
dependency. `npm run build` also builds the extension workspaces and tests.

```ts
import { createKernel, defaultConfig, T } from "@thetis/runtime";
import { memoryStore } from "@thetis/runtime/lib/store";

const config = defaultConfig(home, projectRoot);
config.systemPackages = {}; // The embedding application chooses its extensions.
const kernel = await createKernel(config, (container) => {
  container.bind(T.store, () => memoryStore());
  container.bind(T.fence, () => myFence); // Implements the exported Fence interface.
});
// Use kernel.users and kernel.sessions; the caller owns the lifetime.
await kernel.shutdown();
```

The supplied configuration defaults keep the standard installation working. An embedding application
can choose its own package list and storage driver, or inject storage and fence implementations directly.
The runtime does not import a provider, model loop, tool, gateway, or storage-driver package.

## Layout

| Path | Content |
|---|---|
| `src/index.ts` | Public runtime library API: `createKernel`, configuration, typed IoC tokens and adapter interfaces. |
| `src/kernel/` | Authorization, package ownership, session coordination and pipeline dispatch. |
| `src/contracts/`, `src/lib/` | Shared contracts and supporting mechanisms. |
| `src/host/` | Composition root: constructs services and injects storage, fences and host extensions. |
| `src/sandbox/`, `src/userspace-agent/`, `src/door/` | Process isolation, the guest executor and HTTP routing. |
| `test/` | Runtime unit, architecture and integration tests; fixtures live here with their tests. |
| `bin/thetis.js` | Command-line entry point. |
| `packages/` | Git submodule containing extensions: the harness, providers, tools, gateways, skills, storage drivers and host extensions. Also contains the CLI adapter and benchmark application. Core implementation is owned by this runtime repository. |
| `deploy/` | `install.sh`, the one-command installer and updater, and the systemd unit template it fills in for `thetis serve`. |
| `bench/` | Benchmark reports, one per suite. Written by `thetis bench run --write`. See `packages/bench/README.md`. |
| `.thetis/` | Data directory (config, users, registry, userspaces). Not committed. |

## Commands

```
thetis init
thetis chat --user <id> [--session <id>] [--verbose]
thetis send --user <id> [--session <id>] <text>
thetis sessions list|show --user <id> [--session <id>]
thetis users list | add <id> [--admin] | remove <id> | suspend <id> | unsuspend <id> | role <id> <admin|user> | passwd <id> [--password <text>]
thetis install <source> [--user <id>] | uninstall <name> [--user <id>]
thetis packages list|install <source>|uninstall <name> [--user <id>]
thetis serve
thetis models [--user <id>]
thetis config
thetis bench run <suite> [--write]
```

See `packages/gateway-cli/README.md` and `packages/gateway-web/README.md`.

## Structured content

The runtime 0.2 API carries ordered content parts, scoped binary assets, rich tool results and extensible stream events. Text shorthand and old transcripts remain readable. See [the content API and migration guide](docs/content.md) for examples, injection points and adapter support.
