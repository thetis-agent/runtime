# Design clarifications

This file records conflicts with the preserved design documents, not a running
development journal. Schemas and executable conformance tests govern wire details;
accepted [architectural records](adr/README.md) govern architectural amendments.
Routine mechanics belong in [implementation notes](implementation.md), operational
instructions in [the install guide](install.md), and measurements in
[implementation status](implementation-status.md). Git history retains earlier
investigation notes and superseded measurements.

## Authority and isolation

- ADR 0019 removes the proposed content-handling door. Provider content travels
  directly between unprivileged environments and adapters. The kernel authenticates
  calls and receives attributed cost, not prompts, answers or vendor counters.
- ADR 0021 makes an explicitly delegated child part of the same run principal.
  Ordinary children still inherit no kernel descriptors or secrets (TE-024).
- ADR 0020 makes deployment providers enforce durable daily and run reservations
  before vendor access. Final attribution and settlement precede terminal replies;
  a persistence fault refuses further spending (PR-010–011).
- ADR 0023 restores a stopped snapshot in a fresh generation. Undo never revives
  fenced credentials. ADR 0030 makes ordinary restart consume observed recovery
  history rather than silently booting the original seed.
- ADR 0038 supersedes the initial UI deferral. Each person's gateway serves its own
  assets and wire; no deployment-wide package may splice into foreign person
  sockets. Static host TLS routing is outside the package authority boundary.
  The package cookie is `thetis_session`; the trusted kernel origin's distinct
  `__Host-thetis` cookie never belongs to a package.
- ADR 0040 chooses the bounded file storage contract as the reviewed default.
  Encryption, scope checks and observed provenance remain kernel responsibilities.

## Execution and installed operation

- ADR 0035 separates runtime and package source repositories. Development uses
  sibling checkouts or `THETIS_PACKAGES`; no operator's filesystem is a product
  default.
- ADR 0037 amends the original no-build guarantee: exact-Node, hash-verified
  JavaScript executes under original TypeScript URLs. Artifact mode never falls
  back to implicit type stripping. Generation-local caches do not grant authority.
- ADR 0048 launches a maintenance supervisor, not a naked kernel entry point.
  Every subsequent kernel start follows GN-007. File credentials enter the kernel
  on descriptor 4, separately from the inherited supervisor control endpoint.
- Product defaults are Thetis: `/opt/thetis`, `/var/lib/thetis` and
  `thetis.service`. Personal names require explicit installer choices. Public
  target sockets use a stable `<state>/live` alias through update, undo and restart.
- Host operator tools verify and apply signed releases. The unprivileged
  `autoupdate` package only reads status; it cannot modify code or restart services.
  ADR 0049 remains Proposed: unattended apply is refused. Same-major update
  discovery is not authorization to apply.
- CI runs acceptance once and retains a hashed candidate tied to both exact
  source commits. Release publication signs those same successful CI bytes.
  Signature namespace `zero-release` is retained solely for cryptographic
  compatibility; it does not name a service, account or directory.

## Acceptance limits

On 2026-09-10 the operator explicitly set the limits to 1,500 counted kernel
lines, 512,000,000 bytes for the kernel plus one idle environment, and 2,000 ms
for a watched edit to serve. Static imports, blank lines and comment-only lines
are excluded from the source count. The measured workloads, sandbox boundaries
and individual deployment quotas remain enforced. Coverage excludes profiling
the two performance workloads, not running their tests. No gate is waived by an
older status entry.
