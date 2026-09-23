import { AssetAccess } from "../../src/kernel/assets.js";
import { FileAssetStore } from "../../src/lib/assets.js";
import { textContent, contentText } from "@thetis/runtime/lib/content";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fences, Manifest, Message, PackageInfo, SessionRecord, StoreDriver, TurnEvent, UserRecord, Userspace, WatchedTurnEvent } from "../../src/contracts/index.js";
import { LayeredConfig } from "../../src/lib/config.js";
import { Journal } from "../../src/lib/journal.js";
import { SessionStore } from "../../src/lib/session-store.js";
import { RestartLatch, type ArmResult, type FireReport, type RestartState } from "../../src/lib/restart.js";
import { cloneDirFor, forkPackage } from "../../src/lib/pkg-fs.js";
import { memoryStore, StoreMirror } from "../../src/lib/store.js";
import { UserspaceLayout } from "../../src/lib/userspace-layout.js";
import { UserStore } from "../../src/kernel/users.js";
import { AuthService } from "../../src/kernel/auth.js";
import { ProviderRegistry } from "../../src/kernel/providers.js";
import { ServiceSupervisor } from "../../src/kernel/services.js";
import { ConfigService, type ConfigChange } from "../../src/kernel/settings.js";
import { PackageManager } from "../../src/kernel/packages/manager.js";
import { PackageRegistry } from "../../src/kernel/packages/registry.js";
import { validateManifest } from "../../src/kernel/packages/manifest.js";
import { Enumerator } from "../../src/kernel/pipeline/enumerator.js";
import { defaultConfig, saveConfig, loadConfig, packagesLayer } from "../../src/kernel/config.js";
import { createControlHandler, redact } from "../../src/kernel/control.js";
import { createRpcHandler, type RpcServices } from "../../src/kernel/rpc.js";
import { SessionApi, SESSION_ID } from "../../src/kernel/sessions/api.js";
import { PipelineRunner } from "../../src/kernel/pipeline/runner.js";
import type { KernelServices } from "../../src/kernel/kernel.js";

const tmp = () => mkdtempSync(join(tmpdir(), "thetis-unit-"));
const mirror = <T extends object>(driver: StoreDriver, ns: string) => StoreMirror.open<T>(driver.open(ns, { private: ns.startsWith("auth/") }));
/** What a dispatch site sees of the configuration when the test is not about it. */
const noSettings = { effective: async () => ({}) };
const code = (want: string) => (e: { code?: string }) => e.code === want;

test("user store: create, moderate, authorize", async () => {
  const driver = memoryStore();
  const docs = await mirror<UserRecord>(driver, "users");
  const users = new UserStore(docs);
  assert.ok(users.get("_system"));
  users.create("alice");
  assert.throws(() => users.create("Alice"), /invalid user id/);
  assert.throws(() => users.create("alice"), /already exists/);
  users.setStatus("alice", "suspended");
  assert.throws(() => users.authorize("alice"), /suspended/);
  users.setStatus("alice", "active");
  assert.equal(users.setRole("alice", "admin").role, "admin");
  assert.throws(() => users.remove("_system"), /system user/);
  await docs.flush();
  assert.equal(new UserStore(await mirror<UserRecord>(driver, "users")).get("alice")?.role, "admin", "persists in the store");
  users.remove("alice");
  assert.equal(users.get("alice"), undefined);
});

test("manifest validation rejects unscoped names, a missing thetis field, and a bad config declaration", () => {
  assert.throws(() => validateManifest({ name: "foo", version: "1", thetis: { type: "tool" } }), /scoped/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1" } as never), /thetis/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x" } as never] } }), /phase/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x", phase: "prompt", export: "x" }] } }));
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "nope" } } } as never }), /@a\/foo: thetis\.config\.key: type must be one of/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "number", default: "x" } } } as never }), /default/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "string", secret: true, required: true } } } }));
});

const pkgs: PackageInfo[] = [
  { name: "@a/mem", version: "1", type: "memory", description: "", root: "/x", thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }, { id: "save", phase: "after", export: "save" }] } },
  { name: "@a/hist", version: "1", type: "loader", description: "", root: "/y", thetis: { type: "loader", steps: [{ id: "trim", phase: "history", export: "trim" }] } },
];

test("default enumerator schedules declared steps by phase in install order, and nothing of the kernel's own", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  const plan = e.defaultPlan(pkgs).map((s) => `${s.phase}:${s.export}`);
  assert.deepEqual(plan, ["history:trim", "prompt:load", "after:save"]);
  assert.deepEqual(e.defaultPlan(pkgs)[0], { package: "@a/hist", export: "trim", id: "@a/hist#trim", phase: "history" });
  const harness = { ...pkgs[0], name: "@a/harness", thetis: { type: "harness", steps: [{ id: "call", phase: "execute", export: "call" }] } } as PackageInfo;
  const withCall = e.defaultPlan([...pkgs, harness]).map((s) => `${s.phase}:${s.export}`);
  assert.deepEqual(withCall, ["history:trim", "prompt:load", "execute:call", "after:save"], "the model call is a package's step in the execute phase");
  assert.deepEqual(defaultConfig("/tmp/h", "/tmp/p").phases, ["history", "prompt", "tools", "call", "execute", "after"]);
  assert.equal("callPhase" in defaultConfig("/tmp/h", "/tmp/p"), false);
});

test("enumerator output is validated against declared package steps only", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  assert.throws(() => e.validate([{ package: "@a/mem", export: "nope" }], pkgs), /undeclared/);
  assert.throws(() => e.validate({} as never, pkgs), /array/);
  assert.throws(() => e.validate([{ package: "@thetis/runtime/kernel", export: "provider-call" }], pkgs), /undeclared/, "the kernel declares no step, so nothing can schedule one of it");
  const ok = e.validate([{ package: "@a/hist", export: "trim" }, { package: "@a/mem", export: "save", id: "mine", phase: "after" }], pkgs);
  assert.deepEqual(ok, [
    { package: "@a/hist", export: "trim", id: "@a/hist#trim", phase: undefined },
    { package: "@a/mem", export: "save", id: "mine", phase: "after" },
  ]);
});

/** A runner over recorded fences: what each step was sent, and what it streams back. */
function runner(home: string, plan: PackageInfo[], step: (payload: { package: string; export: string; ctx: { config: unknown } }, emit: (e: unknown) => void, signal?: AbortSignal) => Promise<unknown>) {
  const sent: { package: string; export: string; config: unknown }[] = [];
  const fences = {
    request: async (_us: Userspace, op: string, payload: { package: string; export: string; ctx: { config: unknown } }, onEvent?: (e: unknown) => void, signal?: AbortSignal) => {
      assert.equal(op, "step", "every step is the fence's; the kernel runs none itself");
      sent.push({ package: payload.package, export: payload.export, config: payload.ctx.config });
      return step(payload, (e) => onEvent?.(e), signal);
    },
  } as unknown as Fences;
  const config = defaultConfig(home, "/proj");
  const packages = { installed: () => plan } as unknown as PackageManager;
  const settings = { effective: async (_us: Userspace, name: string) => ({ for: name }) };
  const store = new SessionStore(SESSION_ID);
  const r = new PipelineRunner(config, settings, new Enumerator(config, fences), packages, fences, store, new Journal(home));
  const us = new UserspaceLayout(home).ensure("bob");
  const session: SessionRecord = { id: "s_1", user: "bob", createdAt: "0", updatedAt: "0", turns: 0, conversation: [], harness: {} };
  return { r, us, session, sent, store };
}

test("runner: a step's events are the turn's, with its package's configuration, usage summed and the first error kept; a cancel during the last step ends in one cancelled event", async () => {
  const home = tmp();
  try {
    const harness = { ...pkgs[0], name: "@a/harness", thetis: { type: "harness", steps: [{ id: "call", phase: "execute", export: "call" }] } } as PackageInfo;
    const control = new AbortController();
    const { r, us, session, sent, store } = runner(home, [pkgs[1], harness], async (payload, emit, signal) => {
      if (payload.export === "trim") return undefined;
      emit({ type: "text", delta: "hel" });
      emit({ type: "usage", usage: { tokens: 3 } });
      emit({ type: "error", message: "first", code: "provider" });
      emit({ type: "error", message: "second" });
      emit({ type: "usage", usage: { tokens: 4 } });
      control.abort();
      assert.ok(signal?.aborted, "the step's signal is the turn's");
      // A step returns what it has on cancel; the runner, not the step, says the turn was cancelled.
      return { conversation: [{ role: "user", content: "go" }, { role: "assistant", content: "hel" }] };
    });
    const events: TurnEvent[] = [];
    await r.runTurn(us, session, [{ role: "user", content: textContent("go") }], (e) => events.push(e), control.signal);
    assert.deepEqual(sent, [{ package: "@a/hist", export: "trim", config: { for: "@a/hist" } }, { package: "@a/harness", export: "call", config: { for: "@a/harness" } }]);
    assert.deepEqual(events.map((e) => e.type), ["turn.start", "step.start", "step.end", "step.start", "text", "usage", "error", "error", "usage", "step.end", "error", "turn.end"]);
    const errors = events.filter((e): e is Extract<TurnEvent, { type: "error" }> => e.type === "error").map((e) => e.code);
    assert.deepEqual(errors, ["provider", undefined, "cancelled"], "the step's own errors are relayed as they are, and the cancel is one event after the last step");
    const saved = store.load(us.sessions, "s_1");
    assert.deepEqual(saved?.conversation.map((m) => contentText(m.content)), ["go", "hel"], "what the step returned before the cancel is kept");
    assert.equal(saved?.turn, undefined);
    const [end] = new Journal(home).tail(1, { kind: "turn.end" });
    const data = end.data as { reported: unknown; error: { code?: string } };
    assert.deepEqual(data.reported, { tokens: 7 }, "usage is summed across a step's reports");
    assert.equal(data.error.code, "provider", "the first error is the turn's failure");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const [name, result] of Object.entries({
  "invalid call": { conversation: [], call: { model: 123, messages: [] } },
  "invalid harness": { conversation: [], harness: [] },
  "null call": { conversation: [], call: null },
  "null harness": { conversation: [], harness: null },
  "array result": [],
  "invalid tool arguments": { conversation: [{ role: "assistant", content: [], toolCalls: [{ id: "t", name: "read", args: [] }] }] },
  "invalid tools": { conversation: [], call: { model: "test", messages: [], tools: [{ name: 42 }], params: {} } },
  "invalid params": { conversation: [], call: { model: "test", messages: [], tools: [], params: [] } },
})) {
  test(`regression: a step with ${name} preserves the conversation and harness`, async () => {
    const home = tmp();
    try {
      const { r, us, session, store } = runner(home, [pkgs[1]], async () => result);
      session.conversation = [{ role: "user", content: textContent("previous request") }, { role: "assistant", content: textContent("previous response") }];
      session.harness = { remembered: true };
      const input: Message[] = [{ role: "user", content: textContent("new request") }];
      const expected = [...session.conversation, ...input];
      const events: TurnEvent[] = [];
      await r.runTurn(us, session, input, (event) => events.push(event));
      assert.ok(events.some((event) => event.type === "error" && event.code === "step"));
      const saved = store.load(us.sessions, session.id)!;
      assert.deepEqual(saved.conversation, expected, "a rejected result cannot change persisted history");
      assert.deepEqual(saved.harness, { remembered: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("a malformed step event is rejected before reaching subscribers or usage accounting", async () => {
  const home = tmp();
  try {
    const { r, us, session } = runner(home, [pkgs[1]], async (_payload, emit) => {
      emit({ type: "usage", usage: { tokens: "many" } });
    });
    const events: TurnEvent[] = [];
    await r.runTurn(us, session, [], event => events.push(event));
    assert.ok(events.some(event => event.type === "error" && event.code === "step"));
    assert.equal(events.some(event => event.type === "usage"), false);
    assert.deepEqual(new Journal(home).tail(1)[0].data?.reported, {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("auth: passwords, tokens, expiry, and revocation", async () => {
  const driver = memoryStore();
  const users = new UserStore(await mirror(driver, "users"));
  users.create("alice");
  const credentials = await mirror<{ salt: string; hash: string }>(driver, "auth/credentials");
  const tokens = await mirror<{ user: string; createdAt: string }>(driver, "auth/tokens");
  const auth = new AuthService(credentials, tokens, users, 200);
  await assert.rejects(auth.setPassword("nobody", "x"), /unknown user/);
  await assert.rejects(auth.setPassword("_system", "x"), /cannot sign in/);
  await assert.rejects(auth.setPassword("alice", ""), /empty/);
  assert.equal(await auth.login("alice", "secret"), undefined, "no password yet");
  await auth.setPassword("alice", "secret");
  assert.equal(await auth.login("alice", "wrong"), undefined);
  assert.equal(await auth.login("nobody", "secret"), undefined);
  const login = await auth.login("alice", "secret");
  assert.ok(login && /^[a-f0-9]{64}$/.test(login.token));
  assert.equal(auth.authenticate(login!.token)?.id, "alice");
  await tokens.flush();
  const reopened = new AuthService(await mirror(driver, "auth/credentials"), await mirror(driver, "auth/tokens"), users);
  assert.equal(reopened.authenticate(login!.token)?.id, "alice", "tokens persist");
  users.setStatus("alice", "suspended");
  // A suspension is a gate, not a revocation: the tokens stay, and `authorize` -- which both `authenticate`
  // and `login` go through -- refuses them for as long as it lasts. Lifting the suspension is meant to give
  // the person back exactly what they had, so nothing here destroys anything. Removal is the opposite: see
  // `forget` below, and `removeUser` in src/host/kernel.ts.
  assert.equal(auth.authenticate(login!.token), undefined, "a suspended user's token is refused");
  assert.equal(await auth.login("alice", "secret"), undefined);
  users.setStatus("alice", "active");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(auth.authenticate(login!.token), undefined, "expired");
  const again = (await auth.login("alice", "secret"))!;
  await auth.setPassword("alice", "other");
  assert.equal(auth.authenticate(again.token), undefined, "a new password revokes tokens");
  const last = (await auth.login("alice", "other"))!;
  auth.logout(last.token);
  assert.equal(auth.authenticate(last.token), undefined);

  // What the host does on `users remove`: nothing keyed to the id may outlive it, because the id can be added back.
  const live = (await auth.login("alice", "other"))!;
  auth.forget("alice");
  assert.equal(auth.hasPassword("alice"), false, "forget takes the password");
  assert.equal(auth.authenticate(live.token), undefined, "and the sessions it had issued");
  assert.equal(await auth.login("alice", "other"), undefined, "so the old password signs nobody in");
  assert.deepEqual(tokens.all().filter(([, rec]) => rec.user === "alice"), [], "and no record in the namespace still names the user");
});

test("config: the promoted packages directory is derived and secrets are redacted for display", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    assert.equal(cfg.promotedPackagesDir, join(home, "packages"));
    assert.equal(cfg.envFile, join("/proj", ".env"));
    assert.equal(cfg.storage.driver, "@thetis/store-toml");
    assert.ok(cfg.fence.readOnly.includes(join(home, "packages")));
    cfg.packages["@thetis/provider-openrouter"] = { apiKey: "sk-live", baseUrl: "https://x", headers: { Authorization: "Bearer t" } };
    saveConfig(cfg);
    const raw = JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
    assert.equal(raw.promotedPackagesDir, undefined);
    assert.equal(raw.envFile, undefined, "derived, so it is not written while it is the default");
    assert.equal(loadConfig(home, "/other").promotedPackagesDir, join(home, "packages"));
    assert.equal(loadConfig(home, "/proj").envFile, join("/proj", ".env"), "the default is the checkout's, which is where the installer puts the key");

    // A data directory may own its environment, because otherwise a second one under the same checkout
    // silently runs on the first one's provider key. Kept relative to the home, so a moved checkout is fine.
    cfg.envFile = join(home, ".env");
    saveConfig(cfg);
    assert.equal(JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8")).envFile, ".env", "written relative to the home");
    assert.equal(loadConfig(home, "/proj").envFile, join(home, ".env"), "and read back against it, whatever the checkout is");
    assert.equal(loadConfig(home, "/elsewhere").envFile, join(home, ".env"));
    const shown = redact(cfg);
    assert.equal(shown.packages["@thetis/provider-openrouter"].apiKey, "•••");
    assert.equal(shown.packages["@thetis/provider-openrouter"].baseUrl, "https://x");
    assert.equal(shown.model, cfg.model);
    assert.deepEqual(shown.phases, cfg.phases);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: packages keep their ${VAR} references while the rest is interpolated, and packagesLayer reads the file again", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    cfg.model = "${MODEL}";
    cfg.packages["@thetis/exa"] = { apiKey: "${EXA_KEY}" };
    saveConfig(cfg);
    const loaded = loadConfig(home, "/proj", { MODEL: "m1", EXA_KEY: "sk" });
    assert.equal(loaded.model, "m1");
    assert.equal(loaded.packages["@thetis/exa"].apiKey, "${EXA_KEY}", "the config service resolves these at read time");
    assert.equal(loaded.packages["@thetis/provider-openrouter"], undefined, "the kernel compiles in no package's defaults; a manifest declares them");
    assert.deepEqual(packagesLayer(home), { "@thetis/exa": { apiKey: "${EXA_KEY}" } }, "the file layer is the file and nothing under it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: the kernel knows no package by name: a fresh install's file layer is empty", () => {
  const cfg = defaultConfig("/tmp/h", "/tmp/p");
  assert.deepEqual(cfg.packages, {});
  assert.ok(cfg.systemPackages._system?.includes("@thetis/marketplace"), "which packages run is a list of names; what they need is theirs to declare");
  assert.deepEqual(packagesLayer("/nonexistent/home"), {});
});

test("config: a registry url survives being saved and read back, so an operator can replace it", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    cfg.packages["@thetis/marketplace"] = { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] };
    saveConfig(cfg);
    const back = loadConfig(home, "/proj");
    assert.deepEqual(back.packages["@thetis/marketplace"], { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A supervisor over one service package, with every fence operation and journal row recorded. `fail` makes
 *  the next `service.start` throw, as a service whose module graph will not load does. */
async function supervisor(home: string) {
  const order: string[] = [];
  const configs: unknown[] = [];
  let failure: string | undefined;
  const started = (op: string) => {
    if (op === "service.start" && failure) throw new Error(failure);
    return "started";
  };
  const pkg = { name: "@x/svc", version: "1", type: "service", description: "", root: "/x", thetis: { type: "service", service: { export: "startService" } } } as PackageInfo;
  const packages = { installed: () => [pkg], seedSystem: () => order.push("seed") } as unknown as PackageManager;
  const handle = { request: async (op: string) => (order.push(`${op}:${pkg.name}`), started(op)), close: async () => {} };
  const fences = {
    close: async (id?: string) => void order.push(`close:${String(id)}`),
    handle: async (us: Userspace) => (order.push(`open:${us.id}`), handle),
    request: async (_us: Userspace, op: string, payload: { config?: unknown }) => (order.push(`${op}:${pkg.name}`), configs.push(payload.config), started(op)),
  } as unknown as Fences;
  const userspaces = new UserspaceLayout(home);
  userspaces.ensure("alice");
  const journal = new Journal(home);
  const settings = { effective: async (_us: Userspace, name: string) => ({ for: name }) };
  const sup = new ServiceSupervisor(settings, new UserStore(await mirror(memoryStore(), "users")), userspaces, packages, fences, () => {}, journal);
  return { sup, order, configs, journal, pkg, packages, userspaces, fail: (why?: string) => void (failure = why) };
}

test("services.reload closes the fence first, then opens a new one and starts the services on it", async () => {
  const home = tmp();
  try {
    const { sup, order } = await supervisor(home);
    await sup.boot();
    order.length = 0;
    await sup.reload("alice");
    assert.deepEqual(order, ["close:alice", "open:alice", "service.start:@x/svc"], "the old process is gone before the new one starts");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("services.restart stops and starts one service in its fence, with the configuration as it is now, and never closes the fence", async () => {
  const home = tmp();
  try {
    const { sup, order, configs, journal } = await supervisor(home);
    await sup.restart("alice", "@x/svc");
    assert.deepEqual(order, [], "nothing runs before the supervisor is armed");
    await sup.boot();
    order.length = 0;
    await sup.restart("alice", "@x/other");
    await sup.restart("nobody", "@x/svc");
    assert.deepEqual(order, [], "only an installed service of an existing userspace restarts");
    await sup.restart("alice", "@x/svc");
    assert.deepEqual(order, ["service.stop:@x/svc", "service.start:@x/svc"]);
    assert.deepEqual(configs.at(-1), { for: "@x/svc" }, "the service starts with what the settings say now");
    assert.deepEqual(journal.tail(2, { target: "alice" }).map((r) => r.kind), ["service.start", "service.stop"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The restart methods, against a real latch on an injected clock. The clock never moves on its own, the
 * handler records instead of exiting, and something is always in flight, so no latch here can ever come due:
 * a test that let one fire would end the test process, which is the one failure this feature cannot have.
 */
test("restart.request: an admin arms the latch, nobody else does, and every answer is a row", async () => {
  const home = tmp();
  try {
    const users = new UserStore(await mirror(memoryStore(), "users"));
    users.create("alice", "admin");
    users.create("bob");
    let clock = Date.now();
    const fired: FireReport[] = [];
    const latch = new RestartLatch({
      // The kernel's own `control` block is what the host hands the latch, so the test uses it as the daemon does.
      config: defaultConfig(home, "/proj").control,
      inFlight: () => ["bob/s_1"],
      policy: () => "always",
      env: { INVOCATION_ID: "test" },
      now: () => clock,
    });
    latch.onFire((r) => void fired.push(r));
    const k = { users, journal: new Journal(home), restart: latch, restartPolicy: () => "always" } as unknown as KernelServices;
    const control = createControlHandler(k);
    const request = (actor: string | undefined, reason?: string) => control("restart.request", { actor, reason }) as Promise<ArmResult>;
    const rows = (kind: string) => k.journal.tail(50, { kind });

    await assert.rejects(request("alice"), /needs a reason/, "a restart with no stated reason cannot be asked for");
    // Refused for being young: the refusal is the latch's own sentence, and the row says which guard spoke.
    const young = await request("alice", "trying it out");
    assert.equal(young.state, "refused");
    assert.equal(young.why, "young");
    assert.match(young.message, /Nothing was armed and nothing is going to happen/);
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.refused")[0].data, { reason: "trying it out", why: "young" });
    assert.equal(rows("restart.refused")[0].actor, "alice");

    clock += 61_000;
    // A user and the system userspace are both refused here, not by `rpc.ts`, which admits any non-user.
    await assert.rejects(request("bob", "new code"), code("unauthorized"));
    await assert.rejects(request("_system", "new code"), code("unauthorized"));
    assert.equal(latch.status().pending, undefined, "a refused caller arms nothing");
    assert.equal(rows("restart.armed").length, 0, "and leaves no row saying it did");

    const armed = await request("alice", "new kernel code");
    assert.equal(armed.state, "armed");
    assert.equal(armed.pending?.reason, "new kernel code");
    assert.match(armed.message, /A restart is armed: new kernel code \(asked by alice\)/);
    const row = rows("restart.armed")[0];
    assert.equal(row.actor, "alice");
    assert.equal(row.target, "daemon");
    assert.deepEqual(row.data, { reason: "new kernel code" });

    // Asking again is two requests meeting, not a fault: it arms nothing further and says so.
    const again = await request("alice", "new kernel code");
    assert.equal(again.state, "again");
    assert.equal(rows("restart.again").length, 1);
    assert.equal(latch.status().pending?.at, armed.pending?.at, "still the first one");

    const shown = (await control("restart.status", {})) as RestartState & { policy: string | null };
    assert.equal(shown.pending?.by, "alice");
    assert.equal(shown.policy, "always", "and what the deployed unit says, which decides whether it would come back");

    assert.deepEqual(await control("restart.cancel", { actor: "alice" }), { cancelled: true, was: armed.pending });
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.cancel")[0].data, { reason: "new kernel code", by: "alice" });
    assert.deepEqual(await control("restart.cancel", {}), { cancelled: false, was: null }, "cancelling nothing is not an event");
    assert.equal(rows("restart.cancel").length, 1);
    assert.deepEqual(fired, [], "no latch fires in this process");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("providers.forget drops one userspace's cached model list, so a reloaded provider is asked again", async () => {
  let asked = 0;
  const pkg = { name: "@x/prov", version: "1", type: "provider", description: "", root: "/x", thetis: { type: "provider" } } as PackageInfo;
  const packages = { installed: () => [pkg] } as unknown as PackageManager;
  const userspaces = { exists: () => true, pathFor: (id: string) => ({ id }) } as unknown as UserspaceLayout;
  const fences = { request: async () => (asked++, [{ id: "m1" }]) } as unknown as Fences;
  const providers = new ProviderRegistry(noSettings, packages, userspaces, fences);
  const alice = { id: "alice" } as Userspace;
  assert.deepEqual(await providers.listModels(alice), [{ id: "m1", provider: "@x/prov" }]);
  await providers.listModels(alice);
  assert.equal(asked, 1, "the list is memoized in this process for five minutes");
  providers.forget("bob");
  await providers.listModels(alice);
  assert.equal(asked, 1, "another workspace's reload leaves it alone");
  providers.forget("alice");
  await providers.listModels(alice);
  assert.equal(asked, 2, "after a reload the provider is asked what it serves now");
});

/**
 * A config service over a memory store: one shipped provider with declarations, installed for the system
 * and for bob, and alice's fork of it, which declares a service. The manifests are a table; the package
 * manager is the one method the service asks of it.
 */
async function configFixture(home: string, filePackages: Record<string, Record<string, unknown>> = { "@thetis/prov": { apiKey: "${PROV_KEY}" } }) {
  const driver = memoryStore();
  const registry = new PackageRegistry(await mirror(driver, "registry"));
  const manifests: Record<string, Manifest> = {
    "@thetis/prov": { name: "@thetis/prov", version: "1", thetis: { type: "provider", config: { apiKey: { type: "string", secret: true, required: true }, baseUrl: { type: "string", default: "https://x" }, secure: { type: "boolean", scope: "system" } } } },
    "@alice/prov2": { name: "@alice/prov2", version: "1", thetis: { type: "provider", forkedFrom: { name: "@thetis/prov", version: "1" }, service: { export: "start" } } },
  };
  const packages = { manifestOf: (_us: Userspace, name: string) => manifests[name] } as unknown as PackageManager;
  const prov = { name: "@thetis/prov", version: "1", type: "provider", owner: "_system", source: { kind: "system" as const, ref: "/x" } };
  registry.record(prov, "_system");
  registry.record(prov, "bob");
  registry.record({ name: "@alice/prov2", version: "1", type: "provider", owner: "alice", source: { kind: "local", ref: "p" }, forkedFrom: { name: "@thetis/prov", version: "1" } }, "alice");
  const journal = new Journal(home);
  const userspaces = new UserspaceLayout(home);
  const env = { snapshot: () => ({ PROV_KEY: "from-env" }) };
  let settings!: ConfigService;
  const layers = new LayeredConfig(driver, () => settings.filePackages);
  settings = new ConfigService(filePackages, layers, env, packages, registry, userspaces, journal);
  const changes: ConfigChange[] = [];
  settings.onChange(async (c) => void changes.push(c));
  return { driver, registry, settings, journal, userspaces, changes };
}

test("config service: reload sees a file layer that was rewritten in place, and still says what changed", async () => {
  // `config.reload` writes the newly read file into the very configuration object the service was given,
  // so that every holder of it sees the new values. The service therefore has to hold a copy: holding the
  // reference meant diffing the object against itself, finding no package changed, and restarting no
  // service on a configuration change -- while printing "nothing changed in the file" beside the list of
  // keys it had just applied.
  const home = tmp();
  try {
    const live: Record<string, Record<string, unknown>> = { "@thetis/prov": { baseUrl: "https://one" } };
    const { settings } = await configFixture(home, live);
    assert.equal(settings.filePackages, live, "the layer is held by reference, so a key written into it is live");

    // What config.reload does: snapshot the layer, let applyInPlace rewrite that very object, then ask.
    const was = structuredClone(live);
    live["@thetis/prov"].baseUrl = "https://two";
    assert.deepEqual((await settings.reload(live, was)).changed, ["@thetis/prov"], "a key that moved is a package that changed");

    const was2 = structuredClone(live);
    assert.deepEqual((await settings.reload(live, was2)).changed, [], "and a reload that moves nothing says nothing moved");
    assert.deepEqual((await settings.reload(live)).changed, [], "without a snapshot it can only compare the object with itself, which is why the caller keeps one");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config service: who may set what, where a secret lands, what the journal keeps, and who is told", async () => {
  const home = tmp();
  try {
    const { driver, settings, journal, userspaces, changes } = await configFixture(home);
    const prov = "@thetis/prov";
    await assert.rejects(settings.set({ name: prov, user: "bob" }, "secure", true, "bob", true), code("unauthorized"), "a fence never sets a system-scoped key");
    await assert.rejects(settings.set({ name: prov, user: "bob" }, "secure", true, "operator"), code("unauthorized"), "nor does anyone at a person's layer");
    await assert.rejects(settings.set({ name: prov }, "secure", true, "operator", true), code("unauthorized"));
    await assert.rejects(settings.set({ name: prov }, "baseUrl", null, "operator"), code("invalid"));
    await assert.rejects(settings.set({ name: prov }, "baseUrl", 5, "operator"), /declared string/);
    await assert.rejects(settings.set({ name: "@nobody/none" }, "k", "v", "operator"), code("not-found"));
    assert.equal(changes.length, 0, "a refused set tells nobody");

    const shown = await settings.set({ name: prov, user: "bob" }, "apiKey", "sk-bob", "bob", true);
    const key = shown.keys.find((k) => k.key === "apiKey")!;
    assert.equal(key.state, "set");
    assert.equal(key.source, "user");
    assert.equal(key.value, undefined, "the report never carries a secret");
    assert.equal(key.redacted, true);
    assert.deepEqual(await driver.open("secrets/users/bob").get(prov), { apiKey: "sk-bob" }, "a secret lands in the private namespace");
    assert.equal(await driver.open("config/users/bob").get(prov), undefined);
    const row = journal.tail(1, { kind: "config.set" })[0];
    assert.equal(row.actor, "bob");
    assert.equal(row.target, "bob");
    assert.deepEqual(row.data, { package: prov, key: "apiKey", layer: "user", secret: true }, "the row names the key and never the value");
    assert.deepEqual(changes.at(-1)?.affected, [{ user: "bob", package: prov }], "a person's layer reaches that person");

    assert.deepEqual(await settings.effective(userspaces.pathFor("bob"), prov), { apiKey: "sk-bob", baseUrl: "https://x" });
    assert.deepEqual(await settings.effective(userspaces.pathFor("_system"), prov), { apiKey: "from-env", baseUrl: "https://x" }, "the file layer's reference resolves at read time");

    await settings.set({ name: prov }, "baseUrl", "https://y", "operator");
    assert.deepEqual(journal.tail(1, { kind: "config.set" })[0].data, { package: prov, key: "baseUrl", layer: "system", secret: false });
    const affected = changes.at(-1)!.affected.map((a) => `${a.user}:${a.package}`).sort();
    assert.deepEqual(affected, ["_system:@thetis/prov", "alice:@alice/prov2", "bob:@thetis/prov"], "a system change reaches every holder and every fork");

    const fork = await settings.show({ name: "@alice/prov2", user: "alice" });
    assert.deepEqual(fork.inherits, [prov]);
    const inherited = fork.keys.find((k) => k.key === "baseUrl")!;
    assert.equal(inherited.value, "https://y");
    assert.equal(inherited.inheritedFrom, prov);
    const inheritedSecret = fork.keys.find((k) => k.key === "apiKey")!;
    assert.equal(inheritedSecret.source, "file");
    assert.equal(inheritedSecret.inheritedFrom, prov);
    assert.equal(inheritedSecret.value, "${PROV_KEY}", "a pure reference is shown as the reference, never resolved");
    assert.equal(fork.broken, false, "the origin's file layer serves the fork");
    assert.equal(fork.summary, "every key is set");
    const listed = await settings.list("bob");
    assert.deepEqual(listed.map((r) => [r.package, r.user, r.broken]), [[prov, "bob", false]]);
    assert.deepEqual((await settings.list()).map((r) => r.package).sort(), ["@alice/prov2", prov]);

    const unset = await settings.unset({ name: prov, user: "bob" }, "apiKey", "operator");
    assert.equal(unset.keys.find((k) => k.key === "apiKey")?.state, "set", "the file layer's reference is what is left");
    assert.deepEqual(journal.tail(1, { kind: "config.unset" })[0].data, { package: prov, key: "apiKey", layer: "user", secret: true });

    const before = changes.length;
    const reloaded = await settings.reload({ [prov]: { apiKey: "${PROV_KEY}", baseUrl: "https://z" } });
    assert.deepEqual(reloaded.changed, [prov]);
    assert.deepEqual(reloaded.restarted, [{ user: "alice", package: "@alice/prov2" }], "the fork declares a service; the origin does not");
    assert.equal(changes.length, before + 1, "and the listeners heard it");
    assert.deepEqual(await settings.reload({ [prov]: { apiKey: "${PROV_KEY}", baseUrl: "https://z" } }), { changed: [], restarted: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rpc: a fence's store stays under its own namespace, a document is capped, and configuration acts as the fence's user", async () => {
  const home = tmp();
  try {
    const { driver, settings, journal, userspaces } = await configFixture(home);
    const users = new UserStore(await mirror(driver, "users"));
    users.create("bob");
    const prov = { name: "@thetis/prov", version: "1", type: "provider", description: "", root: "/x", thetis: { type: "provider" } } as PackageInfo;
    const packages = { installed: () => [prov] } as unknown as PackageManager;
    const k = { users, packages, store: driver, settings } as unknown as RpcServices;
    const bob = createRpcHandler(userspaces.pathFor("bob"), k);
    await assert.rejects(bob("store.get", { package: "@a/pkg", namespace: "../x", key: "k" }), code("invalid"));
    await assert.rejects(bob("store.get", { package: "", key: "k" }), code("invalid"));
    await assert.rejects(bob("store.set", { package: "@a/pkg", key: "k", doc: { big: "x".repeat(257 * 1024) } }), /limit is 262144/);
    await assert.rejects(bob("store.set", { package: "@a/pkg", key: "k", doc: [1] }), /JSON object/);
    assert.equal(await bob("store.get", { package: "@a/pkg", key: "k" }), null);
    await bob("store.set", { package: "@a/pkg", key: "k", doc: { v: 1 } });
    await bob("store.set", { package: "@a/pkg", namespace: "cache", key: "k", doc: { v: 2 } });
    assert.deepEqual(await bob("store.get", { package: "@a/pkg", key: "k" }), { v: 1 });
    assert.deepEqual(await driver.open("userspaces/bob/@a/pkg/default").get("k"), { v: 1 }, "the kernel built the prefix");
    assert.deepEqual(await driver.open("userspaces/bob/@a/pkg/cache").get("k"), { v: 2 });
    assert.deepEqual(await bob("store.list", { package: "@a/pkg" }), ["k"]);
    await bob("store.delete", { package: "@a/pkg", key: "k" });
    assert.deepEqual(await bob("store.list", { package: "@a/pkg" }), []);
    await bob("store.clear", { package: "@a/pkg", namespace: "cache" });
    assert.equal(await bob("store.get", { package: "@a/pkg", namespace: "cache", key: "k" }), null);

    await assert.rejects(bob("config.show", { name: "@alice/prov2" }), code("not-found"), "not installed in this fence");
    await assert.rejects(bob("config.set", { name: "@thetis/prov", key: "secure", value: true }), code("unauthorized"));
    const report = (await bob("config.set", { name: "@thetis/prov", key: "baseUrl", value: "https://b" })) as { keys: { key: string; source?: string }[] };
    assert.equal(report.keys.find((k) => k.key === "baseUrl")?.source, "user");
    const row = journal.tail(1, { kind: "config.set" })[0];
    assert.equal(row.actor, "bob", "the fence's user is the actor");
    assert.equal(row.target, "bob");
    assert.deepEqual(await bob("config.effective", { name: "@thetis/prov" }), { apiKey: "from-env", baseUrl: "https://b" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packages: a storage driver is refused an install, and manifestOf reads the link or the shipped directory", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const registry = new PackageRegistry(await mirror(driver, "registry"));
    const config = defaultConfig(home, "/proj");
    config.systemPackagesDir = join(home, "system");
    mkdirSync(join(config.systemPackagesDir, "shipped"), { recursive: true });
    writeFileSync(join(config.systemPackagesDir, "shipped", "package.json"), JSON.stringify({ name: "@thetis/shipped", version: "1", thetis: { type: "tool" } }));
    const manager = new PackageManager(config, registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const dir = join(us.home, "packages", "drv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/drv", version: "1", thetis: { type: "storage", export: "createStore" } }));
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;
    await assert.rejects(manager.install(us, alice, "packages/drv"), (e: { code: string; message: string }) => e.code === "invalid" && /runs on the host/.test(e.message));
    assert.equal(registry.get("@alice/drv"), undefined);
    assert.equal(manager.manifestOf(us, "@thetis/shipped")?.name, "@thetis/shipped", "the shipped directory, though nothing links it yet");
    assert.equal(manager.manifestOf(us, "@thetis/none"), undefined);
    manager.installSystem(us, "@thetis/shipped");
    assert.equal(manager.manifestOf(us, "@thetis/shipped")?.name, "@thetis/shipped");
    assert.equal(registry.get("@thetis/shipped")?.forkedFrom, undefined);
    assert.ok(!("forkedFrom" in registry.get("@thetis/shipped")!), "a record holds no undefined: the store would refuse it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The fork round trip, against real directories: a shipped package, a fork of it, the fork installed, and
 * the way back. Two things are being held to account here. The listing has to say what the fork is missing,
 * because a fork that says only "forked from X@0.1.1" is a copy nobody knows to leave. And the way back has
 * to work when the registry recorded nothing about what the fork displaced, which is the case that leaves a
 * person with no gateway at all if the only way out is `uninstall`.
 */
test("packages: a fork says what it was forked from and how far that has moved, and unfork is the way back whether or not anything was recorded as displaced", async () => {
  const home = tmp();
  try {
    const registry = new PackageRegistry(await mirror(memoryStore(), "registry"));
    const config = defaultConfig(home, "/proj");
    config.systemPackagesDir = join(home, "system");
    const shipped = join(config.systemPackagesDir, "gw");
    mkdirSync(shipped, { recursive: true });
    const manifest = (version: string) => JSON.stringify({ name: "@thetis/gw", version, main: "index.js", thetis: { type: "gateway" } });
    writeFileSync(join(shipped, "package.json"), manifest("0.1.1"));
    writeFileSync(join(shipped, "index.js"), "export const x = 1;\n");
    const manager = new PackageManager(config, registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;

    manager.installSystem(us, "@thetis/gw");
    const to = join(us.home, "packages", "gw");
    forkPackage({ from: join(us.store, "node_modules", "@thetis", "gw"), to, name: "@alice/gw", version: "0.1.1-fork.1", origin: { name: "@thetis/gw", version: "0.1.1" }, root: us.root });
    await manager.install(us, alice, "packages/gw");
    assert.deepEqual(manager.listFor(us).map((p) => p.name), ["@alice/gw"], "the fork displaced its origin");

    const forkOf = (name: string) => manager.listFor(us).find((p) => p.name === name)?.fork;
    assert.deepEqual(forkOf("@alice/gw"), { name: "@thetis/gw", version: "0.1.1", shipped: "0.1.1", identical: true }, "a fresh fork is the shipped package under another name, and the listing says so");

    // Upstream ships the change the fork was made for. The fork is now identical to nothing in particular
    // and behind by one version, and both facts have to reach the listing without anything being installed.
    writeFileSync(join(shipped, "index.js"), "export const x = 2;\n");
    writeFileSync(join(shipped, "package.json"), manifest("0.2.0"));
    assert.deepEqual(forkOf("@alice/gw"), { name: "@thetis/gw", version: "0.1.1", shipped: "0.2.0" }, "the origin moved on; the fork's own version says nothing about that");

    const back = await manager.unfork(us, "@alice/gw");
    assert.equal(back.name, "@thetis/gw");
    assert.equal(back.version, "0.2.0", "the way back lands on what is shipped now, not on what was forked");
    assert.deepEqual(manager.listFor(us).map((p) => p.name), ["@thetis/gw"]);
    assert.ok(existsSync(to), "the fork's files are kept: they are the person's own work");
    assert.equal(registry.get("@alice/gw"), undefined);

    // The case that makes this a safety feature rather than a convenience. A fork installed where its
    // origin was not has no `replaced` record, so `uninstall` puts nothing back -- for a gateway that is
    // the person locked out of their own browser. `unfork` reads the origin off the fork's manifest.
    await manager.uninstall(us, "@thetis/gw");
    await manager.install(us, alice, "packages/gw");
    assert.equal(registry.get("@alice/gw")?.replaced, undefined, "nothing was displaced, so nothing was recorded");
    assert.equal((await manager.unfork(us, "@alice/gw", true)).name, "@thetis/gw", "the origin comes back on its name alone");
    assert.deepEqual(manager.listFor(us).map((p) => p.name), ["@thetis/gw"]);
    assert.ok(!existsSync(to), "asked for, so the files went too");

    // Nothing to go back to is refused before anything is removed, rather than after.
    await manager.install(us, alice, "packages/gw").catch(() => {});
    rmSync(shipped, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "package.json"), JSON.stringify({ name: "@alice/gw", version: "0.1.1-fork.1", thetis: { type: "gateway", forkedFrom: { name: "@thetis/gw", version: "0.1.1" } } }));
    await manager.install(us, alice, "packages/gw");
    await assert.rejects(manager.unfork(us, "@alice/gw"), (e: { code: string; message: string }) => e.code === "not-found" && /not here to go back to/.test(e.message));
    assert.deepEqual(manager.listFor(us).map((p) => p.name), ["@alice/gw"], "a refusal removes nothing");
    assert.deepEqual(manager.listFor(us)[0].fork, { name: "@thetis/gw", version: "0.1.1" }, "an origin that is gone has no shipped version to report");
    await assert.rejects(manager.unfork(us, "@thetis/nothing"), (e: { code: string }) => e.code === "invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("regression: Git installs retain a fork's displaced clone and prune unused clones", async () => {
  const home = tmp();
  try {
    const registry = new PackageRegistry(await mirror(memoryStore(), "registry"));
    const manager = new PackageManager(defaultConfig(home, "/proj"), registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;
    // Existing pinned clones avoid invoking Git; the behavior under test is which directory is retained.
    const clone = (name: string, pin: string) => {
      const source = `https://example.invalid/${name}.git@${pin.repeat(40)}`;
      const dir = cloneDirFor(us.store, source);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), pin.repeat(40));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@alice/${name}`, version: "1", thetis: { type: "tool" } }));
      return { source, dir };
    };
    const origin = clone("origin", "a");
    await manager.install(us, alice, origin.source);
    const fork = join(us.home, "packages", "fork");
    forkPackage({ from: origin.dir, to: fork, name: "@alice/fork", version: "1-fork.1", origin: { name: "@alice/origin", version: "1" }, root: us.root });
    await manager.install(us, alice, fork);
    const unused = clone("unused", "b");
    const unrelated = clone("unrelated", "c");
    await manager.install(us, alice, unrelated.source);
    assert.ok(existsSync(origin.dir), "the displaced origin is still needed to undo the fork");
    assert.equal(existsSync(unused.dir), false, "unused clones are still pruned");
    assert.equal((await manager.unfork(us, "@alice/fork")).name, "@alice/origin");
    assert.deepEqual(manager.installed(us).map((pkg) => pkg.name).sort(), ["@alice/origin", "@alice/unrelated"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("regression: unfork refuses a missing displaced origin before removing the installed fork", async () => {
  const home = tmp();
  try {
    const registry = new PackageRegistry(await mirror(memoryStore(), "registry"));
    const manager = new PackageManager(defaultConfig(home, "/proj"), registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;
    const origin = join(us.home, "packages", "origin");
    mkdirSync(origin, { recursive: true });
    writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "@alice/origin", version: "1", thetis: { type: "tool" } }));
    await manager.install(us, alice, origin);
    const fork = join(us.home, "packages", "fork");
    forkPackage({ from: origin, to: fork, name: "@alice/fork", version: "1-fork.1", origin: { name: "@alice/origin", version: "1" }, root: us.root });
    await manager.install(us, alice, fork);
    rmSync(origin, { recursive: true, force: true });
    await assert.rejects(manager.unfork(us, "@alice/fork", true), /not here to go back to/);
    assert.deepEqual(manager.installed(us).map((pkg) => pkg.name), ["@alice/fork"]);
    assert.ok(existsSync(fork), "a refused unfork preserves the person's files");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The fork rule read backwards, which is the direction that was missing. A fork names its origin and so
 * displaces it on install; the origin names nothing, so until now a shipped package installed into a
 * userspace that already held a fork of it landed beside the fork. Two gateways then bind the same
 * `run/web.sock` and two copies of the same tools are offered to the model.
 *
 * The answer is a refusal rather than a second displacement, because a displaced fork is nobody's to put
 * back: see the note on `PackageManager.displace`. What is asserted here is that the refusal comes before
 * anything is removed or linked, that it names the fork so the person can act on it, and that the seed --
 * the one path that installs a system package without going through `install` -- leaves a fork alone too.
 */
test("packages: a package whose fork is already installed here is refused by name, and the seed leaves that fork alone", async () => {
  const home = tmp();
  try {
    const registry = new PackageRegistry(await mirror(memoryStore(), "registry"));
    const config = defaultConfig(home, "/proj");
    config.systemPackagesDir = join(home, "system");
    config.systemPackages = { "*": ["@thetis/gw"] };
    const shipped = join(config.systemPackagesDir, "gw");
    mkdirSync(shipped, { recursive: true });
    writeFileSync(join(shipped, "package.json"), JSON.stringify({ name: "@thetis/gw", version: "0.1.1", main: "index.js", thetis: { type: "gateway", service: { export: "start" } } }));
    writeFileSync(join(shipped, "index.js"), "export const x = 1;\n");
    const manager = new PackageManager(config, registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;
    const admin = { id: "root", role: "admin", status: "active", createdAt: "" } as const;

    manager.seedSystem(us);
    forkPackage({ from: join(us.store, "node_modules", "@thetis", "gw"), to: join(us.home, "packages", "gw"), name: "@alice/gw", version: "0.1.1-fork.1", origin: { name: "@thetis/gw", version: "0.1.1" }, root: us.root });
    await manager.install(us, alice, "packages/gw");
    assert.deepEqual(manager.installed(us).map((p) => p.name), ["@alice/gw"], "the fork displaced its origin: the direction that already worked");

    // An admin installing the shipped package here is refused, and the refusal names the copy in the way.
    await assert.rejects(
      manager.install(us, admin, "@thetis/gw"),
      (e: { code: string; message: string }) => e.code === "fork" && /@alice\/gw/.test(e.message) && /@thetis\/gw/.test(e.message),
    );
    assert.deepEqual(manager.installed(us).map((p) => p.name), ["@alice/gw"], "a refusal installs nothing and removes nothing");
    assert.equal(registry.get("@thetis/gw"), undefined, "and records nothing");

    // The seed is the other way a system package arrives, and it does not go through `install` at all. A
    // person who forked their gateway and then had their userspace seeded again would get it back beside
    // the fork, on the daemon's own start, with nobody having asked for it.
    manager.seedSystem(us);
    assert.deepEqual(manager.installed(us).map((p) => p.name), ["@alice/gw"], "the seed leaves a fork of the package it would install alone");

    // Said on the way out to the person, so that a fork standing in for everyone's default says so.
    assert.equal(manager.listFor(us)[0].fork?.everyone, true);

    // Nothing about a fork of something else, or a reinstall of the fork itself, changes.
    await manager.install(us, alice, "packages/gw");
    assert.deepEqual(manager.installed(us).map((p) => p.name), ["@alice/gw"], "a fork is still reinstallable over itself");
    assert.equal((await manager.unfork(us, "@alice/gw")).name, "@thetis/gw");
    await manager.install(us, admin, "@thetis/gw");
    assert.deepEqual(manager.installed(us).map((p) => p.name), ["@thetis/gw"], "with the fork gone the shipped package installs as it always did");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions.watch: every turn of the user reaches the watcher with its session, parent and input, whoever started it; the signal removes it", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const users = new UserStore(await mirror(driver, "users"));
    users.create("bob");
    users.create("eve");
    const packages = { installed: () => [{}], seedSystem: () => {} } as unknown as PackageManager;
    const runner = {
      runTurn: async (_us: Userspace, session: SessionRecord, input: Message[], emit: (e: TurnEvent) => void) => {
        emit({ type: "turn.start", turn: "t1", session: session.id });
        emit({ type: "message", message: { role: "assistant", content: textContent(`re: ${contentText(input[0].content)}`) } });
        emit({ type: "turn.end", turn: "t1", session: session.id });
        return session;
      },
    } as unknown as PipelineRunner;
    const api = new SessionApi(users, new UserspaceLayout(home), packages, new SessionStore(SESSION_ID), runner);
    const root = api.create("bob");
    const child = api.create("bob", { parent: root.id });
    assert.deepEqual(api.list("bob").map((s) => [s.id, s.first, s.running]), [[root.id, "", false], [child.id, "", false]], "a list answers from the index, with what each session first said and whether it is running");
    const seen: WatchedTurnEvent[] = [];
    const control = new AbortController();
    const done = api.watch("bob", (m) => seen.push(m), control.signal);
    assert.throws(() => api.watch("nobody", () => {}), code("unauthorized"), "a watch is authorized like every other call");
    assert.equal(await api.ask("bob", child.id, "do it"), "re: do it");
    assert.deepEqual(
      seen.map((m) => [m.session, m.parent, m.input, m.event.type]),
      [
        [child.id, root.id, "do it", "turn.start"],
        [child.id, root.id, undefined, "message"],
        [child.id, root.id, undefined, "turn.end"],
      ],
      "a subagent's turn is stamped with its parent, and the input rides on turn.start only",
    );
    await api.ask("bob", root.id, [{ role: "user", content: "as messages" }]);
    assert.equal(seen.length, 6);
    assert.equal(seen[3].parent, undefined, "a root session has no parent");
    assert.equal(seen[3].input, "as messages", "input is the text projection of structured messages");
    assert.deepEqual(seen[3].messages, [{ role: "user", content: textContent("as messages") }]);
    const eve = api.create("eve");
    await api.ask("eve", eve.id, "hers");
    assert.equal(seen.length, 6, "another user's turns are not bob's to see");
    control.abort();
    await done;
    await api.ask("bob", root.id, "again");
    assert.equal(seen.length, 6, "the aborted signal removed the watcher");
    // Over the RPC handler: the fence's own user, the event as the emit, and the handler's signal ends it.
    const k = { users, sessions: api } as unknown as RpcServices;
    const rpc = createRpcHandler(new UserspaceLayout(home).pathFor("bob"), k);
    const life = new AbortController();
    const over: WatchedTurnEvent[] = [];
    const settled = rpc("sessions.watch", {}, (m) => over.push(m as WatchedTurnEvent), life.signal);
    await api.ask("bob", root.id, "through rpc");
    assert.equal(over.length, 3);
    assert.equal(over[0].session, root.id);
    life.abort();
    assert.equal(await settled, undefined, "the watch settles when the fence is gone");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions.delete waits for the cancelled turn before removing the record; over rpc a dropped send cancels its turn and providers.call routes by model", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const users = new UserStore(await mirror(driver, "users"));
    users.create("bob");
    const packages = { installed: () => [{}], seedSystem: () => {} } as unknown as PackageManager;
    const store = new SessionStore(SESSION_ID);
    const layout = new UserspaceLayout(home);
    const runner = {
      runTurn: async (us: Userspace, session: SessionRecord, _input: Message[], emit: (e: TurnEvent) => void, signal: AbortSignal) => {
        emit({ type: "turn.start", turn: "t1", session: session.id });
        await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
        emit({ type: "error", message: "turn cancelled", code: "cancelled" });
        store.save(us.sessions, { ...session, turns: session.turns + 1 });
        emit({ type: "turn.end", turn: "t1", session: session.id });
        return session;
      },
    } as unknown as PipelineRunner;
    const api = new SessionApi(users, layout, packages, store, runner);
    const ref = api.create("bob");
    const events: TurnEvent[] = [];
    const turn = (async () => {
      for await (const e of api.send("bob", ref.id, "wait")) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(api.inspect("bob", ref.id).status, "running");
    await api.delete("bob", ref.id);
    await turn;
    assert.deepEqual(events.map((e) => e.type), ["turn.start", "error", "turn.end"], "the running turn was cancelled");
    assert.equal(store.load(layout.pathFor("bob").sessions, ref.id), undefined, "the turn's closing save landed before the removal, not after");
    assert.deepEqual(api.list("bob"), []);
    assert.throws(() => api.inspect("bob", ref.id), code("not-found"));
    await assert.rejects(api.delete("bob", ref.id), code("not-found"));

    // Over rpc: the fence's signal cancels the turn the send started.
    const calls: { model: string; signal?: AbortSignal }[] = [];
    const providers = {
      resolve: async (_us: Userspace, model: string) => ({ model, userspace: layout.pathFor("bob") }),
      call: async (p: { model: string }, _call: unknown, onEvent: (e: unknown) => void, signal?: AbortSignal) => {
        calls.push({ model: p.model, signal });
        onEvent({ type: "text", delta: `from ${p.model}` });
      },
    } as unknown as ProviderRegistry;
    const rpc = createRpcHandler(layout.pathFor("bob"), { users, sessions: api, providers, assets: new AssetAccess(new FileAssetStore(join(home, "assets"))) } as unknown as RpcServices);
    const again = api.create("bob");
    const over: TurnEvent[] = [];
    const life = new AbortController();
    const sent = rpc("sessions.send", { session: again.id, input: "wait" }, (e) => over.push(e as TurnEvent), life.signal);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(api.inspect("bob", again.id).status, "running");
    life.abort();
    await sent;
    assert.deepEqual(over.map((e) => e.type), ["turn.start", "error", "turn.end"], "dropping the call cancelled the turn");
    assert.equal(api.inspect("bob", again.id).status, "idle");
    const streamed: unknown[] = [];
    assert.equal(await rpc("providers.call", { call: { model: "m1", messages: [], tools: [], params: {} } }, (e) => streamed.push(e), life.signal), null);
    assert.deepEqual(streamed, [{ type: "text", delta: "from m1" }]);
    assert.equal(calls[0].model, "m1", "resolved by the call's model");
    assert.equal(calls[0].signal, life.signal, "the fence's signal ends the provider's request");
    await assert.rejects(rpc("providers.call", { call: {} }), code("rpc"));
    assert.equal(await rpc("sessions.delete", { session: again.id }), null);
    assert.deepEqual(api.list("bob"), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("host.<name>.<export>: the control handler journals the call without its arguments and hands it, actor included, to the host; a non-admin actor is refused", async () => {
  const home = tmp();
  try {
    const users = new UserStore(await mirror(memoryStore(), "users"));
    users.create("alice", "admin");
    users.create("bob");
    const calls: { name: string; method: string; args: Record<string, unknown> }[] = [];
    const k = {
      users,
      journal: new Journal(home),
      hosts: { call: async (name: string, method: string, args: Record<string, unknown>) => (calls.push({ name, method, args }), { ok: true }) },
    } as unknown as KernelServices;
    const control = createControlHandler(k);
    // The operator at the socket: no actor, and the row says so. The arguments reach the host and never the journal.
    assert.deepEqual(await control("host.grants.mountsSet", { user: "bob", mounts: [{ path: "/srv/x", mode: "ro" }] }), { ok: true });
    assert.deepEqual(calls, [{ name: "grants", method: "mountsSet", args: { user: "bob", mounts: [{ path: "/srv/x", mode: "ro" }] } }]);
    let row = k.journal.tail(1, { kind: "host.call" })[0];
    assert.deepEqual([row.actor, row.target, row.data], ["operator", "bob", { name: "grants", method: "mountsSet" }]);
    // Through an admin's fence: the actor rides along to the package, and names the row.
    await control("host.grants.sshImport", { user: "bob", actor: "alice", name: "k", privateKey: "SECRET" });
    assert.deepEqual(calls[1], { name: "grants", method: "sshImport", args: { user: "bob", actor: "alice", name: "k", privateKey: "SECRET" } });
    row = k.journal.tail(1, { kind: "host.call" })[0];
    assert.deepEqual([row.actor, row.target, row.data], ["alice", "bob", { name: "grants", method: "sshImport" }]);
    assert.ok(!readFileSync(join(home, "journal.jsonl"), "utf8").includes("SECRET"), "no argument is journalled");
    // A person who is not an admin, and the system userspace, are refused before the host sees anything.
    await assert.rejects(control("host.grants.sshSet", { user: "bob", actor: "bob", ssh: [] }), code("unauthorized"));
    await assert.rejects(control("host.grants.sshSet", { user: "bob", actor: "_system", ssh: [] }), code("unauthorized"));
    assert.equal(calls.length, 2);
    assert.equal(k.journal.tail(10, { kind: "host.call" }).length, 2, "a refusal is not a call");
    // Only the three-part name is a host method; anything else is still unknown.
    await assert.rejects(control("host.grants", {}), /unknown control method/);
    await assert.rejects(control("host.grants.mountsSet.extra", {}), /unknown control method/);
    await assert.rejects(control("hosts.grants.mountsSet", {}), /unknown control method/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The other half of "report the real state, not the intention": `status` used to list the installed packages
 * that declare a service and call that the running ones, so a `@thetis/marketplace` that failed to start at
 * boot read as perfectly healthy while its index went stale and nobody was told. What the supervisor tried
 * and could not do is the only honest source for this, and it is where the row now gets it from.
 */
test("status leaves a service that failed to start out of what is running, and says which one and since when", async () => {
  const home = tmp();
  try {
    const { sup, pkg, userspaces, fail } = await supervisor(home);
    fail("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@thetis/runtime/lib'");
    await sup.boot();
    await sup.ensure("alice");
    const down = sup.notRunning.get("alice") ?? [];
    assert.deepEqual(down.map((d) => d.name), ["@x/svc"]);
    assert.match(down[0].error, /ERR_MODULE_NOT_FOUND/);
    assert.ok(Date.parse(down[0].since) > 0, "the moment it failed, so a person can see how long it has been dead");

    const k = {
      config: { projectRoot: home, systemPackagesDir: home },
      fences: {},
      users: { list: () => [{ id: "alice" }] },
      userspaces,
      packages: { listFor: () => [pkg] } as unknown as PackageManager,
      restart: { status: () => ({}) },
      restartPolicy: () => "always",
      services: sup,
      journal: new Journal(home),
    } as unknown as KernelServices;
    const report = async () => (await createControlHandler(k)("status", {})) as { workspaces: { services: string[]; down: { name: string; error: string }[] }[] };

    const bad = (await report()).workspaces[0];
    assert.deepEqual(bad.services, [], "a service that is not running is not reported as running");
    assert.deepEqual(bad.down.map((d) => d.name), ["@x/svc"]);

    fail(undefined);
    await sup.restart("alice", "@x/svc");
    assert.deepEqual(sup.notRunning.get("alice"), [], "the record goes the moment the service does start");
    const good = (await report()).workspaces[0];
    assert.deepEqual(good.services, ["@x/svc"]);
    assert.deepEqual(good.down, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
