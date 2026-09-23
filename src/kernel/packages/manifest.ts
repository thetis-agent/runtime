import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Manifest, PackageInfo, StepRef } from "../../contracts/index.js";
import { ManifestSchema } from "../../contracts/schemas/packages.js";
import { validateDecls } from "../../lib/config.js";
import { parseSchema } from "../../lib/validation.js";

const ManifestConfigSchema = z.looseObject({ name: z.string(), thetis: z.looseObject({ config: z.unknown().optional() }) });

export function readManifest(dir: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  return validateManifest(raw);
}

/** Structural validation of the package.json shape the kernel relies on. */
export function validateManifest(raw: unknown): Manifest {
  const config = ManifestConfigSchema.safeParse(raw);
  if (config.success && config.data.thetis.config !== undefined) validateDecls(config.data.name, config.data.thetis.config);
  return parseSchema(ManifestSchema, raw, "package.json");
}

export function scopeOf(name: string): string {
  return name.split("/")[0];
}

export function toInfo(m: Manifest, root: string): PackageInfo {
  const description = typeof m.description === "string" ? m.description.trim() : "";
  const info: PackageInfo = { name: m.name, version: m.version, type: m.thetis.type, description, root, thetis: m.thetis };
  return m.thetis.forkedFrom ? { ...info, forkedFrom: m.thetis.forkedFrom } : info;
}

/** True when the package declares the export this step reference points at. */
export function declaresStep(pkg: PackageInfo, ref: StepRef): boolean {
  return (pkg.thetis.steps ?? []).some((s) => s.export === ref.export);
}
