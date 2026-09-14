# 18 Marketplace

The marketplace is the set of registries this installation trusts. A registry is one git repository that holds package directories. The package `@thetis/marketplace` in `packages/marketplace` mirrors the registries and writes an index. The control panel searches the index and installs from it. See [17-control-panel.md](17-control-panel.md).

## 1. Registries

`config.packages["@thetis/marketplace"]`:

```json
{
  "registries": [
    { "name": "thetis", "url": "file:///srv/thetis/runtime/packages" },
    { "name": "team", "url": "https://git.example.com/thetis/packages.git" }
  ],
  "refreshMinutes": 30
}
```

| Key | Default | Meaning |
|---|---|---|
| `registries[].url` | required | A git URL. `file://` paths work when the path is readable inside the system fence. `<root>/packages` is, so the shipped packages repository is a natural first registry. |
| `registries[].name` | the last path segment | Shown in the panel. |
| `refreshMinutes` | `30` | How often the service refreshes. |

A registry holds packages at its first or second directory level. Each package directory has a `package.json` with a `thetis` field. A directory without one is ignored. `node_modules` directories are skipped.

## 2. The service

`@thetis/marketplace` is a `service` package installed in the system userspace:

```json
"systemPackages": { "_system": ["@thetis/provider-openrouter", "@thetis/marketplace"] }
```

`startService` refreshes on start and every `refreshMinutes`. A refresh clones each registry with `git clone --depth 1` into `home/marketplace/repos/<slug>` through the fence's `exec`, reads every `package.json`, and writes the index. A registry that fails keeps the packages of its last successful refresh and records the error.

Install it into a running daemon with `thetis packages install @thetis/marketplace`. The log line `indexed N packages from M registries` confirms the first refresh.

## 3. The index file

`home/marketplace/index.json` in the system userspace. This file is the contract. Any package or gateway in that userspace can read it by path.

```json
{
  "version": 1,
  "updatedAt": "2026-09-14T00:00:00.000Z",
  "registries": [{ "name": "thetis", "url": "file:///...", "commit": "<40 hex>", "error": "<only when the refresh failed>" }],
  "packages": [
    {
      "name": "@thetis/prompt-cache", "version": "0.1.0", "type": "loader",
      "description": "", "keywords": [],
      "registry": "thetis", "url": "file:///...", "dir": "prompt-cache",
      "source": "file:///...#prompt-cache",
      "steps": [{ "id": "cache-hints", "phase": "call" }], "tools": [], "service": false
    }
  ]
}
```

`description` and `keywords` come from the standard `package.json` fields. Add them to a package to make it findable.

## 4. Search

`search(index, query, { type?, limit? })` in `src/search.ts`. Every word of the query must match. A match on the name scores 100, on a keyword 10, on the type 5, on the description 1. Results are sorted by score, then by name. An empty query lists everything.

## 5. Install

The panel installs a result by sending its `source` to `POST /api/packages` (for yourself) or `POST /api/admin/packages` (an admin, for someone). The kernel clones the registry into the person's own store and uses the directory after `#`. See [05-packages.md](05-packages.md) section 5.

The ownership rules apply. A `@thetis/*` package installs for an admin. A `@<user>/*` package installs for that user only.

## 6. Library

The gateway imports three functions: `readIndex(env)`, `search(index, query, opts)`, and `refresh(env, registries)`. `env` is any object with `readFile`, `writeFile`, and `exec` rooted in the userspace home, which the agent's `StepEnv` is.

## 7. Tests

`packages/marketplace/test/marketplace.test.ts` builds a git registry in a temporary directory, refreshes with a real `exec`, and checks the index, a failed registry, the search ranking, and the configuration parsing.
