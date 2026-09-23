// A process handle over a child that ignores SIGTERM: close must still return, by killing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Userspace } from "../../src/contracts/index.js";
import { ProcessHandle } from "../../src/sandbox/handle.js";

const us = { id: "alice", root: "/nowhere", home: "/nowhere", store: "/nowhere", run: "/nowhere", mounts: [] } as unknown as Userspace;

test("close waits for the agent to exit and kills one that ignores SIGTERM", async () => {
  const lines: string[] = [];
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.error('ready')"], { stdio: ["pipe", "pipe", "pipe"] });
  const handle = new ProcessHandle(stubborn, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 300, log: (l) => lines.push(l) });
  // The handle relays the child's stderr to the log; the handler is in place once the child says so.
  while (!lines.some((l) => /ready/.test(l))) await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await handle.close();
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `close took ${took} ms`);
  assert.equal(stubborn.exitCode ?? stubborn.signalCode, "SIGKILL");
  assert.ok(lines.some((l) => /did not exit/.test(l)));

  const polite = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const quick = new ProcessHandle(polite, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 5000, log: () => {} });
  const t = Date.now();
  await quick.close();
  assert.ok(Date.now() - t < 1000, "a child that honours SIGTERM is not waited on for the grace period");
  assert.equal(polite.signalCode, "SIGTERM");
  await assert.rejects(quick.request("ping", {}), /closed/);
});

/**
 * A child that speaks the agent's protocol for the cancellation and liveness tests. `slow` answers 100 ms
 * after it is cancelled; `deaf` never answers anything, cancels included; `ask` opens one RPC to the kernel,
 * cancels it after 100 ms, and answers with the outcome the kernel sent back; `ask-and-die` opens one RPC
 * and exits. The liveness three: `beat` reports itself alive every 40 ms and answers after `payload.ms`,
 * which is longer than the budget these tests give it; `stream` sends events at the same rate instead, and
 * is asked for without an `onEvent` on purpose; `beat-then-stop` beats `payload.beats` times and then goes
 * silent for good, but does answer a cancel -- a wedged fence that can still be stopped.
 */
const AGENT = `
  const rl = require("node:readline").createInterface({ input: process.stdin });
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const onCancel = new Map();
  let asking;
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.op === "slow") { onCancel.set(m.id, () => setTimeout(() => out({ id: m.id, result: "partial" }), 100)); return; }
    if (m.op === "deaf") return;
    if (m.op === "beat") { const n = setInterval(() => out({ id: m.id, alive: true }), 40); setTimeout(() => { clearInterval(n); out({ id: m.id, result: "finished" }); }, m.payload.ms); return; }
    if (m.op === "stream") { const n = setInterval(() => out({ id: m.id, event: { type: "text", delta: "." } }), 40); setTimeout(() => { clearInterval(n); out({ id: m.id, result: "finished" }); }, m.payload.ms); return; }
    if (m.op === "beat-then-stop") { let left = m.payload.beats; const n = setInterval(() => { if (left-- > 0) out({ id: m.id, alive: true }); else clearInterval(n); }, 40); onCancel.set(m.id, () => setTimeout(() => out({ id: m.id, result: "what it kept" }), 10)); return; }
    if (m.op === "ask") { asking = m.id; out({ rpc: "k1", method: "wait", args: {} }); setTimeout(() => out({ rpcCancel: "k1" }), 100); return; }
    if (m.op === "ask-and-die") { out({ rpc: "k2", method: "wait", args: {} }); setTimeout(() => process.exit(0), 100); return; }
    if (typeof m.cancel === "string") { onCancel.get(m.cancel)?.(); return; }
    if (typeof m.rpcResult === "string") { out({ id: asking, result: m }); return; }
  });
  console.error("ready");
`;

/** A handle over the protocol child, whose kernel side answers `wait` when its signal aborts. */
async function agent(opts: { cancelGraceMs?: number; requestTimeoutMs?: number } = {}) {
  const lines: string[] = [];
  const signals: AbortSignal[] = [];
  const child = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = (_method: string, _args: unknown, _emit?: unknown, signal?: AbortSignal) =>
    new Promise<unknown>((res) => {
      signals.push(signal!);
      signal!.addEventListener("abort", () => res("aborted"), { once: true });
    });
  const handle = new ProcessHandle(child, us, rpc, { requestTimeoutMs: opts.requestTimeoutMs ?? 5000, cancelGraceMs: opts.cancelGraceMs, exitGraceMs: 300, log: (l) => lines.push(l) });
  while (!lines.some((l) => /ready/.test(l))) await new Promise((r) => setTimeout(r, 10));
  return { handle, signals, lines };
}

test("rpcCancel aborts the one served call it names, and the agent gets that call's outcome", async () => {
  const { handle, signals } = await agent();
  try {
    const outcome = await handle.request("ask", {});
    assert.deepEqual(outcome, { rpcResult: "k1", result: "aborted" });
    assert.equal(signals.length, 1);
    assert.ok(signals[0].aborted);
  } finally {
    await handle.close();
  }
});

test("the agent's exit aborts every call it still had open", async () => {
  const { handle, signals } = await agent();
  await assert.rejects(handle.request("ask-and-die", {}), /exited/);
  await handle.gone;
  assert.equal(signals.length, 1);
  assert.ok(signals[0].aborted, "the served call's signal followed the agent out");
});

test("a cancelled request is told, and its answer within the grace is delivered", async () => {
  const { handle } = await agent({ cancelGraceMs: 1000 });
  try {
    const control = new AbortController();
    const result = handle.request("slow", {}, undefined, control.signal);
    setTimeout(() => control.abort(), 50);
    assert.equal(await result, "partial", "what the stopped step returned reaches the caller");
  } finally {
    await handle.close();
  }
});

test("a cancelled request that never answers settles as cancelled when the grace runs out; one never answered at all times out", async () => {
  const { handle } = await agent({ cancelGraceMs: 200, requestTimeoutMs: 300 });
  try {
    const control = new AbortController();
    const result = handle.request("deaf", {}, undefined, control.signal);
    const started = Date.now();
    setTimeout(() => control.abort(), 20);
    await assert.rejects(result, (err: { code?: string; message: string }) => err.code === "cancelled" && /cancelled/.test(err.message));
    const took = Date.now() - started;
    assert.ok(took >= 200 && took < 300, `settled after the grace, before the timeout: ${took} ms`);
    await assert.rejects(handle.request("deaf", {}), (err: { code?: string; message: string }) => err.code === "fence" && /stopped answering/.test(err.message));
    const already = new AbortController();
    already.abort();
    await assert.rejects(handle.request("deaf", {}, undefined, already.signal), (err: { code?: string }) => err.code === "cancelled");
  } finally {
    await handle.close();
  }
});

/**
 * The defect this suite exists for: the timer was armed when the request went out and never reset, so it
 * capped the whole of a turn -- every model call, every tool, every subagent -- and a turn doing real work
 * was killed at ten minutes with everything it had done thrown away. The timer now measures silence, and a
 * fence that is working says so, so the work may take as long as it takes.
 */
test("a fence that reports itself alive is never killed, however long the work takes", async () => {
  const { handle } = await agent({ requestTimeoutMs: 200 });
  try {
    const started = Date.now();
    assert.equal(await handle.request("beat", { ms: 700 }), "finished", "700 ms of work under a 200 ms silence budget");
    assert.ok(Date.now() - started >= 700);
  } finally {
    await handle.close();
  }
});

/** Events are signs of life too, and the reset must not depend on the caller having asked for them: most
 *  callers here pass no `onEvent` at all, and one that passed none had no reset whatsoever. */
test("events reset the timer even when the caller asked for none", async () => {
  const { handle } = await agent({ requestTimeoutMs: 200 });
  try {
    assert.equal(await handle.request("stream", { ms: 700 }), "finished");
  } finally {
    await handle.close();
  }
});

/** A fence that really has stopped answering is stopped the way an abort stops it, so the step hands back
 *  what it had; the caller is told why in words that say how long the silence was and how far in it fell. */
test("a fence that stops reporting itself alive is stopped, and comes back with what it kept", async () => {
  const { handle } = await agent({ requestTimeoutMs: 200, cancelGraceMs: 500 });
  try {
    const events: { type?: string; message?: string; code?: string }[] = [];
    const started = Date.now();
    const result = await handle.request("beat-then-stop", { beats: 6 }, (e) => events.push(e as { type?: string }));
    const took = Date.now() - started;
    assert.equal(result, "what it kept", "the stopped step's own answer reaches the caller, not an error instead of it");
    assert.ok(took >= 400 && took < 900, `stopped after the beats stopped plus the budget, not before: ${took} ms`);
    const told = events.find((e) => e.type === "error");
    assert.ok(told, "the caller is told the work was cut short; nothing else would ever say so");
    assert.equal(told?.code, "fence");
    assert.match(told?.message ?? "", /stopped answering/);
    assert.match(told?.message ?? "", /frames in/);
  } finally {
    await handle.close();
  }
});

/** One that answers nothing at all, the cancel included, is the only case that ends in an error, and the
 *  error says what a person can act on: the fence is gone, not "the request timed out". */
test("a fence that answers nothing at all fails with what actually happened", async () => {
  const { handle, lines } = await agent({ requestTimeoutMs: 200, cancelGraceMs: 100 });
  try {
    await assert.rejects(handle.request("deaf", {}), (err: { code?: string; message: string }) => {
      assert.equal(err.code, "fence");
      assert.match(err.message, /the fence for alice stopped answering/);
      assert.match(err.message, /not answered at all/);
      assert.match(err.message, /reports itself alive every/);
      return true;
    });
    assert.ok(lines.some((l) => /stopped answering/.test(l)), "the operator gets the same sentence in the log");
  } finally {
    await handle.close();
  }
});
