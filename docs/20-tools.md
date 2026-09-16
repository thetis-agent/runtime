# 20 Tools for the model

The model works through tools. Five shipped packages provide them. The first four are in the default `systemPackages["*"]` ([09-configuration.md](09-configuration.md)), so every person has them unless an installation leaves one out; `@thetis/tool-operator` is installed per admin and never for everyone (section 3.3). A person can add tools with a package of their own; see [05-packages.md](05-packages.md).

| Package | Tools | Function |
|---|---|---|
| `@thetis/tools-files` | `read_path`, `edit_path`, `write_path`, `search_files`, `find_files`, `get_directory` | Files in the person's home, bounded and path-contained. |
| `@thetis/tools-plan` | `todo_write`, `todo_add`, `todo_mark`, `todo_order`, `todo_read`, `ask_user` | A plan per conversation, and questions for the person. |
| `@thetis/tool-exec` | `install_package`, `uninstall_package`, `fork_package`, `delete_package`, `spawn_subagent` | Packages, forks, and subagents. It declared `exec` until 2026-09-16; see section 3.2. |
| `@thetis/terminal` | `shell`, `shell_read`, `shell_send`, `shell_interrupt`, `shell_sessions` | Long-lived shell sessions in the person's fence, shown live in the page. See [24-terminal.md](24-terminal.md). |
| `@thetis/tool-operator` | `restart_daemon` | Asks this daemon to restart itself, for code a workspace reload cannot reach. One admin at a time. See [25-restart.md](25-restart.md). |

`@thetis/tools-files`, `@thetis/tools-plan`, `@thetis/terminal` and `@thetis/tool-operator` are plain ECMAScript modules with no build step and no npm dependency; `@thetis/terminal` vendors the terminal emulator its page needs. `@thetis/tool-exec` is TypeScript and imports `@thetis/lib/pkg-fs` for the fork mechanism. `@thetis/tools-files` and `@thetis/tools-plan` were written by Thetis itself from a brief, tested, and then reviewed and shipped; see section 5.

## 1. Rules every file tool follows

**Paths.** A path is relative to the person's home, or absolute. The roots are the home (read and write), the shared directory (read only), and each mount the fence announces in `THETIS_MOUNTS` (`rw` or `ro` as granted; see [12-security.md](12-security.md) section 10). The mounts are read once when the package loads; an absent or malformed variable means none. The tool walks up to the nearest existing ancestor, resolves symlinks, joins the missing suffix back, and refuses a result outside every root: `<path> is outside the spaces you can reach (home rw, shared ro, /srv/repos/thetis rw).` A write to a read-only root is refused with `<path> is read-only (shared); writes need a path under home or /srv/repos/thetis.`, naming the `rw` mounts. Empty paths, NUL bytes, and dangling symlinks are refused. A component named `.git` is protected from writes in every root. Paths inside the home come back relative to it, so a returned path can be passed straight back in. Paths under the shared directory or a mount come back absolute.

**Bounded output.** Every result and every refusal passes through the spill bound of 32768 characters. Under the bound the text is returned as is. Over it, the whole text is written to `tool-output/<tool>-<time>.txt` in the home, and the model receives the first three quarters of the budget, a line `[... N of M characters not shown here ...]`, the last eighth, and last of all a footer that names the file and says how to read on with `read_path` or `search_files`. The tail is kept because a tool's own resumption footer lives at the end. When the file cannot be written the footer says the middle is lost.

**A result names the next action.** A partial read says `read on with offset N`. A partial search says how to narrow. A refused edit says whether to read the file first or pass `replace_all`.

**Failures are marked.** A refusal comes back as `error: <sentence>`, so the transcript shows a failed call and the model does not mistake the sentence for an answer.

## 2. The file tools

| Tool | Arguments | Returns | Bounds |
|---|---|---|---|
| `read_path` | `path`, `offset` (1-based line, default 1), `limit` (default 400, max 2000) | Numbered lines `    12<tab>text`, then `[lines 1-400 of 2310; read on with offset 401]` or `[lines 1-2310 of 2310]`. | 24000 characters per window, whichever of lines or characters is reached first; the footer says `(stopped at the output size limit)`. Lines over 500 characters are cut. Binary files (a NUL in the first 8 KiB) and files over 4 MiB are refused by name. |
| `edit_path` | `path`, `old_text`, `new_text`, `replace_all` (default false) | `edited <path> — replaced N occurrence(s) starting at line L` and a numbered snippet of 4 lines around the change. | `old_text` must be non-empty, differ from `new_text`, and match exactly once unless `replace_all`. The refusals: `old_text was not found in <path>. Read the file first — whitespace and indentation must match exactly.` and `old_text appears N times in <path>. Include enough surrounding lines to make it unique, or pass replace_all to change every occurrence.` The write is atomic. |
| `write_path` | `path`, `contents`, `overwrite` (default false) | `wrote <path> (N lines, M bytes)` | Parent directories are created. An existing file is refused unless `overwrite`: `<path> exists (N lines). Use edit_path to change part of it, or pass overwrite to replace it.` |
| `search_files` | `pattern` (JavaScript regular expression), `path` (default home), `glob` (file name), `mode` `content`, `files`, or `count`, `ignore_case`, `max_results` (default 100, max 1000) | Content: `path:line:text` lines. Files: paths with match counts. Count: the total. Always a tally line. | Skips `.git`, `node_modules`, `dist`, `target`, `.cache`, `tool-output`, and binary files. At most 20000 files are scanned. A partial answer says `(stopped at the first 100). Narrow with a tighter pattern, a glob such as '*.js', or a path deeper in the tree; or use mode='files' to see just where.` or `(the scan bound was reached before the tree was exhausted; narrow path to be sure)`. Lines are clipped at 300 characters. |
| `find_files` | `glob` (a glob without `/` matches the file name anywhere), `path`, `max_results` (default 200) | Paths, newest modification first, then `N files matching <glob>`, with `(newest 200 shown; there may be more)` when capped. | The same skip list and scan bound. |
| `get_directory` | `path` (default home), `depth` (default 1, max 3) | Entries, directories first with a trailing `/`, sizes for files, and an entry count. | 500 entries per call, with `… and N more`. The skip list applies below the top level. |

The descriptions the model reads say, for each file tool, to prefer it over `cat`, `sed -n`, `grep`, `find`, or a heredoc in a shell: it costs fewer tokens, it is bounded, and it says when the answer is partial. `shell` stays for running programs.

## 3. The plan tools

The plan of a conversation is `plans/<session id>.json` in the home. Every plan tool returns the whole rendered plan, one item per line, then a tally. The package carries its page UI in `ui/`, declared in the `ui` field of its manifest, and the web gateway loads it when it is installed ([15-web-gateway.md](15-web-gateway.md) sections 1 and 11): a `todo_*` call draws one quiet line in the transcript, the chat bar's `todo done/total` chip opens the Todo dock, and the dock lists the plan with a checkbox per item. The page reads the plan through two commands the manifest declares: `plan` (`uiPlan`) answers the items and the done/total tally of the conversation on screen as data; `mark` (`uiMark`) takes `{ id, stage }`, validates it like `todo_mark`, writes the plan, and answers the plan it left. Both refuse when no conversation is open. A gateway that does not read the field (the CLI gateway) sees only the tools.

```
[x] t-1 Read the failing test
[>] t-2 Fix the parser — the off-by-one in scan()
[ ] t-3 Run the suite
1 done · 1 active · 1 pending
```

| Tool | Arguments | Rule |
|---|---|---|
| `todo_write` | `items`: strings or `{ text, stage, note }` | Replaces the plan. Ids are minted by the tool, `t-1`, `t-2`, and keep counting across writes, so a finished id never names a different line. At most 64 items; text is one line of at most 200 characters. |
| `todo_add` | `items` | Appends. When the plan would exceed 64 items the new items are refused; old items are never dropped. |
| `todo_mark` | `ids`, `stage` (`pending`, `active`, `done`, `dropped`) | Only one item is active at a time. Marking a second one active returns the previous one to pending, and the reply says so. |
| `todo_order` | `ids` | The listed ids come first in that order; the rest keep their relative order after them. |
| `todo_read` | none | The plan as it is. |

## 3.1 The package tools

| Tool | Arguments | Effect |
|---|---|---|
| `install_package` | `source` | Installs from a path under the home, a git URL, or `url#dir`. A fork replaces its original. See [05-packages.md](05-packages.md) section 16. |
| `uninstall_package` | `name` | Removes the link. The files stay. A fork's original comes back. |
| `fork_package` | `name`, `as` (optional) | Copies an installed package to `packages/<as>` as `@<you>/<as>`, ready to edit. Does not install. |
| `delete_package` | `name` | Uninstalls a package of your own scope and deletes its directory under `packages/`. Refuses `@thetis/*`. |

## 3.2 The shell session tools

`@thetis/terminal` gives the model a long-lived shell instead of a one-shot command. A session is a real pty in the person's own fence. It keeps its working directory, its environment and its shell state between calls, the person can watch it and type in it in the page, and a command that outlives its wait keeps running instead of being killed. The full reference is [24-terminal.md](24-terminal.md).

| Tool | Arguments | Answer |
|---|---|---|
| `shell` | `cmd`, `session?`, `cwd?`, `timeoutMs?`, `background?` | Runs the command in this conversation's session, opening it on the first call. The exit status, the output, and a note when the working directory moved. A command still out when the wait runs out is not killed: the answer says so and `shell_read` collects the rest. |
| `shell_read` | `session?`, `waitMs?` | What the session has printed since the last read, and whether the command has finished and with what status. |
| `shell_send` | `text`, `session?`, `submit?` | Writes raw input — a passphrase, a `y`, a line for a REPL — and answers with what the session printed in the 400 milliseconds after. |
| `shell_interrupt` | `session?` | Writes the interrupt character. The command ends; the session lives. |
| `shell_sessions` | `close?` | This conversation's sessions: the name, where each one is, what it is busy with and for how long, and whether the person is watching. `close` ends one. |

`shell` replaces `exec`, which `@thetis/tool-exec` declared until 2026-09-16 and no longer does. `exec` started in the home with a fresh shell every time, so a `cd`, a virtualenv or an `ssh-agent` was lost between calls; it had no stdin, so a command that asked for a passphrase could only time out; and it killed the command it was waiting for when the timeout ran out, throwing the work away. `shell` keeps the session, `shell_send` answers the question, and a command that outlives its wait keeps running. `@thetis/tool-exec` keeps its other five tools and its name.

The descriptions the model reads say, for each of these, that the session is shared with the person and that the file tools are still the cheaper and safer way to read or change a file.

## 3.3 Restarting the daemon

`@thetis/tool-operator` carries one tool. **It is installed per admin, and never for everyone.**

| Tool | Arguments | Effect |
|---|---|---|
| `restart_daemon` | `reason` (required) | Arms a restart of this daemon. Nothing restarts in the call. |

`reason` is the only parameter, and it is required: it is shown to everyone waiting and written to the journal, so it has to name what changed and why reloading a workspace cannot pick it up. A call without one is refused before the kernel is asked.

**The tool arms rather than acts.** A tool that exited the process at once would kill the turn that called it, and the person would see a turn that simply stopped and never read why. So the call records the request, the turn finishes, and the reply reaches the person — that reply is the announcement. Only then does the daemon wait for every turn running anywhere to end, count down ten seconds where everyone can see it, and exit so that systemd starts the replacement. It waits at most two minutes; at that deadline it restarts anyway and the journal names whose turn it cut. Until it fires it can be called off.

The description the model reads tells it to **prefer a workspace reload**: a reload replaces that workspace's service code in about a second and takes nothing else down, so a restart is only for the code the daemon read once when it started — the kernel, the host, the sandbox, the door, `@thetis/lib`, `@thetis/contracts`, the `thetis` command, or `thetis.config.json`. It also tells the model to ask with `ask_user` first unless the person has just asked for it, and that a refusal means nothing happened, which is the sentence that stops a model inventing a second attempt. Every answer the tool gives is the latch's own sentence, passed through unchanged; the sentences live in `@thetis/lib` so that forking the tool cannot change what the kernel says about itself.

A tool declaration carries no `role` field, unlike a UI command, so authority here is what is installed: `thetis packages install @thetis/tool-operator --user <admin-id>`. Putting the package in `systemPackages["*"]` is a configuration error, and the kernel refuses a caller who is not an admin whatever is installed. The package also draws one statusbar chip, for the admins who have it, which counts an armed restart down and offers **Cancel**. See [25-restart.md](25-restart.md) section 5 and [12-security.md](12-security.md) section 11.

## 4. Questions for the person

`ask_user` takes `questions` (1 to 4 of `{ id?, question, options?, allow_multiple? }`, at most 500 characters per question and 12 options of 120 characters) and `intro`. It records them in `questions/<session id>.json` and returns fixed text telling the model to end its reply with one line saying it is waiting, and stop. The form is part of the package's page UI in `ui/` (section 3), not of the gateway. The web page draws the call as a form in the transcript: radios or checkboxes per question, a "Something else" text option, a free text area when there are no options, a Skip per question, and one Submit. Submit sends one user message, `1. <question> — <answer>` per line (or `skipped`), through the same path as the composer, and locks the card. A card followed by a user message is drawn locked when the conversation is reopened. See [15-web-gateway.md](15-web-gateway.md) section 1.

## 5. Provenance and tests

Thetis wrote both packages in the `alice` userspace on 2026-09-14 from a written brief through the web gateway, ran their tests inside its fence with `exec`, installed them with `install_package`, and used them on its own files. Two runtime defects surfaced on the way and were fixed before publishing: a provider refusal in the middle of a turn discarded the turn's tool history ([04-pipeline.md](04-pipeline.md) section 5.2), and the OpenRouter provider did not retry a transient refusal ([07-providers.md](07-providers.md) section 4.4). The packages were then copied into `packages/` under the `@thetis` scope, the wrapper was changed to mark refusals as errors, and `read_file` and `write_file` were removed from `@thetis/tool-exec`. The `ask_user` form followed the same path: Thetis forked its own web gateway in its userspace, built the form on the fork from the Thetis 1 design, replaced its gateway with the fork, asked a question through it, and the form's answers were merged into the shipped gateway.

The tests are `packages/tools-files/test/*.test.js` and `packages/tools-plan/test/*.test.js`, plain `node --test` files over a temporary directory. `npm test` runs them with the rest.
