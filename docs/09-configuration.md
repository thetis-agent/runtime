# 09 Configuration

## 1. Files and directories

```
$THETIS_HOME/
  thetis.config.json      The configuration file. Created by `thetis init`.
  users.json              User records.
  auth.json               Passwords and login tokens. Mode 0600.
  thetis.sock             The control socket while `thetis serve` runs. Mode 0600.
  registry.json           Package registry.
  mounts.json             Per-user mounts: { "<user>": [ { "path", "mode" } ] }. Written by `mounts.set` only.
  userspaces/<user>/      One directory per user. See 06-sessions-and-users.md section 2.
```

`THETIS_HOME` defaults to `~/.thetis`. The `.env` file in this repository sets it to `.thetis`, which resolves to `<root>/.thetis`.

## 2. Loading

`loadConfig(home, projectRoot, env)` in `src/config.ts`:

1. Start from `defaultConfig(home, projectRoot)`.
2. Read `thetis.config.json` when it exists. Copy its top-level fields over the defaults. The `fence` object is merged one level deep.
3. Replace every `${NAME}` in every string with `env[NAME]`. A missing variable becomes an empty string.

`saveConfig` writes the config without `home`, `systemPackagesDir`, `promotedPackagesDir`, `sharedDir`, `agentPath`, `fence.readOnly`, and `fence.hidden`. The kernel never calls it; only `thetis init` does. Those fields are derived from `projectRoot` at load time. The saved file stays valid when the checkout moves.

## 3. Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `home` | string | the `home` argument | The data directory. Derived. |
| `systemPackagesDir` | string | `<root>/packages` | Where the kernel looks for `@thetis/*` packages. Derived. |
| `promotedPackagesDir` | string | `<home>/packages` | Where promoted packages live. Derived. Bound read-only into every fence. See [05-packages.md](05-packages.md) section 14. |
| `sharedDir` | string | `<home>/shared` | Written by the system userspace, read by every fence. Derived. See [03-fence.md](03-fence.md) section 3.7. |
| `door.host`, `door.port` | string, number | `127.0.0.1`, `8777` | The one host port. `thetis serve` binds it. See [15-web-gateway.md](15-web-gateway.md). |
| `agentPath` | string | `<root>/packages/userspace-agent/dist/src/agent.js` | The agent the fence starts. Derived. |
| `model` | string | `anthropic/claude-sonnet-5` | The initial `call.model` of every turn. |
| `phases` | string[] | `["history","prompt","tools","call","after"]` | The phase order. |
| `callPhase` | string | `call` | The phase that ends with the built-in provider call. |
| `enumerator` | `{ package, export }` | not set | A package enumerator that replaces the default plan. |
| `systemPackages` | object | see below | System packages to link per userspace. Seeding runs when a userspace is created. An existing userspace gets a new system package with `thetis packages install @thetis/<name> --user <id>`. |
| `packages` | object | see below | Per-package configuration. |
| `fence.sandbox` | `auto`, `bwrap`, `none` | `auto` | The sandbox mode. |
| `fence.network` | `auto`, `egress`, `none`, `host` | `auto` | What a fence can reach. See [03-fence.md](03-fence.md) section 3.2. |
| `fence.limits` | `{ memoryMb, pids, cpuPercent }` | `1024`, `512`, `200` | Per-fence resource limits. Need a delegated cgroup. See [03-fence.md](03-fence.md) section 3.3. |
| `fence.readOnly` | string[] | `[<root>/packages, <root>/node_modules]` | Extra read-only binds. Derived. |
| `fence.hidden` | string[] | `[<home>]` | Paths masked with an empty tmpfs. Derived. |
| `requestTimeoutMs` | number | `600000` | Timeout of one fence request. |

Defaults for the object fields:

```json
"systemPackages": {
  "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/tools-files", "@thetis/tools-plan", "@thetis/terminal", "@thetis/gateway-web", "@thetis/ui-tools", "@thetis/ui-context", "@thetis/projects", "@thetis/ui-admin", "@thetis/ui-marketplace", "@thetis/skills", "@thetis/skills-thetis", "@thetis/skills-hybrid", "@thetis/ui-skills"],
  "_system": ["@thetis/provider-openrouter", "@thetis/gateway-login", "@thetis/marketplace"]
},
"packages": {
  "@thetis/provider-openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "baseUrl": "https://openrouter.ai/api/v1"
  },
  "@thetis/marketplace": {
    "registries": [{ "name": "thetis", "url": "https://github.com/thetis-agent/packages.git" }]
  },
  "@thetis/skills-hybrid": {
    "embeddings": { "apiKey": "${OPENROUTER_API_KEY}" }
  }
}
```

## 4. Per-package configuration

`config.packages[<name>]` reaches:

- the steps of that package, as `ctx.config`;
- the tools of that package, as `env.config`;
- the provider factory of that package, as its argument.

The kernel never sends the configuration of one package to another package. Secrets for a provider stay in the fence of that provider.

Known keys:

| Package | Key | Meaning |
|---|---|---|
| `@thetis/provider-openrouter` | `apiKey`, `baseUrl`, `headers`, `defaults`, `cache` | See [07-providers.md](07-providers.md) and [16-prompt-cache.md](16-prompt-cache.md). |
| `@thetis/prompt-cache` | `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `enabled`, `diagnostics`, `affinity` | The hint and the diagnostics. See [16-prompt-cache.md](16-prompt-cache.md). |
| `@thetis/marketplace` | `registries`, `refreshMinutes` | The registries to mirror. Ships with one, `https://github.com/thetis-agent/packages.git`, the approved extensions. Set `registries` to `[]` to index nothing and keep the refresh off the network. See [18-marketplace.md](18-marketplace.md). |
| `@thetis/gateway-web` | none | Runs in each person's fence on a unix socket. See [15-web-gateway.md](15-web-gateway.md). |
| `@thetis/gateway-login` | `secure` | Adds `Secure` to the login cookie. Set it when TLS terminates in front of the door. |
| `@thetis/exa` | `apiKey`, `baseUrl`, `timeoutMs`, `defaults` | The Exa API key and the tool defaults. See [19-exa.md](19-exa.md). |
| `@thetis/skills-hybrid` | `fusionWeight`, `pinLimit`, `pinBodies`, `embeddings` | The dense share of the fusion (0.7), how many skills are pinned (6), bodies instead of cards (false), and the vector source `{ baseUrl, apiKey, model, dimensions }` with defaults `https://openrouter.ai/api/v1`, `${OPENROUTER_API_KEY}`, `openai/text-embedding-3-small`, `1536`. Without a key the ranking is lexical. See [23-skills.md](23-skills.md) section 4.3. |
| `@thetis/terminal` | `shell`, `sessions`, `bufferBytes`, `idleMinutes`, `waitMs` | The shell the pty runs (`/bin/bash`), the open sessions per person (8), the ring buffer per session in characters (262144), the minutes of idle before a session is closed (30, `0` disables it), and the default wait of the `shell` tool in milliseconds (120000). There is no `enabled` key: a person who should not have a terminal does not have the package installed. See [24-terminal.md](24-terminal.md) section 6. |

## 5. Changing the configuration

1. Edit `$THETIS_HOME/thetis.config.json`.
2. Start the CLI again. Each CLI invocation reads the file.

To change the model for one user only, install a package with a `prompt` step that sets `call.model`.

## 6. Example: a minimal file

```json
{
  "model": "anthropic/claude-sonnet-5",
  "fence": { "sandbox": "auto" },
  "packages": {
    "@thetis/provider-openrouter": { "apiKey": "${OPENROUTER_API_KEY}" }
  }
}
```

All other fields take their defaults.
