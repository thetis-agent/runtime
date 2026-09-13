# 05 Packages

A package is the unit of everything in Thetis. A package is a directory with a `package.json` that has a `thetis` field.

## 1. The manifest

```json
{
  "name": "@alice/example",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "dependencies": {},
  "peerDependencies": { "@thetis/kernel": "^0.1.0" },
  "scripts": { "build": "tsc -b" },
  "thetis": {
    "type": "loader",
    "steps": [ { "id": "add-context", "phase": "prompt", "export": "addContext" } ],
    "tools": [ { "name": "greet", "description": "Say hi", "parameters": { "type": "object", "properties": {} }, "export": "greet" } ],
    "export": "createProvider",
    "publish": [ { "port": 8777, "to": "host" } ]
  }
}
```

### 1.1 Standard fields the kernel reads

| Field | Use |
|---|---|
| `name` | Required. Must match `@<scope>/<name>`. The scope gives ownership. See section 4. |
| `version` | Required. A string. |
| `main` | The module the agent imports. Default `index.js`. Relative to the package directory. |
| `dependencies` | When not empty and there is no build script, install runs `npm install --omit=dev`. |
| `peerDependencies` | Each peer must be installed in the same userspace. `@thetis/kernel` is always satisfied. |
| `scripts.build` | When present, install runs `npm install` and then `npm run build`. |

### 1.2 The `thetis` field

| Field | Type | Use |
|---|---|---|
| `type` | string, required | The package type. An open set. See section 2. |
| `steps` | array | Pipeline steps. Each entry needs `id`, `phase`, and `export`. |
| `tools` | array | Tools. Each entry needs `name`, `description`, `export`, and can have `parameters` (a JSON schema object). |
| `export` | string | The factory export of a provider or the function export of an enumerator. Default `createProvider` for providers. |
| `publish` | array | Declared ports. The kernel records the field. It does not act on it yet. |

`validateManifest` in `src/packages/manifest.ts` enforces the required fields. A manifest that fails validation does not install.

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
| `gateway` | An endpoint. `@thetis/gateway-cli` has this type. |
| `skill`, `skill-type`, `mcp`, `mcp-server`, `rag`, `service` | Planned. No kernel behavior yet. |

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

Import types from `@thetis/kernel`: `PackageStepContext`, `Step`, `StepResult`, `Tool`, `ToolEnv`, `Provider`, `ProviderCall`, `ProviderEvent`, `EnumeratorContext`, `PackageInfo`, `Message`. Use `import type`. The kernel module is not available at run time inside a fence.

## 4. Scopes and ownership

| Scope | Owner | Install rule |
|---|---|---|
| `@thetis/*` | The system | Shipped in `<root>/packages`. An admin or the system user can install one into any userspace. |
| `@<user>/*` | That user | Only that user can install it, and only into that user's userspace. |

`PackageManager.checkOwnership` enforces the rule. The error code is `unauthorized`.

## 5. Sources

`PackageManager.install(userspace, actor, source)` classifies `source`:

| Source | Detection | Action |
|---|---|---|
| System name | `@thetis/<name>` with no further `/` | Link the shipped package. Requires role `admin` or `system`. |
| Git URL | Starts with `http://`, `https://`, `git@`, `git://`, or `ssh://`, or ends with `.git` | `git clone --depth 1` into `<store>/src/<slug>` inside the fence. |
| Local path | Anything else | Resolve relative to the userspace home. The path must stay inside the userspace root. |

## 6. The install procedure

1. Obtain the package directory (section 5).
2. Read and validate `package.json`.
3. Check ownership (section 4).
4. Check peer dependencies. Each peer except `@thetis/kernel` must be installed in this userspace. Error code `peer`.
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

`kind` is `system`, `local`, or `git`. `ref` is the system directory, the local path relative to home, or the git URL. `userspaces` lists where the package is installed. A record with no userspaces is deleted.

## 9. Reading installed packages

`PackageManager.installed(userspace)` returns the packages in registry order. For each record it reads the live manifest from the store link. When the link is dead:

- a system package is linked again from `<root>/packages`;
- a local package is linked again from `<home>/<ref>`;
- a git package is linked again from `<store>/src/<slug>`;
- when the files are missing, the kernel logs a message and skips the package.

This repair makes a moved checkout or a moved data directory work without a reinstall.

## 10. System packages

The configuration field `systemPackages` lists the packages that the kernel links into a userspace when the userspace is created:

```json
{ "*": ["@thetis/harness-core", "@thetis/tool-exec"], "_system": ["@thetis/provider-openrouter"] }
```

`"*"` applies to every userspace. A user id applies to that userspace only. `PackageManager.seedSystem` runs when a userspace is created and when a userspace has no packages.

The kernel finds a system package by name. It scans every directory in `systemPackagesDir` (default `<root>/packages`) and reads the `name` field of each `package.json`.

## 11. Uninstall

`PackageManager.uninstall(userspace, name)` removes the store link and the registry entry for that userspace. It does not delete the package files. It does not stop processes.

## 12. Lifecycle from a conversation

The model performs this cycle with the tools of `@thetis/tool-exec`:

1. `write_file` writes `packages/<name>/package.json` and `packages/<name>/index.js` under the home directory.
2. `exec` runs `node` to test the module.
3. `install_package` with `source: "packages/<name>"` installs it.
4. On the next turn the new steps run and the new tools are attached.

The test `test/e2e.test.ts` verifies this cycle.
