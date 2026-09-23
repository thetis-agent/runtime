import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest, PackageInfo, StepRef, ThetisField } from "../../contracts/index.js";
import { validateDecls } from "../../lib/config.js";
import { assert } from "../../lib/error.js";

const SCOPED_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;

export function readManifest(dir: string): Manifest {
  const raw = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest;
  return validateManifest(raw);
}

/** Structural validation of the package.json shape the kernel relies on. */
export function validateManifest(m: Manifest): Manifest {
  assert(typeof m.name === "string" && SCOPED_NAME.test(m.name), `package name must be scoped (@scope/name): ${m.name}`);
  assert(typeof m.version === "string", `${m.name}: version is required`);
  const t = m.thetis as ThetisField | undefined;
  assert(t && typeof t === "object" && typeof t.type === "string", `${m.name}: package.json needs a "thetis" field with a "type"`);
  for (const s of t.steps ?? []) {
    assert(s && typeof s.id === "string" && typeof s.phase === "string" && typeof s.export === "string", `${m.name}: each step needs id, phase, export`);
  }
  if (t.service !== undefined) assert(t.service && typeof t.service.export === "string", `${m.name}: service needs an export`);
  const f = t.forkedFrom;
  if (f !== undefined) assert(f && SCOPED_NAME.test(f.name) && typeof f.version === "string", `${m.name}: forkedFrom needs a scoped name and a version`);
  for (const tool of t.tools ?? []) {
    assert(tool && typeof tool.name === "string" && typeof tool.export === "string", `${m.name}: each tool needs name and export`);
    assert(typeof tool.description === "string", `${m.name}: tool ${tool.name} needs a description`);
  }
  if (t.config !== undefined) validateDecls(m.name, t.config);
  return m;
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
