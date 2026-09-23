// What a package declares to be benchmarked, and what it reports while it is. The bench never reads a
// package's own data: it ships a neutral corpus every mechanism imports into its own shape, and scores
// only what the harness assembled. Two seams, both optional, both inert outside a bench run.
import type { z } from "zod";
import type * as schemas from "./schemas/bench.js";
import type { PackageStepContext } from "./guest.js";
import type { StepResult } from "./pipeline.js";

/** How far a capability is from the model right now. `direct` costs no round trip; the others cost one. */
export type Reachability = z.infer<typeof schemas.ReachabilitySchema>;

/**
 * One capability in the neutral corpus. Mechanism-free by construction: a retriever, a catalogue and an
 * inject-everything loader all hold the same records and differ only in what they do with them.
 */
export type CapabilityRecord = z.infer<typeof schemas.CapabilityRecordSchema>;

export type Corpus = z.infer<typeof schemas.CorpusSchema>;

/** What an importer did with the corpus. Reported for the record; never scored. */
export type ImportRecord = z.infer<typeof schemas.ImportRecordSchema>;

/**
 * A package's own account of what it surfaced for the turn's call. Claims are cross-checked against the
 * canaries the provider found: a claim with no canary behind it is `adapterLies`, which fails the run.
 * `ranked` has no verifiable counterpart, so it is reported under its own arm and never compared across
 * mechanisms.
 */
export type BenchClaim = z.infer<typeof schemas.BenchClaimSchema>;

/** What a bench turn collects in `harness["@thetis/bench"]`, keyed by package name. */
export type BenchHarness = z.infer<typeof schemas.BenchHarnessSchema>;

/**
 * corpus in. The `bench`-phase export named by `thetis.bench.importer`. It reads the corpus from
 * `bench/corpus.json` under `env.cwd` and writes its own representation anywhere under `env.cwd`. It runs
 * on every bench turn, so it must be idempotent; the cost of its first run is reported as `import_ms`.
 */
export type CorpusImporter = (ctx: PackageStepContext) => Promise<StepResult | void>;

/**
 * ids out. The `bench`-phase export named by `thetis.bench.adapter`. The kernel replaces `harness` rather
 * than merging it, so an adapter must spread what is already there:
 *   `{ harness: { ...ctx.harness, "@thetis/bench": { ...prev, claims: { ...prev.claims, [self]: claim } } } }`
 */
export type BenchAdapter = (ctx: PackageStepContext) => Promise<StepResult>;

/**
 * `thetis.bench`. Opting in is `suites`; everything else is what a suite needs to run this package. Both
 * `importer` and `adapter` must also appear in `thetis.steps` with `phase: "bench"` — that is how they are
 * called, and it is why they cannot run outside a bench: no production config lists that phase.
 */
export type BenchDecl = z.infer<typeof schemas.BenchDeclSchema>;
