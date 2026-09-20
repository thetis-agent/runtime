# 09 Configuration

## 1. Files and directories

```
$THETIS_HOME/
  thetis.config.json      The configuration file. Created by `thetis init`.
  journal.jsonl           The append-only record. See [12-security.md](12-security.md) section 9.
  thetis.sock             The control socket while `thetis serve` runs. Mode 0600.
  store/                  The service plane's document store. Layout with the default driver: <namespace>/<key>.toml.
  packages/               Promoted packages. See [05-packages.md](05-packages.md) section 14.
  shared/                 Written by the system userspace, read by every fence.
  userspaces/<user>/      One directory per user. Sessions are under userspaces/<user>/sessions. See [06-sessions-and-users.md](06-sessions-and-users.md) section 2.
```

`THETIS_HOME` defaults to `~/.thetis`. The `.env` file in this repository sets it. A relative path resolves against `<root>`.

The records that were JSON files before 2026-09-18 are documents in the store now. The namespaces:

| Namespace | Holds | Private |
|---|---|---|
| `users` | One user record per id. | no |
| `auth/credentials` | One scrypt credential per user. | yes |
| `auth/tokens` | One login token record per token. | yes |
| `registry` | One package record per package name. | no |
| `mounts` | One `{ mounts }` document per user. | no |
| `config/system` | The system layer of per-package configuration. One document per package name. | no |
| `config/users/<user>` | That person's layer. One document per package name. | no |
| `secrets/system` | The secrets of the system layer. | yes |
| `secrets/users/<user>` | The secrets of that person's layer. | yes |
| `userspaces/<user>/<package>/<namespace>` | What a package keeps through `env.storage()`. | no |

A private namespace is unreadable to other host users: the default driver creates it with mode `0700` and its files with mode `0600`. See [26-storage.md](26-storage.md).

**`thetis migrate`** moves the four legacy files (`users.json`, `auth.json`, `registry.json`, `mounts.json`) into their namespaces and renames each one `<file>.migrated`. A daemon refuses to start while any of the four is still in `$THETIS_HOME`, and the command refuses to run while a daemon answers the socket. A second run imports nothing. See [08-cli.md](08-cli.md) section 2.16.

## 2. Loading

`loadConfig(home, projectRoot, env)` in `packages/kernel/src/config.ts`:

1. Start from `defaultConfig(home, projectRoot)`.
2. Read `thetis.config.json` when it exists. Copy its top-level fields over the defaults. The `fence`, `door`, `control` and `storage` objects are merged one level deep; `fence.limits` two levels deep.
3. Replace every `${NAME}` in every string with `env[NAME]`, **except under `packages`**. Outside `packages`, a missing variable becomes an empty string, and the value is read once, at start.
4. `packages` keeps its `${NAME}` references as written. The shipped defaults (section 3) sit under the file's entries. `packagesLayer(home)` reads this layer again for `thetis config reload`.

The config service resolves the references under `packages` **at read time**, on every call that hands a package its configuration. The environment it resolves against is `EnvFile.snapshot()` in `@thetis/lib/config`: the process environment, with the names that came from `<root>/.env` following that file. The file is parsed again whenever its modification time changes. A name the shell set to a value different from the file's keeps the shell's value. A name the file gained later, that the shell never set, is the file's too.

A reference to a variable that is not set is **not** an empty string. The string leaf that holds it is left out of what the package receives, and `config.show` reports the key as `missing` with the variable named. A package sees nothing rather than a wrong value.

`saveConfig` writes the config without `home`, `systemPackagesDir`, `promotedPackagesDir`, `sharedDir`, `agentPath`, `envFile`, `fence.readOnly`, and `fence.hidden`. The kernel never calls it; only `thetis init` does. Those fields are derived from `projectRoot` at load time. The saved file stays valid when the checkout moves.

## 3. Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `home` | string | the `home` argument | The data directory. Derived. |
| `systemPackagesDir` | string | `<root>/packages` | Where the kernel looks for `@thetis/*` packages. Derived. |
| `promotedPackagesDir` | string | `<home>/packages` | Where promoted packages live. Derived. Bound read-only into every fence. See [05-packages.md](05-packages.md) section 14. |
| `sharedDir` | string | `<home>/shared` | Written by the system userspace, read by every fence. Derived. See [03-fence.md](03-fence.md) section 3.7. |
| `envFile` | string | `<root>/.env` | The file whose variables `${VAR}` references under `packages` resolve against. Derived. |
| `door.host`, `door.port` | string, number | `127.0.0.1`, `8777` | The one host port. `thetis serve` binds it. See [15-web-gateway.md](15-web-gateway.md). |
| `agentPath` | string | `<root>/packages/userspace-agent/dist/src/agent.js` | The agent the fence starts. Derived. |
| `model` | string | `anthropic/claude-sonnet-5` | The initial `call.model` of every turn. |
| `phases` | string[] | `["history","prompt","tools","call","after"]` | The phase order. |
| `callPhase` | string | `call` | The phase that ends with the built-in provider call. |
| `enumerator` | `{ package, export }` | not set | A package enumerator that replaces the default plan. |
| `systemPackages` | object | see below | System packages to link per userspace. Seeding runs when a userspace is created. An existing userspace gets a new system package with `thetis packages install @thetis/<name> --user <id>`. |
| `packages` | object | see below | The file layer of per-package configuration. See section 4. |
| `storage.driver` | string | `@thetis/store-toml` | The storage driver: a package of type `storage`, loaded by the host at start, never installed into a fence. See [26-storage.md](26-storage.md) section 3. |
| `fence.sandbox` | `auto`, `bwrap`, `none` | `auto` | The sandbox mode. |
| `fence.network` | `auto`, `egress`, `none`, `host` | `auto` | What a fence can reach. See [03-fence.md](03-fence.md) section 3.2. |
| `fence.limits` | `{ memoryMb, pids, cpuPercent }` | `auto`, `512`, `200` | Per-fence resource limits. Need a delegated cgroup. `memoryMb: "auto"` is no memory ceiling; a number caps it. See [03-fence.md](03-fence.md) section 3.3. |
| `fence.readOnly` | string[] | `[<root>/packages, <root>/node_modules, <home>/packages]` | Extra read-only binds. Derived. |
| `fence.hidden` | string[] | `[<home>]` | Paths masked with an empty tmpfs. Derived. |
| `fence.docker` | `auto`, `on`, `off` | `auto` | Whether every fence is given the host's Docker socket. Socket access is host root. See [03-fence.md](03-fence.md) section 3.9 and [12-security.md](12-security.md) section 3. |
| `fence.dockerSocket` | string | unset | The host Docker socket to bind, when it is not in one of the usual places. When set it is the only candidate. |
| `requestTimeoutMs` | number | `600000` | Timeout of one fence request. |
| `control.allowRestart` | boolean | `true` | Whether a restart of the daemon may be asked for at all. `false` refuses every request, whoever makes it. See [25-restart.md](25-restart.md). |
| `control.minUptimeSecs` | number | `60` | A restart is refused before this uptime, so a restart that fixes nothing cannot become a loop. |
| `control.quietWaitMs` | number | `120000` | How long an armed restart waits for every turn to finish before it restarts anyway and cuts the turns still running. |

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

### 4.1 The four layers

A package's configuration is the merge of four layers. A later layer wins a top-level key.

| Order | Layer | Where | Who writes it |
|---|---|---|---|
| 1 | `default` | The `default` of each key the package declares (section 4.3). | The package author. |
| 2 | `file` | `packages[<name>]` in `thetis.config.json`, over the shipped defaults of section 3. | The operator, with an editor, then `thetis config reload`. |
| 3 | `system` | The store namespaces `config/system` and `secrets/system`. | An admin: `thetis config set`, the Configuration section of the control panel, or the operator method `config.set`. |
| 4 | `user` | The store namespaces `config/users/<user>` and `secrets/users/<user>`. | That person: **Configure** in the marketplace, `kernel.config.set` from their fence, the `configure_package` tool, or `thetis config set --user <id>`. |

Within the system and the user layer, the secrets document overlays the config document, so a key lives in one of the two. The system userspace `_system` has no user layer: its own layer is the system layer.

`ConfigService` in `packages/kernel/src/settings.ts` decides who may write what. `LayeredConfig` in `packages/lib/src/config.ts` reads and writes the documents.

### 4.2 Forks inherit

A fork receives its origin's configuration. The chain is read from `forkedFrom`, origin first, up to eight links, and stops at a package the userspace cannot see or a name already visited. `PackageManager.manifestOf` reads the manifest from the store link, else the shipped or promoted directory, else the directory the displaced origin was installed from (the fork's record carries `replacedSource`), because installing a fork uninstalls its origin.

The merge is **layer-major**: for a fork `P` of origin `O`, the documents are read in the order `default(O)`, `default(P)`, `file(O)`, `file(P)`, `system(O)`, `system(P)`, `user(O)`, `user(P)`. So a person's override on the origin still beats a file entry on the fork, and the fork's own key beats the origin's at every layer. `config.show` reports `inheritedFrom` on a key whose value came from an origin; `package_config` prints it as `inherited from <name>`.

### 4.3 Declarations

A package declares its keys under `thetis.config` in its manifest. Declaring is optional. An undeclared key is allowed and untyped.

```json
"thetis": {
  "type": "tool",
  "config": {
    "token": { "type": "string", "secret": true, "required": true, "help": "The API token." },
    "timeoutMs": { "type": "number", "default": 60000, "help": "One request, in milliseconds." },
    "sessions": { "type": "number", "default": 8, "scope": "system", "help": "Per person." }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | `string`, `number`, `boolean`, `object`, `array` | Required. A value set through `config.set` must match. |
| `secret` | boolean | Kept in a private namespace. Never shown, never echoed by a tool, named but not valued in the journal. |
| `required` | boolean | The package cannot work without it. The panel, the CLI and `package_config` say so before the model finds out. |
| `default` | any | The `default` layer. Checked against `type`. |
| `scope` | `system`, `user` | `system`: only an admin sets it, at the system layer; a person's own layer never holds it. Default `user`. |
| `help` | string | One sentence for the form. |

A key is a bare identifier (`^[A-Za-z_][A-Za-z0-9_]*$`). `validateManifest` runs `validateDecls` on the field, so a package with a bad declaration does not install and is not read. A fork's declaration of a key replaces its origin's.

An undeclared key whose name matches `key`, `secret`, `token` or `password` (any case) is treated as a secret. A string leaf under such a name inside a non-secret value (`embeddings.apiKey`) is shown as `•••` at any depth.

### 4.4 What a package receives

Every dispatch site calls `ConfigService.effective(userspace, name)`: every layer merged along the fork chain, secrets included, references resolved from the environment as it is now, unresolved leaves left out.

| Code | Receives it as |
|---|---|
| A step | `ctx.config` |
| A tool | `env.config` |
| A provider factory | Its argument. The agent keeps one provider instance per package, export and configuration, so a changed key makes a new instance. |
| A service | `env.config`, read once at `service.start`. |
| A UI command | `env.config`, fetched by the web gateway through `kernel.config.effective` on every call. |

`kernel.config.effective(name)` over the fence RPC answers for any package installed in the same fence, secrets included: a fence is one person's authority, so a package in it may load another's configuration the way the web gateway runs another package's UI commands. See [12-security.md](12-security.md) section 4.

### 4.5 Known keys

| Package | Key | Meaning |
|---|---|---|
| `@thetis/provider-openrouter` | `apiKey` (secret, required), `baseUrl` (`https://openrouter.ai/api/v1`), `headers`, `defaults`, `cache`, `retries` (`3`) | The key, the API root, extra headers, request fields sent with every call, the caching policy, and how many times a transient refusal is tried again. See [07-providers.md](07-providers.md) and [16-prompt-cache.md](16-prompt-cache.md). |
| `@thetis/prompt-cache` | `enabled` (`true`), `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `diagnostics` (`true`), `affinity` (`true`) | The hint and the diagnostics. See [16-prompt-cache.md](16-prompt-cache.md). |
| `@thetis/marketplace` | `registries` (system), `refreshMinutes` (`30`, system) | The registries to mirror. Ships with one, `https://github.com/thetis-agent/packages.git`, the approved extensions. Set `registries` to `[]` to index nothing and keep the refresh off the network. See [18-marketplace.md](18-marketplace.md). |
| `@thetis/gateway-web` | none | Runs in each person's fence on a unix socket. See [15-web-gateway.md](15-web-gateway.md). |
| `@thetis/gateway-login` | `secure` (`false`, system) | Adds `Secure` to the login cookie. Set it when TLS terminates in front of the door. |
| `@thetis/exa` | `apiKey` (secret, required), `baseUrl` (`https://api.exa.ai`), `timeoutMs` (`60000`), `defaults` | The Exa API key and the tool defaults. See [19-exa.md](19-exa.md). |
| `@thetis/skills-hybrid` | `fusionWeight` (`0.7`), `pinLimit` (`6`), `pinBodies` (`false`), `embeddings` | The dense share of the fusion, how many skills are pinned, bodies instead of cards, and the vector source `{ baseUrl, apiKey, model, dimensions }` with defaults `https://openrouter.ai/api/v1`, `${OPENROUTER_API_KEY}`, `openai/text-embedding-3-small`, `1536`. Without a key the ranking is lexical. See [23-skills.md](23-skills.md) section 4.3. |
| `@thetis/terminal` | `shell` (`/bin/bash`), `sessions` (`8`, system), `bufferBytes` (`262144`, system), `idleMinutes` (`30`, system), `waitMs` (`120000`) | The shell the pty runs, the open sessions per person, the ring buffer per session in characters, the minutes of idle before a session is closed (`0` disables it), and the default wait of the `shell` tool in milliseconds. The three limits are admins-only: a person cannot raise them in their own layer. There is no `enabled` key: a person who should not have a terminal does not have the package installed. See [24-terminal.md](24-terminal.md) section 6. |

The value in parentheses is the declared default. `system` marks a key declared `scope: "system"`.

## 5. Changing the configuration

### 5.1 What is live

| Change | Reaches a running daemon |
|---|---|
| `config.set` or `config.unset` at any layer | At once. A step or a tool sees it on its next call; a provider on its next call, through a new instance; the service of the changed package, and of every fork of it, stops and starts again with the new configuration. The fence stays open: the person's other services, gateway and shell sessions are not touched. |
| `packages[*]` edited in `thetis.config.json` | After `thetis config reload`, the same way. The kernel diffs the file layer, names the packages that changed, and restarts their services. |
| A variable changed in `<root>/.env` | On the next call that resolves it. No service restarts for it: a service reads its configuration once at start, so `thetis config reload` or a reload of the workspace is needed for a service to see it. |

The restart runs in the fence the service already runs in. The journal shows `service.stop` and then `service.start` for the package.

### 5.2 What still needs a restart

`door`, `storage` and `requestTimeoutMs` are read once by `thetis serve` and held for its life; so is any key with no entry in `CONFIG_TIERS`. A change to them needs a new daemon process: `sudo systemctl restart thetis-runtime.service`, `thetis restart`, or the `restart_daemon` tool. Reloading a workspace does not help: it replaces the code in a fence, not what the kernel holds. See [25-restart.md](25-restart.md) and [10-development.md](10-development.md) section 4.1.

To change the model for one user only, install a package with a `prompt` step that sets `call.model`.

### 5.3 The command line

```
thetis config                                         the file over its defaults, secret-looking keys hidden
thetis config show [<package>] [--user <id>]           every key of one package, or one line per package
thetis config set <package> <key> [<value>] [--user <id>] [--json] [--stdin]
thetis config unset <package> <key> [--user <id>]
thetis config reload                                  re-read packages[*] and restart the services that changed
```

Without `--user` a command acts on the system layer; with it, on that person's layer. `--json` parses the value, so a number, a boolean, an object or an array can be set. `--stdin` reads the value from standard input, so a secret never lands in the shell's history or in `ps`. `show` prints the kernel's one sentence about the package first, then one line per key: the key, its state (`set`, `missing`, `unset`), the value or `•••` for a secret, the layer it came from, the origin it was inherited from, and the variables that did not resolve. See [08-cli.md](08-cli.md) section 2.15.

### 5.4 The panel

The **Configuration** section of the control panel (`@thetis/ui-admin`, admins) shows one card per package at the system layer, or at one person's layer from a picker. A form is drawn from the declarations; a secret is a write-only box that says `set` or `not set`; an undeclared key is a JSON box; a key declared `scope: "system"` is read-only in a person's view. **Reload the file** runs `config.reload`. See [17-control-panel.md](17-control-panel.md).

**Configure** on a package's page in the marketplace (`@thetis/ui-marketplace`, everyone) is the same form on the person's own layer. The gallery card and the page say the kernel's sentence when a required key is missing, so a person sees it before an agent does. See [18-marketplace.md](18-marketplace.md) section 9.

### 5.5 The tool

`configure_package { name, key, value?, unset?, json? }` in `@thetis/tool-exec` sets or unsets one key in the caller's own layer for a package installed in their userspace, secrets included. The reply names the key and its new state, never the value. `package_config { name }` returns the state of every key. See [20-tools.md](20-tools.md) section 3.1.

**Caution:** a secret the model sets through `configure_package` was pasted into the conversation, and the transcript keeps it. The tool's description tells the model to prefer asking the person to set a secret in the panel.

### 5.6 The journal

Every `config.set` and `config.unset` writes one row: the actor, the target user (or `_system` for the system layer), and `data` with `package`, `key`, `layer` and `secret`. The value is never written. See [12-security.md](12-security.md) section 9.

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

All other fields take their defaults. Then, without a restart:

```sh
thetis config set @thetis/exa apiKey --stdin < exa.key       # a secret, at the system layer
thetis config set @thetis/exa timeoutMs 30000 --json          # a number
thetis config show @thetis/exa
```
