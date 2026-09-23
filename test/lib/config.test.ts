import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThetisField } from "../../src/contracts/index.js";
import {
  EnvFile,
  LayeredConfig,
  changedPackages,
  checkValue,
  defaultsOf,
  describe,
  findRefs,
  forkChain,
  isSecretKey,
  mergeDocs,
  mergedDecls,
  parseDotEnv,
  resolveRefs,
  validateDecls,
} from "../../src/lib/config.js";
import type { ConfigDoc, ConfigLink } from "../../src/lib/config.js";
import { memoryStore } from "../../src/lib/store.js";

const invalid = (err: unknown) => (err as { code?: string }).code === "invalid";

test("config declarations: the five types pass, and a bad one is refused with the key named", () => {
  const decls = validateDecls("@x/p", {
    apiKey: { type: "string", secret: true, required: true, help: "The key." },
    n: { type: "number", default: 3 },
    on: { type: "boolean", default: false, scope: "system" },
    obj: { type: "object", default: { a: 1 } },
    list: { type: "array", default: [] },
  });
  assert.deepEqual(Object.keys(decls), ["apiKey", "n", "on", "obj", "list"]);
  assert.deepEqual(decls.on, { type: "boolean", default: false, scope: "system" });
  assert.deepEqual(validateDecls("@x/p", {}), {});
  assert.throws(() => validateDecls("@x/p", { n: { type: "integer" } }), (err: Error) => invalid(err) && /@x\/p: thetis\.config\.n: type/.test(err.message), "a bad type");
  assert.throws(() => validateDecls("@x/p", { n: { type: "number", scope: "global" } }), /thetis\.config\.n: scope/, "a bad scope");
  assert.throws(() => validateDecls("@x/p", { n: { type: "number", default: "3" } }), /thetis\.config\.n: default n is declared number; a string was given/, "a default of the wrong type");
  assert.throws(() => validateDecls("@x/p", { n: { type: "number", requried: true } }), /thetis\.config\.n: unknown field requried/, "a typo in a field");
  assert.throws(() => validateDecls("@x/p", { "bad key": { type: "string" } }), /bare identifier/);
  assert.throws(() => validateDecls("@x/p", [{ type: "string" }]), /must be an object/);
});

const FORKS: Record<string, ThetisField> = {
  "@thetis/x": { type: "tool", config: { apiKey: { type: "string", secret: true }, n: { type: "number", default: 1 } } },
  "@alice/x": { type: "tool", forkedFrom: { name: "@thetis/x", version: "1.0.0" }, config: { n: { type: "number", default: 2 }, extra: { type: "string" } } },
  "@bob/x": { type: "tool", forkedFrom: { name: "@alice/x", version: "1.0.0" } },
  loopA: { type: "tool", forkedFrom: { name: "loopB", version: "1" } },
  loopB: { type: "tool", forkedFrom: { name: "loopA", version: "1" } },
};
const thetisOf = (name: string) => FORKS[name];

test("fork chain: origin first, the package itself last; a cycle and the limit both stop it", () => {
  assert.deepEqual(forkChain("@bob/x", thetisOf).map((l) => l.name), ["@thetis/x", "@alice/x", "@bob/x"]);
  assert.deepEqual(forkChain("@thetis/x", thetisOf).map((l) => l.name), ["@thetis/x"]);
  assert.deepEqual(forkChain("@bob/x", thetisOf)[2].decls, {}, "a link without declarations has none");
  assert.deepEqual(forkChain("nowhere", thetisOf).map((l) => l.name), ["nowhere"], "an unknown package is still a link, so its documents are read");
  assert.deepEqual(forkChain("loopA", thetisOf).map((l) => l.name), ["loopB", "loopA"]);
  assert.deepEqual(forkChain("@bob/x", thetisOf, 2).map((l) => l.name), ["@alice/x", "@bob/x"]);
  const merged = mergedDecls(forkChain("@bob/x", thetisOf));
  assert.deepEqual(merged, { apiKey: { type: "string", secret: true }, n: { type: "number", default: 2 }, extra: { type: "string" } });
  assert.deepEqual(defaultsOf(merged), { n: 2 });
  assert.equal(isSecretKey(merged, "apiKey"), true);
  assert.equal(isSecretKey(merged, "n"), false);
  assert.equal(isSecretKey(merged, "notionToken"), true, "an undeclared key is a secret by name");
  assert.equal(isSecretKey(merged, "colour"), false);
});

test("merging documents: later wins, so a person's override on the origin beats the file's entry on the fork", () => {
  const docs: ConfigDoc[] = [
    { layer: "default", from: "O", doc: { a: "default-O", b: "default-O" } },
    { layer: "file", from: "O", doc: { a: "file-O" } },
    { layer: "file", from: "F", doc: { a: "file-F", c: "file-F" } },
    { layer: "user", from: "O", doc: { a: "user-O" } },
  ];
  const { values, sources } = mergeDocs(docs);
  assert.deepEqual(values, { a: "user-O", b: "default-O", c: "file-F" });
  assert.deepEqual(sources.a, { layer: "user", from: "O" });
  assert.deepEqual(sources.c, { layer: "file", from: "F" });
  assert.deepEqual(mergeDocs(docs.slice(0, 3)).values.a, "file-F", "a fork's file entry beats the origin's");
});

test("merging documents: an object under a key is laid over the earlier layer's, one level deep; arrays and scalars replace", () => {
  const docs: ConfigDoc[] = [
    { layer: "default", from: "P", doc: { embeddings: { apiKey: "${KEY}", model: "m", nested: { a: 1 } }, list: [1, 2], n: 1 } },
    { layer: "file", from: "P", doc: { embeddings: { baseUrl: "http://x", nested: { b: 2 } }, list: [3], n: 2 } },
  ];
  const { values, sources } = mergeDocs(docs);
  assert.deepEqual(values.embeddings, { apiKey: "${KEY}", model: "m", baseUrl: "http://x", nested: { b: 2 } }, "a declared secret survives a file entry beside it; the level below replaces");
  assert.deepEqual(values.list, [3]);
  assert.equal(values.n, 2);
  assert.deepEqual(sources.embeddings, { layer: "file", from: "P" }, "the source is the last layer that touched the key");
  assert.deepEqual(mergeDocs([docs[0], { layer: "user", from: "P", doc: { embeddings: "off" } }]).values.embeddings, "off", "a scalar over an object replaces it");
  assert.deepEqual(mergeDocs([{ layer: "user", from: "P", doc: { embeddings: "off" } }, docs[1]]).values.embeddings, { baseUrl: "http://x", nested: { b: 2 } }, "an object over a scalar replaces it");
  assert.deepEqual(docs[0].doc.embeddings, { apiKey: "${KEY}", model: "m", nested: { a: 1 } }, "the documents themselves are untouched");
});

test("references: found anywhere, resolved from the environment, and dropped rather than emptied when unresolved", () => {
  const value = { embeddings: { apiKey: "${OPENROUTER_API_KEY}", model: "m", dims: 3 }, baseUrl: "${BASE}/v1", list: ["${BASE}", "${GONE}"], plain: true };
  assert.deepEqual(findRefs(value), ["OPENROUTER_API_KEY", "BASE", "GONE"]);
  assert.deepEqual(findRefs("a ${X} and ${X} and ${Y}"), ["X", "Y"]);
  const { value: resolved, missing } = resolveRefs(value, { BASE: "http://x" });
  assert.deepEqual(resolved, { embeddings: { model: "m", dims: 3 }, baseUrl: "http://x/v1", list: ["http://x"], plain: true });
  assert.deepEqual(missing, { embeddings: ["OPENROUTER_API_KEY"], list: ["GONE"] });
  assert.ok(!JSON.stringify(resolved).includes('""'), "nothing became an empty string");
  assert.deepEqual(resolveRefs(value, { BASE: "b", OPENROUTER_API_KEY: "k", GONE: "g" }).missing, {});
  assert.deepEqual(resolveRefs({ a: "${X}" }, { X: "" }), { value: { a: "" }, missing: {} }, "a variable set to empty is set");
});

const CHAIN: ConfigLink[] = [
  {
    name: "@thetis/p",
    decls: {
      apiKey: { type: "string", secret: true, required: true, help: "The key." },
      token: { type: "string", secret: true },
      baseUrl: { type: "string", default: "https://d" },
      count: { type: "number", required: true, scope: "system" },
      url: { type: "string" },
      embeddings: { type: "object" },
    },
  },
  { name: "@alice/p", decls: {} },
];

test("describe: every state, where a value came from, and what a secret shows", () => {
  const docs: ConfigDoc[] = [
    { layer: "default", from: "@thetis/p", doc: { baseUrl: "https://d" } },
    { layer: "system", from: "@thetis/p", doc: { apiKey: "literal-secret", url: "${BASE}/v1" } },
    { layer: "user", from: "@alice/p", doc: { token: "${NOTION_TOKEN}", extra: 1, otherToken: "plain" } },
  ];
  const r = describe("@alice/p", CHAIN, docs, { NOTION_TOKEN: "t" }, "alice");
  assert.equal(r.package, "@alice/p");
  assert.equal(r.user, "alice");
  assert.deepEqual(r.inherits, ["@thetis/p"]);
  const by = Object.fromEntries(r.keys.map((k) => [k.key, k]));
  assert.deepEqual(by.apiKey, { key: "apiKey", state: "set", secret: true, declared: true, type: "string", required: true, help: "The key.", source: "system", inheritedFrom: "@thetis/p", redacted: true });
  assert.ok(!("value" in by.apiKey), "a secret literal is never shown");
  assert.deepEqual(by.token, { key: "token", state: "set", secret: true, declared: true, type: "string", source: "user", value: "${NOTION_TOKEN}" });
  assert.deepEqual(by.baseUrl, { key: "baseUrl", state: "set", secret: false, declared: true, type: "string", source: "default", inheritedFrom: "@thetis/p", value: "https://d" });
  assert.deepEqual(by.count, { key: "count", state: "missing", secret: false, declared: true, type: "number", required: true, scope: "system" });
  assert.deepEqual(by.url, { key: "url", state: "missing", secret: false, declared: true, type: "string", source: "system", inheritedFrom: "@thetis/p", missing: ["BASE"], value: "${BASE}/v1" });
  assert.deepEqual(by.embeddings, { key: "embeddings", state: "unset", secret: false, declared: true, type: "object" });
  assert.deepEqual(by.extra, { key: "extra", state: "set", secret: false, declared: false, source: "user", value: 1 });
  assert.deepEqual(by.otherToken, { key: "otherToken", state: "set", secret: true, declared: false, source: "user", redacted: true }, "an undeclared key is a secret by name");
  assert.equal(r.summary, "count is required and not set; url: BASE is not in the environment");
  assert.equal(r.broken, true);

  const ok = describe("@thetis/p", CHAIN.slice(0, 1), [
    { layer: "default", from: "@thetis/p", doc: { baseUrl: "https://d" } },
    { layer: "file", from: "@thetis/p", doc: { apiKey: "${K}", count: 2 } },
  ], { K: "k" });
  assert.equal(ok.summary, "every key is set");
  assert.equal(ok.broken, false);
  assert.equal(ok.user, undefined);
  assert.deepEqual(ok.inherits, []);
  assert.equal(ok.keys.find((k) => k.key === "apiKey")?.value, "${K}", "a pure reference is shown as the reference");
  assert.equal(ok.keys.find((k) => k.key === "apiKey")?.source, "file");
});

test("describe: a secret inside a non-secret object is hidden at any depth, and the key says so", () => {
  const docs: ConfigDoc[] = [
    { layer: "file", from: "@thetis/p", doc: { embeddings: { apiKey: "sk-literal", model: "m", nested: { token: "${T}" }, headers: [{ password: "p", name: "n" }] } } },
    { layer: "file", from: "@thetis/p", doc: { url: "https://x", headers: { Authorization: "Bearer x" } } },
  ];
  const r = describe("@thetis/p", CHAIN.slice(0, 1), docs, { T: "t" });
  const by = Object.fromEntries(r.keys.map((k) => [k.key, k]));
  assert.deepEqual(by.embeddings.value, { apiKey: "•••", model: "m", nested: { token: "${T}" }, headers: [{ password: "•••", name: "n" }] });
  assert.equal(by.embeddings.redacted, true);
  assert.equal(by.embeddings.state, "set");
  assert.equal(by.url.redacted, undefined, "nothing hidden, nothing claimed");
  assert.deepEqual(by.headers.value, { Authorization: "Bearer x" }, "only a secret-looking name is hidden");
});

test("check value: null is refused, a declared type must match, and a reference is a string", () => {
  const decls = mergedDecls(CHAIN);
  assert.throws(() => checkValue(decls, "url", null), invalid);
  assert.throws(() => checkValue(decls, "url", undefined), invalid);
  assert.throws(() => checkValue(decls, "url", 3), /url is declared string; a number was given/);
  assert.throws(() => checkValue(decls, "count", "${N}"), /count is declared number; a string was given/);
  assert.throws(() => checkValue(decls, "embeddings", [1]), /declared object; an array/);
  assert.throws(() => checkValue(decls, "embeddings", { apiKey: null }), /embeddings\.apiKey is null/);
  assert.throws(() => checkValue(decls, "undeclared", { a: [null] }), invalid, "an undeclared value holds no null either");
  assert.doesNotThrow(() => checkValue(decls, "url", "${BASE}/v1"));
  assert.doesNotThrow(() => checkValue(decls, "count", 3));
  assert.doesNotThrow(() => checkValue(decls, "embeddings", { apiKey: "${K}" }));
  assert.doesNotThrow(() => checkValue(decls, "undeclared", ["anything", { goes: true }]));
});

test("dot env: quotes stripped, comments and blank lines ignored, the first line naming a variable wins", () => {
  const parsed = parseDotEnv('# a comment\n\nA=1\nB="quoted"\nC=\'single\'\nD = spaced\nexport E=1\nA=2\nnot a line\n');
  assert.deepEqual(parsed, { A: "1", B: "quoted", C: "single", D: "spaced" });
  assert.deepEqual(parseDotEnv(""), {});
});

test("env file: names that came from the file follow it; a shell override does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "A=from-file\nB=file-b\n");
    // A came into the process from the file; B was set by the shell to something else; C is only the shell's.
    const base = { A: "from-file", B: "shell-b", C: "shell-c" };
    const env = new EnvFile(file, base);
    assert.deepEqual(env.snapshot(), { A: "from-file", B: "shell-b", C: "shell-c" });
    // Each forced mtime is a later whole second than the last, whatever the clock did in between.
    let t = Math.floor(Date.now() / 1000) + 10;
    const later = (): void => {
      t += 5;
      utimesSync(file, t, t);
    };
    writeFileSync(file, "A=changed\nB=file-b2\nD=new\n");
    later();
    assert.deepEqual(env.snapshot(), { A: "changed", B: "shell-b", C: "shell-c", D: "new" }, "A follows the file, B keeps the shell, D is new and only the file's");
    writeFileSync(file, "D=new\n");
    later();
    assert.deepEqual(env.snapshot(), { B: "shell-b", C: "shell-c", D: "new" }, "a name gone from the file is gone");
    const none = new EnvFile(join(dir, "missing.env"), base);
    assert.deepEqual(none.snapshot(), base, "no file is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed packages: names whose configuration differs on either side, ignoring key order", () => {
  const before = { a: { x: 1, y: 2 }, b: { y: 1 }, same: { k: [1, { z: 1 }] } };
  const after = { a: { x: 2, y: 2 }, c: {}, same: { k: [1, { z: 1 }] } };
  assert.deepEqual(changedPackages(before, after).sort(), ["a", "b", "c"]);
  assert.deepEqual(changedPackages({ p: { a: 1, b: 2 } }, { p: { b: 2, a: 1 } }), []);
  assert.deepEqual(changedPackages({}, {}), []);
});

const TWO: ConfigLink[] = [
  { name: "@thetis/n", decls: { a: { type: "string", default: "dA" } } },
  { name: "@alice/n", decls: { b: { type: "string", default: "dB" } } },
];

test("layered config: a secret lands in the private namespace, and the layers come out layer-major along the chain", async () => {
  const driver = memoryStore();
  const file: Record<string, Record<string, unknown>> = { "@thetis/n": { f: 1 }, "@alice/n": { f: 2 } };
  const cfg = new LayeredConfig(driver, () => file);
  await cfg.write("alice", "@alice/n", "apiKey", "sk", true);
  await cfg.write("alice", "@alice/n", "plain", "p", false);
  assert.deepEqual(await driver.open("secrets/users/alice").get("@alice/n"), { apiKey: "sk" });
  assert.deepEqual(await driver.open("config/users/alice").get("@alice/n"), { plain: "p" });
  await cfg.write(undefined, "@thetis/n", "s", "system-origin", false);
  await cfg.write(undefined, "@thetis/n", "sk", "system-secret", true);
  await cfg.write(undefined, "@alice/n", "s", "system-fork", false);
  await cfg.write("alice", "@thetis/n", "u", "user-origin", false);
  const docs = await cfg.docs(TWO, "alice");
  assert.deepEqual(docs.map((d) => [d.layer, d.from]), [
    ["default", "@thetis/n"], ["default", "@alice/n"],
    ["file", "@thetis/n"], ["file", "@alice/n"],
    ["system", "@thetis/n"], ["system", "@thetis/n"], ["system", "@alice/n"],
    ["user", "@thetis/n"], ["user", "@alice/n"], ["user", "@alice/n"],
  ]);
  assert.deepEqual(docs[4].doc, { s: "system-origin" });
  assert.deepEqual(docs[5].doc, { sk: "system-secret" }, "the secrets document follows the config document of its layer");
  assert.deepEqual(mergeDocs(docs).values, { a: "dA", b: "dB", f: 2, s: "system-fork", sk: "system-secret", u: "user-origin", plain: "p", apiKey: "sk" });
  const system = await cfg.docs(TWO);
  assert.ok(system.every((d) => d.layer !== "user"), "without a user there is no user layer");
  assert.deepEqual(system.map((d) => d.from).slice(0, 2), ["@thetis/n", "@alice/n"], "an empty default document is left out");
  // A key moves when its secrecy changes, so it lives in one document.
  await cfg.write("alice", "@alice/n", "plain", "now-secret", true);
  assert.deepEqual(await driver.open("config/users/alice").get("@alice/n"), undefined);
  assert.deepEqual(await driver.open("secrets/users/alice").get("@alice/n"), { apiKey: "sk", plain: "now-secret" });
});

test("layered config: remove, forget and copy touch both documents; invalidate sees a write made behind its back", async () => {
  const driver = memoryStore();
  const cfg = new LayeredConfig(driver, () => ({}));
  const one: ConfigLink[] = [{ name: "@x/p", decls: {} }];
  await cfg.write("alice", "@x/p", "a", 1, false);
  await cfg.write("alice", "@x/p", "k", "s", true);
  assert.equal(await cfg.remove("alice", "@x/p", "a"), true);
  assert.equal(await cfg.remove("alice", "@x/p", "a"), false);
  assert.equal(await cfg.remove("alice", "@x/p", "k"), true);
  assert.deepEqual(await driver.open("config/users/alice").list(), [], "an emptied document is deleted");
  assert.deepEqual(await driver.open("secrets/users/alice").list(), []);
  assert.deepEqual(await cfg.docs(one, "alice"), []);

  await cfg.write("alice", "@x/p", "a", 1, false);
  await cfg.write("alice", "@x/p", "k", "s", true);
  await cfg.write("alice", "@x/q", "a", 2, false);
  await cfg.forgetPackage("alice", "@x/p");
  assert.deepEqual(await driver.open("config/users/alice").list(), ["@x/q"]);
  assert.deepEqual(await driver.open("secrets/users/alice").list(), []);
  assert.deepEqual(await cfg.docs(one, "alice"), []);
  await cfg.write("alice", "@x/p", "k", "s", true);
  await cfg.forgetUser("alice");
  assert.deepEqual(await driver.open("config/users/alice").list(), []);
  assert.deepEqual(await driver.open("secrets/users/alice").list(), []);
  assert.deepEqual(await cfg.docs([{ name: "@x/q", decls: {} }], "alice"), []);

  await cfg.write(undefined, "@x/p", "a", 1, false);
  await cfg.write(undefined, "@x/p", "k", "s", true);
  await cfg.copySystem("@x/p", "@thetis/p");
  assert.deepEqual(await driver.open("config/system").get("@thetis/p"), { a: 1 });
  assert.deepEqual(await driver.open("secrets/system").get("@thetis/p"), { k: "s" });
  assert.deepEqual((await cfg.docs([{ name: "@thetis/p", decls: {} }])).map((d) => d.doc), [{ a: 1 }, { k: "s" }]);

  const r: ConfigLink[] = [{ name: "@x/r", decls: {} }];
  assert.deepEqual(await cfg.docs(r), [], "absence is cached too");
  await driver.open("config/system").set("@x/r", { z: 1 });
  assert.deepEqual(await cfg.docs(r), [], "a write made behind the cache is not seen");
  cfg.invalidate();
  assert.deepEqual(await cfg.docs(r), [{ layer: "system", from: "@x/r", doc: { z: 1 } }]);
});
