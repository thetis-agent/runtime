# ADR 0049 · Pre-authorised kernel updates for fixes and improvements

**Status:** Proposed · 2026-09-10 — awaiting the operator's decision
**Deciders:** the operator (pending); runtime implementers
**Amends, if accepted:** ADR 0048's manual act; `docs/design/generations.md`'s
"an administrator, by the maintenance command"
**Removes, if accepted:** a person's reading of a release before the kernel's
own code changes

## Context

ADR 0048 ships the update path with the act kept manual: `zero-update.timer`
checks the runtime repository's tags, stages the assets, verifies the signature,
the tag binding and the execution artifacts, writes `updates/status.json` and
notifies. Nothing changes until an administrator runs `zero update --apply` with
their password. The flag `--auto-update fixes|improvements` exists and is
refused, naming this record, so the question is asked once, on the record,
rather than in a flag.

The operator will ask for it. Unattended patching is the normal expectation of a
`curl | sh` product, and the gates that would remain are real: a release must be
signed by a key in `allowed_signers`, its `SHA256SUMS` must check, its
`provenance.runtime.commit` must equal the commit its annotated tag peels to,
every execution artifact must verify (ADR 0037), every kernel code pin must
match its published tree hash, and the switch is still the GN-007 transaction
with its isolated probe, its check against every connected client major, and its
restore path that leaves the old kernel serving on refusal.

`docs/design/generations.md` nevertheless says the kernel's code changes by "an
administrator, by the maintenance command", and proposal §9 says "People edit it
with a pull request. The loop does not." A timer pressing that command is not
the loop, but it is not a person either.

## Decision (proposed, not taken)

Let `install.json` carry an update policy that the timer honours:

- `none` — the shipped default and the only value accepted today. The timer
  checks, stages, verifies and notifies; an administrator applies.
- `fixes` — the timer may apply a release whose tag has the same major and the
  same minor as the running version and a greater patch.
- `improvements` — the timer may additionally apply a greater minor within the
  same major.

Never a major version, never a prerelease, never a downgrade, and never the
default profile: the pins of packages everyone runs still move only by a
reviewer's act with evaluator evidence at the kernel origin (ADR 0018,
proposal §9). The policy pre-authorises exactly one thing — the maintenance
command for the kernel's own code, within the stated version range.

Under a policy, the timer's apply runs the same `lib/update` code path an
administrator runs by hand, with the same verification, and holds no separate
credential: it presents a deployment-scope authorisation the installer recorded
at install time, and `kernel/generations/maintenance.ts` still resolves the
administrator's identity from the kernel's own evidence. Every applied update
writes the same `generation.transition` rows and the same `updates/status.json`
record an administrator's apply writes.

## What is lost

An administrator no longer reads a release note before the kernel's own code
changes. A signed, well-formed but *wrong* release lands on its own — the probe
catches a kernel that will not serve or will not talk to a connected client
major, and catches nothing else: a release that starts, probes healthy and then
behaves badly is live until someone runs `zero undo`. The window between a bad
release being published and being noticed is the timer's interval, not a
person's attention. And the sentence in `docs/design/generations.md` stops being
true as written: the maintenance command acquires a caller that is not an
administrator at a terminal.

## Alternatives considered

**Stay manual (ADR 0048 as accepted).** Loses unattended security fixes; an
unattended host runs a known-bad kernel until someone signs in. This is the
status quo and needs no record.

**A staged delay** — apply only a release older than *n* days, so a bad release
has time to be yanked. Keeps most of the benefit and adds a clock the deployment
must trust; a yanked release also has to be discoverable, which the tag
advertisement does not express.

**Notify-and-arm** — the timer stages and verifies, then applies only after an
administrator has armed *that specific version* once. Keeps the person's reading
and loses unattendedness, which is the whole request.

**Apply only when the running version is behind by a security-tagged release.**
Needs a release-metadata field, a trust decision about who sets it, and a
schema; worth its own record if the operator wants this shape.

## Consequences if accepted

Good: an unattended host tracks fixes; the applied path is the tested one; the
blast radius stays inside the kernel target and its restore path.

Bad: the guarantee that a person reads before the kernel changes is gone for
patch (and, under `improvements`, minor) releases. The refusal sentence naming
this record disappears from `--auto-update`, and `docs/design/generations.md`
needs its sentence amended in the same change.

## Consequences while Proposed

`--auto-update` accepts only `none`. Any other value is refused with one
sentence naming this record. The policy's code path is implemented and tested,
so accepting this record is a configuration change and a documentation
amendment, not new machinery. Nothing in the shipped default behaves as if this
record were accepted.

## Revisit

On the operator's decision. If accepted, revisit when a release-metadata field
distinguishes a fix from a feature, or when a yank channel exists.
