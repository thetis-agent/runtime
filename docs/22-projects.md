# 22 Projects

`@thetis/projects` gives a person named workspaces in the web gateway. A project is a name, zero or more project directories, standing instructions, and a set of tools and skills that are switched off. A conversation belongs to at most one project. The package is a `loader` with a `ui`. It changes no kernel code. It imports the `@thetis/skills` library only when the page asks for the skill list. Source: `packages/projects`.

## 1. What a project is

| Part | Content | Default |
|---|---|---|
| Name | Up to 80 characters. The switcher shows it. | Required. |
| Project directories | Absolute paths on the host. A directory is a place the person works in; it can be outside their userspace. | None. A project with no directories is a name, a tool set, and instructions. |
| Instructions | Text the package adds to the system prompt of every conversation in the project. | Empty. |
| Tools | The tools that are switched off for the project. Every tool is on unless it is listed. | None switched off. |
| Skills | The skills that are switched off. Every skill is on unless it is listed; a switched-off parent takes its nested skills with it. `@thetis/skills` reads `skills.disable` and leaves those ids out of every loader's prompt and of `skill_fetch` ([23-skills.md](23-skills.md)). | None switched off. |

A project directory does not open the fence. The fence binds a directory only when an admin mounts it with `thetis mounts add <user> <path> [--ro]` ([08-cli.md](08-cli.md), [12-security.md](12-security.md) section 10). Until then the directory is listed and marked as not mounted. The package reads what is mounted from `THETIS_MOUNTS` ([03-fence.md](03-fence.md) section 3.5), the same source the file tools read ([20-tools.md](20-tools.md) section 1), so the page, the prompt, and the tools agree.

## 2. Files

All files are under `projects/` in the person's home. Only this package writes them. The gateway writes nothing.

| File | Content |
|---|---|
| `projects/<id>.json` | `{ id, name, directories: [paths], tools: { disable: [tool names] }, skills: { disable: [] }, createdAt, updatedAt }`. |
| `projects/<id>.md` | The instructions. This is the `PROJECT.md` of the design, kept flat beside the record. |
| `projects/sessions.json` | `{ "<session id>": "<project id>" }`. A session that is not listed has no project. |

An id is `p_` and 8 hexadecimal characters. A record whose `id` field disagrees with its file name is ignored. An assignment to a project that no longer exists is ignored; `remove` deletes the assignments of the project it removes.

## 3. Steps

| Step | Phase | Effect |
|---|---|---|
| `project-prompt` | `prompt` | Finds the session's project through `projects/sessions.json`. Without one, returns nothing. With one, appends to `call.system` a section `## Project: <name>`, then one line per project directory: the path and `(mounted rw)`, `(mounted ro)`, or `(not mounted — ask an admin: thetis mounts add <user> <path>)`, then the instructions under `### Instructions` when there are any. |
| `project-tools` | `call` | Without a project, or with no tool switched off, returns nothing. Otherwise returns `call` with `tools` filtered: a tool whose name is in `tools.disable` is left out. The `call` phase runs after every `tools`-phase step, whatever the install order, so the step sees the full list ([04-pipeline.md](04-pipeline.md) section 1). |

Both steps read through `ctx.env.readFile`, relative to the home, and treat a missing file as empty. A person without projects pays one small read per step per turn.

The switch is visible in the page after the first turn: the **Tools** dock ([15-web-gateway.md](15-web-gateway.md) section 11.6) lists under **Turned off right now** every declared tool the conversation's last call did not carry, with a `withheld` badge, from the record `@thetis/harness-core` keeps after each call. The dock compares the declarations with that record and names the tools, not this package: whatever filters `call.tools` in the call phase shows up there the same way, and `@thetis/ui-tools` imports nothing from `@thetis/projects`. Until the first call the section reads "No call yet in this conversation."

The skill switch shows at once: the **Skills** dock of `@thetis/ui-skills` reads `skills.disable` through the library's `excludedFor` and lists the ids under **Switched off by the project** before the next turn; the loaders leave them out of the prompt and of `skill_fetch` from the next turn on ([23-skills.md](23-skills.md) section 2).

## 4. Commands

The page sends these through `POST /api/ext/@thetis/projects/<verb>` ([15-web-gateway.md](15-web-gateway.md) section 11.4). Any signed-in person may send them. Each answers `{ data }`. A refusal is a thrown error; the gateway answers `400 { error }` with the sentence.

| Verb | Arguments | Answer |
|---|---|---|
| `list` | none | `{ projects: [{ id, name, directories: n, conversations: n }], assignments: { session: project }, current }`. Projects are in creation order, then by name. `current` is the project of the session the page named, or `null`. |
| `get` | `{ id? }` | `{ project, directories: [{ path, mounted: "rw" \| "ro" \| null }], instructions, conversations, mounts, tools, skills }`. `tools` is one entry per installed package with tools: `{ package, version, tools: [{ name, description, disabled }] }`. `skills` is every skill `loadSkills(env, env.kernel.packages.list())` finds, by id: `{ id, brief, short, package, universal, disabled }`, `package` null for a skill under the home and `disabled` true when the id or a parent of it is in `skills.disable`. Without `id`, `project` is `null` and the rest is the template a new project starts from. |
| `save` | `{ id?, name, directories?, disable?, disableSkills?, instructions? }` | `{ project }`. Without `id`, creates. `disable` is tool names for `tools.disable`; `disableSkills` is skill ids for `skills.disable`; each left out is saved empty. `instructions` left out keeps the file as it is; given as an empty string, empties it. |
| `remove` | `{ id }` | `{ removed: id }`. Deletes the record, the instructions, and the project's assignments. |
| `assign` | `{ session, project }` | `{ session, project }`. `project` `null` takes the session out of its project. `session` must be the session the page named, which the gateway has checked to be the person's own. |
| `sessions` | `{ project }` | `{ sessions: [ids] }`. |
| `mounts` | none | `{ mounts: [{ path, mode }] }`, from `THETIS_MOUNTS`. A person cannot call the operator's `mounts.list`; this fence's own list is enough. |

`save` checks: the name is not empty and at most 80 characters; each directory is absolute, normalized (`path.normalize` returns it unchanged, no trailing slash), with no `..` segment and no NUL byte; at most 64 directories; tool names are strings of at most 64 characters, at most 256; skill ids have the library's shape (`^[a-z0-9][a-z0-9-]{0,63}` per level, up to three levels joined by `/`), at most 256; the instructions are text of at most 32768 characters; a create is refused at 32 projects. Duplicates in the lists are dropped.

## 5. The switcher and the place

The package declares `sidebar: [{ id: "head" }]` and `places: [{ id: "project" }]` ([15-web-gateway.md](15-web-gateway.md) section 11.1). Its browser module is `ui/index.js`; its stylesheet `ui/index.css` is scoped under `.pj-`.

**The switcher** sits in the sidebar under the ≡ menu button: a row `PROJECT <name>` with a caret. It opens a list: All conversations, each project with how many conversations it holds, then Settings for the chosen project, then New project…. Choosing a project narrows the conversation list through `ext.sessions.filter` to the sessions assigned to it; All shows every conversation. The choice is kept in `localStorage` under `thetis.project` and applies again when the page loads. While a project is chosen, a conversation the page has not seen before, that is not archived, and that was created in the last two minutes is assigned to the project with one `assign` request, so `+` starts a conversation in the chosen project. Conversations that exist when the page loads are never assigned by the page: the page adopts nothing until its first `list` has answered, and every conversation it knows of by then counts as existing.

**The place** is the project's settings, opened from the switcher with `{ id }`, or with no id for a new project:

| Section | Content |
|---|---|
| Name | One input. |
| Project directories | One row per directory: the path, a badge (`mounted · read-write`, `mounted · read-only`, or `not mounted`), and a remove ✕. An input and a button add one. The note: "None by default. A directory outside your space reaches the file tools once an admin mounts it (thetis mounts add …); until then it is listed and marked." |
| Instructions | A text area for `PROJECT.md`. |
| Conversations | How many conversations are in the project. |
| Tools | Every installed package's tools, grouped by package, each with a switch. A switch off puts the tool in `tools.disable`. |
| Skills | Every skill the loaders see, grouped by the package it comes from (the home's own `skills/` last), each with the same switch as a tool. A switch off puts the id in `skills.disable`. A nested skill whose parent is off is shown off with its switch greyed: a switched-off parent switches off its nested skills too, and the note says so. Without any skill: "No skills are installed. A package that declares thetis.skills, or a skills/ directory under your home, adds some; each appears here with a switch." |
| Actions | Save, which calls `save`, shows a toast, and refreshes the switcher; a new project is chosen after its first save. Delete project, behind the shell's confirm popover. |

Nothing is sent until Save. The page reads with one `get` when it opens and again after a save.

## 6. Project directories and mounts

The package never mounts anything. The decision is the kernel's, made by an admin ([12-security.md](12-security.md) section 10). The package does three things with a directory:

1. It lists the directory in the project and in the system prompt.
2. It says whether the fence has it mounted, from `THETIS_MOUNTS`: a directory that is a mount, or lies under one, has that mount's mode.
3. When it is not mounted, it tells the model the command an admin must run, so the model can ask for it instead of failing on every `read_path`.

A mount applies when the fence next opens; `mounts.set` closes the fence, so the change is there within a second. The page shows the state as of the last `get`.

## 7. Limits

| Limit | Value |
|---|---|
| Projects per person | 32 |
| Name | 80 characters |
| Directories per project | 64 |
| Tools switched off per project | 256 |
| Skills switched off per project | 256 |
| Instructions | 32768 characters |

## 8. Tests

`packages/projects/test/*.test.js`, run with `node --test` under the root `npm test`:

| File | Content |
|---|---|
| `store.test.js` | An empty home; create, read, update, and the files written; assign, list, remove with its assignments; the project limit; every validation rule. |
| `steps.test.js` | Nothing back for an unassigned session or a stale assignment; the prompt section with the mount state of each directory and the instructions; the section for a bare project; the tool filter; `THETIS_MOUNTS` parsing. |
| `commands.test.js` | Every verb against a fake environment over a temporary home with a fake package list: counts, `current`, the tool groups with `disabled` flags, the skill list from a pack and the home with a switched-off parent covering its nested skill, the mount state, the refusals, and `assign` for a session other than the page's. Also checks that every module under `ui/` parses. |

The browser side is checked by hand with the checklist in `packages/gateway-web/test/BROWSER.md`.
