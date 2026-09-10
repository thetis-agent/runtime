# Runtime package reuse assessment · 2026-09-10

There are credible npm reuse opportunities, chiefly in support libraries. None
of the reviewed substitutions by itself closes the kernel's 380-line overage.
The final inventory has 1,680 counted kernel lines against 1,300; runtime
assembly and generation orchestration account for 700 of those lines.

The following savings are estimates from source review after retaining required
adapters. They have not been measured with implementation prototypes. No new
dependencies were installed as part of this assessment.

| Candidate | Existing implementation | Estimated net saving | Recommendation |
| --- | --- | --- | --- |
| Execa | [Registry subprocesses](../../lib/registry/git.ts#L7), [artifact subprocesses](../../lib/artifacts/index.ts#L10) | 10–25 support-library lines; 0 kernel | Prototype if command wrappers continue multiplying. Keep environment control, combined output-byte limits, capacity refusal and typed errors. |
| Piscina | [Snapshot workers](../../lib/snapshots/pool.ts#L19), [evaluation workers](../../lib/evaluation/async.ts#L16) | 15–35 support-library lines; 0 kernel | Closest structural fit. Keep independent workload budgets, schema checks, artifact execution flags and worker memory limits. |
| eventsource-parser | [Provider SSE parsing](https://github.com/thetis-agent/packages/blob/main/provider-openai-compatible/sse.ts#L5) | 0–10 package lines; 0 kernel | Consider for maintained standards handling; the current parser is already small. |
| big.js or decimal.js | [Exact provider money](../../lib/provider/money.ts#L1) | 0–10 support-library lines; 0 kernel | Consider when arithmetic grows. The present implementation is 22 lines and uses native BigInt. |

Execa provides promise-based execution, timeout and buffering controls. Those
features can replace repeated collection and failure handling, while sandbox,
descriptor custody and cgroup termination remain project responsibilities.
[Official API](https://github.com/sindresorhus/execa/blob/v10.0.1/docs/api.md).

Piscina exposes thread, queue and worker-resource limits. Its defaults are not
the runtime's policy: configure every bound and verify immediate refusal when
capacity is full. Worker reuse and crash handling are useful existing machinery.
[Official stable API](https://github.com/piscinajs/piscina/blob/v5.3.2/README.md).

The SSE parser's buffer limit counts characters. An adoption must retain the
runtime's UTF-8 byte bound, fatal decoder and refusal of truncated events, as
well as the provider's event conversion.
[Official parser API](https://github.com/rexxars/eventsource-parser).

Big.js documents exact addition and subtraction, making it the closer fit for
budget ledgers. Decimal.js defaults to 20 significant digits and rounds ordinary
arithmetic to its configured precision. Using those defaults would regress the
new full-range exact accounting. Any replacement needs canonical serialization
and the existing magnitude, exponent, restart and concurrency regressions.
[Big.js arithmetic](https://github.com/MikeMcl/big.js#use),
[decimal.js precision](https://mikemcl.github.io/decimal.js/#precision).

## Packages that do not presently justify a kernel rewrite

The generation transition gate is 73 lines plus a 22-line table. The larger
driver performs real fencing, checkpointing, probing, rollback and process
ownership. XState supplies machine and persistence APIs, but its presence would
not remove those decisions. The required journal write before exposing a state
would need an adapter. My assessment is that a replacement could increase code
and change recovery semantics without material savings.
[XState persistence](https://stately.ai/docs/persistence).

P-queue schedules promise tasks; it does not directly replace the runtime's
immediate capacity rejection or byte-weighted asynchronous event streams. It is
not a useful kernel-size substitution for the current queues.
[Official API](https://github.com/sindresorhus/p-queue).

## Actual kernel reduction candidates

1. Extract generation-profile history bookkeeping from
   [runtime.ts](../../kernel/boundary/runtime.ts#L184):
   repeated stage/get/prune mechanics around group, switch and reset. Keep
   authorization, commitment decisions and epoch selection in the kernel.
   Estimated net saving: 10–20 kernel lines.
2. Move typed usage-argument decoding behind the existing schema machinery at
   [runtime.ts](../../kernel/boundary/runtime.ts#L331).
   Keep identity, attribution and quota enforcement in the kernel.
   Estimated net saving: about five kernel lines.

The project already reuses Ajv, semver, YAML and ws. Further meaningful kernel
reduction needs an explicit review of orchestration responsibilities and
duplication. Moving authority-bearing functions to an imported package solely
to evade the counter would not reduce the trusted system's complexity.
