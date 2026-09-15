# 17 Control panel

The control panel is the part of the web gateway where a person manages packages and, for an admin, people, models, mounts, and the installation. It is a place, not a separate address: the link **Control panel** sits in the sidebar footer beside **Log out**, the panel takes over the main pane, and the close button or the Escape key returns to the conversation. See [15-web-gateway.md](15-web-gateway.md) section 11 for the seam it is built on.

## 1. Sections

The panel is a slot. One section is built into the gateway; the others come from packages that declare `ui.panel` entries. The browser draws the navigation from the registry: the built-in entries the server's `api/panel` listed, then every package entry `api/ui` listed for the person's role, sorted by `order`.

| Section | From | Who | Content |
|---|---|---|---|
| Packages | `@thetis/gateway-web`, order 10 | Everyone | One table of everything known here, one row per name: what is installed for the person (Only me, Everyone) and what the registries offer (Available). What each package brings. A fork carries a badge `fork of <name> <version>`. Install for yourself, add from a source, remove, delete a package of your own with its files. An admin can pick whose packages to see, install for another person, install for everyone, and make a person's package the default for everyone. See [18-marketplace.md](18-marketplace.md). |
| People | `@thetis/ui-admin`, order 20 | Admins | Who can sign in. Add a person, change the role, suspend or activate, set a password, remove. Your own account is not offered. |
| Models | `@thetis/ui-admin`, order 30 | Admins | The default model and the models every provider in the system userspace serves. Read-only. |
| Mounts | `@thetis/ui-admin`, order 35 | Admins | Which host directories are bound into whose fence, at their host path, `rw` or `ro`. One table of every person's mounts with an **Unbind** button per row, and a form: the person, the host path, the mode. Every change sends that person's whole list; the page says that the person's fence reopens and their services restart. See [12-security.md](12-security.md) section 10. |
| Activity | `@thetis/ui-admin`, order 40 | Admins | The kernel's journal, newest first: who did what, mounts, turns, services. A filter by kind. See [12-security.md](12-security.md) section 9. |
| Overview | `@thetis/ui-admin`, order 50 | Admins | The configuration as the kernel reports it, with secrets hidden. Read-only. |

Packages stays built in because a person must be able to install from the browser when nothing else is installed. `@thetis/ui-admin` is in the default `systemPackages["*"]` ([09-configuration.md](09-configuration.md)), so every person has it; a user sees none of its sections because `api/ui` drops entries above the person's role. An installation without the package has a panel with Packages only.

Words on screen follow the same rules as the rest of the interface. A package's state is **Only me**, **Everyone**, or **Available**. An admin does not "promote"; the buttons say **Install for everyone** and **Make it the default for everyone**. The code and the API say `installEveryone` and `promote`.

## 2. The three checks

A role check happens three times:

1. The browser draws only the sections `api/panel` and `api/ui` listed for the person's role. This is a courtesy.
2. The gateway refuses a command whose declared `role` is above the person's with `403`, before the package's code runs ([15-web-gateway.md](15-web-gateway.md) section 11.4). Every command of `@thetis/ui-admin` declares `role: "admin"`. What is left of `/api/admin/*` is refused the same way.
3. The kernel refuses every operator method unless the fence's own user is an admin. See [12-security.md](12-security.md) section 4.

The gateway reads the role from `kernel.auth.authenticate`, which the kernel answers only for the person the gateway serves. It never trusts a role from the browser. A command of `@thetis/ui-admin` reads the admin's own id from `env.user`, never from its arguments, when it refuses a change to the admin's own account.

## 3. Routes

All routes are under the person's prefix, `/<user>/api/...`, and need the login cookie of that person. Non-GET routes need a same-site request. Package names in a path are URL-encoded as one segment, for example `/alice/api/packages/%40alice%2Fhello`.

| Route | Who | Effect |
|---|---|---|
| `GET /api/panel` | any | `{ user, role, sections }`. `sections` names the built-in sections: `["packages"]` for everyone. |
| `GET /api/packages` | any | The person's packages as rows. See section 4. |
| `POST /api/packages` `{ source }` | any | Installs into the person's own userspace. `201` with the row. `source` is a path under home, a git URL, `url#dir`, or, for admins, `@thetis/<name>`. |
| `DELETE /api/packages/<name>` | any | Removes the package from the person's own userspace. The files stay. A fork's original comes back. |
| `DELETE /api/packages/<name>?files=1` | any | Deletes the package: removes it and its directory under the home. Only for the person's own scope; `403` for `@thetis/*`. Returns `{ name, path, restored? }`. |
| `GET /api/marketplace?q=&type=` | any | `{ updatedAt, registries, total, results }` from the index. `404` when no index exists; the Packages table then shows installed packages only. |
| `GET /api/admin/users` | admin | All user records. The Packages section's picker of whose packages to see. |
| `GET /api/admin/packages?user=<id>` | admin | The packages of that person. |
| `POST /api/admin/packages` `{ user, source }` | admin | Installs into that person's userspace. |
| `DELETE /api/admin/packages/<name>?user=<id>` | admin | Removes from that person's userspace. |
| `POST /api/admin/packages/<name>/promote` `{ user }` | admin | Makes the person's package the default for everyone. Returns `{ name, userspaces }`. See [05-packages.md](05-packages.md) section 14. |
| `POST /api/admin/packages/everyone` `{ source }` | admin | Installs a package for everyone, now and later. A shipped `@thetis/<name>` is marked for everyone and linked into every person. Any other source is installed for the admin and then promoted. Returns `{ name, userspaces }`. See [05-packages.md](05-packages.md) section 15. |

An install builds inside the target person's fence. It can take minutes. The gateway does not time the request out; the fence request timeout applies.

Errors carry a plain sentence in `{ error }`. Kernel codes map to statuses as in [15-web-gateway.md](15-web-gateway.md).

The admin sections send their own commands as `POST /api/ext/@thetis/ui-admin/<verb>` with `{ args }` ([15-web-gateway.md](15-web-gateway.md) section 11.4). Each answers `{ data }`, or `400 { error }` with a sentence.

| Verb | Export | Arguments | Effect |
|---|---|---|---|
| `users` | `users` | none | `users.list`: all user records. |
| `user-create` | `userCreate` | `id`, `role?`, `password?` | `users.create`, then `users.passwd` when a password was given. `role` defaults to `user`. |
| `user-role` | `userRole` | `id`, `role` | `users.setRole`: `user` or `admin`. Not for your own account. |
| `user-status` | `userStatus` | `id`, `status` | `users.setStatus`: `active` or `suspended`. Not for your own account. |
| `user-password` | `userPassword` | `id`, `password` | `users.passwd`: at least 8 characters. Signs the person out everywhere. Not for your own account. |
| `user-remove` | `userRemove` | `id` | `users.remove`: the user and their userspace. Not for your own account. |
| `models` | `models` | none | `{ model, models }` from `config.get` and `models`. |
| `config` | `config` | none | `config.get`: the configuration with secrets replaced by `•••`. |
| `journal` | `journal` | `limit?`, `kind?` | `journal.tail`: the newest rows, at most 1000, 200 by default. |
| `mounts-list` | `mountsList` | `user?` | `mounts.list`: `{ "<user>": [{ path, mode }] }` for one person, or for everyone. |
| `mounts-set` | `mountsSet` | `user`, `mounts` | `mounts.set`: replaces that person's mounts with the list, at most 32, each an absolute normalized path that is not `/` and a mode `rw` or `ro`, no path twice. The kernel closes the person's fence. |

An `id` is `^[a-z][a-z0-9-]{0,31}$`. The verbs are lowercase because a verb matches the seam's id pattern; the exports keep the camel case of the code.

## 4. A package row

```json
{ "name": "@alice/hello", "version": "0.1.0", "type": "tool", "scope": "me", "steps": [{ "id": "mark", "phase": "prompt" }], "tools": ["greet"], "service": false }
```

`scope` is `everyone` when every person gets the package (it is in `systemPackages["*"]`, promoted, or marked for everyone; the kernel reports this as `everyone` on the package) and `me` otherwise. A shipped `@thetis/*` package one person installed for themselves is `me`. The browser reads these fields by name.

A fork's row also carries `forkedFrom` (`{ name, version }`) and, when the fork displaced that package here, `replaced` (its name). The row shows the badge `fork of @thetis/tools-plan 0.1.0`. The card lists **forked from** and **replaces**. A package in the person's own scope, seen from their own setup, gets a **Delete** button beside **Remove**. Its confirm popover states the name, what it was forked from, what comes back, and that the files under `packages/` go too. The admin's view of another person shows the badge and no Delete. See [05-packages.md](05-packages.md) section 16.

## 5. How the gateway reaches the kernel

The gateway holds a `KernelClient` inside the system fence. Three calls carry the panel:

- `kernel.packages.list()`, `install(source)`, `uninstall(name)`, `delete(name)`: the person's own packages. Identity is the fence.
- `kernel.operator.call(method, args)`: a control method, allowed when the fence's user is an admin. The kernel records that user as the actor. The method table is the one the command line uses. See [08-cli.md](08-cli.md) section 4. The gateway calls it for the Packages section's admin routes; `@thetis/ui-admin`'s commands call it through the `env.kernel` the gateway hands a command, which is the same client.
- `readIndex` and `search` from `@thetis/marketplace`, over the shared directory the gateway's environment names.

The gateway imports `@thetis/marketplace` for the index file and the search. Nothing else in the gateway imports a domain package. The browser imports nothing from the server.

## 6. Files

| File | Content |
|---|---|
| `gateway-web/src/panel.ts` | The routes of section 3. |
| `gateway-web/src/http.ts` | `HttpError`, `json`, `readJson`, `field`. |
| `gateway-web/assets/views/panel.js` | The launcher, the shell, the navigation. Registers Packages with `order: 10`. |
| `gateway-web/assets/views/panel-packages.js` | The Packages section. Merges the installed list with the marketplace index by name. |
| `gateway-web/assets/lib/panel-ui.js` | Tables, badges, fields, buttons, the confirm popover, key/value lists. Handed to packages as `ext.ui`. |
| `ui-admin/package.json` | The five `panel` entries and the eleven commands, every one `role: "admin"`. |
| `ui-admin/index.js` | The commands: the checks of section 3, then one operator call each. |
| `ui-admin/ui/index.js` | `install(ext)`: registers the five sections. |
| `ui-admin/ui/people.js`, `models.js`, `mounts.js`, `activity.js`, `overview.js` | One section each, built from `ext.dom` and `ext.ui`, sending through `ext.request`. |
| `ui-admin/ui/index.css` | What the sections add to the shell's styles, under `.ua-`. |

## 7. Tests

`packages/ui-admin/test/ui-admin.test.js` runs each command over a fake `env.kernel.operator.call`: the method and arguments it sends, what it refuses before the kernel is asked, and the own-account refusal. It parses every browser module and checks that the entry defines `install` and nothing else, and that `install` registers exactly the five declared sections.

`packages/gateway-web/test/gateway.test.ts` has a third user `root` with role `admin` and `@thetis/ui-admin` in `systemPackages["*"]`. The cases: `api/panel` says `["packages"]` for everyone, `api/ui` lists the five sections and eleven verbs for `root` and none for a user, and a user gets `403` from a role-admin verb; people are added, changed, and removed through the verbs, and the journal names `root` as the actor; a directory is bound for `bob`, listed, and unbound; a person installs their own package, an admin promotes it, everyone gets it, and an admin installs a shipped package for everyone, which a person created afterwards is seeded with; a fork's row says what it replaced, delete with files puts the original back, and a shipped package is refused; the marketplace search reads the index, a missing index is a `404`, and `models` and `config` answer as the kernel does.

The browser code has no automated test. Check it by hand from `packages/gateway-web/test/BROWSER.md`: open the panel as an admin and as a user.

## Benchmarks

A package that opts into a benchmark suite carries a badge on its row: the number of suites it has a report
for, or `bench: not run` when it opted in and has never been measured. A red badge means an arm claimed it
surfaced something the assembled prompt does not show. The detail panel lists the suites and the last run of
each. See [21-benchmarks.md](21-benchmarks.md).
