// The agent as a process, with this test as its kernel: a step that emits, calls the kernel with the turn's
// signal, runs a tool through `env.invokeTool`, and is cancelled mid-call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/userspace-agent/agent.js");

const PROBE = `
export async function probe(ctx) {
  const events = [];
  const tool = await ctx.env.invokeTool({ package: "@t/p", export: "greet", name: "greet" }, { who: "bob" }, { session: ctx.session, config: { k: 1 }, signal: ctx.signal });
  ctx.emit({ type: "text", delta: "hi" });
  let cancelled;
  try {
    await ctx.env.kernel.providers.call({ model: "m", messages: [], tools: [], params: {} }, (e) => events.push(e), ctx.signal);
  } catch (err) {
    cancelled = err.code;
  }
  return { harness: { tool, events, cancelled, aborted: ctx.signal.aborted } };
}
export async function greet(args, env) {
  return "hello " + args.who + " config=" + JSON.stringify(env.config) + " session=" + env.session.id + " storage=" + typeof env.storage + " signal=" + (env.signal instanceof AbortSignal);
}
`;

/** A package with one export that never returns, and one that watches its signal, for the allowance tests. */
const STUCK = `
export async function hang(ctx) {
  await new Promise(() => {});
}
export async function polite(ctx) {
  await new Promise((done) => ctx.signal.addEventListener("abort", () => done(), { once: true }));
  return { harness: { stopped: true } };
}
`;

/**
 * The heartbeat keeps a busy fence alive, and it beats for as long as an operation runs -- which took the
 * kernel's timer away as the bound on everything. A step outside `execute` that never returns would hang the
 * turn for ever. The allowance puts that bound back inside the agent, where what fails is the package rather
 * than the workspace: the fence goes on serving, and the person is told which export hung.
 */
test("a step outside the execute phase is stopped when it runs past its allowance, and says which package hung", async () => {
  const root = mkdtempSync(join(tmpdir(), "thetis-agent-"));
  const pkg = join(root, "store", "node_modules", "@t", "slow");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@t/slow", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), STUCK);
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, THETIS_USERSPACE: root, THETIS_HEARTBEAT_MS: "40", THETIS_STEP_DEADLINE_MS: "400" }, stdio: ["pipe", "pipe", "pipe"] });
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line));
    waiters.splice(0).forEach((w) => w());
  });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const next = async <T extends Record<string, unknown>>(pick: (f: Record<string, unknown>) => boolean): Promise<T> => {
    for (;;) {
      const hit = frames.find(pick);
      if (hit) return hit as T;
      await new Promise<void>((w) => waiters.push(w));
    }
  };
  const ctx = { session: { id: "s1", user: "alice" }, turn: { id: "t1", input: [] }, conversation: [], call: { model: "m", messages: [], tools: [], params: {} }, harness: {}, packages: [], config: {} };
  try {
    send({ id: "r1", op: "step", payload: { package: "@t/slow", export: "hang", phase: "prompt", ctx } });
    const failed = await next<{ error: string }>((f) => f.id === "r1" && "error" in f);
    assert.match(failed.error, /@t\/slow#hang in the prompt phase did not finish within 400 ms/);
    assert.match(failed.error, /bug in that package/);
    assert.match(failed.error, /The workspace is unaffected/);
    assert.ok(!/\n\s+at /.test(failed.error), "the sentence is the whole diagnosis; no stack of the timer that fired");
    assert.ok(frames.some((f) => f.id === "r1" && f.alive === true), "the fence was beating the whole time: it is healthy, the package is not");

    // The step is told to stop as well as failed, so work that does watch its signal stops rather than running
    // on unwatched. A step that ignores it, as `hang` does, is failed regardless -- that is the whole point.
    send({ id: "r2", op: "step", payload: { package: "@t/slow", export: "polite", phase: "after", ctx } });
    const stopped = await next<{ error?: string }>((f) => f.id === "r2" && ("error" in f || "result" in f));
    assert.ok(stopped.error, "the allowance is what settles the request, whatever the step then does with its signal");

    // The execute phase is exempt: it is the turn's long work and is watched from the inside, so it is still
    // running well past the allowance and it is the cancel, not the clock, that ends it.
    send({ id: "r3", op: "step", payload: { package: "@t/slow", export: "polite", phase: "execute", ctx } });
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(!frames.some((f) => f.id === "r3" && ("error" in f || "result" in f)), "no allowance over the model loop");
    send({ cancel: "r3" });
    const ended = await next<{ result: { harness: { stopped: boolean } } }>((f) => f.id === "r3" && ("result" in f || "error" in f));
    assert.deepEqual(ended.result.harness, { stopped: true }, "and it ends on the signal, with what it kept");

    send({ id: "r4", op: "ping", payload: {} });
    assert.equal((await next((f) => f.id === "r4")).result, "pong", "the fence is still serving after a package hung in it");
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => child.once("exit", () => done()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a step emits, runs a tool under its package's env, and a cancel aborts its signal and the kernel call it made", async () => {
  const root = mkdtempSync(join(tmpdir(), "thetis-agent-"));
  const pkg = join(root, "store", "node_modules", "@t", "p");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@t/p", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), PROBE);
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, THETIS_USERSPACE: root }, stdio: ["pipe", "pipe", "pipe"] });
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line));
    waiters.splice(0).forEach((w) => w());
  });
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const next = async <T extends Record<string, unknown>>(pick: (f: Record<string, unknown>) => boolean): Promise<T> => {
    for (;;) {
      const hit = frames.find(pick);
      if (hit) return hit as T;
      await new Promise<void>((w) => waiters.push(w));
    }
  };
  try {
    const ctx = { session: { id: "s1", user: "alice" }, turn: { id: "t1", input: [] }, conversation: [], call: { model: "m", messages: [], tools: [], params: {} }, harness: {}, packages: [], config: {} };
    send({ id: "r1", op: "step", payload: { package: "@t/p", export: "probe", ctx } });
    const text = await next((f) => f.id === "r1" && "event" in f);
    assert.deepEqual(text.event, { type: "text", delta: "hi" }, "the step's emit reaches the kernel as an event frame of the step request");
    const rpc = await next<{ rpc: string; method: string; args: unknown }>((f) => typeof f.rpc === "string");
    assert.equal(rpc.method, "providers.call");
    assert.deepEqual(rpc.args, { call: { model: "m", messages: [], tools: [], params: {} } });
    send({ rpcEvent: rpc.rpc, event: { type: "text", delta: "one" } });
    send({ rpcEvent: rpc.rpc, event: { type: "text", delta: "two" } });
    // The kernel stops the turn: the step's signal aborts, and the call it was waiting on is cancelled on both sides.
    send({ cancel: "r1" });
    const cancel = await next((f) => typeof f.rpcCancel === "string");
    assert.equal(cancel.rpcCancel, rpc.rpc, "the agent tells the kernel which call to stop serving");
    const done = await next<{ result: { harness: Record<string, unknown> } }>((f) => f.id === "r1" && ("result" in f || "error" in f));
    assert.deepEqual(done.result.harness, {
      tool: "hello bob config={\"k\":1} session=s1 storage=function signal=true",
      events: [{ type: "text", delta: "one" }, { type: "text", delta: "two" }],
      cancelled: "cancelled",
      aborted: true,
    });
    // A late reply to the cancelled call is dropped, not delivered anywhere.
    send({ rpcResult: rpc.rpc, result: "late" });
    send({ id: "r2", op: "ping", payload: {} });
    assert.equal((await next((f) => f.id === "r2")).result, "pong", "the agent is still serving after the cancel");
    assert.ok(!frames.some((f) => f.id === "r1" && (f as { result?: unknown }).result === "late"));
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => child.once("exit", () => done()));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(stderr, [], "the agent logged nothing");
});
