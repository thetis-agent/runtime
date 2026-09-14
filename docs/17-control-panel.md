# 17 Control panel

The control panel is the part of the web gateway where a person manages packages and, for an admin, people, models, and the installation. It is a section of the page, not a separate address. The link **Control panel** sits in the sidebar footer beside **Log out**. The panel takes over the main pane. The close button and the Escape key return to the conversation.

## 1. Sections

The server names the sections a person can use. The browser draws only those.

| Section | Who | Content |
|---|---|---|
| Packages | Everyone | What is installed for the person, what each package brings, add and remove. An admin can pick whose packages to see and can make a package the default for everyone. |
| Marketplace | Everyone | Search the index the marketplace service wrote to the shared directory. Install for yourself. An admin can install for another person. See [18-marketplace.md](18-marketplace.md). |
| People | Admins | Who can sign in. Add a person, change the role, suspend or activate, set a password, remove. |
| Models | Admins | The default model and the models every provider in the system userspace serves. Read-only. |
| Activity | Admins | The kernel's journal, newest first: who did what, turns, services. A filter by kind. See [12-security.md](12-security.md) section 9. |
| Overview | Admins | The configuration as the kernel reports it, with secrets hidden. Read-only. |

Words on screen follow the same rules as the rest of the interface. A package "runs for" **Only me** or **Everyone**. An admin does not "promote"; the button says **Make it the default for everyone**. The code and the API say `promote`.

## 2. The three checks

A role check happens three times:

1. The browser draws only the sections and buttons the server listed. This is a courtesy.
2. The gateway refuses `/api/admin/*` with `403` when the person's role is `user`.
3. The kernel refuses every operator method unless the fence's own user is an admin. See [12-security.md](12-security.md) section 4.

The gateway reads the role from `kernel.auth.authenticate`, which the kernel answers only for the person the gateway serves. It never trusts a role from the browser.

## 3. Routes

All routes are under the person's prefix, `/<user>/api/...`, and need the login cookie of that person. Non-GET routes need a same-site request. Package names in a path are URL-encoded as one segment, for example `/alice/api/packages/%40alice%2Fhello`.

| Route | Who | Effect |
|---|---|---|
| `GET /api/panel` | any | `{ user, role, sections }`. |
| `GET /api/packages` | any | The person's packages as rows. See section 4. |
| `POST /api/packages` `{ source }` | any | Installs into the person's own userspace. `201` with the row. `source` is a path under home, a git URL, `url#dir`, or, for admins, `@thetis/<name>`. |
| `DELETE /api/packages/<name>` | any | Removes the package from the person's own userspace. |
| `GET /api/marketplace?q=&type=` | any | `{ updatedAt, registries, total, results }`. `404` when no index exists. |
| `GET /api/admin/users` | admin | All user records. |
| `POST /api/admin/users` `{ id, role?, password? }` | admin | Creates the user. Sets the password when given. |
| `POST /api/admin/users/<id>/role` `{ role }` | admin | `user` or `admin`. Not for your own account. |
| `POST /api/admin/users/<id>/status` `{ status }` | admin | `active` or `suspended`. Not for your own account. |
| `POST /api/admin/users/<id>/password` `{ password }` | admin | At least 8 characters. Signs the person out everywhere. |
| `DELETE /api/admin/users/<id>` | admin | Removes the user and their userspace. Not for your own account. |
| `GET /api/admin/packages?user=<id>` | admin | The packages of that person. |
| `POST /api/admin/packages` `{ user, source }` | admin | Installs into that person's userspace. |
| `DELETE /api/admin/packages/<name>?user=<id>` | admin | Removes from that person's userspace. |
| `POST /api/admin/packages/<name>/promote` `{ user }` | admin | Makes the person's package the default for everyone. Returns `{ name, userspaces }`. See [05-packages.md](05-packages.md) section 14. |
| `GET /api/admin/models` | admin | `{ model, models }`: the default model and what the providers serve. |
| `GET /api/admin/config` | admin | The configuration with secrets replaced by `•••`. |
| `GET /api/admin/journal?limit=&kind=` | admin | The newest journal rows. |

An install builds inside the target person's fence. It can take minutes. The gateway does not time the request out; the fence request timeout applies.

Errors carry a plain sentence in `{ error }`. Kernel codes map to statuses as in [15-web-gateway.md](15-web-gateway.md).

## 4. A package row

```json
{ "name": "@alice/hello", "version": "0.1.0", "type": "tool", "scope": "me", "steps": [{ "id": "mark", "phase": "prompt" }], "tools": ["greet"], "service": false }
```

`scope` is `everyone` for a `@thetis/*` package and `me` otherwise. The browser reads these fields by name.

## 5. How the gateway reaches the kernel

The gateway holds a `KernelClient` inside the system fence. Three calls carry the panel:

- `kernel.packages.list()`, `install(source)`, `uninstall(name)`: the person's own packages. Identity is the fence.
- `kernel.operator.call(method, args)`: a control method, allowed when the fence's user is an admin. The kernel records that user as the actor. The method table is the one the command line uses. See [08-cli.md](08-cli.md) section 4.
- `readIndex` and `search` from `@thetis/marketplace`, over the shared directory the gateway's environment names.

The gateway imports `@thetis/marketplace` for the index file and the search. Nothing else in the gateway imports a domain package. The browser imports nothing from the server.

## 6. Files

| File | Content |
|---|---|
| `src/panel.ts` | The routes of section 3. |
| `src/http.ts` | `HttpError`, `json`, `readJson`, `field`. |
| `assets/views/panel.js` | The launcher, the shell, the navigation. |
| `assets/views/panel-packages.js`, `panel-marketplace.js`, `panel-people.js`, `panel-models.js`, `panel-activity.js`, `panel-overview.js` | One section each. |
| `assets/lib/panel-ui.js` | Tables, badges, fields, buttons, the confirm popover, key/value lists. |

## 7. Tests

`packages/gateway-web/test/gateway.test.ts` has a third user `root` with role `admin`. The cases: sections follow the role and admin routes are refused for a user; people are added, changed, and removed; a person installs their own package, an admin promotes it, and everyone gets it; the marketplace search reads the index and a missing index is a `404`.

The browser code has no automated test. Check it by hand: open the panel as an admin and as a user.
