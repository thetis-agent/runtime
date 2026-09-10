# Verified execution artifacts · ADR 0037

The operator accepted the build step on 2026-09-09. TypeScript remains the
editable and strictly checked source. No memory, latency, quota, authority or
generation guarantee is waived.

## Build and check

From the runtime checkout, with its sibling package checkout available:

```sh
export THETIS_NODE=/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node
"$THETIS_NODE" --import ./lib/artifacts/source.mjs lib/schema/generate.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/build.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/check.ts
"$THETIS_NODE" --import ./lib/artifacts/source.mjs scripts/test.ts
```

Generation writes committed contract types, schema guards and the reviewed
loader bootstrap. The explicit build runs inside bubblewrap with only the
source directories writable; it evaluates no package. It produces `file.ts.js`
and `file.ts.artifact.json` beside each first-party TypeScript file. These
sidecars are ignored in both source repositories, but registry publication pins
them with the sources. `check` recomputes their exact bytes without writing and
refuses stale output. Node upgrades require regeneration and rebuilding.

Metadata records version 1, generator `node:stripTypeScriptTypes:strip`, exact
`process.version`, and SHA-256 hashes of the source and output. Strip-only output
preserves source positions and leaves imports and worker URLs unchanged.

## Root imports

`@/` resolves from the importing module's installed runtime tree, including
`@/kernel/...`, `@/lib/...` and `@/contracts/...`. TypeScript uses the same
mapping for checking. Independent package internals and bootstrap modules keep
relative imports; copied compatibility fixtures retain their portable paths.

The generated `source.mjs` preload enables aliases for explicit source
execution. The generated `register.mjs` preload resolves aliases and verifies
artifacts before loading. Both use the same resolver; neither depends on the
current directory or the original checkout. Worker and child launchers select
the appropriate preload without passing authority through the environment.

[TypeScript paths](https://www.typescriptlang.org/tsconfig/paths.html) describe
the checker mapping; [Node module hooks](https://nodejs.org/docs/latest-v24.x/api/module.html#customization-hooks)
provide execution-time resolution. [Root imports](implementation.md#0047--root-imports)
records the decision and the package-boundary requirements.

## Activation

New assembled plans explicitly select `execution: "artifacts"`. The kernel
copies each new pin and checks its tree hash, then a bounded snapshot worker
verifies every advertised source/output pair before mounting it. Retained pins
are verified too. Vendored JavaScript distributions may contain TypeScript as
non-executable source data; that does not authorize TypeScript execution.

A synchronous preload serves verified JavaScript under the original `.ts` URL.
Node's implicit stripping is disabled. Missing, malformed, incompatible or
hash-mismatched output refuses execution, including when both sidecars disappear.
Regular-file, canonical-path and bounded-read checks reject symlinks and races.
Workers inherit the preload; snapshot workers retain it explicitly without
inheriting test-runner arguments. Legacy source plans remain available for
compatibility, but an artifact plan has no source fallback.

Run the trusted entry point with the preload and the documented 32 MiB old /
1 MiB young heap settings; see [headless startup](headless-startup.md). The
sandbox runner applies those settings itself. Kernel stdout remains its single
readiness document, not startup diagnostics or model content.

## Work edits and schemas

The watcher first captures the edit into its bounded cache. A separate trusted
child copies that snapshot and erases changed TypeScript without evaluating it.
Unchanged output can come only from a verified previous trusted pin, never from
the editable package's supplied sidecars. Edited package schemas regenerate
their standalone guards. The resulting tree is captured and sent through the
ordinary generation machine; compilation is included in edit-to-serve time.

Committed schema guards are loaded lazily. Their source and referenced-schema
fingerprints must match the registered schemas; otherwise validation uses the
ordinary Ajv compiler. Dynamic schemas still use Ajv. Differential tests compare
every generated definition against authoritative Ajv validation; tests also
cover changed root constraints, foreign references and changed dependencies.

## Bounds

| Setting | Default |
| --- | --- |
| Source or output per module | 1,048,576 bytes |
| Metadata per module | 4,096 bytes |
| Loader modules / total output | 4,096 / 67,108,864 bytes |
| Build entries / depth / source bytes | 10,000 / 64 / 67,108,864 bytes |
| Compiler children / deadline / old heap | 1 / 10 seconds / 32 MiB |
| Compiler request and combined response streams | 16,384 bytes each |
| Schema directories / schema bytes | 256 / 1,048,576 bytes |

Registry bootstrap incrementally packs loose objects with one worker and no
delta search. Registry-owned immutable profile caches share blobs through hard
links, with hashes checked again. Generation snapshots and mutable state still
use isolated copies. These storage changes avoid duplicated artifact pages
without raising the 128 MiB sandbox cgroup limit.

The full measurements and remaining failures are recorded in
[implementation status](implementation-status.md); this build step alone is not
Milestone A acceptance.
