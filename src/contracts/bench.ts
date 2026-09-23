// What a package declares to be benchmarked, and what it reports while it is. The bench never reads a
// package's own data: it ships a neutral corpus every mechanism imports into its own shape, and scores
// only what the harness assembled. Two seams, both optional, both inert outside a bench run.
import type { PackageStepContext } from "./guest.js";
import type { StepResult } from "./pipeline.js";

/** How far a capability is from the model right now. `direct` costs no round trip; the others cost one. */
export type Reachability = "direct" | "catalogue" | "search";

/**
 * One capability in the neutral corpus. Mechanism-free by construction: a retriever, a catalogue and an
 * inject-everything loader all hold the same records and differ only in what they do with them.
 */
export interface CapabilityRecord {
  /** Stable and corpus-owned. Gold sets and adapter claims both name capabilities by this. */
  id: string;
  name: string;
  /** At most 1,024 bytes. The conformance test enforces it. */
  description: string;
  /** The full text a mechanism may inject. Contains `canary` verbatim. */
  body: string;
  tags: string[];
  /**
   * An opaque token inside `body`. A mechanism may reformat a body however it likes and must keep this
   * exactly. It is how the bench verifies what reached the prompt without knowing the mechanism.
   */
  canary: string;
}

export interface Corpus {
  /** `caps@1`. Part of a report's identity: two reports on different corpora are not comparable. */
  id: string;
  version: string;
  /** Over the canonical records and the canary salt, so a re-salted corpus is a new corpus. */
  sha256: string;
  records: CapabilityRecord[];
}

/** What an importer did with the corpus. Reported for the record; never scored. */
export interface ImportRecord {
  imported: number;
  /** Free text, for example `3-level cache: 1 index + 12 cards + 120 bodies`. */
  representation: string;
  bytesOnDisk?: number;
  builtMs?: number;
}

/**
 * A package's own account of what it surfaced for the turn's call. Claims are cross-checked against the
 * canaries the provider found: a claim with no canary behind it is `adapterLies`, which fails the run.
 * `ranked` has no verifiable counterpart, so it is reported under its own arm and never compared across
 * mechanisms.
 */
export interface BenchClaim {
  package: string;
  /** Which of `thetis.bench.arms` is active, when the package has more than one configuration. */
  arm?: string;
  direct: string[];
  offered: string[];
  reach?: Reachability;
  ranked?: string[];
  scores?: Record<string, number>;
  budgetBytes?: number;
  droppedForBudget?: string[];
}

/** What a bench turn collects in `harness["@thetis/bench"]`, keyed by package name. */
export interface BenchHarness {
  claims?: Record<string, BenchClaim>;
  imports?: Record<string, ImportRecord>;
}

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
export interface BenchDecl {
  suites: string[];
  corpus?: string;
  /** Which packages this one is compared against. Defaults to the first suite id. */
  peerGroup?: string;
  importer?: string;
  adapter?: string;
  arms?: string[];
  /** Per arm in `arms`, the configuration of this package under which that arm runs. An arm without an entry runs on the defaults. */
  armConfig?: Record<string, Record<string, unknown>>;
  /** Where the generated view goes inside the package. Default `bench`. */
  report?: string;
}
