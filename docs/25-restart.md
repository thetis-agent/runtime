# 25 Reload and restart

New code on disk does not reach a running installation by itself. What it takes depends on where the code
lives, and there are three answers. This document is the whole of the second and third; the table that
tells them apart is [10-development.md](10-development.md) section 4.1.

| Tier | What is in it | What puts it into service |
|---|---|---|
| 1 | Browser files, package manifests, and the **entry module** a `tool`, `step`, `enumerator` or UI-command export is declared in | Nothing. The next request or turn has it. |
| 1 | **Configuration**: `packages[*]` of `thetis.config.json` and the `.env` file | `thetis config reload` for the file (`config.set` from the CLI, the panel or the tool needs nothing at all); the next call for a changed `.env` variable. A changed package's service restarts in place, fence open. See [09-configuration.md](09-configuration.md) section 5. |
| 2 | **Anything an entry module imports**, a service's module graph, a provider, the userspace agent | A **reload** of that person's workspace (section 2) |
| 3 | The kernel, the host, the sandbox, the door, `@thetis/lib`, `@thetis/contracts`, the `thetis` command, and everything else in `thetis.config.json` (`fence`, `door`, `systemPackages`, `control`, `storage`, `model`, `phases`) | A **restart** of the daemon (section 4) |

## 1. Why the tiers exist

A `tool` or `step` export is imported with a modification-time query (`?v=<mtime>`), so the userspace
agent re-reads that file on every call. **Only that file.** A static `import "./client.js"` inside it
resolves to a URL carrying no query, so the module cache goes on serving the copy it already has: editing a
helper that a tool imports changes nothing until the agent process is new. The safe-sounding reading — "it
is tool code, so it is live" — is the wrong one, and it costs an afternoon to discover.

A **service** is imported once, when its agent starts, and the query versions only a package's entry
module — `@thetis/gateway-web`'s `index.js` imports `./server.js` with a
plain specifier, so that file stays in the process's module registry however many times the entry is
re-imported. Node has no way to reload a module graph. The only thing that reads one again is a new
process, and for a service that means a new agent: a new fence.

The kernel, the door and the rest of the configuration are read once by `thetis serve` and held for its
life, so `fence`, `door`, `systemPackages`, `control`, `storage` and `model` are tier 3. `packages[*]` is
not: the config service resolves a package's configuration on every dispatch, `thetis config reload`
reads the file layer again, and a service whose configuration changed is stopped and started in its
fence with the new one. The `.env` file is read again whenever its modification time changes.

## 2. Reload

```sh
thetis reload --user alice     # one workspace
thetis reload --all            # everyone, one at a time, `_system` last
```

or the **Workspaces** section of the control panel ([17-control-panel.md](17-control-panel.md)).

A reload closes that person's fence and opens it again. The agent is new, so every service in it starts
on the code that is on disk now, and the provider cache the kernel holds for that userspace is dropped —
without that, a rebuilt provider would go on advertising its old model list for up to five minutes.

`_system` is a legal target, and sometimes the one you want: the providers and the sign-in page live
there.

**What a reload costs.** Everything inside that fence stops. Every open terminal shell session closes,
with whatever was running in it ([24-terminal.md](24-terminal.md) section 7), and a turn in flight ends
with an error of code `fence`. Conversations and files are untouched. It takes about a second.

**What a reload does not reach.** The kernel, the door, `thetis.config.json`, and anyone else's
workspace. Reloading `alice` does nothing for `bob`; and when the provider lives in `_system`, which is
usual, reloading `alice` does not reload the provider that answers her turns.

### 2.1 A workspace cannot be left dark

Closing a fence and failing to open it again used to leave that person with nothing: the door routes to a
socket that only the fence creates, so nothing would reopen it. The door now asks the kernel to open a
fence it cannot find, and treats a refused connection to a stale socket the same way, so a workspace
recovers on the next request whatever happened to it. A fence that will not open is reported, not
retried forever: after the deadline the door answers `503`, and a short cooldown stops one page's twenty
assets becoming twenty attempts.

## 3. Saying what is stale

```sh
thetis status
```

Compares what is on disk against what each part loaded, and names anything running older code — the
daemon, and every workspace. The same words appear in the control panel's **Workspaces** section, with
the Reload button in the row that reports the problem.

A workspace with no fence open is never stale: the next request opens it on whatever is there then.

## 4. Restart

A restart replaces the daemon process. It ends **every turn in progress, everywhere**, and every terminal
shell session. Conversations are on disk and come back; people stay signed in.

```sh
sudo systemctl restart thetis-runtime.service     # the ordinary way
thetis restart --reason "the kernel changed"      # from the host, over the control socket
```

and, for an admin, `restart_daemon` — a tool the model can call (section 5).

### 4.1 The daemon does not restart itself; it arms a latch

A tool that restarted immediately would kill the turn that called it: the person would see a turn that
simply stopped, and never read why. So the request only **arms** a latch. The turn finishes, the model's
reply reaches the person — that reply is the announcement — and only then does the daemon act.

The latch then waits on two clocks:

- it waits for **every turn running anywhere** to end, and once nothing is in flight it counts down ten
  seconds where everyone can see it;
- and it will not wait longer than **two minutes**. At that deadline it restarts anyway, and the journal
  records whose turn it cut.

Quiet is not re-tested once the countdown starts, or a busy installation could defer a restart forever
while calling it pending. Until it fires it can be called off, from the chip on the page or
`thetis restart cancel`.

The exit is clean, and systemd starts the replacement.

### 4.2 The guards

A restart is refused, with nothing armed, when:

| Refusal | Meaning |
|---|---|
| `off` | `control.allowRestart` is false in `thetis.config.json` |
| `unsupervised` | The daemon was not started by systemd, so exiting would stop Thetis rather than restart it |
| `no-listener` | This is a short-lived command's own kernel (`thetis send`, `thetis chat`, a bench run), not the serving daemon; a restart here would only kill the command |
| `young` | The daemon has been up less than `control.minUptimeSecs`, so "restart, it did not help, restart" cannot become a loop |
| `policy` | The **deployed** unit does not say `Restart=always`, so the process would exit and stay down |

The last is the one that matters most, and it is the reason the feature reads the running system rather
than the repository. The unit file in this checkout is not the unit systemd is using. If
`/etc/systemd/system/thetis-runtime.service` still says `Restart=on-failure`, every other guard passes,
the tool reports a restart, the daemon exits cleanly — and systemd, seeing a clean exit under
`on-failure`, leaves it stopped. The installation would go down for good with the model's last words
being that it would be right back. So the daemon asks systemd what the deployed policy actually is
(`systemctl show -p Restart --value`, for the unit named by its own cgroup) and refuses unless the answer
is `always`. When the answer cannot be read at all, it refuses too: not knowing is not permission.

`thetis status` and the startup banner both report the deployed policy, so an operator learns whether a
restart would come back when the daemon starts — not when the model first tries it.

### 4.3 The unit

`deploy/thetis-runtime.service` carries `Restart=always`, because a deliberate restart is a clean exit and
`on-failure` would not cover it. `StartLimitIntervalSec=300` and `StartLimitBurst=5` sit in `[Unit]`, not
`[Service]` — under `[Service]` older systemd accepts and ignores them, which is a guard that does
nothing. Five starts in five minutes and systemd gives up and leaves the unit failed, which is what you
want: a daemon that will not stay up should say so rather than flap.

`Restart=always` does **not** defeat `systemctl stop`. An operator stopping the service still stops it.

After changing the unit, deploy it — the repository's copy is not what systemd reads. **Do not copy the
file over the deployed one.** The template's `User`, `Group`, `WorkingDirectory` and `ExecStart` lines are
placeholders, and the live unit on this host is hand-adapted; copying the template over it took production
down once. Diff the repository's unit against the deployed one and carry the change across by hand,
keeping the four host-specific lines as they are:

```sh
diff /etc/systemd/system/thetis-runtime.service deploy/thetis-runtime.service
sudoedit /etc/systemd/system/thetis-runtime.service
sudo systemctl daemon-reload
```

## 5. `restart_daemon`, the tool

`@thetis/tool-operator` carries one tool, `restart_daemon`, taking a `reason` that is required, shown to
everyone waiting, and written to the journal.

**It is installed per admin, and never for everyone.** A tool declaration has no `role` field, unlike a
UI command, so a tool that every model can see and only an admin may use would be a tool most people's
model calls and is refused for — a setting that records an intention rather than granting anything. Here
authority is what is installed:

```sh
thetis packages install @thetis/tool-operator --user <admin-id>
```

Putting `@thetis/tool-operator` in `systemPackages["*"]` is a configuration error. The kernel refuses a
caller who is not an admin regardless of what is installed, so the packaging is the signal and the kernel
is the guard.

The tool's description tells the model to prefer a reload, to ask with `ask_user` first unless the person
has just asked, and that a refusal means nothing happened — the sentence that stops a model inventing a
second attempt. Every answer it gives is the latch's own sentence, passed through unchanged; the
sentences live in `@thetis/lib` so that forking the tool cannot change what the kernel says about itself.

### 5.1 The chip

The package draws one statusbar entry, which exists only for the admins who have the package. It is
hidden while nothing is pending. While a restart is armed it counts down, carries the reason, and offers
**Cancel**. When the daemon goes it says it is waiting, for up to ninety seconds — a restart is an exit,
`RestartSec=2`, a fresh kernel, every fence reopening and every service booting — and then stops and says
so, naming `journalctl -u thetis-runtime`, rather than spinning forever.

## 6. The journal

| Kind | When |
|---|---|
| `fence.reload` | A workspace was reloaded, with the person as the target |
| `restart.armed` / `restart.again` / `restart.refused` / `restart.cancel` | A restart was asked for, asked for twice, refused (with `why`), or called off |
| `restart.fire` | The latch fired: `quiet` says which branch, and `cut` names the turns it ended |
| `daemon.start` / `daemon.stop` | The process, with its pid, whether it is supervised, the deployed policy, and why it stopped |

`restart.fire` with `quiet: false` and a non-empty `cut` is the row to look for: it is the only durable
record that somebody's turn was truncated.

## 7. What is not solved

**A restart that hits the deadline cuts a turn, and the person whose turn it was is not told.** Their
transcript ends with their own message and nothing after it. The design makes this improbable — a
single-operator installation is quiet within seconds — states the branch in the tool's description and in
its answer so the person who asked can warn about it, and records `restart.fire` with `cut` so it is
auditable. It does not tell the person it happened to. Doing that honestly means writing into a
conversation on behalf of somebody who is not the caller, inside the shutdown path, and it needs its own
design.

**A restart is not zero-downtime.** The port is refused for the few seconds it takes, and a browser sees a
failed connection rather than a pause. Socket activation would turn that into a queue; it is not built,
and [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md) records the hazard that any future
attempt must close first.
