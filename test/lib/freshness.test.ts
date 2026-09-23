import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestMtime } from "../../src/lib/freshness.js";

/** Writes a file, its parents, and an exact mtime, so an assertion can name the number it expects. */
function file(path: string, mtimeMs: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const when = new Date(mtimeMs);
  utimesSync(path, when, when);
}

const OLD = 1_000_000_000_000;
const NEW = 1_000_000_200_000;
const FUTURE = 2_000_000_000_000;

test("freshness: the newest file wins, dependencies and compiled tests are skipped, a missing directory is not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "thetis-fresh-"));
  try {
    const code = join(root, "code");
    file(join(code, "dist", "src", "a.js"), OLD);
    file(join(code, "dist", "src", "deep", "b.js"), NEW);
    file(join(code, "node_modules", "dep", "index.js"), FUTURE);
    file(join(code, ".git", "index"), FUTURE);
    file(join(code, "dist", "test", "a.test.js"), FUTURE);
    assert.equal(newestMtime([code]), NEW);
    assert.equal(newestMtime([join(root, "not-there")]), 0);
    assert.equal(newestMtime([code, join(root, "not-there")]), NEW, "a missing directory is skipped, not fatal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freshness: an answer is cached for a few seconds, so a polling page does not re-walk the tree", () => {
  const root = mkdtempSync(join(tmpdir(), "thetis-fresh-"));
  try {
    const one = join(root, "one");
    const two = join(root, "two");
    file(join(one, "a.js"), OLD);
    mkdirSync(two, { recursive: true });
    assert.equal(newestMtime([one]), OLD);
    file(join(one, "a.js"), NEW);
    assert.equal(newestMtime([one]), OLD, "within the window the same directory set gives the same answer");
    assert.equal(newestMtime([one, two]), NEW, "a different set is a different key, and it walks and sees the change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
