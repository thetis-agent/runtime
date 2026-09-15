# 18 Marketplace

The marketplace is the set of registries this installation trusts. A registry is one git repository that holds package directories. The package `@thetis/marketplace` in `packages/marketplace` mirrors the registries and writes an index. The package `@thetis/ui-marketplace` in `packages/ui-marketplace` is the **Marketplace** place of the web gateway: a gallery of the index beside what is installed, one card per name, and one page per package. See section 9 and [17-control-panel.md](17-control-panel.md).

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
| `registries[].name` | the last path segment | Shown on the cards and the pages. |
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
      "steps": [{ "id": "cache-hints", "phase": "call" }], "tools": [], "service": false,
      "readme": true
    }
  ]
}
```

`description` and `keywords` come from the standard `package.json` fields. Add them to a package to make it findable. `readme` is `true` when the package directory holds a `README.md` and a copy of it sits in the shared directory; see section 8.

## 4. Search

`search(index, query, { type?, limit? })` in `src/search.ts`. Every word of the query must match. A match on the name scores 100, on a keyword 10, on the type 5, on the description 1. Results are sorted by score, then by name. An empty query lists everything.

## 5. Install

A package page installs an available package by sending its `source` through the commands of section 9: `install` (for yourself), `install-for` (an admin, for someone), or `install-everyone` (an admin, for everyone). A `@thetis/*` package that this installation ships is sent by name, so the built copy is linked rather than cloned. Anything else the kernel clones into the person's own store, using the directory after `#`. See [05-packages.md](05-packages.md) sections 5 and 15.

The ownership rules apply. A `@thetis/*` package installs for an admin. A `@<user>/*` package installs for that user only.

## 6. Library

Readers import `readIndex(env)`, `search(index, query, opts)`, `readReadme(env, entry)`, which returns the README copy of section 8 for an index entry, or `undefined` when it has none, and `behind(installed, index)`, which lists the installed packages whose pin is older than the index. The service uses `refresh(env, registries)`. `env` is any object with `shared`, `readFile`, `writeFile`, and `exec`, which the agent's `StepEnv` is. Only the system userspace can write the shared directory, so only the service refreshes.

The one reader is `@thetis/ui-marketplace`, whose commands run inside each person's fence with the gateway's `StepEnv`. The web gateway itself imports nothing from this package.

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

## 7. Updating

Nothing updates on its own. The index says what is latest, the record says what is installed, and a person
decides. There is no background updater and no setting that turns one on.

```sh
thetis packages outdated --user alice
thetis packages update --user alice            # every package that is behind
thetis packages update @thetis/exa --user alice  # one of them
```

The marketplace place says the same thing: a card or a page whose registry has moved on carries an **update to
\<version\>** badge, and the page an **Update to \<version\>** button, and neither does anything until it is pressed.

An update is an install of the newer pinned source. There is no separate code path, which is the point: a
failed update cannot leave a half-updated package, because `install` links the new copy only after it has
cloned, validated and built it. Until that succeeds the old link stands and the old package keeps running.

**Note:** this applies to packages installed *from a registry*, which carry a pin. A package shipped with the
service is linked from `<root>/packages` and tracks that checkout instead; it has no pin and is never
reported as behind. Updating those means updating the checkout.

Clones are kept under `<store>/src` named for the repository and commit. After a successful install the ones
no installed package refers to are removed, so an installation does not grow by a copy of the registry every
time it takes an update.

## 8. README copies

A package page renders the package's README, and the page runs in whatever fence the person is in. The mirror clone lives in the system userspace home, which no other fence can read, so the README crosses through the shared directory the way the index does.

During a refresh the mirror widens its sparse checkout to `README.md` at the package level (a partial clone fetches only those blobs) and, for each indexed package directory that holds a file of exactly that name, copies it to:

```
<shared>/marketplace/readme/<registry name>/<dir>.md
```

`<dir>` is the entry's `dir`; a `/` in it becomes `__`, so `nested/memo` is `nested__memo.md`. The copy is capped at 256 KiB (262144 bytes): a longer README is cut there and ends with the line `[README truncated at 256 KiB]`. The index entry gets `readme: true`; a package without a `README.md` (a `readme.md` is not one) gets `readme: false`. When a package drops out of a registry its copy is removed on that registry's next successful refresh. A registry that fails to refresh keeps its previous entries and their copies.

`readReadme(env, entry)` reads the copy back through the same `env` the index is read with, so the marketplace UI needs no path of its own.

## 9. The Marketplace place

`@thetis/ui-marketplace` is a `ui` package in the default `systemPackages["*"]` ([09-configuration.md](09-configuration.md)). It declares one place, `marketplace`, which the web gateway draws as the link **Marketplace** in the sidebar footer beside **Control panel** ([15-web-gateway.md](15-web-gateway.md) section 11). The place opens in the main pane with the sidebar kept; the close button or the Escape key returns to the conversation.

**The gallery.** A search box, one chip per package type (**All** first), a note (`registry thetis · refreshed 12 min ago · 23 packages`, or `n installed · no marketplace index yet`), and one card per package: the name, the description, the version, the type and the registry, and the badges **Only me**, **Everyone** or **Available · \<registry\>**, `fork of …`, `update to <version>`, and the benchmark badge. Installed packages come first. The search runs through the command `search`, so the index's ranking of section 4 applies; an installed package that no registry carries is matched on its name, type and description. Clicking a card opens the package's page.

**A package page.** The crumb **Marketplace › \<name\>** leads back. On the left the README copy of section 8, rendered by the shell's markdown (DOM, never `innerHTML`), or the line *This package has no README.* On the right a card: the badges, the description, the facts (**installed** `<version> at <short commit>` for a copy taken from a registry; **registry** the tip version and the registry name; **update** when the two differ; **type**, **license**, **forked from**, **replaces**, **source**), then **Brings**: one pill per tool (the description as the tooltip, when the copy is installed here), the steps by phase, the service, the keywords, and the benchmark suites and last run. Under it the actions the state and the role allow:

| Action | Who | Command | Effect |
|---|---|---|---|
| **Install for me** | anyone, when not installed | `install { source }` | `kernel.packages.install`: a shipped `@thetis/*` by name, anything else by its pinned source. |
| **Update to \<version\>** | anyone, when behind | `update { name }` | An install of the newer pinned source, as `thetis packages update` does. Refused when nothing is newer. |
| **Remove** | anyone, when installed | `remove { name }` | `kernel.packages.uninstall`. The files stay. A fork's original comes back. |
| **Delete** | the owner of a `@<user>/*` package | `delete { name }` | `kernel.packages.delete`: the files under `packages/` go too. |
| **Install for everyone** | admins, when not everyone's | `install-everyone { source }` | `packages.installEveryone` over the operator channel. See [05-packages.md](05-packages.md) section 15. |
| **Make it the default for everyone** | admins, for a person's own package | `promote { user, name }` | `packages.promote`. See [05-packages.md](05-packages.md) section 14. |
| **Install for \<person\>** | admins, from a picker of the people (`people`) | `install-for { user, source }` | `packages.install` for that person. `remove-for { user, name }` is the counterpart. |

Every action sits behind a confirm popover that states the package and version, where it comes from, whom it is for, and one sentence on what happens next; nothing is sent until the person confirms. After an action the page is opened again, or the gallery when the package is gone from here.

The commands answer `{ data }`. `search { q?, type? }` answers `{ indexed, updatedAt, registries, total, rows, user, role }`; `show { name }` the same facts with one `row` and the `readme` text or `null`. A row is `{ name, version, type, description, keywords, registry, source, installed, scope, pin, license, available, tip, update, readme, forkedFrom, replaced, steps, tools, service, bench }`: `scope` is `me`, `everyone`, or `null` when not installed; `pin` the short commit of a registry copy; `tip` the version the registry holds; `update` `{ version, from, to, source, registry }` or `null`. The gateway runs a command only when the person's role clears the declared one, and the kernel refuses an operator method from a fence whose user is not an admin, so a user who sends `install-everyone` by hand gets `403` before the package's code runs.

Files: `ui-marketplace/package.json` (the place and the eleven commands), `index.js` (the commands), `lib/rows.js` (the merge of the installed list with the index, the update offer, the benchmark reports), `ui/index.js` (`install(ext)`), `ui/gallery.js`, `ui/page.js`, `ui/actions.js`, `ui/badges.js`, `ui/index.css` (under `.mk-`). Tests: `ui-marketplace/test/ui-marketplace.test.js` runs the commands over a fake environment; `gateway-web/test/gateway.test.ts` sends `search` and `show` through a real gateway with an index and a README copy in the shared directory, and the admin verbs from an admin and from a user.
