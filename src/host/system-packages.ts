// What the shipped and promoted directories hold that the kernel will not offer. Those directories are the
// installation's own, resolved by @thetis name alone; a package under any other name there was published to
// the wrong registry, and a manifest that does not validate there is one nobody can install. The kernel leaves
// both out of its catalog, and this says so at boot, once per package, so the mistake is seen where it is
// made rather than as an install that fails for somebody else later.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_SCOPE } from "../contracts/index.js";
import { errorMessage } from "../lib/error.js";
import { readManifest, scopeOf } from "../kernel/packages/manifest.js";

export interface SystemPackageProblem {
  dir: string;
  name?: string;
  problem: string;
}

/** Every package directory under `bases` that the catalog leaves out, and why. A directory with no `thetis` field is not a Thetis package and is not one. */
export function systemPackageProblems(bases: string[]): SystemPackageProblem[] {
  const out: SystemPackageProblem[] = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = resolve(base, entry);
      const file = resolve(dir, "package.json");
      if (!existsSync(file)) continue;
      let raw: { name?: unknown; thetis?: unknown };
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        out.push({ dir, problem: `package.json is not JSON: ${errorMessage(err)}` });
        continue;
      }
      if (raw?.thetis === undefined) continue;
      const name = typeof raw.name === "string" ? raw.name : undefined;
      try {
        readManifest(dir);
      } catch (err) {
        out.push({ dir, name, problem: `the manifest does not validate: ${errorMessage(err)}` });
        continue;
      }
      if (name && scopeOf(name) !== SYSTEM_SCOPE) out.push({ dir, name, problem: `only ${SYSTEM_SCOPE}/* packages belong here; ${name} was published to the wrong registry` });
    }
  }
  return out;
}

export function reportSystemPackages(bases: string[], log: (line: string) => void): void {
  for (const p of systemPackageProblems(bases)) log(`[packages] ERROR: ${p.dir}${p.name ? ` (${p.name})` : ""} is not offered and cannot be installed: ${p.problem}`);
}
