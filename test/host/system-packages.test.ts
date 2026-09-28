// The boot report of what the shipped and promoted directories hold that the catalog leaves out, and the
// shipped tree of this checkout held to its own registry rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSystemPackages, systemPackageProblems } from "../../src/host/system-packages.js";
import { parseRegistryRules, registryRefusal, REGISTRY_RULES_FILE } from "../../src/lib/registry-rules.js";

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages");

function pkg(base: string, dir: string, manifest: unknown): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(base, dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

test("a package under another scope, a manifest that does not validate and unreadable JSON are each named; a plain workspace package is not", () => {
  const base = mkdtempSync(join(tmpdir(), "thetis-system-"));
  try {
    pkg(base, "good", { name: "@thetis/good", version: "1.0.0", thetis: { type: "tool" } });
    pkg(base, "stray", { name: "@bitmuse/gcloud", version: "0.1.0", thetis: { type: "tool" } });
    pkg(base, "broken", { name: "@thetis/broken", version: "1.0.0", thetis: { type: 7 } });
    pkg(base, "garbled", "{ not json");
    pkg(base, "bench", { name: "@thetis/bench", version: "1.0.0" });
    const problems = systemPackageProblems([base, join(base, "missing")]);
    assert.deepEqual(problems.map((p) => [p.dir.slice(base.length + 1), p.name]).sort(), [["broken", "@thetis/broken"], ["garbled", undefined], ["stray", "@bitmuse/gcloud"]]);
    assert.match(problems.find((p) => p.name === "@bitmuse/gcloud")!.problem, /only @thetis\/\* packages belong here/);
    const lines: string[] = [];
    reportSystemPackages([base], (l) => lines.push(l));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.startsWith("[packages] ERROR: ")), "loud: each one an error line of its own");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a registry's rules: a scope list, no file, and a file that is not a rule", () => {
  const rules = parseRegistryRules('{ "scopes": ["@thetis"] }');
  assert.equal(registryRefusal(rules, "@thetis/exa"), undefined);
  assert.match(registryRefusal(rules, "@bitmuse/gcloud") ?? "", /@bitmuse\/gcloud is not in @thetis, the only scope this registry accepts/);
  assert.match(registryRefusal(rules, "unscoped") ?? "", /not in @thetis/);
  assert.deepEqual(parseRegistryRules(undefined), {}, "no file, no rule");
  assert.equal(registryRefusal({}, "@anyone/anything"), undefined);
  assert.throws(() => parseRegistryRules("{"), /is not JSON/);
  assert.throws(() => parseRegistryRules("[]"), /is not an object/);
  assert.throws(() => parseRegistryRules('{ "scopes": "@thetis" }'), /not a list of scopes/);
  assert.throws(() => parseRegistryRules('{ "scopes": ["thetis"] }'), /not a list of scopes/);
});

test("the shipped tree accepts only @thetis, and holds nothing its own rule refuses", () => {
  const rules = parseRegistryRules(readFileSync(join(PACKAGES, REGISTRY_RULES_FILE), "utf8"));
  assert.deepEqual(rules.scopes, ["@thetis"], "the tree every installation ships is the installation's namespace and no other");
  const problems = systemPackageProblems([PACKAGES]);
  assert.deepEqual(problems.map((p) => `${p.name ?? p.dir}: ${p.problem}`), [], "every package here is installable by name, which is what shipping it promises");
});
