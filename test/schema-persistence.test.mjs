import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateManifest } from "../dist/src/kernel/packages/manifest.js";
import { FileAssetStore } from "../dist/src/lib/assets.js";
import { RestartLatch } from "../dist/src/lib/restart.js";
import { SessionStore } from "../dist/src/lib/session-store.js";

test("manifest validation rejects malformed nested fields as boundary errors", () => {
  const manifest = { name: "@alice/tool", version: "1", thetis: { type: "tool" } };
  for (const raw of [null, [], { ...manifest, dependencies: [] }, { ...manifest, thetis: { type: "tool", steps: {} } }, { ...manifest, thetis: { type: "tool", tools: [{ name: "x", export: "x", description: "x", parameters: [] }] } }]) {
    assert.throws(() => validateManifest(raw), { code: "invalid" });
  }
  const extensible = { ...manifest, license: "MIT", thetis: { ...manifest.thetis, "@alice/custom": { enabled: true } } };
  assert.deepEqual(validateManifest(extensible), extensible);
  const legacyTool = validateManifest({ ...manifest, thetis: { type: "tool", tools: [{ name: "no_args", export: "run", description: "No arguments" }] } });
  assert.deepEqual(legacyTool.thetis.tools[0].parameters, {});
});

test("asset reads validate persisted metadata and its relationship to the stored bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "thetis-asset-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileAssetStore(root);
  const asset = await store.put("alice", new Uint8Array([1, 2]), { mediaType: "image/png" });
  const metadata = join(root, Buffer.from("alice").toString("base64url"), asset.id, "metadata.json");
  for (const value of [{ ...asset, size: "2" }, { ...asset, size: 3 }, { ...asset, id: "a_" + "0".repeat(32) }, { ...asset, mediaType: null }]) {
    await writeFile(metadata, JSON.stringify(value));
    await assert.rejects(store.read("alice", asset.id), { code: "invalid" });
  }
});

test("restart configuration rejects values whose truthiness would enable a disabled restart", () => {
  for (const config of [{ allowRestart: "false" }, { pollMs: 0 }, { quietWaitMs: -1 }]) {
    const latch = new RestartLatch({ config, inFlight: () => [] });
    assert.throws(() => latch.status(), { code: "invalid" });
    latch.close();
  }
});

test("session loads and indexes reject malformed persisted records before trusting them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "thetis-session-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { id: "s_aaaa", user: "alice", createdAt: "now", updatedAt: "now", turns: "1", conversation: [], harness: {} };
  await writeFile(join(root, "s_aaaa.json"), JSON.stringify(record));
  assert.throws(() => new SessionStore(/^s_[a-f0-9]+$/).load(root, record.id), { code: "invalid" });
  assert.throws(() => new SessionStore(/^s_[a-f0-9]+$/).summaries(root), { code: "invalid" });
  await writeFile(join(root, "index.json"), JSON.stringify({ [record.id]: { ...record, turns: 1, first: [], last: "" } }));
  assert.throws(() => new SessionStore(/^s_[a-f0-9]+$/).summaries(root), { code: "invalid" });
});

test("session and asset validation preserve extension metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "thetis-extension-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new SessionStore(/^s_[a-f0-9]+$/);
  const record = { id: "s_aaaa", user: "alice", createdAt: "now", updatedAt: "now", turns: 1, conversation: [], harness: {}, future: { enabled: true } };
  sessions.save(root, record);
  assert.deepEqual(sessions.load(root, record.id).future, record.future);
  const assets = new FileAssetStore(join(root, "assets"));
  const asset = await assets.put("alice", new Uint8Array([1]), { mediaType: "image/png", future: { width: 1 } });
  assert.deepEqual((await assets.read("alice", asset.id)).asset.future, { width: 1 });
});
