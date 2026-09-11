# Remaining work

Current verification and operational limits are in
[implementation status](docs/implementation-status.md). The original
[implementation prompt](docs/implementation-prompt.md) is preserved as historical
design input, not as an installation guide.

## Specification follow-up

- Audit every specification clause, schema-coded boundary error, matcher branch
  and generation guard. The 106-id conformance inventory is useful but is not a
  substitute for that clause-level audit.
- Review the generated default profile and its installation seed before declaring
  the original milestone accepted. Do not create a milestone acceptance document
  merely because installation passes.
- Extend session coverage for attachment handling and background notices where
  not already exercised. Keep real-provider caching measurements separate from
  deterministic mock claims.
- Exercise every maintenance refusal branch. The supervisor currently normalizes
  unexpected internal error codes to the public wire's `io`; evaluate whether
  additional schema-defined codes would improve diagnostics without weakening
  reply validation.
- Audit host-tool dependencies on sandbox-excluded configuration. The test-only
  passwd entry permits OpenSSH signature tests; it does not expose host account
  data to deployment sandboxes.
- Profile complete generation switches without reusing the read-only probe as a
  serving writer. Preserve ADR 0026's fresh serving process and all current limits.

## Workflow

Use Node from `.nvmrc` with sibling `runtime/` and `packages/` checkouts, or an
explicit `THETIS_PACKAGES` override. See the [README](README.md) for commands.
Run build, check and the complete test suite before committing; regenerate
`profiles/default/` when its source closure changes.

Keep CI offline and deterministic. Paid model checks require explicit operator
authorization and a separate cost ceiling. ADR 0049 remains Proposed, so
automatic apply remains refused. Product names, host paths, passwords and API
keys must never come from a developer's personal deployment by default.
