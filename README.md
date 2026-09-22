# Thetis

A multi-user recursive language model service with a continual harness. The model does its
work by writing code that runs in its own fenced userspace. That code can rewrite the harness
the model runs inside: prompt, tools, memory, subagents.

Each package has a `README.md` describing what it does and what enforces it. The skills in
`packages/skills-thetis/skills/thetis/` are the documentation an agent reads to use Thetis and to change
it: start at `thetis/using`, and at `thetis/developing` for the host-side build, test and guard rules.

## Install

One command puts a whole installation on a Linux machine with systemd: Node 24 under `~/.local`, the
fence's OS packages (bubblewrap, slirp4netns), both repositories under `/opt/zero/runtime`, the data
directory at `/opt/zero/data`, the first admin, and `thetis-runtime.service` with this host's real
paths, started and checked:

```sh
curl -fsSL https://raw.githubusercontent.com/thetis-agent/runtime/main/deploy/install.sh | bash
```

It asks for the prefix, the admin, the listen address and the OpenRouter key; `bash -s -- -y` takes
the defaults and the environment instead (`OPENROUTER_API_KEY`, `THETIS_ADMIN_PASSWORD`). Run it again
to update. `--help` lists every option; `deploy/install.sh` is the script.

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
