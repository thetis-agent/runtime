# 09 Configuration

## 1. Files and directories

```
$THETIS_HOME/
  thetis.config.json      The configuration file. Created by `thetis init`.
  users.json              User records.
  auth.json               Passwords and login tokens. Mode 0600.
  thetis.sock             The control socket while `thetis serve` runs. Mode 0600.
  registry.json           Package registry.
  userspaces/<user>/      One directory per user. See 06-sessions-and-users.md section 2.
```

`THETIS_HOME` defaults to `~/.thetis`. The `.env` file in this repository sets it to `.thetis`, which resolves to `<root>/.thetis`.

## 2. Loading

`loadConfig(home, projectRoot, env)` in `src/config.ts`:

1. Start from `defaultConfig(home, projectRoot)`.
2. Read `thetis.config.json` when it exists. Copy its top-level fields over the defaults. The `fence` object is merged one level deep.
3. Replace every `${NAME}` in every string with `env[NAME]`. A missing variable becomes an empty string.

`saveConfig` writes the config without `home`, `systemPackagesDir`, `promotedPackagesDir`, `agentPath`, `fence.readOnly`, and `fence.hidden`. Those fields are derived from `projectRoot` at load time. The saved file stays valid when the checkout moves.

## 3. Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `home` | string | the `home` argument | The data directory. Derived. |
| `systemPackagesDir` | string | `<root>/packages` | Where the kernel looks for `@thetis/*` packages. Derived. |
| `promotedPackagesDir` | string | `<home>/packages` | Where promoted packages live. Derived. Bound read-only into every fence. See [05-packages.md](05-packages.md) section 14. |
| `agentPath` | string | `<root>/packages/userspace-agent/dist/src/agent.js` | The agent the fence starts. Derived. |
| `model` | string | `anthropic/claude-sonnet-5` | The initial `call.model` of every turn. |
| `phases` | string[] | `["history","prompt","tools","call","after"]` | The phase order. |
| `callPhase` | string | `call` | The phase that ends with the built-in provider call. |
| `enumerator` | `{ package, export }` | not set | A package enumerator that replaces the default plan. |
| `systemPackages` | object | see below | System packages to link per userspace. Seeding runs when a userspace is created. An existing userspace gets a new system package with `thetis packages install @thetis/<name> --user <id>`. |
| `packages` | object | see below | Per-package configuration. |
| `fence.sandbox` | `auto`, `bwrap`, `none` | `auto` | The sandbox mode. |
| `fence.readOnly` | string[] | `[<root>/packages, <root>/node_modules]` | Extra read-only binds. Derived. |
| `fence.hidden` | string[] | `[<home>]` | Paths masked with an empty tmpfs. Derived. |
| `maxToolRounds` | number | `40` | Maximum tool rounds per provider call step. |
| `requestTimeoutMs` | number | `600000` | Timeout of one fence request. |

Defaults for the object fields:

```json
"systemPackages": {
  "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache"],
  "_system": ["@thetis/provider-openrouter", "@thetis/marketplace"]
},
"packages": {
  "@thetis/provider-openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "baseUrl": "https://openrouter.ai/api/v1"
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
| `@thetis/harness-core` | `historyWindow`, `historyKeep` | The window over the conversation: at most `historyWindow` messages (default 80); after an overflow, `historyWindow * historyKeep` remain (default 0.5). |
| `@thetis/prompt-cache` | `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `enabled`, `diagnostics`, `affinity` | The hint and the diagnostics. See [16-prompt-cache.md](16-prompt-cache.md). |
| `@thetis/marketplace` | `registries`, `refreshMinutes` | The registries to mirror. See [18-marketplace.md](18-marketplace.md). |
| `@thetis/gateway-web` | `host`, `port`, `secure` | See [15-web-gateway.md](15-web-gateway.md). |

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
