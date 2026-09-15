# 18 Marketplace

The marketplace is the set of registries this installation trusts. A registry is one git repository that holds package directories. The package `@thetis/marketplace` in `packages/marketplace` mirrors the registries and writes an index. The control panel's Packages section shows the index beside what is installed, one row per name, and installs from it. See [17-control-panel.md](17-control-panel.md).

An installation ships with one registry already configured: **`https://github.com/thetis-agent/packages.git`**, the approved extensions. The index always shows what is latest there. An install takes a copy and pins the commit it took, so a package cannot change under an installation that already has it. See section 6.

## 1. Registries

`config.packages["@thetis/marketplace"]`, with the shipped default:

```json
{
  "registries": [{ "name": "thetis", "url": "https://github.com/thetis-agent/packages.git" }],
  "refreshMinutes": 30
}
```

Replacing it replaces the set of extensions this installation trusts:

```json
{
  "registries": [
    { "name": "thetis", "url": "https://github.com/thetis-agent/packages.git" },
    { "name": "team", "url": "https://git.example.com/thetis/packages.git" }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `registries[].url` | required | A git URL. `file://` paths work when the path is readable inside the system fence, which is useful for a registry you are writing. |
| `registries[].name` | the last path segment | Shown in the panel. |
| `refreshMinutes` | `30` | How often the service refreshes. |

**Note:** the refresh is a shallow `git clone` from the system userspace. An installation with no egress records the failure against the registry, keeps the packages it indexed before, and carries on; it does not fail a turn.

A registry holds packages at its first or second directory level. Each package directory has a `package.json` with a `thetis` field. A directory without one is ignored. `node_modules` directories are skipped.

## 2. The service

`@thetis/marketplace` is a `service` package installed in the system userspace:

```json
"systemPackages": { "_system": ["@thetis/provider-openrouter", "@thetis/marketplace"] }
```

`startService` refreshes on start and every `refreshMinutes`. A refresh clones each registry with `git clone --depth 1` into `home/marketplace/repos/<slug>` through the fence's `exec`, reads every `package.json`, and writes the index. A registry that fails keeps the packages of its last successful refresh and records the error. The system fence has network mode `egress`, so a remote registry is reachable.

Install it into a running daemon with `thetis packages install @thetis/marketplace`. The log line `indexed N packages from M registries` confirms the first refresh.

## 3. The index file

`<shared>/marketplace/index.json`, where `<shared>` is `$THETIS_HOME/shared`: the directory the system userspace writes and every fence reads ([03-fence.md](03-fence.md) section 3.7). Package code reaches it as `env.shared`. This file is the contract. Any package or gateway in any fence can read it by path.

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

The panel installs an available package by sending its `source` to `POST /api/packages` (for yourself), `POST /api/admin/packages` (an admin, for someone), or `POST /api/admin/packages/everyone` (an admin, for everyone). A `@thetis/*` package that this installation ships is sent by name, so the built copy is linked rather than cloned. Anything else the kernel clones into the person's own store, using the directory after `#`. See [05-packages.md](05-packages.md) sections 5 and 15.

The ownership rules apply. A `@thetis/*` package installs for an admin. A `@<user>/*` package installs for that user only.

## 6. Library

The gateway imports two functions: `readIndex(env)` and `search(index, query, opts)`. The service uses `refresh(env, registries)`. `env` is any object with `shared`, `readFile`, `writeFile`, and `exec`, which the agent's `StepEnv` is. Only the system userspace can write the shared directory, so only the service refreshes.

## 7. Tests

`packages/marketplace/test/marketplace.test.ts` builds a git registry in a temporary directory, refreshes with a real `exec`, and checks the index, a failed registry, the search ranking, and the configuration parsing.

## 6. Versions and pinning

The index is the latest. An install is a copy at one commit.

Each entry carries the `commit` its registry was mirrored at, and its `source` is that commit pinned:

```
https://github.com/thetis-agent/packages.git#tools-files@ae6fdfd733a5b1c46eb6f26e8a1d249182dcf1ce
```

`splitSource` in `packages/lib/src/pkg-fs.ts` reads the three parts: the repository, the directory inside it,
and the commit. A pin is exactly forty hexadecimal characters, so nothing shorter can be mistaken for one, and
a source without one still means "the tip of the default branch".

Installing a pinned source fetches that one commit — `git init`, `git fetch --depth 1 origin <commit>`,
`git checkout --detach FETCH_HEAD` — which is one shallow round trip rather than a clone and a checkout. The
pin is recorded in the registry as the package's source, so `thetis packages list` shows exactly what is
installed and a later refresh of the index does not move it.

**Note:** a clone directory is named for the repository *and* the commit. One registry holds many packages, so
two installs at different commits must not share a directory — the second would replace the first's code
underneath the link already using it.

To move to a newer version, install again. The index will have refreshed, so the source it offers carries the
newer commit, and the new copy replaces the old link.
