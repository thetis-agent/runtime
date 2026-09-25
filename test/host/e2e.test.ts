import { contentText } from "@thetis/runtime/lib/content";
// End-to-end through the real process fence and userspace agent, with a deterministic
// provider fixture instead of the network. Exercises: seeding, prompt/tool steps, the tool
// loop, self-extension by installing a user package, RPC from inside the fence, and isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { ConfigReport, PackageInfo, TurnEvent } from "../../src/contracts/index.js";
import { createControlHandler, createRpcHandler, defaultConfig } from "../../src/kernel/index.js";
import { memoryStore } from "../../src/lib/store.js";
import type { ProcessFence } from "../../src/sandbox/index.js";
import { ControlServer, createKernel, migrateStore, T, type Kernel } from "../../src/host/index.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = resolve(PROJECT, "test/host/fixtures");
const SANDBOX = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
/** The shipped driver, when it has been built; otherwise the records live in memory and nothing about files can be asserted. */
const REAL_DRIVER = existsSync(resolve(PROJECT, "packages/store-toml/dist/src/index.js"));

let home: string;
let kernel: Kernel;

async function collect(events: AsyncIterable<TurnEvent>) {
  const all: TurnEvent[] = [];
  let text = "";
  for await (const e of events) {
    all.push(e);
    if (e.type === "text") text += e.delta;
  }
  const errors = all.filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
  return { all, text, errors };
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "thetis-e2e-"));
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec", "prompt-cache", "terminal", "store-toml"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  for (const name of ["provider-echo", "config-probe", "config-svc"]) symlinkSync(join(FIXTURES, name), join(sys, name));
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = SANDBOX;
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/terminal", "@thetis/config-probe"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" }, "@thetis/prompt-cache": { explicitVendors: ["echo"], ttl: "1h" } };
  config.requestTimeoutMs = 60_000;
  if (!REAL_DRIVER) console.error("packages/store-toml is not built: the e2e records live in a memory store and file modes are not checked");
  kernel = await createKernel(config, (c) => {
    c.bind(T.log, () => (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line));
    if (!REAL_DRIVER) c.bind(T.store, () => memoryStore());
  });
  kernel.users.create("alice");
  kernel.users.create("bob");
  // `shell` is a client of a service: the session host listens on a socket inside the userspace, and
  // nothing answers it until the supervisor is armed. Arming it here starts that service in every fence
  // this file opens, which is what the real system does at boot.
  await kernel.services.boot();
});

after(async () => {
  await kernel.shutdown();
  rmSync(home, { recursive: true, force: true });
});

test("first turn seeds the userspace and round-trips through the provider", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "hello"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, "echo: hello (t1)");
  const names = kernel.packages.installed(kernel.userspaces.pathFor("alice")).map((p) => p.name);
  assert.deepEqual(names, ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/terminal", "@thetis/config-probe"]);
  assert.equal(kernel.sessions.inspect("alice", s.id).conversation.length, 2);
});

test("the prompt-cache step hands the provider a policy hint and keeps diagnostics", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "hints?"));
  assert.deepEqual(r.errors, []);
  const hints = JSON.parse(r.text) as { cache: { strategy?: string; ttl?: string; systemTtl?: string; affinity?: string } };
  assert.equal(hints.cache.strategy, "breakpoints", "echo is configured as an explicit vendor");
  assert.equal(hints.cache.ttl, "1h");
  assert.equal(hints.cache.systemTtl, undefined, "the hint names only what is configured");
  assert.match(hints.cache.affinity ?? "", /^thetis:[0-9a-f]{16}$/);
  await collect(kernel.sessions.send("alice", s.id, "hints?"));
  const diag = kernel.sessions.inspect("alice", s.id).harness["@thetis/prompt-cache"] as { turns: number; divergences: number };
  assert.equal(diag.turns, 2);
  assert.equal(diag.divergences, 0, "an append-only conversation never rewrites its prefix");
});

test("harness steps build the system prompt and attach tools", async () => {
  const s = kernel.sessions.create("alice");
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /You are Thetis/);
  assert.match(sys.text, /## Working style/);
  assert.doesNotMatch(sys.text, /list_packages/, "the prompt names no tool: a tool's description is its contract");
  assert.doesNotMatch(sys.text, /@thetis\/tool-exec@/);
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  for (const t of ["shell", "list_packages", "install_package", "spawn_subagent"]) assert.ok(tools.text.split(",").includes(t), `missing tool ${t}`);
  const listed = await collect(kernel.sessions.send("alice", s.id, "packages?"));
  // The version is not pinned: this asserts that the listing carries a version and the description, not
  // which version, so an ordinary bump of a shipped package is not a failing end-to-end test.
  assert.match(listed.text, /@thetis\/tool-exec@\d+\.\d+\.\d+ \(tool\): Tools for the model/);
  assert.match(listed.text, /@thetis\/terminal@\d+\.\d+\.\d+ \(tool\): Long-lived shell sessions/);
});

test("context capture is readable during the first turn through the real fence", async () => {
  const s = kernel.sessions.create("alice");
  let observed = false;
  for await (const event of kernel.sessions.send("alice", s.id, "slow: first second third")) {
    if (event.type !== "context.updated" || observed) continue;
    const record = kernel.sessions.inspect("alice", s.id);
    assert.equal(record.status, "running");
    assert.equal(record.turns, 0);
    assert.equal(record.harness["@thetis/harness-core"], undefined, "the session's after-step has not run yet");
    const file = join(kernel.userspaces.pathFor("alice").home, "harness-core/context", `${s.id}.json`);
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    assert.match(contentText(snapshot.lastCall.request.messages.at(-1).content), /slow: first second third/);
    assert.equal(snapshot.usage[0].status, "running");
    observed = true;
  }
  assert.ok(observed, "the live snapshot notification crossed the fence before turn.end");
});

test("tool loop: the model runs a command inside the fence and sees the result", async () => {
  const s = kernel.sessions.create("alice");
  // The first `shell` call opens this conversation's session, whose pty starts in the person's home.
  const r = await collect(kernel.sessions.send("alice", s.id, "run: echo hi-from-fence && pwd"));
  assert.deepEqual(r.errors, []);
  const call = r.all.find((e) => e.type === "tool.call");
  assert.ok(call, "tool.call event emitted");
  assert.match(r.text, /tool said: exit 0/);
  assert.match(r.text, /hi-from-fence/);
  assert.match(r.text, new RegExp(kernel.userspaces.pathFor("alice").home));
  const conv = kernel.sessions.inspect("alice", s.id).conversation;
  assert.deepEqual(conv.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
});

test("self-extension: a package written into the userspace is live on the next turn", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@alice/hello", version: "0.1.0", type: "module", main: "index.js",
    thetis: { type: "loader", steps: [{ id: "mark", phase: "prompt", export: "mark" }, { id: "count", phase: "after", export: "count" }],
      tools: [{ name: "greet", description: "greets", parameters: { type: "object", properties: {} }, export: "greet" }] },
  }));
  writeFileSync(join(dir, "index.js"), `
    export async function mark(ctx) { return { call: { ...ctx.call, system: ctx.call.system + "\\nMARKER-FROM-ALICE " + (ctx.harness.turns ?? 0) } }; }
    export async function count(ctx) { return { harness: { ...ctx.harness, turns: (ctx.harness.turns ?? 0) + 1 } }; }
    export async function greet() { return "hi"; }
  `);
  const s = kernel.sessions.create("alice");
  const viaRpc = await collect(kernel.sessions.send("alice", s.id, "install: packages/hello"));
  assert.deepEqual(viaRpc.errors, []);
  assert.match(viaRpc.text, /installed @alice\/hello@0.1.0/);
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /MARKER-FROM-ALICE 0/);
  assert.equal(kernel.sessions.inspect("alice", s.id).harness.turns, 1, "after-phase step persisted harness state");
  const again = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(again.text, /MARKER-FROM-ALICE 1/);
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  assert.ok(tools.text.split(",").includes("greet"));
  assert.ok(existsSync(join(us.store, "node_modules", "@alice", "hello", "package.json")));
});

test("a scope is a namespace: alice installs a package named in bob's scope into her own workspace, bob does not see it, and only @thetis is refused her", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "evil");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bob/evil", version: "0.0.1", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(dir, "index.js"), "");
  // The name is a label the author chose. The copy is alice's, lands in her workspace only, and the registry keeps her entry apart from anything bob might hold under that name.
  assert.equal((await kernel.packages.install(us, kernel.users.authorize("alice"), "packages/evil")).name, "@bob/evil");
  assert.deepEqual(kernel.registry.holders("@bob/evil"), ["alice"]);
  assert.ok(!kernel.packages.installed(kernel.userspaces.pathFor("bob")).some((p) => p.name === "@bob/evil"), "bob's workspace is untouched");
  await kernel.packages.uninstall(us, "@bob/evil");
  // The one namespace with a meaning: the kernel resolves @thetis names on disk, so a source claiming it is an admin's to install.
  const claim = join(us.home, "packages", "claim");
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "package.json"), JSON.stringify({ name: "@thetis/claim", version: "0.0.1", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(claim, "index.js"), "");
  await assert.rejects(kernel.packages.install(us, kernel.users.authorize("alice"), "packages/claim"), (e: { code: string; message: string }) => e.code === "unauthorized" && /installation's namespace/.test(e.message));
  await assert.rejects(kernel.packages.install(us, kernel.users.authorize("alice"), "../../.."), /inside the userspace/);
  const s = kernel.sessions.create("bob");
  const tools = await collect(kernel.sessions.send("bob", s.id, "tools?"));
  assert.ok(!tools.text.split(",").includes("greet"));
  assert.throws(() => kernel.sessions.inspect("bob", kernel.sessions.list("alice")[0].id), /unknown session/);
});

test("promote: an admin makes a user package the default for everyone", async () => {
  const control = createControlHandler(kernel);
  const r = (await control("packages.promote", { user: "alice", name: "@alice/hello" })) as { name: string; userspaces: string[] };
  assert.equal(r.name, "@thetis/hello");
  assert.ok(r.userspaces.includes("alice") && r.userspaces.includes("bob"));
  const alice = kernel.packages.installed(kernel.userspaces.pathFor("alice")).map((p) => p.name);
  assert.ok(!alice.includes("@alice/hello"), "the owner's copy is gone");
  assert.ok(alice.includes("@thetis/hello"), "the owner runs the promoted one");
  assert.ok(existsSync(join(kernel.config.promotedPackagesDir, "hello", "package.json")));
  assert.ok(kernel.packages.promoted().includes("@thetis/hello"), "new userspaces get it too");
  assert.ok(!kernel.config.systemPackages["*"].includes("@thetis/hello"), "the configuration file is not written by the kernel");
  // Bob's steps and tools run inside bob's fence, which proves the promoted directory is readable there.
  const s = kernel.sessions.create("bob");
  const tools = await collect(kernel.sessions.send("bob", s.id, "tools?"));
  assert.deepEqual(tools.errors, []);
  assert.ok(tools.text.split(",").includes("greet"), `bob has the promoted tool: ${tools.text}`);
  const sys = await collect(kernel.sessions.send("bob", s.id, "system?"));
  assert.match(sys.text, /MARKER-FROM-ALICE/);
  await assert.rejects(control("packages.promote", { user: "alice", name: "@thetis/hello" }), /not installed in alice from a source of its own/);
});

test("git install: a package directory inside a repository, as url#dir", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const repo = join(us.home, "registry");
  mkdirSync(join(repo, "pkgs", "wave"), { recursive: true });
  writeFileSync(join(repo, "pkgs", "wave", "package.json"), JSON.stringify({ name: "@alice/wave", version: "0.0.1", type: "module", main: "index.js", thetis: { type: "tool", tools: [{ name: "wave", description: "waves", export: "wave" }] } }));
  writeFileSync(join(repo, "pkgs", "wave", "index.js"), "export async function wave() { return 'o/'; }");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init", { cwd: repo });
  const actor = kernel.users.authorize("alice");
  const info = await kernel.packages.install(us, actor, `file://${repo}#pkgs/wave`);
  assert.equal(info.name, "@alice/wave");
  assert.ok(existsSync(join(us.store, "node_modules", "@alice", "wave", "index.js")));
  await assert.rejects(kernel.packages.install(us, actor, `file://${repo}#../escape`), /inside the repository/);
  await kernel.packages.uninstall(us, "@alice/wave");
});

test("a turn that fails after a tool ran keeps the tool call and its result in the record, and the after steps still run", async () => {
  const s = kernel.sessions.create("alice");
  const r = await collect(kernel.sessions.send("alice", s.id, "run: echo FAIL_NEXT"));
  assert.ok(r.all.some((e) => e.type === "tool.result"), "the tool ran");
  const failure = r.all.find((e) => e.type === "error") as { message: string; code?: string } | undefined;
  assert.match(failure?.message ?? "", /provider error: the provider gave up/, "then the provider failed, and the call step says so");
  assert.equal(failure?.code, "provider");
  assert.equal(r.all.filter((e) => e.type === "error").length, 1, "one error, emitted by the step; the kernel adds none");
  assert.equal(r.all.at(-1)?.type, "turn.end");
  const rec = kernel.sessions.inspect("alice", s.id);
  const roles = rec.conversation.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool"], "the call and its result survive the failure");
  assert.match(contentText(rec.conversation[2].content), /FAIL_NEXT/);
  // The step returned rather than threw, so the turn went on to `after`: the record of the call is this turn's.
  const own = rec.harness["@thetis/harness-core"] as { lastCall?: { messages: number } } | undefined;
  assert.equal(own?.lastCall?.messages, 3, "recordCall saw the request, the reply and the tool result");
});

test("operator methods: an admin's fence may use them; a user's may not", async () => {
  const handler = (id: string) => createRpcHandler(kernel.userspaces.pathFor(id), kernel, createControlHandler(kernel));
  await assert.rejects(handler("alice")("operator.users.list", {}), /only an admin/);
  kernel.users.create("root", "admin");
  const root = handler("root");
  const users = (await root("operator.users.list", {})) as { id: string }[];
  assert.ok(users.some((u) => u.id === "alice"));
  assert.equal(await root("operator.ping", {}), "pong");
  const list = (await root("operator.packages.list", { user: "alice" })) as { name: string }[];
  assert.ok(list.some((p) => p.name === "@thetis/harness-core"), "an admin sees another person's packages");
  await assert.rejects(root("operator.nope", {}), /unknown control method/);
  const rows = (await root("operator.journal.tail", { limit: 50 })) as { kind: string; actor?: string }[];
  assert.ok(rows.some((r) => r.kind === "turn.end"), "turns are journaled");
  assert.ok(rows.some((r) => r.kind === "package.promote" && r.actor === "operator"), "the promotion was journaled");
});

test("cancel: a running turn stops mid-stream, keeps the partial text, and the session is idle again", async () => {
  const s = kernel.sessions.create("alice");
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const events = kernel.sessions.send("alice", s.id, `slow: ${words}`);
  assert.equal(kernel.sessions.cancel("alice", "s_000000000000"), false, "no turn on an unknown session");
  setTimeout(() => assert.equal(kernel.sessions.cancel("alice", s.id), true), 300);
  const r = await collect(events);
  const error = r.all.find((e) => e.type === "error") as { code?: string } | undefined;
  assert.equal(error?.code, "cancelled");
  assert.equal(r.all.at(-1)?.type, "turn.end");
  assert.ok(r.text.length > 0 && r.text.split(" ").length < 40, `stopped early: ${JSON.stringify(r.text)}`);
  const rec = kernel.sessions.inspect("alice", s.id);
  assert.equal(rec.status, "idle");
  assert.deepEqual(rec.conversation.map((m) => m.role), ["user", "assistant"]);
  assert.equal(contentText(rec.conversation[1].content), r.text);
  const again = await collect(kernel.sessions.send("alice", s.id, "hello"));
  assert.deepEqual(again.errors, []);
});

test("cancel: the turn ends at once, and the command it started keeps running in the shell session", async () => {
  const s = kernel.sessions.create("alice");
  // Open this conversation's session first, so the cancel below lands on a shell that is already at a
  // prompt and the sleep is certain to have been submitted.
  assert.match((await collect(kernel.sessions.send("alice", s.id, "run: echo ready"))).text, /ready/);
  const events = kernel.sessions.send("alice", s.id, "run: sleep 30; echo late");
  setTimeout(() => kernel.sessions.cancel("alice", s.id), 500);
  const started = Date.now();
  const r = await collect(events);
  assert.ok(Date.now() - started < 3_000, "the turn did not wait for the sleep, nor for the fence's cancel grace");
  assert.equal((r.all.find((e) => e.type === "error") as { code?: string })?.code, "cancelled");
  assert.equal(r.all.filter((e) => e.type === "error").length, 1);
  // The call step returned what it had: the tool call the model made, closed as never run, so the next turn's provider sees a whole conversation.
  const kept = kernel.sessions.inspect("alice", s.id).conversation.slice(-3);
  assert.deepEqual(kept.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(kept[1].toolCalls?.[0]?.name, "shell");
  assert.equal(contentText(kept[2].content), "error: the turn was stopped before this tool ran");
  // `shell` is not `exec`. Cancelling a turn abandons the wait; it does not reach into the pty and kill
  // what the shell is running, and the session is shared with the person, so killing it would be a
  // surprise rather than a cleanup. The proof that the process survived is the next call meeting it.
  const busy = await collect(kernel.sessions.send("alice", s.id, "run: echo alive"));
  assert.match(busy.text, /the session is busy: you are running "sleep 30; echo late"/);
  // The refusal names the repair, and it works: Ctrl-C ends the command and leaves the session alive.
  const stopped = await collect(kernel.sessions.send("alice", s.id, "interrupt!"));
  assert.match(stopped.text, /exit 130/);
  const again = await collect(kernel.sessions.send("alice", s.id, "run: echo alive"));
  assert.match(again.text, /alive/);
  assert.doesNotMatch(again.text, /late/, "the interrupted list never reached its second command");
});

test("rpc: identity is the fence; only the system fence logs people in; a token resolves only for its own user", async () => {
  const handler = (id: string) => createRpcHandler(kernel.userspaces.pathFor(id), kernel);
  const forAlice = handler("alice");
  const forBob = handler("bob");
  const forSystem = handler("_system");
  await assert.rejects(forAlice("auth.login", { id: "alice", password: "x" }), /only the system userspace/);
  await kernel.auth.setPassword("alice", "wonderland1");
  const login = (await forSystem("auth.login", { id: "alice", password: "wonderland1" })) as { token: string };
  assert.deepEqual(await forAlice("auth.authenticate", { token: login.token }), { id: "alice", role: "user" });
  assert.equal(await forBob("auth.authenticate", { token: login.token }), null, "bob's fence cannot resolve alice's token");
  assert.deepEqual(await forSystem("auth.authenticate", { token: login.token }), { id: "alice", role: "user" });
  await forBob("auth.logout", { token: login.token });
  assert.ok(await forAlice("auth.authenticate", { token: login.token }), "bob's fence cannot revoke alice's token");
  await forAlice("auth.logout", { token: login.token });
  assert.equal(await forAlice("auth.authenticate", { token: login.token }), null);
  const own = (await forAlice("sessions.list", {})) as { user: string }[];
  assert.ok(own.length > 0 && own.every((s) => s.user === "alice"));
  const events: TurnEvent[] = [];
  const created = (await forAlice("sessions.create", {})) as { id: string };
  await forAlice("sessions.send", { session: created.id, input: "streamed" }, (e) => events.push(e as TurnEvent));
  assert.ok(events.some((e) => e.type === "turn.end"));
  assert.throws(() => kernel.sessions.inspect("bob", created.id), /unknown session/);
});

test("rpc: a fence lists the models its providers serve, and a turn may name one", async () => {
  const forAlice = createRpcHandler(kernel.userspaces.pathFor("alice"), kernel, undefined, async (us) => ({ model: kernel.config.model, models: await kernel.providers.listModels(us) }));
  const choices = (await forAlice("models", {})) as { model: string; models: { id: string; provider?: string }[] };
  assert.equal(choices.model, "echo");
  assert.ok(choices.models.some((m) => m.id === "echo" && m.provider === "@thetis/provider-echo"));
  const s = (await forAlice("sessions.create", {})) as { id: string };
  const said = (turn: TurnEvent[]) => turn.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  const byDefault: TurnEvent[] = [];
  await forAlice("sessions.send", { session: s.id, input: "model?" }, (e) => byDefault.push(e as TurnEvent));
  assert.equal(said(byDefault), "echo");
  const named: TurnEvent[] = [];
  await forAlice("sessions.send", { session: s.id, input: "model?", model: "echo-2" }, (e) => named.push(e as TurnEvent));
  assert.ok(named.some((e) => e.type === "error" && /echo-2/.test(e.message)), "a model no provider serves is refused by name");
  const r = await collect(kernel.sessions.send("alice", s.id, "model?", { model: "echo" }));
  assert.equal(r.text, "echo");
});

test("control socket: an operator client lists users, installs into the system userspace, and streams a turn", async () => {
  const path = join(home, "thetis.sock");
  const control = new ControlServer(path, createControlHandler(kernel));
  await control.listen();
  try {
    const socket = createConnection(path);
    await new Promise<void>((done, fail) => socket.once("connect", done).once("error", fail));
    const lines: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: socket }).on("line", (line) => {
      lines.push(JSON.parse(line));
      waiters.splice(0).forEach((w) => w());
    });
    const call = async (id: string, method: string, args: unknown) => {
      socket.write(JSON.stringify({ id, method, args }) + "\n");
      for (;;) {
        const done = lines.find((l) => l.id === id && ("result" in l || "error" in l));
        if (done) return done;
        await new Promise<void>((w) => waiters.push(w));
      }
    };
    assert.equal((await call("1", "ping", {})).result, "pong");
    const users = (await call("2", "users.list", {})).result as { id: string }[];
    assert.ok(users.some((u) => u.id === "alice"));
    const s = (await call("3", "sessions.create", { user: "alice" })).result as { id: string };
    const done = await call("4", "sessions.send", { user: "alice", session: s.id, input: "over the socket" });
    assert.equal(done.result, null);
    const text = lines.filter((l) => l.id === "4" && "event" in l).map((l) => l.event as TurnEvent).filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    assert.equal(text, "echo: over the socket (t1)");
    const bad = await call("5", "sessions.inspect", { user: "alice", session: "s_000000000000" });
    assert.match(String(bad.error), /unknown session/);
    assert.equal(bad.code, "not-found");
    assert.equal((await call("6", "nope", {})).code, "rpc");
    socket.end();
  } finally {
    await control.close();
  }
  assert.ok(!existsSync(path), "the socket file is removed on close");
});

test("suspended users cannot start turns", async () => {
  kernel.users.setStatus("bob", "suspended");
  assert.throws(() => kernel.sessions.create("bob"), /suspended/);
  kernel.users.setStatus("bob", "active");
});

test("fence isolation: a userspace cannot read the service plane or another userspace", async (t) => {
  const fence = kernel.container.get(T.fence) as ProcessFence;
  if (fence.mode !== "bwrap") return t.skip("bwrap sandbox unavailable; running unfenced");
  const s = kernel.sessions.create("alice");
  const bob = kernel.userspaces.pathFor("bob").root;
  // The service plane's data dir must be invisible except for the mount-point path to alice's own userspace.
  const data = join(home, "data");
  const probe = [
    `ls ${join(data, "store")} && echo LEAK-STORE`,
    `ls ${bob} && echo LEAK-BOB`,
    `ls -A ${data} | grep -v '^userspaces$' | grep -v '^packages$' | grep -v '^shared$' | grep . && echo LEAK-DATA`,
    `touch ${join(data, "shared", "x")} 2>/dev/null && echo LEAK-SHARED-WRITE`,
    `ls ${join(data, "packages", "hello", "package.json")} >/dev/null || echo NO-PROMOTED`,
    `ls -A ${join(data, "userspaces")} | grep -v '^alice$' | grep . && echo LEAK-USERSPACES`,
    `echo probe-done`,
  ].join("; ");
  const r = await collect(kernel.sessions.send("alice", s.id, `run: ${probe}`));
  assert.match(r.text, /probe-done/);
  assert.doesNotMatch(r.text, /LEAK-/);
  assert.doesNotMatch(r.text, /NO-PROMOTED/, "the promoted packages directory is readable inside the fence");
});

test("fork: a fork of a promoted package replaces it on install, and uninstalling the fork puts it back", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const s = kernel.sessions.create("alice");
  const forked = await collect(kernel.sessions.send("alice", s.id, "fork: @thetis/hello as hello2"));
  assert.match(forked.text, /forked @thetis\/hello@0\.1\.0 to packages\/hello2 as @alice\/hello2@0\.1\.0-fork\.1; steps: prompt:mark, after:count; tools: greet\./);
  const manifest = JSON.parse(readFileSync(join(us.home, "packages", "hello2", "package.json"), "utf8")) as { name: string; version: string; thetis: { forkedFrom?: unknown } };
  assert.equal(manifest.name, "@alice/hello2");
  assert.deepEqual(manifest.thetis.forkedFrom, { name: "@thetis/hello", version: "0.1.0" });
  assert.ok(!kernel.packages.installed(us).some((p) => p.name === "@alice/hello2"), "fork_package does not install");
  const installed = await collect(kernel.sessions.send("alice", s.id, "install: packages/hello2"));
  assert.match(installed.text, /installed @alice\/hello2@0\.1\.0-fork\.1 \(loader\).*; replaced @thetis\/hello\./);
  const names = kernel.packages.installed(us).map((p) => p.name);
  assert.ok(names.includes("@alice/hello2") && !names.includes("@thetis/hello"), `the fork replaced its origin: ${names.join(", ")}`);
  const info = kernel.packages.installed(us).find((p) => p.name === "@alice/hello2");
  assert.deepEqual(info?.forkedFrom, { name: "@thetis/hello", version: "0.1.0" });
  assert.equal(info?.replaced, "@thetis/hello");
  const rec = kernel.registry.installOf("@alice/hello2", "alice");
  assert.equal(rec?.replaced, "@thetis/hello");
  assert.equal(rec?.replacedSource?.kind, "system");
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  assert.equal(tools.text.split(",").filter((t) => t === "greet").length, 1, `the tool is offered once, by the fork: ${tools.text}`);
  const listed = await collect(kernel.sessions.send("alice", s.id, "packages?"));
  assert.match(listed.text, /@alice\/hello2@0\.1\.0-fork\.1 \(loader\).*fork of @thetis\/hello@0\.1\.0/);
  assert.doesNotMatch(listed.text, /- @thetis\/hello@/);
  const sys = await collect(kernel.sessions.send("alice", s.id, "system?"));
  assert.match(sys.text, /MARKER-FROM-ALICE/, "the fork's step runs");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "fork: @thetis/hello as hello2"))).text, /not installed in your userspace/);
  assert.match((await collect(kernel.sessions.send("alice", s.id, "fork: @alice/hello2 as hello2"))).text, /target exists/);
  const rpc = createRpcHandler(us, kernel);
  await rpc("packages.uninstall", { name: "@alice/hello2" });
  const after = kernel.packages.installed(us).map((p) => p.name);
  assert.ok(after.includes("@thetis/hello") && !after.includes("@alice/hello2"), `the origin is back: ${after.join(", ")}`);
  assert.equal(kernel.registry.get("@alice/hello2"), undefined);
  assert.ok(existsSync(join(us.home, "packages", "hello2", "package.json")), "uninstall keeps the files");
  const again = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  assert.equal(again.text.split(",").filter((t) => t === "greet").length, 1);
});

test("fork with a service: replacing stops the origin and starts the fork; delete removes the files and restarts the origin", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "svc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/svc", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "service", service: { export: "start" } } }));
  writeFileSync(join(dir, "index.js"), `
    export async function start(env) {
      await env.exec("echo started-" + env.config.tag + " >> svc.log");
      return { stop: () => env.exec("echo stopped-" + env.config.tag + " >> svc.log") };
    }
  `);
  kernel.config.packages["@alice/svc"] = { tag: "origin" };
  kernel.config.packages["@alice/svc2"] = { tag: "fork" };
  await kernel.services.boot();
  const log = () => readFileSync(join(us.home, "svc.log"), "utf8").trim().split("\n");
  await kernel.packages.install(us, kernel.users.authorize("alice"), "packages/svc");
  assert.deepEqual(log(), ["started-origin"]);
  const s = kernel.sessions.create("alice");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "fork: @alice/svc as svc2"))).text, /forked @alice\/svc@0\.1\.0 to packages\/svc2 as @alice\/svc2@0\.1\.0-fork\.1; a service\./);
  assert.match((await collect(kernel.sessions.send("alice", s.id, "install: packages/svc2"))).text, /installed @alice\/svc2@0\.1\.0-fork\.1 \(service\); a service; replaced @alice\/svc\./);
  assert.deepEqual(log(), ["started-origin", "stopped-origin", "started-fork"], "the origin stops before the fork starts");
  assert.equal(kernel.registry.installOf("@alice/svc2", "alice")?.replacedSource?.ref, "packages/svc");
  // Delete is about where the files are, not what the package is called: the installation's copy is not under alice's home.
  assert.match((await collect(kernel.sessions.send("alice", s.id, "delete: @thetis/hello"))).text, /error: .*@thetis\/hello does not live under the home directory/);
  const deleted = await collect(kernel.sessions.send("alice", s.id, "delete: @alice/svc2"));
  assert.match(deleted.text, /deleted @alice\/svc2 and its files at .*packages\/svc2; @alice\/svc is back in place\./);
  assert.deepEqual(log(), ["started-origin", "stopped-origin", "started-fork", "stopped-fork", "started-origin"], "the origin's service runs again");
  assert.ok(!existsSync(join(us.home, "packages", "svc2")), "delete removes the directory");
  const names = kernel.packages.installed(us).map((p) => p.name);
  assert.ok(names.includes("@alice/svc") && !names.includes("@alice/svc2"));
  assert.deepEqual(kernel.registry.installOf("@alice/svc", "alice")?.source, { kind: "local", ref: "packages/svc" });
  assert.match((await collect(kernel.sessions.send("alice", s.id, "delete: @alice/svc"))).text, /deleted @alice\/svc and its files at .*packages\/svc\. Live/);
  assert.ok(!existsSync(dir));
  assert.deepEqual(log().at(-1), "stopped-origin");
});

/**
 * An admin makes a package everyone's default while somebody is holding a fork of it. The admin is acting
 * on people who are not at the keyboard, so neither silent answer is good enough: installing over the fork
 * takes a person's own work out of service without telling them, and skipping them quietly leaves the admin
 * believing the package is everywhere when it is not. The sweep therefore installs where it can, leaves the
 * fork alone, and names the people it left alone -- in its answer and in the journal row.
 *
 * The harm being prevented is concrete. `@thetis/hello` brings a tool; before this, both copies were
 * installed and `greet` was offered to the model twice. With a gateway it is worse: two services bind the
 * same `run/web.sock` and the second one wins, so the person's fork stops answering their browser.
 */
test("install for everyone: a person holding a fork keeps it, is named in the answer and the journal, and their tools are still offered once", async () => {
  const control = createControlHandler(kernel);
  const us = kernel.userspaces.pathFor("alice");
  const s = kernel.sessions.create("alice");
  await collect(kernel.sessions.send("alice", s.id, "fork: @thetis/hello as hello3"));
  await collect(kernel.sessions.send("alice", s.id, "install: packages/hello3"));
  assert.ok(!kernel.packages.installed(us).some((p) => p.name === "@thetis/hello"), "the fork displaced the origin");

  const r = (await control("packages.installEveryone", { source: "@thetis/hello" })) as { name: string; userspaces: string[]; forks: { user: string; fork: string }[] };
  assert.equal(r.name, "@thetis/hello");
  assert.ok(r.userspaces.includes("bob") && !r.userspaces.includes("alice"), `everyone who was not holding a fork of it: ${r.userspaces.join(", ")}`);
  assert.deepEqual(r.forks, [{ user: "alice", fork: "@alice/hello3" }], "and the one who was, by name");
  const names = kernel.packages.installed(us).map((p) => p.name);
  assert.ok(names.includes("@alice/hello3") && !names.includes("@thetis/hello"), `alice keeps her fork and only her fork: ${names.join(", ")}`);
  const tools = await collect(kernel.sessions.send("alice", s.id, "tools?"));
  assert.equal(tools.text.split(",").filter((t) => t.trim() === "greet").length, 1, `the tool is offered once, by the fork: ${tools.text}`);
  const rows = kernel.journal.tail(50).filter((row) => row.kind === "package.everyone");
  assert.deepEqual(rows[0]?.data?.forks, [{ user: "alice", fork: "@alice/hello3" }], "an admin reading the journal later sees who was left alone");
  assert.equal(kernel.packages.listFor(us).find((p) => p.name === "@alice/hello3")?.fork?.everyone, true, "and alice's own listing says the package she forked is now everyone's default");

  await control("packages.unfork", { user: "alice", name: "@alice/hello3", deleteFiles: true });
  kernel.packages.markEveryone("@thetis/hello", false);
});

test("mounts: an admin grants a host directory into a person's fence through the host package; the agent reads it and learns it from THETIS_MOUNTS", async () => {
  const fence = kernel.container.get(T.fence) as ProcessFence;
  const dir = mkdtempSync(join(tmpdir(), "thetis-mount-"));
  const control = createControlHandler(kernel);
  // The grant is `host.grants.mountsSet`: a host package the daemon finds among the system packages by its
  // `thetis.host.name`, so the shipped one is linked in beside the fixtures for this test.
  const link = join(kernel.config.systemPackagesDir, "host-grants");
  if (!existsSync(link)) symlinkSync(resolve(PROJECT, "packages", "host-grants"), link);
  try {
    writeFileSync(join(dir, "note.txt"), "from-the-host\n");
    await assert.rejects(control("host.grants.mountsSet", { user: "alice", mounts: [{ path: "relative", mode: "rw" }] }), /invalid mount path/);
    await assert.rejects(control("host.grants.mountsSet", { user: "_system", mounts: [] }), /takes no mounts/);
    await assert.rejects(control("host.grants.nothing", { user: "alice" }), /does not export a method named nothing/);
    // Before the grant the directory is out of reach under bubblewrap.
    if (fence.mode === "bwrap") {
      const before = await collect(kernel.sessions.send("alice", kernel.sessions.create("alice").id, `run: cat ${join(dir, "note.txt")} || echo NOT-YET`));
      assert.match(before.text, /NOT-YET/);
    }
    await control("host.grants.mountsSet", { user: "alice", mounts: [{ path: dir, mode: "ro" }, { path: "/does/not/exist", mode: "rw" }] });
    assert.deepEqual(kernel.userspaces.pathFor("alice").mounts, [{ path: dir, mode: "ro" }, { path: "/does/not/exist", mode: "rw" }]);
    assert.deepEqual(kernel.journal.tail(1, { kind: "host.call" })[0].data, { name: "grants", method: "mountsSet" }, "the kernel wrote the call, without its arguments");
    const s = kernel.sessions.create("alice");
    const probe = `cat ${join(dir, "note.txt")}; echo MOUNTS=$THETIS_MOUNTS; touch ${join(dir, "w")} 2>/dev/null && echo WROTE-RO; echo probe-done`;
    const r = await collect(kernel.sessions.send("alice", s.id, `run: ${probe}`));
    assert.deepEqual(r.errors, []);
    assert.match(r.text, /probe-done/);
    assert.match(r.text, /from-the-host/, "the mounted file is readable inside the fence");
    assert.ok(r.text.includes(`MOUNTS=${JSON.stringify([{ path: dir, mode: "ro" }])}`), `the agent sees the mounts that were bound, not the missing one: ${r.text}`);
    if (fence.mode === "bwrap") assert.doesNotMatch(r.text, /WROTE-RO/, "a ro mount refuses writes");
    const rows = kernel.journal.tail(5, { kind: "mounts", target: "alice" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data, { mounts: [{ path: dir, mode: "ro" }, { path: "/does/not/exist", mode: "rw" }] });
    if (fence.mode === "bwrap") assert.ok(!existsSync(join(dir, "w")), "nothing was written on the host through the ro mount");
    await control("host.grants.mountsSet", { user: "alice", mounts: [] });
    assert.equal(kernel.userspaces.pathFor("alice").mounts, undefined);
    const none = await collect(kernel.sessions.send("alice", s.id, "run: echo MOUNTS=$THETIS_MOUNTS"));
    assert.match(none.text, /MOUNTS=\[\]/, "the variable is set even when nothing is mounted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fence.reload: a service's module graph is read again, which a modification-time import cannot do", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/probe", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "service", service: { export: "start" } } }));
  // The mark lives in a file the entry *imports*. That is the whole point: `loadExport` versions the entry
  // with its modification time, so a change there would be picked up without any of this — a change behind
  // it can only arrive with a new process.
  writeFileSync(join(dir, "index.js"), `
    import { mark } from "./impl.js";
    export async function start(env) { await env.exec("echo " + mark + " >> probe.log"); }
  `);
  writeFileSync(join(dir, "impl.js"), `export const mark = "v1";`);
  const log = () => readFileSync(join(us.home, "probe.log"), "utf8").trim().split("\n");
  const control = createControlHandler(kernel);
  try {
    await kernel.services.boot();
    await kernel.packages.install(us, kernel.users.authorize("alice"), "packages/probe");
    assert.deepEqual(log(), ["v1"]);

    const before = await kernel.fences.handle(us);
    writeFileSync(join(dir, "impl.js"), `export const mark = "v2";`);
    const out = (await control("fence.reload", { user: "alice" })) as { user: string; services: string[] };

    assert.equal(out.user, "alice");
    assert.ok(out.services.includes("@alice/probe"), `the answer names what it restarted: ${out.services.join(", ")}`);
    assert.deepEqual(log(), ["v1", "v2"], "the imported module was read again, so the agent process is a new one");
    await assert.rejects(before.request("ping", {}), /fence/, "a handle taken before the reload is dead");
    assert.match((await collect(kernel.sessions.send("alice", kernel.sessions.create("alice").id, "run: echo after-reload"))).text, /after-reload/, "turns work in the new fence");

    const rows = kernel.journal.tail(20, { kind: "fence.reload", target: "alice" });
    assert.equal(rows.length, 1, "the reload is journaled against the person it reopened");
  } finally {
    await kernel.packages.uninstall(us, "@alice/probe");
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(us.home, "probe.log"), { force: true });
  }
});

test("loaded versions: a list says what the open fence read, status names what a workspace has not loaded, and a person reloads only their own", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "loaded");
  mkdirSync(dir, { recursive: true });
  const onDisk = (version: string) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/loaded", version, type: "module", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(dir, "index.js"), "export const nothing = 1;\n");
  onDisk("0.1.0");
  const control = createControlHandler(kernel);
  const copy = async () => ((await control("packages.list", { user: "alice" })) as PackageInfo[]).find((p) => p.name === "@alice/loaded");
  const changed = async () =>
    ((await control("status", {})) as { workspaces: { user: string; changed: { name: string; loaded: string; onDisk: string }[] }[] }).workspaces.find((w) => w.user === "alice")?.changed;
  const unauthorized = (e: { code?: string }) => e.code === "unauthorized";
  try {
    await kernel.packages.install(us, kernel.users.authorize("alice"), "packages/loaded");
    // The fence that is open read alice's packages before this one existed, so a reload is what makes it one of them.
    await control("fence.reload", { user: "alice" });
    assert.equal((await copy())?.loadedVersion, "0.1.0", "the open fence read the version that was on disk");
    assert.deepEqual(await changed(), [], "nothing has moved under it yet");

    // A version bump on disk and nothing else: no install, no build, no new process.
    onDisk("0.2.0");
    assert.equal((await copy())?.version, "0.2.0", "the list is the disk as it is now");
    assert.equal((await copy())?.loadedVersion, "0.1.0", "and what the fence is holding is what it read");
    assert.deepEqual(await changed(), [{ name: "@alice/loaded", loaded: "0.1.0", onDisk: "0.2.0" }]);

    const forAlice = createRpcHandler(us, kernel, control);
    await assert.rejects(control("fence.reload", { user: "alice", actor: "bob" }), unauthorized, "another person's workspace is an admin's call");
    await assert.rejects(forAlice("operator.fence.reload", { user: "bob" }), /only an admin/, "and a fence cannot ask for one either");
    await assert.rejects(forAlice("operator.users.list", {}), /only an admin/, "the rest of the operator table is unchanged");

    await assert.rejects(forAlice("operator.fence.reload", {}), /only an admin/, "a reload with nobody named is the system fence's, which is nobody's own");
    await forAlice("operator.fence.reload", { user: "alice" });
    assert.equal((await copy())?.loadedVersion, "0.2.0", "a person put their own workspace on the code that is on disk");
    assert.deepEqual(await changed(), []);

    await kernel.fences.close("alice");
    assert.equal((await copy())?.loadedVersion, undefined, "no fence open, so nothing is loaded and nothing is behind");
    assert.deepEqual(await changed(), []);
  } finally {
    await kernel.packages.uninstall(us, "@alice/loaded");
    rmSync(dir, { recursive: true, force: true });
    // Left as this file found it: alice's fence was open when the test started, and tests after it say so.
    await kernel.fences.handle(us);
  }
});

/** Every file and directory under `dir`, for the mode check. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]));
}

test("config.set at the system layer reaches the provider on its next call, with no restart of anything", async () => {
  const control = createControlHandler(kernel);
  const opened = () => ({ ...((kernel.fences as { openedAt?(): Record<string, number> }).openedAt?.() ?? {}) });
  const before = opened();
  // Every service row this file has ever written, not the last fifty: a window that short counts a
  // different stretch of history each time a test above it learns to write one more row, and then this
  // test fails for something that has nothing to do with configuration.
  const rows = () => kernel.journal.tail(1000).filter((r) => r.kind.startsWith("service.")).length;
  const serviceRows = rows();
  const s = kernel.sessions.create("alice");
  assert.equal((await collect(kernel.sessions.send("alice", s.id, "hello"))).text, "echo: hello (t1)");
  const report = (await control("config.set", { name: "@thetis/provider-echo", key: "tag", value: "t2" })) as ConfigReport;
  assert.equal(report.keys.find((k) => k.key === "tag")?.source, "system");
  assert.equal((await collect(kernel.sessions.send("alice", s.id, "hello"))).text, "echo: hello (t2)", "the provider was called with the new value");
  assert.deepEqual(opened(), before, "no fence was reopened");
  assert.equal(rows(), serviceRows, "no service was stopped or started: the provider has none");
  const row = kernel.journal.tail(1, { kind: "config.set" })[0];
  assert.equal(row.target, "_system");
  assert.deepEqual(row.data, { package: "@thetis/provider-echo", key: "tag", layer: "system", secret: false });
  await control("config.unset", { name: "@thetis/provider-echo", key: "tag" });
  assert.equal((await collect(kernel.sessions.send("alice", s.id, "hello"))).text, "echo: hello (t1)", "the file layer shows again");
});

test("config.set on a service package restarts that service in the same fence, with the new configuration", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const control = createControlHandler(kernel);
  const log = () => readFileSync(join(us.home, "svc-config.log"), "utf8").trim().split("\n");
  const openedAt = () => (kernel.fences as { openedAt?(): Record<string, number> }).openedAt?.()?.alice;
  await kernel.packages.install(us, kernel.users.authorize("_system"), "@thetis/config-svc");
  try {
    assert.deepEqual(log(), ['started {"level":"quiet"}'], "the declared default");
    const fence = openedAt();
    assert.ok(fence, "alice's fence is open");
    const rowsBefore = kernel.journal.tail(500, { target: "alice" }).length;
    await control("config.set", { name: "@thetis/config-svc", key: "level", value: "loud", user: "alice" });
    assert.deepEqual(log(), ['started {"level":"quiet"}', "stopped", 'started {"level":"loud"}'], "stopped, then started with the person's value");
    assert.equal(openedAt(), fence, "the fence itself stayed open");
    const rows = kernel.journal.tail(500, { target: "alice" });
    const since = rows.slice(0, rows.length - rowsBefore).filter((r) => r.kind.startsWith("service.")).map((r) => r.kind);
    assert.deepEqual(since, ["service.start", "service.stop"], "newest first: the stop was journaled before the start");
    await assert.rejects(control("config.set", { name: "@thetis/config-svc", key: "level", value: 3, user: "alice" }), /declared string/);
  } finally {
    await kernel.packages.uninstall(us, "@thetis/config-svc");
    rmSync(join(us.home, "svc-config.log"), { force: true });
  }
});

test("storage: a tool keeps a document through env.storage(); another person reads nothing there; delete and removeUser clear it", async () => {
  const s = kernel.sessions.create("alice");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "put: color blue"))).text, /tool said: stored color/);
  assert.match((await collect(kernel.sessions.send("alice", s.id, "get: color"))).text, /tool said: blue/, "a later turn reads it back");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "get: size"))).text, /tool said: nothing/);
  const b = kernel.sessions.create("bob");
  assert.match((await collect(kernel.sessions.send("bob", b.id, "get: color"))).text, /tool said: nothing/, "bob's fence has its own namespace");
  assert.deepEqual(await kernel.store.open("userspaces/alice/@thetis/config-probe/default").get("color"), { value: "blue" }, "under the prefix the kernel built");

  // A package of alice's own, so that delete_package may remove it: what it kept goes with its files.
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "keeper");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/keeper", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(dir, "index.js"), "export const nothing = 1;");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "install: packages/keeper"))).text, /installed @alice\/keeper/);
  const rpc = createRpcHandler(us, kernel);
  await rpc("store.set", { package: "@alice/keeper", key: "note", doc: { kept: true } });
  await rpc("config.set", { name: "@alice/keeper", key: "flag", value: "on" });
  assert.deepEqual(await kernel.store.open("userspaces/alice/@alice/keeper/default").get("note"), { kept: true });
  assert.match((await collect(kernel.sessions.send("alice", s.id, "delete: @alice/keeper"))).text, /deleted @alice\/keeper/);
  assert.equal(await kernel.store.open("userspaces/alice/@alice/keeper/default").get("note"), undefined, "delete_package cleared the package's namespace");
  assert.equal(await kernel.store.open("config/users/alice").get("@alice/keeper"), undefined, "and alice's layer for it");

  kernel.users.create("carol");
  const carol = kernel.sessions.userspaceFor(kernel.users.authorize("carol"));
  await createRpcHandler(carol, kernel)("store.set", { package: "@thetis/config-probe", key: "k", doc: { v: 1 } });
  await createRpcHandler(carol, kernel)("config.set", { name: "@thetis/config-probe", key: "token", value: "tok-carol" });
  await kernel.removeUser("carol");
  assert.equal(await kernel.store.open("userspaces/carol/@thetis/config-probe/default").get("k"), undefined, "removeUser leaves no userspaces/carol namespace");
  assert.equal(await kernel.store.open("secrets/users/carol").get("@thetis/config-probe"), undefined, "nor a layer");
  assert.equal(kernel.users.get("carol"), undefined);
});

test("removeUser forgets the password and the tokens, so the id comes back as an account with no password", async () => {
  kernel.users.create("dave");
  await kernel.auth.setPassword("dave", "hunter2");
  const session = (await kernel.auth.login("dave", "hunter2"))!;
  assert.equal(kernel.auth.authenticate(session.token)?.id, "dave", "signed in");
  const records = kernel.container.get(T.records);
  assert.equal(records.credentials.has("dave"), true);
  assert.equal(records.tokens.all().filter(([, rec]) => rec.user === "dave").length, 1);
  // What `ssh.keygen` would have left on the host for them, which no store namespace knows about.
  const keys = join(kernel.config.home, "fence-keys", "dave");
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(keys, "id_ed25519"), "stand-in for the private half\n");

  await kernel.removeUser("dave");
  assert.equal(existsSync(keys), false, "the keys the host held for them went with them, so a re-added id is not handed one");
  assert.equal(records.credentials.has("dave"), false, "removeUser took the password with the user");
  assert.deepEqual(records.tokens.all().filter(([, rec]) => rec.user === "dave"), [], "and every token naming them");
  await records.credentials.flush();
  await records.tokens.flush();
  assert.equal(await kernel.store.open("auth/credentials", { private: true }).get("dave"), undefined, "the deletions reached the store, not only the mirror");
  assert.equal(await kernel.store.open("auth/tokens", { private: true }).get(session.token), undefined, "no orphan token document is left behind");

  // The reason this matters: the id is free again, and whoever is given it next is a different person.
  kernel.users.create("dave");
  assert.equal(kernel.auth.hasPassword("dave"), false, "the new account has no password, which is what the sign-in page tells them");
  assert.equal(await kernel.auth.login("dave", "hunter2"), undefined, "the old password does not open it");
  assert.equal(kernel.auth.authenticate(session.token), undefined, "and the old token is not a live session again");
  await kernel.removeUser("dave");
});

test("nothing under the data directory is still named after a removed user", async () => {
  // `removeUser` is a hand-maintained list of everything keyed by a person, and nothing fails when a new
  // per-user namespace or per-user directory is added and forgotten there. That is not hypothetical: it is
  // how the password and the live tokens were left behind, and then how `fence-keys/<id>` was left behind
  // after that -- private key material, which `ssh.keygen` would have handed to whoever was given the id
  // next. So this asserts the shape rather than the list: after a removal, no file or directory under the
  // data directory is named after them. It is blunt on purpose. A new leak has to be of a kind that does
  // not put the id in a path to get past it, and the next person to add one does not have to remember.
  const id = "erin";
  kernel.users.create(id);
  await kernel.auth.setPassword(id, "hunter2");
  await kernel.auth.login(id, "hunter2");
  const us = kernel.userspaces.pathFor(id);
  for (const dir of ["fence-keys", "fence-ssh"]) {
    mkdirSync(join(kernel.config.home, dir, id), { recursive: true });
    writeFileSync(join(kernel.config.home, dir, id, "something"), "held for them by the host\n");
  }
  kernel.sessions.create(id);
  assert.ok(existsSync(us.home), "they had a userspace to begin with");

  await kernel.removeUser(id);
  await Promise.all(Object.values(kernel.container.get(T.records)).map((m: { flush(): Promise<void> }) => m.flush()));

  const named: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === id) named.push(join(dir, entry.name));
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === `${id}.toml` || entry.name === `${id}.json`) named.push(join(dir, entry.name));
    }
  };
  walk(kernel.config.home);
  assert.deepEqual(named, [], `these were left behind by removeUser:\n${named.join("\n")}`);
});

test("a secret set over RPC reaches the tool and nothing else: not the reply, not config.show, not the journal", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const rpc = createRpcHandler(us, kernel);
  const s = kernel.sessions.create("alice");
  const before = JSON.parse((await collect(kernel.sessions.send("alice", s.id, "config?"))).text.replace(/^tool said: /, "")) as Record<string, unknown>;
  assert.deepEqual(before, { greeting: "hi" }, "the declared default, and no token yet");
  const shown = (await rpc("config.show", { name: "@thetis/config-probe" })) as ConfigReport;
  assert.equal(shown.broken, true);
  assert.equal(shown.summary, "token is required and not set");
  await assert.rejects(rpc("config.set", { name: "@thetis/config-probe", key: "mode", value: "x" }), (e: { code: string }) => e.code === "unauthorized", "a system-scoped key is not a person's to set");
  await assert.rejects(rpc("config.show", { name: "@thetis/provider-echo" }), (e: { code: string }) => e.code === "not-found", "not installed in alice's fence");
  const reply = (await rpc("config.set", { name: "@thetis/config-probe", key: "token", value: "tok-alice" })) as ConfigReport;
  const token = reply.keys.find((k) => k.key === "token")!;
  assert.equal(token.state, "set");
  assert.equal(token.source, "user");
  assert.equal(token.value, undefined);
  assert.equal(token.redacted, true);
  assert.equal(reply.broken, false);
  assert.ok(!JSON.stringify(await rpc("config.show", { name: "@thetis/config-probe" })).includes("tok-alice"));
  assert.ok(!JSON.stringify(kernel.journal.tail(5, { kind: "config.set" })).includes("tok-alice"));
  const after = JSON.parse((await collect(kernel.sessions.send("alice", s.id, "config?"))).text.replace(/^tool said: /, "")) as Record<string, unknown>;
  assert.deepEqual(after, { greeting: "hi", token: "tok-alice" }, "the tool receives it on the next turn");
  assert.deepEqual(await rpc("config.effective", { name: "@thetis/config-probe" }), { greeting: "hi", token: "tok-alice" });
  const bob = JSON.parse((await collect(kernel.sessions.send("bob", kernel.sessions.create("bob").id, "config?"))).text.replace(/^tool said: /, "")) as Record<string, unknown>;
  assert.deepEqual(bob, { greeting: "hi" }, "alice's layer is alice's");
  await createControlHandler(kernel)("config.set", { name: "@thetis/config-probe", key: "mode", value: "strict" });
  assert.deepEqual(await rpc("config.effective", { name: "@thetis/config-probe" }), { greeting: "hi", token: "tok-alice", mode: "strict" }, "an admin's system-scoped key reaches everyone");
});

test("a fork inherits its origin's configuration: the report says so, and its tool receives the origin's key", async () => {
  const us = kernel.userspaces.pathFor("alice");
  const s = kernel.sessions.create("alice");
  assert.match((await collect(kernel.sessions.send("alice", s.id, "fork: @thetis/config-probe as probe2"))).text, /forked @thetis\/config-probe/);
  assert.match((await collect(kernel.sessions.send("alice", s.id, "install: packages/probe2"))).text, /replaced @thetis\/config-probe/);
  try {
    const report = (await createControlHandler(kernel)("config.show", { name: "@alice/probe2", user: "alice" })) as ConfigReport;
    assert.deepEqual(report.inherits, ["@thetis/config-probe"]);
    const token = report.keys.find((k) => k.key === "token")!;
    assert.equal(token.inheritedFrom, "@thetis/config-probe");
    assert.equal(token.source, "user");
    assert.equal(token.value, undefined);
    assert.equal(report.keys.find((k) => k.key === "mode")?.inheritedFrom, "@thetis/config-probe");
    const seen = JSON.parse((await collect(kernel.sessions.send("alice", s.id, "config?"))).text.replace(/^tool said: /, "")) as Record<string, unknown>;
    assert.deepEqual(seen, { greeting: "hi", token: "tok-alice", mode: "strict" }, "the fork's tool runs with the origin's configuration");
  } finally {
    await kernel.packages.uninstall(us, "@alice/probe2");
  }
});

test("the store keeps credentials, tokens and secrets unreadable to anyone else", async (t) => {
  if (!REAL_DRIVER) return t.skip("the memory store has no files");
  const root = join(home, "data", "store");
  for (const dir of ["auth", "secrets"]) {
    const entries = walk(join(root, dir));
    assert.ok(entries.length > 0, `${dir} has files`);
    for (const path of entries) assert.equal(statSync(path).mode & 0o077, 0, `${path} is private`);
  }
  assert.ok(existsSync(join(root, "users", "alice.toml")), "one document per record");
});

test("migrate: a data directory with the four legacy files refuses to start, imports once, and never twice", async (t) => {
  if (!REAL_DRIVER) return t.skip("migrate needs the shipped driver");
  const legacy = mkdtempSync(join(tmpdir(), "thetis-legacy-"));
  try {
    const config = defaultConfig(join(legacy, "data"), PROJECT);
    config.systemPackagesDir = join(home, "system-packages");
    config.systemPackages = { "*": [], _system: [] };
    config.fence.sandbox = "none";
    mkdirSync(config.home);
    const token = "ab".repeat(32);
    const stamp = new Date().toISOString();
    writeFileSync(join(config.home, "users.json"), JSON.stringify({ _system: { id: "_system", role: "system", status: "active", createdAt: stamp }, alice: { id: "alice", role: "admin", status: "active", createdAt: stamp } }));
    writeFileSync(join(config.home, "auth.json"), JSON.stringify({ credentials: { alice: { salt: "00".repeat(16), hash: "11".repeat(64) } }, tokens: { [token]: { user: "alice", createdAt: stamp } } }));
    writeFileSync(join(config.home, "registry.json"), JSON.stringify({ "@thetis/harness-core": { name: "@thetis/harness-core", version: "0.1.0", type: "harness", owner: "_system", source: { kind: "system", ref: resolve(PROJECT, "packages/harness-core") }, userspaces: ["alice"] } }));
    writeFileSync(join(config.home, "mounts.json"), JSON.stringify({ alice: [{ path: "/srv/x", mode: "ro" }], bob: [] }));
    const quiet = (c: Parameters<NonNullable<Parameters<typeof createKernel>[1]>>[0]) => c.bind(T.log, () => () => {});
    await assert.rejects(createKernel(config, quiet), (e: { code: string; message: string }) => e.code === "invalid" && /run `thetis migrate`/.test(e.message));
    const first = await migrateStore(config, () => {});
    assert.deepEqual(first, { imported: { "users.json": 2, "auth.json": 2, "registry.json": 1, "mounts.json": 1 }, skipped: [] });
    for (const f of ["users.json", "auth.json", "registry.json", "mounts.json"]) {
      assert.ok(!existsSync(join(config.home, f)), `${f} is gone`);
      assert.ok(existsSync(join(config.home, `${f}.migrated`)), `${f}.migrated is there`);
    }
    const migrated = await createKernel(config, quiet);
    try {
      assert.equal(migrated.users.get("alice")?.role, "admin");
      assert.equal(migrated.auth.authenticate(token)?.id, "alice", "the token still signs alice in");
      // The legacy one-owner record was rewritten into one entry per workspace when the registry opened.
      assert.deepEqual(migrated.registry.get("@thetis/harness-core")?.installs, { alice: { version: "0.1.0", type: "harness", source: { kind: "system", ref: resolve(PROJECT, "packages/harness-core") } } });
      assert.deepEqual(migrated.registry.holders("@thetis/harness-core"), ["alice"]);
      assert.deepEqual(migrated.mounts.get("alice"), [{ path: "/srv/x", mode: "ro" }]);
      assert.deepEqual(migrated.mounts.get("bob"), [], "an empty list was not imported as a document");
    } finally {
      await migrated.shutdown();
    }
    assert.deepEqual(await migrateStore(config, () => {}), { imported: {}, skipped: ["users.json", "auth.json", "registry.json", "mounts.json"] }, "a second run imports nothing");
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

test("structured input, scoped assets and opaque output cross real fences, replay and persistence", async () => {
  const { kernelClient } = await import("../../src/lib/kernel-client.js");
  const client = kernelClient(createRpcHandler(kernel.userspaces.pathFor("alice"), kernel));
  const bobs = kernelClient(createRpcHandler(kernel.userspaces.pathFor("bob"), kernel));
  const photo = await client.assets.put({ mediaType: "image/png", data: "AP8q", name: "sample.png" });
  await assert.rejects(bobs.assets.read(photo.id), { code: "not-found" });
  const opaque = { id: "mesh", type: "@example/mesh.v17", data: { vertices: [1, 2, 3], material: null } };
  const attachment = { id: "image", type: "asset", data: { id: photo.id, mediaType: photo.mediaType, name: photo.name! } };
  const input = { id: "request", role: "user" as const, content: [{ type: "text", data: { text: "rich?" } }, attachment, opaque], extensions: { "@example/meta": { future: null } } };
  const session = await client.sessions.create();
  const life = new AbortController();
  const replay: import("../../src/contracts/index.js").WatchedTurnEvent[] = [];
  let watch: Promise<void> | undefined;
  const result = await collect(kernel.sessions.send("alice", session.id, input));
  assert.deepEqual(result.errors, []);
  const message = result.all.find((event) => event.type === "message");
  assert.ok(message?.type === "message");
  assert.deepEqual(message.message, { role: "assistant", id: "rich-response", content: [attachment, opaque] });
  const record = await client.sessions.inspect(session.id);
  assert.deepEqual(record.conversation[0].content.slice(0, 3), input.content);
  assert.deepEqual(record.conversation[0].extensions, input.extensions);
  assert.deepEqual(record.conversation[1], message.message);
  const disk = JSON.parse(readFileSync(join(kernel.userspaces.pathFor("alice").sessions, `${session.id}.json`), "utf8"));
  assert.deepEqual(disk.conversation, record.conversation);
  const made = result.all.find((event) => event.type === "extension" && event.name === "@test/asset-created");
  assert.ok(made?.type === "extension");
  const generated = made.data as { id: string };
  assert.equal((await client.assets.read(generated.id)).data, "AP8q", "provider output belongs to its caller");
  await assert.rejects(bobs.assets.read(generated.id), { code: "not-found" });
  for await (const event of kernel.sessions.send("alice", session.id, input)) {
    if (event.type === "content.start" && !watch) watch = kernel.sessions.watch("alice", (event) => replay.push(event), life.signal);
  }
  life.abort();
  await watch;
  assert.deepEqual(replay[0].messages, [input], "late watchers receive complete structured input");
  assert.ok(replay.some((m) => m.event.type === "content.end" && m.event.part.type === opaque.type));
  const complete = await client.sessions.complete(session.id, input);
  assert.deepEqual(complete.content, [attachment, opaque]);
  assert.equal(await client.sessions.askText(session.id, "hello"), "echo: hello (t1)");
});

test("a malformed structured stream fails the turn without crashing its fence or kernel", async () => {
  const session = kernel.sessions.create("alice");
  const result = await collect(kernel.sessions.send("alice", session.id, "bad-stream?"));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unopened part/);
  assert.equal(await kernel.sessions.askText("alice", session.id, "hello"), "echo: hello (t1)");
});

test("malformed step return values fail across a real fence before becoming empty results", async () => {
  const session = kernel.sessions.create("alice");
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "malformed-step");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@alice/malformed-step", version: "1.0.0", type: "module", main: "index.js",
    thetis: { type: "loader", steps: [{ id: "malformed", phase: "prompt", export: "run" }] },
  }));
  writeFileSync(join(dir, "index.js"), `export const run = (ctx) => ({ false: false, true: true, number: 3, string: "oops", array: [], null: null })[ctx.turn.input[0].content[0].data.text];`);
  await kernel.packages.install(us, kernel.users.authorize("alice"), "packages/malformed-step");
  try {
    for (const input of ["null", "void"]) {
      const result = await collect(kernel.sessions.send("alice", session.id, input));
      assert.deepEqual(result.errors, [], `${input} is a valid no-op`);
    }
    for (const input of ["false", "true", "number", "string", "array"]) {
      const result = await collect(kernel.sessions.send("alice", session.id, input));
      const failures = result.all.filter((event) => event.type === "error");
      assert.equal(failures.length, 1, `${input} must fail as a step result`);
      assert.equal(failures[0].code, "step");
      assert.match(failures[0].message, /invalid result/);
      assert.equal(result.all.at(-1)?.type, "turn.end");
      assert.equal(kernel.sessions.inspect("alice", session.id).status, "idle");
    }
  } finally {
    await kernel.packages.uninstall(us, "@alice/malformed-step");
  }
  assert.equal(await kernel.sessions.askText("alice", session.id, "hello"), "echo: hello (t1)", "the same fence remains usable");
});
