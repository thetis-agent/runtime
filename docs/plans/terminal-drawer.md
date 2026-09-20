# Plan: the terminal drawer, and a resize that does not echo

**Date:** 2026-09-20. **Status:** approved, in progress. **Scope:** two changes to `@thetis/terminal` and the
shelf it lives in. (1) A resize sets the pty's window size from outside the shell, so nothing is typed into
the person's terminal and a running program learns the new size at once. (2) The browser side returns to
the legacy drawer's visual elements, styling and structure (`/opt/thetis/gateways/gateway-web/src/ui/views/terminal.js`,
`app.css` lines 3184–3521, `theme.css` lines 75–120), keeping what the rewrite gained: a real pty the person
can type into, interrupt, rename and reopen, and shells that belong to the fence rather than to one page.

The two are built in parallel against this contract. Section 1 is the server side (`lib/`, `index.js`,
tests); section 2 is the browser side (`ui/`, the shelf chrome in the gateway, the tokens).

---

## 0. Why

The `stty rows R cols C` line the person sees after every layout change is the rewrite's way of telling a
pty its size: Node has no ioctl, so the size was typed at the prompt and hidden from the agent only. The
legacy drawer never had the problem because it never gave a local shell a pty at all, and never told it a
size; its emulator only reflowed. The pty is worth keeping. The echo is not: `stty -F <pty> rows R cols C`
run as a sibling process sets the size on the device directly, the kernel raises `SIGWINCH` in the
foreground group, and it works while a command runs. Verified on this host with a `script`-backed bash
(the shell reported the new size, saw the signal, and a resize during a `sleep` landed).

The drawer itself deviated from the legacy one in structure (a list on the left and a pane on the right,
rows that are paragraphs of state, a head with a summary sentence, a status-bar chip) and in material (the
app's cool surfaces instead of the terminal's own warm neutrals and green wash). The person wants the legacy
look and structure back.

---

## 1. Server side: the resize

### 1.1 Learning the device

`lib/marks.js` `initFile` gains one line after the initial `stty`: the shell reports its device once,
through a private OSC the mark parser understands and the emulator ignores:

```sh
[ -t 0 ] && printf '\033]7770;tty=%s\007' "$(tty)" 2>/dev/null
```

`MarkParser` parses `OSC 7770 ; tty=<path> ST/BEL` into a mark `{ kind: "tty", path }` (only `/dev/pts/N`
or `/dev/tty*` paths are accepted; anything else is ignored). The session keeps it as `ttyPath`. It is in
the raw buffer like every other mark; the emulator drops unknown OSCs. A shell without the rc (not bash)
never reports one.

### 1.2 Applying a size

`lib/session.js`:

- `resize(r, c)` validates as today. With `ttyPath` known it runs `stty -F <ttyPath> rows R cols C` with
  `execFile` (from `node:child_process`, no shell, 2 s timeout) and answers `{ applied: true, deferred: false,
  rows, cols }` whether or not a command is running. `wantRows`/`wantCols` are updated so a reopen keeps the size.
- Without `ttyPath` (a non-bash shell, or the report not yet seen because the shell is still starting) it
  falls back to today's typed `stty` at the next prompt, with today's answer shape, hidden from the agent as today.
- A `stty -F` failure (the device vanished, `stty` missing) falls back the same way and is not an error.
- `pendingResize`, `internalBusy` and `addSkip` stay for the fallback path only.

`lib/host.js` `resize` and `index.js` `uiResize` are unchanged in shape; `uiResize` now also passes
`deferred` through: `{ data: { applied, deferred } }`.

### 1.3 Tests

- `test/marks.test.js`: the init file carries the tty report line; the parser yields a `tty` mark for
  `\x1b]7770;tty=/dev/pts/3\x07` and ignores a path outside `/dev`.
- `test/session.test.js`: after open, the session knows its `ttyPath` (exposed in the state record as `tty`
  for the details card); a resize while `sleep 1` runs answers `applied: true` and `tput cols` right after
  the sleep prints the new width (the program running got the size); a resize at idle prints nothing the
  agent sees and nothing the person sees either (the raw buffer has no `stty` after the report line); the
  existing deferred test becomes the fallback test by opening the session with `sh` (no rc, no tty report).
- `test/host.test.js`: the deferred case likewise moves to a `sh` session.

### 1.4 Docs

`docs/24-terminal.md`: the resize paragraph of section 7 ("the one honest limitation") is rewritten: a
resize is an ioctl on the device from a sibling `stty`, immediate, silent, and effective for the program
running now; the typed fallback remains for a shell that did not report its device. The constants table
(`RESIZE_WAIT_MS`), the notes table (the deferred note is now the fallback's only), the test inventory.
`README.md` section on limitations. `packages/gateway-web/test/BROWSER.md` step 59 (a resize during a
full-screen program now takes effect at once).

---

## 2. Browser side: the drawer

### 2.1 Where things live

| Piece | Owner | Notes |
|---|---|---|
| Drawer chrome: grip, head, collapse, hide, height, animation, persistence | `@thetis/gateway-web` `assets/views/shelf.js`, `index.html` `#shelf`, `app.css` `.shelf*` | The shelf is the legacy `terminal-dock`, generic enough for any tenant. |
| Terminal palette tokens `--term-*` | `assets/theme.css` | Copied from the legacy file. The terminal is a dark device in both colour schemes unless the legacy light block overrides them; check `/opt/thetis/.../theme.css` and do what it did. |
| Body (emulator left, list right), footer, rows, details card, kill popover, chip | `@thetis/terminal` `ui/` | All `.term-*` classes and their CSS from the legacy block, adapted only where the rewrite's capabilities need it. |

### 2.2 The shelf chrome (gateway)

`#shelf` becomes:

```html
<div id="shelf" class="shelf" hidden aria-label="Terminals">
  <div class="shelf-grip" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
  <header class="shelf-head">
    <span class="shelf-title"></span>                 <!-- uppercase, faint, letter-spaced: the legacy .term-title -->
    <div class="shelf-actions"></div>                 <!-- the tenant's buttons, then collapse, then hide -->
  </header>
  <div class="shelf-body"></div>
</div>
```

Mechanics, from the legacy `terminal.js` verbatim where possible: `DEFAULT_H = 300`, `MIN_H = 140`,
`maxH = round(innerHeight * 0.72)`; height as an inline `px` style; persisted in `localStorage` under
`thetis.shelf.height` (read clamped, written on pointer-up); open = `hidden` off, `height: 0`, two nested
`requestAnimationFrame`, then `.is-open` and the stored height; close = `.is-open` off, `height: 0`,
`hidden` on at `transitionend` for `height`; `.is-dragging` disables the transition; `.is-collapsed`
(`height: auto !important`, body hidden, chevron rotated) toggled by the collapse button, dragging disabled
while collapsed. CSS: the legacy `.terminal-dock`, `.term-grip`, `.term-head`, `.term-title`,
`.term-head-actions`, `.term-collapse` rules, renamed to `.shelf`, `.shelf-grip`, `.shelf-head`,
`.shelf-title`, `.shelf-actions`, `.shelf-collapse`, on the `--term-*` tokens (`--term-bg` background,
`--term-panel` head, `--term-hairline` borders, the upward shadow, square corners, `max-height: 72vh`).

The mount contract grows: a shelf entry's `mount(body, shelf)` receives a second argument
`{ actions(nodes), fit(fn) }`: `actions` places the tenant's buttons before the collapse button;
`fit` registers what to call after a drag, a collapse or the open animation. The returned function still
unmounts. `ext.open.shelf(id)` opens; a new `ext.close.shelf()` closes; `ext.shelf.isOpen()` answers.
`registry`/`ext.js` gain nothing else.

### 2.3 The body (`@thetis/terminal` `ui/`)

Built into `.shelf-body`, the legacy tree with the rewrite's additions marked †:

```
div.term-body
├── div.term-panes                     the emulator host, first in the DOM
│   └── div.term-pane                  one per session, swapped in when chosen
└── nav.term-list[aria-label="Terminal sessions"]
    ├── div.term-tab[.is-active][.has-activity][.is-elsewhere†][data-id]
    │   ├── button.term-tab-pick        title="<id> — <shell> in <cwd>"
    │   │   ├── span.term-dot.is-busy|.is-ok|.is-done
    │   │   ├── span.term-tab-text
    │   │   │   ├── span.term-tab-label     name || id
    │   │   │   └── span.term-tab-sub       leaf(cwd); for a shell of another conversation† `leaf(cwd) · "<title>"`
    │   │   └── span.term-tab-note          "exited" when closed
    │   ├── button.icon-btn.sm.term-tab-stop†   shown while busy: interrupt (Ctrl-C to the foreground program)
    │   ├── button.icon-btn.sm.term-tab-info[data-info]   the details card
    │   └── button.icon-btn.sm.term-tab-kill               close (popover), or remove a closed row
    └── span.term-empty                 "No shells open — open one with +, or the agent opens one when it needs to run something."
div.term-foot
├── span.term-cwd[title=cwd]            the chosen shell's full cwd, `~` for the home
└── span.term-meta                      "<shell> · <state sentence>", e.g. "bash · idle", "bash · running make · 14s", "bash · you are running vim", "bash · closed · exit 0"
```

Head actions supplied through `shelf.actions`: `+` (open a shell in this conversation, `.term-add`) and
the eraser (clear the chosen view). The collapse and hide buttons are the shelf's. Icons: the legacy path
data (`chevron`, `close`, `trash`, `eraser`, `info`) plus a stop square for interrupt.

CSS: the legacy `.term-body`, `.term-panes`, `.term-pane`, `.term-list` (190px, flush, panel background,
left hairline, local scrollbar colours), `.term-tab*`, `.term-dot*`, `.term-empty`, `.term-foot`, `.term-cwd`,
`.term-meta`, `.term-fallback*`, the two `@media` steps (1060px, 900px), the details card `.term-card*`, and a
`.term-popover*` copied from the legacy `.popover` rules, verbatim on the `--term-*` tokens. Do not add a
`.mono` rule: the legacy labels rendered in the UI font; only the canvas is monospaced.

Rows: sorted by conversation (the open conversation's shells and the person's own first, then the rest,
which carry `.is-elsewhere`), then by name with numeric collation. The dot: busy (any of `busy`, `busy-quiet`,
`person`, `fullscreen`) pulses in `--term-yellow`; `idle`/`unframed` is `--term-bright-green`; `closed` is
`--term-bright-black`. `.has-activity` (label bold and bright) when output arrived on a row that is not
chosen; cleared when it is chosen. Clicking a row chooses it and focuses the emulator. Double-click on the
label renames (the input takes the label's place, Enter keeps, Escape drops), because the rewrite lets a
person name a shell.

The details card (`.term-card`, `position: fixed`, placed left of the list as the legacy did, Escape or
a click outside closes it, re-anchored after a redraw) rows: Name, Session id, Working directory,
Conversation (its title, or "opened by you"), Shell, State, Command (when running), Running since,
Last exit, Terminal (the `tty` path), "Reports exit codes" (framed). The foot says "What you type here goes
to the shell." Kill: the popover `Close <name>?` with the detail sentence ("The shell in <cwd> and everything
it is running will be terminated. The agent may be using it."), a Close button in the error tone, Escape
cancels; a closed row's trash removes it from the list without asking (the host keeps its record; the row
stays hidden for this page).

The emulator (`ui/screen.js`): the palette from the `--term-*` tokens read with `getComputedStyle` (plain
hex, no probe needed; keep the probe only for the cell measurement), `fontSize: 12.5`, `lineHeight: 1.45`,
`scrollback: 5000`, cursor blinking (it is writable), `.term-panes` padding `8px 0 8px 12px`. The legacy
`convertEol: true` is not used: the pty already sends `\r\n`.

### 2.4 The chip

The chip moves from the status bar to the chat bar: `package.json` declares `"chips": [{ "id": "terminal",
"order": 50 }]` instead of the `statusbar` entry (the status bar hides itself again when nothing fills it).
Per pane, `draw(button, { session })` renders the legacy chip: `span.term-dot` (busy → `--warn`, live →
`is-ok`, none alive → `is-done`) and `N terminals` for the shells of that conversation plus the person's own,
or `Terminal` when there are none; `.is-on` while the drawer is open; the title as the legacy. Click toggles
the drawer (and uncollapses it).

### 2.5 Behaviour

- A shell appearing in the open conversation opens the drawer, every time (the legacy `opened` rule), and
  the first shell of the page is chosen; a later one brightens its row instead of stealing the view.
- Switching conversations closes the drawer and reopens it when the new conversation has shells (the legacy
  `setSession` + `onList` rule). The chosen row follows: the new conversation's first shell.
- `fit()`: one `ResizeObserver` on `.term-panes` plus the shelf's `fit` hook; the emulator is resized and
  one `resize` command sent when the grid changed. With section 1 in place the answer is always applied, so
  no note is drawn; `applied: false` (the fallback) is shown in the footer meta as "size applies at the next
  prompt".
- The person's typing, the reconnect with widening retry, the output replay guard, the `closed` freeze and
  the auto-open once rule from today's `ui/index.js` are kept as they are, only rewired.
- Keyboard: none global, as the legacy. Escape closes the card and the popover.

### 2.6 Checklist and docs

`packages/gateway-web/test/BROWSER.md` steps 53–61 rewritten for the new DOM (`.term-tab`, `.term-dot`,
`.term-card`, the chip in `.chips`, the shelf's `.is-open`/`.is-collapsed`, the persisted height).
`docs/24-terminal.md` section 5 (the drawer), `docs/15-web-gateway.md` where the shelf and the status bar
are described (§1 table, §8, §11.7), `packages/terminal/README.md` browser section, and
`docs/plans/gateway-ui-modular.md` note that the shelf's chrome is the terminal drawer's.
