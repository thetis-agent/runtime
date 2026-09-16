# 05 Packages

A package is the unit of everything in Thetis. A package is a directory with a `package.json` that has a `thetis` field.

## 1. The manifest

```json
{
  "name": "@alice/example",
  "version": "0.1.0",
  "description": "Adds a greeting tool and a context step.",
  "type": "module",
  "main": "index.js",
  "dependencies": {},
  "peerDependencies": { "@thetis/contracts": "^0.1.0" },
  "scripts": { "build": "tsc -b" },
  "thetis": {
    "type": "loader",
    "steps": [ { "id": "add-context", "phase": "prompt", "export": "addContext" } ],
    "tools": [ { "name": "greet", "description": "Say hi", "parameters": { "type": "object", "properties": {} }, "export": "greet" } ],
    "export": "createProvider",
    "service": { "export": "startService" },
    "publish": [ { "port": 8777, "to": "host" } ]
  }
}
```

### 1.1 Standard fields the kernel reads

| Field | Use |
|---|---|
| `name` | Required. Must match `@<scope>/<name>`. The scope gives ownership. See section 4. |
| `version` | Required. A string. |
| `description` | One sentence on what the package does. Shown in the control panel, in the marketplace index, and in the system prompt's package list. Every shipped package has one. |
| `main` | The module the agent imports. Default `index.js`. Relative to the package directory. |
| `dependencies` | When not empty and there is no build script, install runs `npm install --omit=dev`. |
| `peerDependencies` | Each peer must be installed in the same userspace. `@thetis/contracts`, `@thetis/lib`, and `@thetis/kernel` are always satisfied. |
| `scripts.build` | When present, install runs `npm install` and then `npm run build`. |

### 1.2 The `thetis` field

| Field | Type | Use |
|---|---|---|
| `type` | string, required | The package type. An open set. See section 2. |
| `steps` | array | Pipeline steps. Each entry needs `id`, `phase`, and `export`. |
| `tools` | array | Tools. Each entry needs `name`, `description`, `export`, and can have `parameters` (a JSON schema object). |
| `export` | string | The factory export of a provider or the function export of an enumerator. Default `createProvider` for providers. |
| `service` | `{ export }` | A long-running process. The userspace agent starts the export when the fence opens under `thetis serve`. See section 13. |
| `publish` | array | Declared ports. The kernel records the field. It does not act on it yet. |
| `forkedFrom` | `{ name, version }` | Set on a fork. Installing the fork replaces the named package when it is installed in the same userspace. See section 16. |
| `bench` | object | Opts the package into benchmark suites. The kernel records the field and does not read it. See [21-benchmarks.md](21-benchmarks.md). |
| `ui` | object | What the package adds to the web gateway's page: browser files, slot entries, and commands. The kernel records the field and does not read it. See [15-web-gateway.md](15-web-gateway.md) section 11. |
| `skills` | string | A directory of skills relative to the package root, usually `"skills"`. `@thetis/skills` reads it; the kernel records the field and does not read it. See [23-skills.md](23-skills.md). |

`validateManifest` in `src/packages/manifest.ts` enforces the required fields. A manifest that fails validation does not install. It does not reject fields it does not know, so `thetis.bench` and `thetis.ui` reach every step through `ctx.packages.list()` untouched. `@thetis/bench` validates the first and `@thetis/gateway-web` the second, because the kernel never reads them.

**Note:** a step declared with `phase: "bench"` is never scheduled. The default phases are `history`, `prompt`, `tools`, `call`, `after`, and only the bench adds `bench` to them. That is how a package carries benchmark code it can never run on an ordinary turn.

## 2. Package types

The type is a label. The kernel reads the `steps` and `tools` arrays of every package, whatever its type. Only two types have kernel behavior:

- `provider`: `ProviderRegistry` discovers packages with this type and calls their factory export.
- Any type with steps or tools: the enumerator schedules the steps; `@thetis/harness-core` attaches the tools.

Types in use or planned:

| Type | Contributes |
|---|---|
| `loader` | Steps that put content into the call. |
| `tool` | Tools. |
| `memory` | Steps that read and write `harness`. |
| `provider` | A model source. |
| `enumerator` | A replacement for the default plan. Set `config.enumerator` to use it. |
| `gateway` | An endpoint. `@thetis/gateway-cli` and `@thetis/gateway-web` have this type. |
| `service` | A long-running process with no other contribution. Any type can also declare a `service`. |
| `skill` | A directory of skills, declared with `thetis.skills`. See [23-skills.md](23-skills.md). |
| `skill-type` | The skill format and library: `@thetis/skills`, with the `skill_fetch` tool. The loaders that use it are `loader` packages. |
| `mcp`, `mcp-server`, `rag` | Planned. No kernel behavior yet. |

## 3. Writing package code

Use plain ECMAScript modules. A build step is optional.

### 3.1 A step

```js
export async function addContext(ctx) {
  const memory = await ctx.env.readFile("memory.md").catch(() => "");
  return {
    call: { ...ctx.call, system: `${ctx.call.system ?? ""}\n\n${memory}` },
    harness: { ...ctx.harness, seen: (ctx.harness.seen ?? 0) + 1 },
  };
}
```

See [04-pipeline.md](04-pipeline.md) section 3 for the full contract.

### 3.2 A tool

```js
export async function greet(args, env) {
  const r = await env.exec("whoami");
  return `hi ${args.name}, I am ${r.stdout.trim()}`;
}
```

A tool receives the arguments the model sent and the `ToolEnv`. It returns a string or a JSON-serializable value. A thrown error becomes the text `error: <message>` for the model.

### 3.3 A provider

```js
export function createProvider(config) {
  return {
    async models() { return [{ id: "my-model" }]; },
    async *call(call) {
      yield { type: "text", delta: "hello" };
      yield { type: "tool_call", call: { id: "c1", name: "exec", args: { cmd: "ls" } } };
      yield { type: "usage", usage: { total_tokens: 12 } };
    },
  };
}
```

`config` is `config.packages[<package name>]`. See [07-providers.md](07-providers.md).

### 3.4 An enumerator

```js
export async function enumerate(ctx) {
  const steps = [];
  for (const phase of ctx.phases) {
    for (const pkg of ctx.packages.list()) {
      for (const s of pkg.thetis.steps ?? []) if (s.phase === phase) steps.push({ package: pkg.name, export: s.export, phase });
    }
    if (phase === "call") steps.push({ package: "@thetis/kernel", export: "provider-call", phase });
  }
  return steps;
}
```

### 3.5 Types for TypeScript packages

Import types from `@thetis/contracts`: `PackageStepContext`, `Step`, `StepResult`, `Tool`, `ToolEnv`, `Provider`, `ProviderCall`, `ProviderEvent`, `EnumeratorContext`, `PackageInfo`, `Message`. Use `import type`. The contracts package has no code. The kernel is not available inside a fence.

## 4. Scopes and ownership

| Scope | Owner | Install rule |
|---|---|---|
| `@thetis/*` | The system | Shipped in `<root>/packages`, or promoted into `$THETIS_HOME/packages`. An admin or the system user can install one into any userspace. |
| `@<user>/*` | That user | Only that user can install it, and only into that user's userspace. |

`PackageManager.checkOwnership` enforces the rule. The error code is `unauthorized`.

## 5. Sources

`PackageManager.install(userspace, actor, source)` classifies `source`:

| Source | Detection | Action |
|---|---|---|
| System name | `@thetis/<name>` with no further `/` | Link the shipped package. Requires role `admin` or `system`. |
| Git URL | Starts with `http://`, `https://`, `git@`, `git://`, `ssh://`, or `file://`, or ends with `.git`. An optional `#<dir>` names a directory inside the repository, and an optional `@<commit>` pins one commit. | Without a pin, `git clone --depth 1` into `<store>/src/<slug>` inside the fence. With one, `git fetch --depth 1 origin <commit>` into `<store>/src/<slug>-<commit prefix>`. With `#<dir>`, the package is that directory of the clone. A `dir` that leaves the clone is refused with the code `unauthorized`. |
| Local path | Anything else | Resolve relative to the userspace home. The path must stay inside the userspace root. |

## 6. The install procedure

1. Obtain the package directory (section 5).
2. Read and validate `package.json`.
3. Check ownership (section 4).
4. Check peer dependencies. Each peer except `@thetis/contracts`, `@thetis/lib`, and `@thetis/kernel` must be installed in this userspace. Error code `peer`.
5. Build inside the fence:
   - with `scripts.build`: `npm install --no-audit --no-fund && npm run build`;
   - else with `dependencies`: `npm install --omit=dev --no-audit --no-fund`;
   - else: nothing.
   Each command has a timeout of 300000 milliseconds. A non-zero exit code fails the install with the code `build`.
6. Make sure the `main` file exists.
7. Link `<store>/node_modules/<name>` to the package directory. Links to directories inside the userspace are relative. Links to system packages are absolute.
8. Record the package in the registry.

The package is active on the next turn. The kernel reads manifests at the start of each turn.

## 7. The store

Each userspace has a store at `<userspace>/store`:

```
store/
  node_modules/@thetis/<name>  -> <root>/packages/<dir>        (system packages)
  node_modules/@<user>/<name>  -> ../../../home/packages/<dir>  (local packages)
  src/<slug>/                                                  (git clones)
```

The agent imports modules from `store/node_modules`. The store is inside the fence.

## 8. The registry

The registry is the file `$THETIS_HOME/registry.json`. It is in the service plane. Each record is:

```json
{
  "name": "@alice/hello",
  "version": "0.1.0",
  "type": "loader",
  "owner": "alice",
  "source": { "kind": "local", "ref": "packages/hello" },
  "userspaces": ["alice"]
}
```

`kind` is `system`, `local`, or `git`. `ref` is the system directory, the local path relative to home, or the git source. A git source from the marketplace carries its pin, so the record says exactly which commit is installed. See [18-marketplace.md](18-marketplace.md) section 6. `userspaces` lists where the package is installed. A record with no userspaces is deleted.

A fork's record also carries `forkedFrom` (from its manifest), `replaced` (the package it displaced), and `replacedSource` (where that package was installed from). See section 16.

## 9. Reading installed packages

`PackageManager.installed(userspace)` returns the packages in registry order. For each record it reads the live manifest from the store link. When the link is dead:

- a system package is linked again from `<root>/packages`;
- a local package is linked again from `<home>/<ref>`;
- a git package is linked again from `<store>/src/<slug>`;
- when the files are missing, the kernel logs a message and skips the package.

This repair makes a moved checkout or a moved data directory work without a reinstall.

Each `PackageInfo` carries `everyone: true` when every person gets the package: it is in `systemPackages["*"]`, promoted (section 14), or marked for everyone (section 15). `PackageManager.forEveryone()` is that list. A shipped package one person installed for themselves has no mark.

## 10. System packages

The configuration field `systemPackages` lists the packages that the kernel links into a userspace when the userspace is created:

```json
{ "*": ["@thetis/harness-core", "@thetis/tool-exec"], "_system": ["@thetis/provider-openrouter"] }
```

`"*"` applies to every person's userspace, together with every promoted package. A user id applies to that userspace only. The system userspace `_system` gets only its own list: it is not a person. `PackageManager.seedSystem` runs when a userspace is created and when a userspace has no packages.

The kernel finds a system package by name. It scans every directory in `systemPackagesDir` (default `<root>/packages`) and then in `promotedPackagesDir` (default `$THETIS_HOME/packages`), and reads the `name` field of each `package.json`.

## 11. Uninstall

`PackageManager.uninstall(userspace, name)` stops the package's service, removes the store link, and removes the registry entry for that userspace. It does not delete the package files. When the record carries `replaced`, the displaced package comes back in the same call. See section 16.

`PackageManager.delete(userspace, name)` uninstalls a package in the userspace's own scope and deletes its directory. The package must be a local package under the home directory. `@thetis/*` packages and anything outside the home are refused with the code `unauthorized`.

## 12. Lifecycle from a conversation

The model performs this cycle with the tools of `@thetis/tool-exec`:

1. `write_path` writes `packages/<name>/package.json` and `packages/<name>/index.js` under the home directory.
2. `exec` runs `node` to test the module.
3. `install_package` with `source: "packages/<name>"` installs it.
4. On the next turn the new steps run and the new tools are attached.

The test `test/e2e.test.ts` verifies this cycle.

To change a package that is already installed, the model uses `fork_package`, edits the copy, and installs it. See section 16.

## 13. Services

A package with a `service` field runs a process for as long as it is installed and its fence is open.

```js
export async function startService(env) {
  const server = createServer(...).listen(env.config.port ?? 8777);
  env.log("listening");
  return { stop: () => new Promise((done) => server.close(done)) };
}
```

`env` is a `ServiceEnv`: the `StepEnv` fields, `config` (`config.packages[<name>]`), and `log`. The service runs inside the userspace agent, so it sees the same files and reaches the kernel through `env.kernel`.

`ServiceSupervisor` in `src/services.ts` controls the lifecycle:

| Event | Effect |
|---|---|
| `thetis serve` calls `services.boot()` | Every declared service in every userspace starts. |
| A fence opens while the supervisor is armed | The services of that userspace start. This covers a restart after a crash. |
| A service package is installed while the supervisor is armed | It starts at once. |
| A service package is uninstalled | `service.stop` runs before the link is removed. |
| A workspace is reloaded (`fence.reload`, or `mounts.set`) | The fence closes and `ServiceSupervisor.reload` opens it again, starting every declared service. |
| The kernel shuts down | Every fence closes. Every service exits with its agent. |

A one-shot CLI command never arms the supervisor. `thetis send` does not start a gateway.

A service's code is read **once**, when its agent starts — unlike a `tool` or `step` export, which the
agent re-imports with a modification-time query on every call. So editing a service's files changes
nothing in a running installation until that workspace is reloaded. See
[25-restart.md](25-restart.md).

`publish` is recorded and not enforced. The process fence shares the host network, so a port bound by a service is reachable on the host. See [12-security.md](12-security.md).

## 14. Promote: make a package the default for everyone

An admin can make a user's package a system package. The control method is `packages.promote { user, name }`. The command is `thetis packages promote <name> --user <id>`. The web gateway offers it in the control panel as **Make it the default for everyone**.

`PackageManager.promote(us, name)`:

1. The package must be recorded for `user`, owned by `user`, and not a system package. Otherwise the code is `invalid`.
2. The package directory is copied to `$THETIS_HOME/packages/<basename>`, with its built `node_modules`. A target that exists is refused.
3. The `name` in the copied `package.json` becomes `@thetis/<basename>`.

The control handler then removes the owner's original `@<user>/<basename>` and installs `@thetis/<basename>` into every existing userspace. New userspaces get it because `seedSystem` links every package in the promoted directory. The configuration file is never written by the kernel. Services the package declares start at once when the supervisor is armed.

The promoted directory is bound read-only into every fence, after `$THETIS_HOME` is hidden. See [03-fence.md](03-fence.md).

**Caution:** promotion copies the package as it is. A later change to the owner's source does not reach the promoted copy. Promote again under a new name, or edit the copy in `$THETIS_HOME/packages` on the host.

## 15. Install for everyone

An admin can install a package for every person, now and later. The control method is `packages.installEveryone { source }`. The control panel offers it on an available package as **Install for everyone**.

- A shipped system package (`@thetis/<name>` in `<root>/packages`) is linked into every existing person's userspace and marked `everyone` in the registry record. `seedSystem` links every marked package into each new person's userspace. The configuration file is not written.
- Any other source is installed for the admin first. A `@thetis/*` package from a registry is then linked into every person. A package in the admin's own scope is promoted (section 14), which covers every new person through the promoted directory.

The system userspace is never included: it is not a person.

## 16. Forks

A fork is a copy of an installed package under the person's own scope. It runs in place of the original.

### 16.1 The tool

`fork_package` in `@thetis/tool-exec` takes `name` (an installed package, such as `@thetis/tools-plan`) and `as` (the directory name under `packages/` in the home; default the unscoped name). It:

1. Copies the package's root, without `node_modules`, to `packages/<as>` under the home.
2. Rewrites the copy's `package.json`:

| Field | Change |
|---|---|
| `name` | `@<user>/<as>`. |
| `version` | `<origin version>-fork.1`. When a package named `@<user>/<as>` is already installed with a version `<origin version>-fork.N`, the copy gets `fork.N+1`. |
| `scripts` | Removed. |
| `devDependencies` | Removed. |
| `dependencies` | A dependency the original resolves is linked into the copy's `node_modules` and removed from the field. The rest stay, and install runs `npm install` for them. |
| `thetis.forkedFrom` | `{ name, version }` of the original. |
| everything else | Kept. |

3. Returns the path, the original's name and version, the steps, tools and service the copy carries, and the next step: edit, then `install_package` with `source: "packages/<as>"`.

The tool does not install. It refuses a package that is not installed in the caller's userspace and a target directory that exists.

The mechanism is `forkPackage` in `@thetis/lib/pkg-fs`. The tool is thin.

### 16.2 The replace rule

`PackageManager.install` applies one rule: when the manifest carries `forkedFrom` and that package is installed in the same userspace, the fork replaces it in one operation.

1. The original's service stops.
2. The original's link and registry entry go.
3. The fork's link comes. Its record gets `replaced` and `replacedSource`.
4. The fork's service starts.

Tool names and sockets never clash: the original is gone before the fork is live. When the original is not installed, the fork installs like any package.

The ownership rules do not change. A person forks into `@<user>/*`. A promoted package that carries `forkedFrom` replaces its original in each userspace it is installed into, so an admin brings a fork under `@thetis/*` through promote (section 14), not through install. `seedSystem` does not apply the rule.

### 16.3 The restore rule

`PackageManager.uninstall` of a record with `replaced` puts the original back in the same call:

- a `@thetis/*` system package is installed by name;
- any other package is linked again from its recorded source and recorded for the userspace.

The original's service starts when the supervisor is armed.

### 16.4 Delete

`delete_package` in `@thetis/tool-exec` takes `name`. It calls `PackageManager.delete`: the package is uninstalled, which restores the original when it was a fork, and its directory under `packages/` in the home is deleted. It returns what was removed and what came back. Only packages in the caller's own scope, installed from under the home, can be deleted. `uninstall_package` keeps its meaning: the link goes, the files stay.

The control panel offers **Delete** beside **Remove** on a package of the person's own. See [17-control-panel.md](17-control-panel.md).

### 16.5 TypeScript packages

A shipped TypeScript package cannot rebuild inside a fence: the compiler is a development dependency, and the fence has no network. The fork therefore carries the built `dist/` and runs it as it is. The `main` field still points at `dist/src/index.js`. To change such a fork, edit the JavaScript in `dist/`, or build outside the fence and copy the result in.

### 16.6 Example

```
fork_package { name: "@thetis/tools-plan" }
  -> forked @thetis/tools-plan@0.1.0 to packages/tools-plan as @alice/tools-plan@0.1.0-fork.1; tools: todo_write, ...
edit_path { path: "packages/tools-plan/index.js", ... }
install_package { source: "packages/tools-plan" }
  -> installed @alice/tools-plan@0.1.0-fork.1 (tool); tools: ...; replaced @thetis/tools-plan. Live on the next turn.
delete_package { name: "@alice/tools-plan" }
  -> deleted @alice/tools-plan and its files at .../packages/tools-plan; @thetis/tools-plan is back in place.
```
