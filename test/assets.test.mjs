import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssetAccess } from "../dist/src/kernel/assets.js";
import { FileAssetStore, decodeUpload } from "../dist/src/lib/assets.js";
import { assetPart } from "../dist/src/lib/content.js";

test("assets isolate owners and limit provider grants to one call's references", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "thetis-assets-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const assets = new AssetAccess(new FileAssetStore(home));
  const upload = { mediaType: "image/png", name: "image.png", data: Buffer.from([0, 255, 42]).toString("base64") };
  const a = await assets.put("alice", upload);
  const hidden = await assets.put("alice", upload);
  const b = await assets.put("bob", upload);
  assert.equal((await assets.read("alice", a.id)).data, upload.data);
  await assert.rejects(assets.read("bob", a.id), { code: "not-found" });
  await assert.rejects(assets.read("alice", "../escape"), { code: "invalid" });
  const message = { role: "user", content: [assetPart(a.id, a.mediaType)] };
  let expired;
  let generated;
  await assets.during("alice", "_system", [message], async (grant) => {
    expired = grant;
    assert.equal((await assets.read("_system", a.id, grant)).data, upload.data);
    await assert.rejects(assets.read("bob", a.id, grant), { code: "unauthorized" });
    await assert.rejects(assets.read("_system", hidden.id, grant), { code: "unauthorized" });
    await assert.rejects(assets.read("_system", b.id, grant), { code: "unauthorized" });
    generated = await assets.put("_system", upload, grant);
    assert.equal((await assets.read("_system", generated.id, grant)).asset.id, generated.id);
  });
  assert.equal((await assets.read("alice", generated.id)).asset.id, generated.id);
  await assert.rejects(assets.read("_system", a.id, expired), { code: "unauthorized" });
  await assert.rejects(assets.put("_system", upload, expired), { code: "unauthorized" });
  await assert.rejects(assets.read("_system", generated.id), { code: "not-found" });
  await assert.rejects(assets.during("alice", "_system", [{ role: "user", content: [assetPart(b.id, b.mediaType)] }], async () => assert.fail("must not grant another owner's asset")), { code: "not-found" });
  await assets.forget("alice");
  await assert.rejects(assets.read("alice", a.id), { code: "not-found" });
  assert.equal((await assets.read("bob", b.id)).asset.id, b.id);
});

test("failed provider calls revoke grants and concurrent calls do not share ownership", async () => {
  const records = new Map();
  let next = 0;
  const assets = new AssetAccess({
    async put(owner, bytes, metadata) { const asset = { id: String(++next), size: bytes.length, ...metadata }; records.set(`${owner}/${asset.id}`, { asset, bytes }); return asset; },
    async read(owner, id) { const value = records.get(`${owner}/${id}`); if (!value) throw new Error("missing"); return value; },
    async removeOwner() {},
  });
  let revoked;
  await assert.rejects(assets.during("alice", "provider", [], async (token) => { revoked = token; throw new Error("cancelled"); }), /cancelled/);
  await assert.rejects(assets.read("provider", "anything", revoked), { code: "unauthorized" });
  const upload = { mediaType: "audio/wav", data: "AA==" };
  const [a, b] = await Promise.all(["alice", "bob"].map((owner) => assets.during(owner, "provider", [], (token) => assets.put("provider", upload, token))));
  assert.equal((await assets.read("alice", a.id)).asset.id, a.id);
  assert.equal((await assets.read("bob", b.id)).asset.id, b.id);
  await assert.rejects(assets.read("bob", a.id), /missing/);
});

test("uploads validate portable metadata, base64 and size before storage", () => {
  for (const upload of [null, {}, { mediaType: "image/png", data: "garbage" }, { mediaType: "text/html\r\nX: bad", data: "" }, { mediaType: "text/plain", data: "", name: "bad\nname" }, { mediaType: "text/plain", data: "A".repeat(12 * 1024 * 1024) }]) {
    assert.throws(() => decodeUpload(upload), { code: "invalid" });
  }
});

test("deleting an owner waits for an accepted write before clearing their assets", async () => {
  let finish;
  let stored = false;
  let cleared = false;
  const assets = new AssetAccess({
    put: () => new Promise((done) => { finish = () => { stored = true; done({ id: "a", mediaType: "text/plain", size: 0 }); }; }),
    async read() { throw new Error("unused"); },
    async removeOwner() { assert.ok(stored, "an accepted write settled before deletion"); stored = false; cleared = true; },
  });
  const writing = assets.put("alice", { mediaType: "text/plain", data: "" });
  const removing = assets.forget("alice");
  await Promise.resolve();
  assert.equal(cleared, false);
  finish();
  await writing;
  await removing;
  assert.equal(stored, false);
  assert.equal(cleared, true);
});
