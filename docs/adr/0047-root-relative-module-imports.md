# ADR 0047 · Resolve root-relative imports in every execution mode

**Status:** Accepted · 2026-09-10; explicitly requested by the operator
**Deciders:** operator; this session
**Amends:** ADR 0037's relative-import convention

## Context

The operator requested `@/` imports and clarified that the root is the runtime
repository, including `@/kernel/secrets/index.ts`. TypeScript path mappings do
not change Node's module resolution. The same sources run in development,
workers, immutable installations and copied kernel revisions.

## Decision

Map `@/*` to the runtime root in TypeScript and resolve the same specifiers
through Node's synchronous module hooks. Determine the installed root from
the importing module's package scope, preserving the sibling `kernel`, `lib`,
`contracts`, `test`, `scripts` and `packages` layout in ADR 0035. Never resolve
a copied revision through the original checkout or the current directory.

Use aliases for imports across package boundaries and within the kernel,
test and script trees. Keep imports within independently versioned library,
contract and application packages relative so those packages remain movable.
Keep bootstrap imports relative until the resolution hook is registered.

Provide a resolution-only source preload for development and keep the same
resolution hook in the verified-artifact preload. Worker and process launchers
must select the appropriate preload explicitly. Aliases neither bypass
artifact verification nor grant a package access to another package or the
kernel. Reject traversal and malformed alias paths; extend the import lint
gate to cover the new spelling.

## Alternatives considered

TypeScript paths alone leave executable imports unresolved. Rewriting emitted
imports would require another transformation and change their source positions.
Binding aliases to the original checkout would mix revisions after relocation.
Adding a third-party loader duplicates the existing artifact loading boundary.

## Consequences

Good: imports expose the repository location without counting parent segments,
while deployed revisions retain their own dependencies. Bad: direct source
commands need the documented resolution preload. The preload remains generated
and checked from TypeScript; no dependency, authority or budget is added.

## Revisit

If the installed directory layout changes or Node supports this alias spelling
without a customization hook.
