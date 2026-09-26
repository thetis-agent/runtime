// Kernel authority stays small. The structured-content API revision adds scoped asset grants
// and complete/askText; modality conversion and binary file mechanics remain outside the kernel.
// New authority requires an explicit contract revision and review of this budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/kernel");
// 2026-09-25: the reload guard and the kept partial turn added the lines past 1420; authority over a running turn is the kernel's.
// 2026-09-26: person-scoped operator and host calls (self exports, own password, own journal); authority over who may act on whom is the kernel's.
const LIMIT = 1458;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

export function countLoc(file: string): number {
  let count = 0;
  let inImport = false;
  let inBlock = false;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*")) continue;
    if (inImport) {
      if (/from\s+["'][^"']+["'];?$/.test(line) || line.endsWith(";")) inImport = false;
      continue;
    }
    if (/^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|export\s+\{)/.test(line)) {
      if (!(/from\s+["'][^"']+["'];?$/.test(line) || /^import\s+["'][^"']+["'];?$/.test(line))) inImport = true;
      continue;
    }
    count++;
  }
  return count;
}

test(`kernel source is under ${LIMIT} lines of code`, () => {
  const files = walk(SRC);
  const perFile = files.map((f) => [f.slice(SRC.length + 1), countLoc(f)] as const);
  const total = perFile.reduce((n, [, c]) => n + c, 0);
  const report = perFile.map(([f, c]) => `${String(c).padStart(5)}  ${f}`).join("\n");
  assert.ok(files.length > 5, "expected kernel sources");
  assert.ok(total < LIMIT, `kernel is ${total} lines of code (limit ${LIMIT}):\n${report}`);
  console.error(`kernel LOC: ${total} / ${LIMIT}\n${report}`);
});
