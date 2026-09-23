import { textContent } from "@thetis/runtime/lib/content";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mount, SessionRecord, SshGrant, TurnEvent, WatchedTurnEvent } from "../../src/contracts/index.js";
import { AsyncQueue } from "../../src/lib/async.js";
import { Container, token } from "../../src/lib/container.js";
import { JsonDirStore } from "../../src/lib/json-store.js";
import { MountStore } from "../../src/lib/mounts.js";
import { findDependency, forkOf, forkPackage, forkVersion, isGitSource, isInside, keepOnly, packageDigest, packagesIn, samePackage, splitSource } from "../../src/lib/pkg-fs.js";
import { PendingCalls, callHandler } from "../../src/lib/rpc-frames.js";
import { StoreMirror, memoryStore } from "../../src/lib/store.js";
import { SessionStore, summarize } from "../../src/lib/session-store.js";
import { SshStore, knownHostsOf } from "../../src/lib/ssh.js";
import { HOME_SOCKETS, MAX_SOCKET_PATH, MAX_USER_ID, assertHomeFitsSockets, assertUserIdFitsSockets, homeSocketProblem, homeSocketWarning, longestHomeSocket, maxHomeLength, maxUserIdLength, userIdProblem } from "../../src/lib/socket-paths.js";
import { TurnTaps } from "../../src/lib/turn-taps.js";

test("container resolves lazily, caches singletons, and allows rebinding", () => {
  const A = token<{ n: number }>("A");
  const B = token<{ a: { n: number } }>("B");
  let built = 0;
  const c = new Container().bind(A, () => ({ n: ++built })).bind(B, (c) => ({ a: c.get(A) }));
  assert.equal(built, 0);
  assert.equal(c.get(B).a, c.get(A));
  assert.equal(built, 1);
  c.bind(A, () => ({ n: 42 }));
  assert.equal(c.get(A).n, 42);
  assert.throws(() => c.get(token("missing")), /No binding/);
});

test("async queue delivers pushed items in order and ends on close", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  setTimeout(() => {
    q.push(3);
    q.close();
  }, 5);
  const got: number[] = [];
  for await (const n of q) got.push(n);
  assert.deepEqual(got, [1, 2, 3]);
});

test("package sources: git urls with an optional #directory, file urls, and local paths", () => {
  assert.deepEqual(splitSource("https://x/y.git#pkgs/a"), { url: "https://x/y.git", sub: "pkgs/a" });
  assert.deepEqual(splitSource("https://x/y.git#"), { url: "https://x/y.git" });
  assert.deepEqual(splitSource("packages/hello"), { url: "packages/hello" });
  for (const src of ["https://x/y.git", "https://x/y#dir", "git@github.com:a/b.git", "file:///tank/packages#prompt-cache", "/abs/repo.git"]) assert.ok(isGitSource(src), src);
  for (const src of ["packages/hello", "@thetis/tool-exec", "./x"]) assert.ok(!isGitSource(src), src);
  assert.ok(isInside("/a/b", "/a/b/c"));
  assert.ok(!isInside("/a/b", "/a/b"));
  assert.ok(!isInside("/a/b", "/a/bc"));
  assert.ok(!isInside("/a/b", "/a"));
});

test("json directory store: ids are checked before they become paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-store-"));
  try {
    const store = new JsonDirStore<{ id: string; n: number }>(/^s_[a-f0-9]+$/);
    store.save(dir, { id: "s_01", n: 1 });
    store.save(dir, { id: "s_02", n: 2 });
    assert.equal(store.load(dir, "s_01")?.n, 1);
    assert.equal(store.load(dir, "s_03"), undefined);
    assert.throws(() => store.load(dir, "../etc/passwd"), /invalid id/);
    assert.deepEqual(store.list(dir).map((r) => r.id).sort(), ["s_01", "s_02"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rpc frames: events stream before the result, errors carry a code, and cleanup runs once", async () => {
  const pending = new PendingCalls("t");
  const events: unknown[] = [];
  let cleaned = 0;
  const call = { onEvent: (e: unknown) => events.push(e), cleanup: () => cleaned++ };
  const a = pending.open(call);
  const b = pending.open();
  assert.equal(a.id, "t1");
  assert.ok(pending.receive({ id: "t1", event: "e1" }));
  assert.ok(pending.receive({ id: "t1", result: 42 }));
  assert.equal(await a.result, 42);
  assert.deepEqual(events, ["e1"]);
  assert.equal(cleaned, 1);
  assert.ok(!pending.receive({ id: "t1", result: 0 }), "a settled call is gone");
  pending.receive({ id: "t2", error: "boom", code: "not-found" });
  await assert.rejects(b.result, (err: { message: string; code: string }) => err.message === "boom" && err.code === "not-found");
  const c = pending.open();
  pending.failAll(new Error("closed"));
  await assert.rejects(c.result, /closed/);
  assert.equal(pending.size, 0);
  const ok = await callHandler(async () => undefined, "m", {});
  assert.deepEqual(ok, { result: null });
  const bad = await callHandler(async () => Promise.reject(Object.assign(new Error("no"), { code: "rpc" })), "m", {});
  assert.deepEqual(bad, { error: "no", code: "rpc" });
});

/**
 * The fork relation backwards. Only the fork's manifest names the other end, so "is something here already
 * standing in for this package?" cannot be asked of the incoming package at all -- it has to be asked of
 * what the userspace holds. The kernel asks it before every install and before every seed, which is what
 * keeps a shipped gateway from landing beside somebody's fork of it and taking its socket.
 */
test("the fork of a package a userspace already holds is found on the records, and nothing else is mistaken for one", () => {
  const held = [
    { name: "@thetis/terminal" },
    { name: "@alice/gw", forkedFrom: { name: "@thetis/gateway-web" } },
    { name: "@alice/tools", forkedFrom: { name: "@thetis/tools-files" } },
  ];
  assert.equal(forkOf(held, "@thetis/gateway-web"), "@alice/gw");
  assert.equal(forkOf(held, "@thetis/tools-files"), "@alice/tools");
  assert.equal(forkOf(held, "@thetis/terminal"), undefined, "a package nobody forked");
  assert.equal(forkOf(held, "@thetis/skills"), undefined, "a package nobody holds at all");
  assert.equal(forkOf(held, "@alice/gw"), undefined, "the fork itself is not a fork of itself: reinstalling it over itself still works");
  assert.equal(forkOf([{ name: "@alice/gw", forkedFrom: { name: "@alice/gw" } }], "@alice/gw"), undefined, "nor when a manifest names itself as its own origin");
  assert.equal(forkOf([], "@thetis/gateway-web"), undefined);
});

test("a fork is identical to its origin when nothing but its name and version differ, and one changed byte says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-same-"));
  try {
    const origin = join(dir, "origin");
    mkdirSync(join(origin, "dist"), { recursive: true });
    mkdirSync(join(origin, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(origin, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
    writeFileSync(join(origin, "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(origin, "package.json"), JSON.stringify({
      name: "@thetis/thing", version: "0.2.0", description: "a thing", main: "dist/index.js",
      scripts: { build: "tsc -b" }, dependencies: { "left-pad": "^1" }, devDependencies: { typescript: "^5" },
      thetis: { type: "tool" },
    }));
    const to = join(dir, "home", "packages", "thing");
    forkPackage({ from: origin, to, name: "@alice/thing", version: forkVersion("0.2.0"), origin: { name: "@thetis/thing", version: "0.2.0" }, root: dir });
    // The whole point: a fresh fork is the origin under another name, and every field that differs between
    // the two is one `forkPackage` rewrote. Anything less than this and a stale fork looks like a change.
    assert.ok(samePackage(to, origin), "a fresh fork is its origin");
    assert.equal(packageDigest(to), packageDigest(origin));
    writeFileSync(join(to, "dist", "index.js"), "export const x = 2;\n");
    assert.ok(!samePackage(to, origin), "one changed byte is a change");
    writeFileSync(join(to, "dist", "index.js"), "export const x = 1;\n");
    writeFileSync(join(to, "dist", "extra.js"), "");
    assert.ok(!samePackage(to, origin), "a file the origin does not have is a change");
    assert.ok(!samePackage(join(dir, "nowhere"), origin), "a directory that is not there is not the same package");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packagesIn lists the packages under a directory and skips what the caller will not read", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-in-"));
  try {
    mkdirSync(join(dir, "good"), { recursive: true });
    mkdirSync(join(dir, "broken"), { recursive: true });
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeFileSync(join(dir, "good", "package.json"), JSON.stringify({ name: "@thetis/good" }));
    writeFileSync(join(dir, "broken", "package.json"), "{ not json");
    const read = (at: string) => JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as { name: string };
    assert.deepEqual(packagesIn(dir, read).map((p) => p.manifest.name), ["@thetis/good"]);
    assert.equal(packagesIn(join(dir, "nowhere"), read).length, 0, "a directory that is not there holds no packages");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keepOnly removes what is not named and leaves a directory that was never made alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-keep-"));
  try {
    for (const name of ["a", "b", "c"]) mkdirSync(join(dir, name), { recursive: true });
    keepOnly(join(dir, "nowhere"), new Set());
    keepOnly(dir, new Set(["b"]));
    assert.ok(!existsSync(join(dir, "a")) && existsSync(join(dir, "b")) && !existsSync(join(dir, "c")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fork: the copy drops scripts and devDependencies, links what the origin resolves, and numbers its version", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-fork-"));
  try {
    const origin = join(dir, "origin");
    mkdirSync(join(origin, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(origin, "dist"), { recursive: true });
    writeFileSync(join(origin, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
    writeFileSync(join(origin, "dist", "index.js"), "export const x = 1;");
    writeFileSync(join(origin, "package.json"), JSON.stringify({
      name: "@thetis/thing", version: "0.2.0", description: "a thing", main: "dist/index.js",
      scripts: { build: "tsc -b" }, dependencies: { "left-pad": "^1", "not-there": "^2" }, devDependencies: { typescript: "^5" },
      peerDependencies: { "@thetis/runtime": "^0.1.0" }, thetis: { type: "tool", tools: [{ name: "t", description: "d", export: "x" }] },
    }));
    const to = join(dir, "home", "packages", "thing");
    const r = forkPackage({ from: origin, to, name: "@alice/thing", version: forkVersion("0.2.0"), origin: { name: "@thetis/thing", version: "0.2.0" }, root: dir });
    assert.deepEqual(r.linked, ["left-pad"]);
    const m = JSON.parse(readFileSync(join(to, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(m.name, "@alice/thing");
    assert.equal(m.version, "0.2.0-fork.1");
    assert.equal(m.description, "a thing", "other fields are kept");
    assert.equal(m.scripts, undefined);
    assert.equal(m.devDependencies, undefined);
    assert.deepEqual(m.dependencies, { "not-there": "^2" }, "an unresolved dependency stays for npm");
    assert.deepEqual(m.peerDependencies, { "@thetis/runtime": "^0.1.0" });
    assert.deepEqual(m.thetis, { type: "tool", tools: [{ name: "t", description: "d", export: "x" }], forkedFrom: { name: "@thetis/thing", version: "0.2.0" } });
    assert.ok(existsSync(join(to, "dist", "index.js")), "the built files came along");
    assert.ok(!existsSync(join(to, "node_modules", "not-there")));
    assert.equal(realpathSync(join(to, "node_modules", "left-pad")), realpathSync(join(origin, "node_modules", "left-pad")), "a resolvable dependency is a link");
    assert.throws(() => forkPackage({ from: origin, to, name: "@alice/thing", version: "x", origin: { name: "@thetis/thing", version: "0.2.0" }, root: dir }), /target exists/);
    assert.equal(forkVersion("0.2.0", "0.2.0-fork.1"), "0.2.0-fork.2");
    assert.equal(forkVersion("0.3.0", "0.2.0-fork.4"), "0.3.0-fork.1", "a new origin version starts over");
    assert.equal(forkVersion("0.2.0", "1.0.0"), "0.2.0-fork.1");
    assert.equal(findDependency(origin, "nope"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mounts: the store keeps one document per person, answers copies, and an empty list removes the document", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mounts-"));
  try {
    mkdirSync(join(dir, "repos"));
    const space = memoryStore().open("mounts");
    const mirror = await StoreMirror.open<{ mounts: Mount[] }>(space);
    const mounts = new MountStore(mirror);
    assert.deepEqual(mounts.get("alice"), []);
    mounts.set("alice", [{ path: join(dir, "repos"), mode: "rw" }]);
    mounts.set("bob", [{ path: dir, mode: "ro" }]);
    assert.deepEqual(mounts.all(), { alice: [{ path: join(dir, "repos"), mode: "rw" }], bob: [{ path: dir, mode: "ro" }] });
    mounts.get("alice")[0].mode = "ro";
    assert.equal(mounts.get("alice")[0].mode, "rw", "get answers a copy");
    mounts.set("bob", []);
    assert.deepEqual(Object.keys(mounts.all()), ["alice"], "an empty list removes the document");
    await mirror.flush();
    assert.deepEqual(await space.get("alice"), { mounts: [{ path: join(dir, "repos"), mode: "rw" }] });
    assert.equal(await space.get("bob"), undefined);
    const reopened = new MountStore(await StoreMirror.open(space));
    assert.deepEqual(reopened.get("alice"), [{ path: join(dir, "repos"), mode: "rw" }], "what was written is what a restart reads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn taps: a watcher gets the user's events stamped with the session, input on turn.start only; one that throws is dropped; the signal removes one", async () => {
  const taps = new TurnTaps();
  const seen: WatchedTurnEvent[] = [];
  const inner: TurnEvent[] = [];
  const control = new AbortController();
  const done = taps.watch("alice", (m) => seen.push(m), control.signal);
  let thrown = 0;
  taps.watch("alice", () => {
    thrown++;
    throw new Error("a broken tap");
  });
  taps.watch("bob", () => assert.fail("bob's watcher saw alice's turn"));
  const emit = taps.emitter("alice", { session: "s_1", parent: "s_0", input: "hi" }, (e) => inner.push(e));
  const start: TurnEvent = { type: "turn.start", turn: "t1", session: "s_1" };
  const text: TurnEvent = { type: "text", delta: "x" };
  emit(start);
  emit(text);
  assert.deepEqual(inner, [start, text], "the inner sink gets every event, before the watchers");
  assert.match(String(seen[0].startedAt), /^\d{4}-/, "turn.start carries when the turn started");
  assert.deepEqual(seen.map(({ startedAt: _, ...m }) => m), [
    { session: "s_1", parent: "s_0", input: "hi", event: start },
    { session: "s_1", parent: "s_0", event: text },
  ]);
  assert.equal(thrown, 1, "a watcher that throws is dropped after its first throw, and the turn goes on");
  assert.equal(taps.count("alice"), 1);
  control.abort();
  await done;
  assert.equal(taps.count("alice"), 0, "the signal removed the watcher");
  emit({ type: "turn.end", turn: "t1", session: "s_1" });
  assert.equal(seen.length, 2);
  assert.equal(inner.length, 3);
  const plain: WatchedTurnEvent[] = [];
  taps.watch("alice", (m) => plain.push(m));
  taps.emitter("alice", { session: "s_2" }, () => {})({ type: "turn.start", turn: "t2", session: "s_2" });
  assert.deepEqual(plain.map(({ startedAt: _, ...m }) => m), [{ session: "s_2", event: { type: "turn.start", turn: "t2", session: "s_2" } }], "no parent and no input: the fields are absent, not undefined");
  const already = new AbortController();
  already.abort();
  await taps.watch("carol", () => {}, already.signal);
  assert.equal(taps.count("carol"), 0, "a signal that is already aborted registers nothing and resolves at once");
});

test("turn taps: a watcher arriving mid-turn is handed the turn so far, stamped as the live events were, then follows it; an ended turn is not kept", () => {
  const taps = new TurnTaps();
  const emit = taps.emitter("alice", { session: "s_2", input: "go" }, () => {});
  const start: TurnEvent = { type: "turn.start", turn: "t2", session: "s_2" };
  const text: TurnEvent = { type: "text", delta: "a" };
  emit(start);
  emit(text);
  const late: WatchedTurnEvent[] = [];
  taps.watch("alice", (m) => late.push(m));
  assert.equal(late.length, 2, "the two events so far arrive before watch returns");
  assert.equal(late[0].input, "go");
  assert.equal(typeof late[0].startedAt, "string");
  assert.equal(late[1].startedAt, undefined, "only turn.start says when the turn started");
  assert.deepEqual(late.map((m) => m.event), [start, text]);
  const end: TurnEvent = { type: "turn.end", turn: "t2", session: "s_2" };
  emit(end);
  assert.deepEqual(late.map((m) => m.event), [start, text, end], "and then the live events");
  const later: WatchedTurnEvent[] = [];
  taps.watch("alice", (m) => later.push(m));
  assert.deepEqual(later, [], "a turn that ended is not replayed");
  taps.watch("bob", () => assert.fail("bob is handed alice's turn"));
});

test("session store: the index beside the records answers a list without opening them, is built once from records that predate it, and follows every save", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-sessions-"));
  const base = { user: "alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", harness: {} };
  const old: SessionRecord = { ...base, id: "s_aaaa", turns: 1, conversation: [{ role: "user", content: textContent("  first\n question  ") }, { role: "assistant", content: textContent("") }, { role: "assistant", content: textContent("the answer") }] };
  writeFileSync(join(dir, "s_aaaa.json"), JSON.stringify(old));
  const store = new SessionStore(/^s_[a-f0-9]+$/);
  assert.deepEqual(store.summaries(dir), [{ id: "s_aaaa", user: "alice", createdAt: base.createdAt, updatedAt: base.updatedAt, turns: 1, first: "first question", last: "the answer" }]);
  assert.ok(existsSync(join(dir, "index.json")), "built from the records the first time");
  const fresh: SessionRecord = { ...base, id: "s_bbbb", parent: "s_aaaa", turns: 0, conversation: [] };
  store.save(dir, fresh);
  const long = "x".repeat(300);
  store.save(dir, { ...fresh, turns: 1, turn: { id: "t1", startedAt: base.createdAt, input: long }, conversation: [{ role: "user", content: textContent(long) }] });
  const listed = store.summaries(dir).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(listed.length, 2);
  assert.equal(listed[1].parent, "s_aaaa");
  assert.equal(listed[1].first.length, 200, "clipped to 200 characters");
  assert.equal(listed[1].last, listed[1].first, "the user message is the last thing said");
  const again = new SessionStore(/^s_[a-f0-9]+$/);
  assert.equal(again.summaries(dir).length, 2, "another process reads the index file, not the records");
  assert.equal(again.load(dir, "s_bbbb")?.turn?.id, "t1", "the record itself keeps the turn in progress");
  store.remove(dir, "s_bbbb");
  assert.equal(store.summaries(dir).length, 1);
  assert.equal(store.load(dir, "s_bbbb"), undefined);
  assert.deepEqual(new JsonDirStore<SessionRecord>(/^s_[a-f0-9]+$/).list(dir).map((r) => r.id), ["s_aaaa"], "the index file is not a record");
  assert.equal(summarize({ ...base, id: "s_cccc", turns: 0, conversation: [] }).first, "");
  rmSync(dir, { recursive: true, force: true });
});

test("ssh: the store keeps one document per person with the key paths and their known hosts, answers copies, and knownHostsOf is every line once", async () => {
  const space = memoryStore().open("ssh");
  const mirror = await StoreMirror.open<{ ssh: SshGrant[] }>(space);
  const ssh = new SshStore(mirror);
  assert.deepEqual(ssh.get("alice"), []);
  ssh.set("alice", [{ key: "/k/a", hosts: ["gh a", "gh b"] }, { key: "/k/b", hosts: [] }]);
  ssh.set("bob", [{ key: "/k/c" }]);
  assert.deepEqual(ssh.all(), { alice: [{ key: "/k/a", hosts: ["gh a", "gh b"] }, { key: "/k/b" }], bob: [{ key: "/k/c" }] }, "empty hosts are not written");
  ssh.get("alice")[0].hosts?.push("x");
  assert.deepEqual(ssh.get("alice")[0].hosts, ["gh a", "gh b"], "get answers a copy");
  ssh.set("bob", []);
  assert.deepEqual(Object.keys(ssh.all()), ["alice"], "an empty list removes the document");
  await mirror.flush();
  assert.deepEqual(await space.get("alice"), { ssh: [{ key: "/k/a", hosts: ["gh a", "gh b"] }, { key: "/k/b" }] });
  assert.equal(await space.get("bob"), undefined);
  assert.deepEqual(new SshStore(await StoreMirror.open(space)).get("alice"), ssh.get("alice"), "what was written is what a restart reads");
  assert.equal(knownHostsOf([{ key: "/k", hosts: ["a", "a"] }, { key: "/other", hosts: ["a", "b"] }]), "a\nb\n");
  assert.equal(knownHostsOf([{ key: "/k" }]), "");
});

test("socket paths: a home with room for every id passes and says nothing, and the inventory is every socket under it", () => {
  assert.equal(homeSocketProblem("/opt/zero/data"), undefined);
  assert.equal(homeSocketWarning("/opt/zero/data"), undefined, "a short home costs a person nothing");
  assert.equal(maxUserIdLength("/opt/zero/data"), MAX_USER_ID);
  assert.doesNotThrow(() => assertUserIdFitsSockets("/opt/zero/data", "u".repeat(MAX_USER_ID)));
  // The two ceilings, and which socket sets each. A full-length id spends 58 bytes on a terminal socket,
  // so 49 is the home that carries everybody; a one-character id spends 34 on the sign-in socket, whose id
  // is the fixed `_system` and does not shrink with it, so 73 is the home that can work at all.
  assert.equal(maxHomeLength(MAX_USER_ID), 49);
  assert.equal(maxHomeLength(), 73);
  // Which socket is the longest is not fixed: the sign-in socket's id is the constant `_system`, so it wins
  // for a short id and the per-person terminal socket overtakes it at nine characters. Nothing below reads
  // the list expecting one particular answer.
  assert.equal(longestHomeSocket("/home/someone/.thetis", "alice").path, "/home/someone/.thetis/userspaces/_system/run/login.sock");
  assert.equal(longestHomeSocket("/home/someone/.thetis", "alexandrina").path, "/home/someone/.thetis/userspaces/alexandrina/run/term.sock");
  assert.ok(HOME_SOCKETS.some((s) => s.path("/h", "alice").endsWith("/thetis.sock")), "the control socket");
  assert.ok(HOME_SOCKETS.some((s) => s.path("/h", "alice").endsWith("/fence-ssh/alice/agent.sock")), "the fence ssh agent");
  assert.ok(HOME_SOCKETS.some((s) => s.path("/h", "alice").endsWith("/userspaces/_system/run/login.sock")), "the sign-in socket");
  assert.ok(HOME_SOCKETS.some((s) => s.path("/h", "alice").endsWith("/userspaces/alice/run/web.sock")), "the gateway");
  assert.ok(HOME_SOCKETS.some((s) => s.path("/h", "alice").endsWith("/userspaces/alice/run/term.sock")), "the terminal");
});

test("socket paths: a home that works for short ids and not long ones is a note, not a refusal, and the id is refused when one is chosen", () => {
  // 60 bytes: the sign-in socket fits, so the home serves; a 32-character id does not, so it costs ids.
  const home = "/" + "d".repeat(59);
  assert.equal(homeSocketProblem(home), undefined, "a home that serves somebody is not refused");
  assert.doesNotThrow(() => assertHomeFitsSockets(home));
  const fits = maxUserIdLength(home);
  assert.equal(fits, 21, "107 less 60 bytes of home and 26 of terminal socket suffix");
  const note = homeSocketWarning(home);
  assert.ok(note?.startsWith("note: "), "a note, with no verdict in it");
  assert.ok(note?.includes(`allows user ids of at most ${fits} characters`), "it names the longest id this home carries");
  assert.ok(note?.includes(`${home}/userspaces/<user id>/run/term.sock`), "and the socket that a longer one could not open");
  assert.ok(note?.includes(`${MAX_SOCKET_PATH} bytes`), "and the limit");
  assert.ok(note?.includes(`at most ${maxHomeLength(MAX_USER_ID)} bytes`), "and the home that would cost nothing");
  // The verdict, at the moment an id exists: the longest that fits passes, one character more does not.
  assert.equal(userIdProblem(home, "a".repeat(fits)), undefined);
  assert.doesNotThrow(() => assertUserIdFitsSockets(home, "a".repeat(fits)));
  assert.equal(longestHomeSocket(home, "a".repeat(fits)).bytes, MAX_SOCKET_PATH, "and that id sits exactly on the limit");
  const tooLong = "a".repeat(fits + 1);
  const problem = userIdProblem(home, tooLong);
  assert.ok(problem?.startsWith(`user id ${tooLong} is too long for this data directory`), "the id is named, and so is why");
  assert.ok(problem?.includes(`${home}/userspaces/${tooLong}/run/term.sock`), "the socket is spelled out, with the real id");
  assert.ok(problem?.includes(`${MAX_SOCKET_PATH + 1} bytes`), "with what it would measure");
  assert.ok(problem?.includes(`${MAX_SOCKET_PATH} bytes`), "against the limit");
  assert.ok(problem?.includes(`${home} allows user ids of at most ${fits} characters`), "and the longest id that would fit");
  assert.throws(() => assertUserIdFitsSockets(home, tooLong), /is too long for this data directory/);
  // An id longer than the kernel's own maximum is malformed, and `users.create` has its own sentence for it.
  assert.equal(userIdProblem(home, "a".repeat(MAX_USER_ID + 1)), undefined);
});

test("socket paths: a home too long for even a one-character id is refused, by a sentence naming the socket, the limit and the ceiling", () => {
  const fits = "/" + "d".repeat(maxHomeLength() - 1);
  assert.equal(homeSocketProblem(fits), undefined, "a home of exactly the ceiling still serves");
  // 73 bytes is where the sign-in socket lands exactly on the limit; the per-person sockets have 8 bytes of
  // id left over, which is why this ceiling is the one a home cannot pass and not the one that is comfortable.
  assert.equal(maxUserIdLength(fits), 8);
  const over = fits + "x";
  const problem = homeSocketProblem(over);
  assert.ok(problem?.startsWith("THETIS_HOME is too long: "), "one byte more is refused");
  assert.equal(maxUserIdLength(over), 0);
  assert.ok(problem?.includes(over), "the sentence names the home that was refused");
  assert.ok(problem?.includes("Even with a one-character user id"), "and that no id could rescue it");
  assert.ok(problem?.includes(`${over}/userspaces/_system/run/login.sock`), "and the socket that does not fit, which here takes no id at all");
  assert.ok(problem?.includes(`${MAX_SOCKET_PATH} bytes`), "and the limit itself");
  assert.ok(problem?.includes(`at most ${maxHomeLength()} bytes`), "and the length a home may be");
  assert.equal(homeSocketWarning(over), undefined, "a refused home is not also warned about");
  assert.throws(() => assertHomeFitsSockets(over), new RegExp(`at most ${maxHomeLength()} bytes`));
});

test("a malformed streamed event rejects and cancels its RPC without escaping the frame reader", async () => {
  const pending = new PendingCalls("content");
  const failure = new Error("invalid content");
  let cleaned = 0;
  let cancelled = 0;
  const { id, result } = pending.open({ onEvent() { throw failure; }, cleanup() { cleaned++; }, cancel() { cancelled++; } });
  const rejected = assert.rejects(result, (error) => error === failure);
  assert.doesNotThrow(() => pending.receive({ id, event: { type: "content.delta" } }));
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(cleaned, 1);
  assert.equal(pending.receive({ id, event: {} }), false);
  assert.equal(pending.size, 0);
});
