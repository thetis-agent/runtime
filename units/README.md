# Unit templates

These four files are the systemd units an installed Thetis deployment runs. They are
**copies for review**: the authoritative text lives in `install.sh`, because a
`curl | sh` installer has no repository beside it, and `install.sh --print-unit
<name>` prints exactly the text it will install. `test/installer.test.ts` asserts
byte equality between these files and that output, so the two cannot drift.

`@PREFIX@`, `@STATE@` and `@USER@` are substituted at install time from
`--prefix`, `--state` and `--user`. `state.mount` is installed under the name
systemd derives from the state path (`/var/lib/thetis` becomes `var-lib-thetis.mount`).

Why the units look like this is recorded in
[ADR 0048](../docs/adr/0048-supervised-kernel-service-and-installed-layout.md):
the service runs `kernel/supervisor-main.ts`, not `kernel/main.ts`, so no kernel
start after the first is a restart outside the generation machine; the master key
reaches the kernel as a descriptor systemd opened from a root-only file; and
`thetis-update.service` may write only `releases/` and `updates/`, because it
checks and stages but never applies.
