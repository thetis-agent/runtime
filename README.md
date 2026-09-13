# Thetis

A multi-user recursive language model service with a continual harness. The model does its
work by writing code that runs in its own fenced userspace. That code can rewrite the harness
the model runs inside: prompt, tools, memory, subagents.

Full documentation is in [docs/](docs/README.md). The design specification is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

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
| `packages/` | Git submodule with all packages: `kernel`, `userspace-agent`, `provider-openrouter`, `harness-core`, `tool-exec`, `gateway-cli`, `gateway-web`. |
| `docs/` | Documentation. |
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
```

See [docs/08-cli.md](docs/08-cli.md) and [docs/15-web-gateway.md](docs/15-web-gateway.md).
