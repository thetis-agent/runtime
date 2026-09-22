# Thetis

A multi-user recursive language model service with a continual harness. The model does its
work by writing code that runs in its own fenced userspace. That code can rewrite the harness
the model runs inside: prompt, tools, memory, subagents.

Each package has a `README.md` describing what it does and what enforces it. The skills in
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
   door's address and port written into `thetis.config.json`.
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
installed to `/etc/systemd/system/thetis-runtime.service`, reloaded, enabled and started; on an update
it is restarted. If the unit stops or stays silent the installer prints the last 40 journal lines and
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
updated, the build redone, `.env` and the users kept, and the service restarted. `--uninstall` disables
and removes the unit and the launcher and leaves `<prefix>/runtime` and `<prefix>/data` in place;
`rm -rf` those to remove everything.

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
tests it with `exec`, calls `install_package`, and the step and tool are live on the next turn.

## Layout

| Path | Content |
|---|---|
| `bin/thetis.js` | Command-line entry point. |
| `packages/` | Git submodule with all packages. Service plane: `contracts`, `lib`, `sandbox`, `kernel`, `host`. Inside the fence: `userspace-agent`, `provider-openrouter`, `prompt-cache`, `marketplace`, `harness-core`, `tool-exec`, `tools-files`, `tools-plan`, `exa`, `gateway-web`, `gateway-login`. On the host: `gateway-cli`, `door`, `bench`. |
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
