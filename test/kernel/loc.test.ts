// The kernel must stay small, and from here on it only shrinks. The guard counts lines of code, not
// imports, re-exports, blank lines, comment-only lines, or tests. Mechanism belongs in @thetis/runtime/lib and
// @thetis/sandbox; behaviour belongs in packages.
//
// The limit ratchets: it is set a little above the count on the day the kernel was declared finished
// (1,332 on 2026-09-22, after the model-call loop moved to @thetis/harness-core and the mounts and ssh
// features moved to @thetis/host-grants), and it moves down, never up. A change that needs more room is
// a feature in the wrong package: see src/kernel/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/kernel");
const LIMIT = 1350;

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
