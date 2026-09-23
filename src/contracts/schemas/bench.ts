import { z } from "zod";

export const ReachabilitySchema = z.enum(["direct", "catalogue", "search"]);

export const CapabilityRecordSchema = z.looseObject({
  /** Stable corpus identity used by gold sets and adapter claims. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Conformance additionally limits the description to 1,024 bytes. */
  description: z.string(),
  /** The full content a mechanism may inject, containing its canary verbatim. */
  body: z.string(),
  tags: z.array(z.string()),
  /** An opaque token mechanisms must preserve exactly when reformatting the body. */
  canary: z.string().min(1),
});

export const CorpusSchema = z.looseObject({
  /** Corpus identity is part of report identity; different corpora are not comparable. */
  id: z.string().min(1),
  version: z.string().min(1),
  /** Digest includes the canary salt, so a re-salted corpus is a new corpus. */
  sha256: z.string().min(1),
  records: z.array(CapabilityRecordSchema),
});

export const ImportRecordSchema = z.looseObject({
  imported: z.number().int().nonnegative(), representation: z.string(),
  bytesOnDisk: z.number().nonnegative().optional(), builtMs: z.number().nonnegative().optional(),
});

export const BenchClaimSchema = z.looseObject({
  package: z.string().min(1), arm: z.string().optional(),
  direct: z.array(z.string()), offered: z.array(z.string()), reach: ReachabilitySchema.optional(),
  ranked: z.array(z.string()).optional(), scores: z.record(z.string(), z.number()).optional(),
  budgetBytes: z.number().nonnegative().optional(), droppedForBudget: z.array(z.string()).optional(),
});

export const BenchHarnessSchema = z.looseObject({
  claims: z.record(z.string(), BenchClaimSchema).optional(), imports: z.record(z.string(), ImportRecordSchema).optional(),
});

export const BenchDeclSchema = z.looseObject({
  suites: z.array(z.string()), corpus: z.string().optional(),
  /** Defaults to the first suite id. */
  peerGroup: z.string().optional(),
  importer: z.string().optional(), adapter: z.string().optional(), arms: z.array(z.string()).optional(),
  /** Configuration for named arms; an arm without an entry uses package defaults. */
  armConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Directory for generated views; defaults to bench. */
  report: z.string().optional(),
});
