// The pool's close is a drain: a request already inside the fence finishes before the fence goes, and a
// request that arrives while the close is under way waits for it and lands in the fence opened next.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fence, FenceHandle, Userspace } from "../../src/contracts/index.js";
import { CodedError } from "../../src/lib/error.js";
import { FencePool } from "../../src/sandbox/pool.js";

const us = { id: "alice" } as Userspace;

/** A fence whose requests resolve, or fail, when the test says so, numbered by the order they were opened. */
function fakeFence(closing: (rec: { closed: boolean }) => Promise<void> = async (rec) => void (rec.closed = true)) {
  const opened: { n: number; closed: boolean; mounts: number; answer: (op: string) => void; fail: (op: string, err: unknown) => void; pending: Map<string, (v: unknown) => void> }[] = [];
  const fence: Fence = {
    async open(u) {
      const pending = new Map<string, (v: unknown) => void>();
      const failing = new Map<string, (e: unknown) => void>();
      const rec = {
        n: opened.length + 1,
        closed: false,
        mounts: u.mounts?.length ?? 0,
        answer: (op: string) => pending.get(op)?.(`${op} from fence ${rec.n}`),
        fail: (op: string, err: unknown) => failing.get(op)?.(err),
        pending,
      };
      opened.push(rec);
      const handle: FenceHandle = {
        request: (op) =>
          new Promise((done, broke) => {
            pending.set(op, done);
            failing.set(op, broke);
          }),
        close: () => closing(rec),
      };
      return handle;
    },
  };
  return { fence, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("close waits for a quiet moment; a request meanwhile still enters the old fence; the next opens a new one with the userspace refreshed", async () => {
  const { fence, opened } = fakeFence();
  let mounts = 0;
  const pool = new FencePool(fence, () => ({}) as never, undefined, (u) => ({ ...u, mounts: Array(mounts).fill({ path: "/x", mode: "rw" }) }));
  const first = pool.request(us, "tool", {});
  await tick();
  assert.equal(opened.length, 1);
  const closing = pool.close(us.id);
  await tick();
  assert.equal(opened[0].closed, false, "the fence stays while its request runs");
  const second = pool.request(us, "child-step", {});
  await tick();
  assert.equal(opened.length, 1, "a request during the drain goes into the fence that is still open");
  opened[0].answer("tool");
  assert.equal(await first, "tool from fence 1");
  await tick();
  assert.equal(opened[0].closed, false, "still one request in flight");
  opened[0].answer("child-step");
  assert.equal(await second, "child-step from fence 1");
  await closing;
  assert.equal(opened[0].closed, true);
  mounts = 1;
  const third = pool.request(us, "next", {});
  await tick();
  assert.equal(opened.length, 2, "a request after the close opens the next fence");
  opened[1].answer("next");
  assert.equal(await third, "next from fence 2");
  assert.equal(opened[1].mounts, 1, "the new fence saw the userspace as it is now");
});

test("a close with nothing in flight is immediate, and a second close joins the first", async () => {
  const { fence, opened } = fakeFence();
  const pool = new FencePool(fence, () => ({}) as never);
  await pool.handle(us);
  const a = pool.close(us.id);
  const b = pool.close(us.id);
  await Promise.all([a, b]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, true);
});

test("regression: a request arriving after draining waits for the old fence to finish closing", async () => {
  let release!: () => void;
  let began!: () => void;
  const finish = new Promise<void>((done) => (release = done));
  const started = new Promise<void>((done) => (began = done));
  const { fence, opened } = fakeFence(async (rec) => {
    began();
    await finish;
    rec.closed = true;
  });
  const pool = new FencePool(fence, () => ({}) as never);
  await pool.handle(us);
  const closing = pool.close(us.id);
  await started;
  const next = pool.request(us, "next", {});
  try {
    await tick();
    assert.equal(opened.length, 1, "opening a second fence here lets the old service unlink its replacement's socket");
  } finally {
    release();
    await closing;
    await tick();
    opened[1]?.answer("next");
    await next;
    await pool.close();
  }
  assert.equal(opened.length, 2);
});

test("the pool stamps each fence it opens with the versions it read, and forgets them with the handle", async () => {
  const { fence, opened } = fakeFence();
  let versions: Record<string, string> = { "@thetis/skills-hybrid": "0.2.1" };
  const pool = new FencePool(fence, () => ({}) as never, undefined, undefined, () => ({ ...versions }));
  assert.deepEqual(pool.loadedVersions(), {}, "nothing is open, so nothing is loaded");
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.1" } });
  versions = { "@thetis/skills-hybrid": "0.2.2" };
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.1" } }, "the open fence still holds what it read");
  await pool.close(us.id);
  assert.deepEqual(pool.loadedVersions(), {}, "a closed fence loaded nothing");
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.2" } }, "the fence opened next reads the disk as it is now");
  assert.equal(opened.length, 2);
});

/**
 * A fence error is the agent saying it is not there any more, and forgetting the handle without closing it
 * left the process behind: found live on the box, forty minutes after the turn that orphaned it, still
 * LISTENing on that workspace's `run/web.sock` while `status` reported the workspace as having no fence open.
 * The map entry and the process go together, or the next fence's gateway cannot bind the socket.
 */
test("a request that fails with a fence error drops the handle and closes it, and the next request opens a new fence", async () => {
  const { fence, opened } = fakeFence();
  const pool = new FencePool(fence, () => ({}) as never);
  const first = pool.request(us, "step", {});
  await tick();
  opened[0].fail("step", new CodedError("the fence for alice stopped answering", "fence"));
  await assert.rejects(first, /stopped answering/);
  await tick();
  assert.equal(opened[0].closed, true, "the agent process is asked to go, not left running unattached");
  const second = pool.request(us, "step", {});
  await tick();
  assert.equal(opened.length, 2, "and the next request opens a fence rather than finding a corpse");
  opened[1].answer("step");
  assert.equal(await second, "step from fence 2");
  assert.equal(opened[1].closed, false, "a healthy fence is untouched by any of this");
});

test("regression: a late error from a retired fence does not forget its replacement", async () => {
  let closes = 0;
  const { fence, opened } = fakeFence(async (rec) => { closes++; rec.closed = true; });
  const pool = new FencePool(fence, () => ({}) as never);
  const first = pool.request(us, "first", {});
  const late = pool.request(us, "late", {});
  await tick();
  opened[0].fail("first", new CodedError("first failure", "fence"));
  await assert.rejects(first, /first failure/);
  const replacement = await pool.handle(us);
  opened[0].fail("late", new CodedError("late failure", "fence"));
  await assert.rejects(late, /late failure/);
  assert.equal(await pool.handle(us), replacement, "the old request must not evict the healthy fence");
  assert.equal(opened.length, 2);
  assert.equal(closes, 1, "a late failure must not stop the retired services again");
  await pool.close();
});

test("regression: fence-error cleanup reports the error immediately but finishes before a replacement opens", async () => {
  let release!: () => void;
  const finish = new Promise<void>((done) => (release = done));
  let closes = 0;
  const { fence, opened } = fakeFence(async (rec) => {
    closes++;
    await finish;
    rec.closed = true;
  });
  const pool = new FencePool(fence, () => ({}) as never);
  const first = pool.request(us, "first", {});
  const late = pool.request(us, "late", {});
  await tick();
  opened[0].fail("first", new CodedError("gone", "fence"));
  await assert.rejects(first, /gone/);
  const replacement = pool.request(us, "next", {});
  try {
    opened[0].fail("late", new CodedError("also gone", "fence"));
    await assert.rejects(late, /also gone/);
    await tick();
    assert.equal(opened.length, 1, "old services still own their socket paths until cleanup finishes");
    assert.equal(closes, 1, "all failures of the same fence join one cleanup");
  } finally {
    release();
    await tick();
    opened[1]?.answer("next");
    await replacement;
    await pool.close();
  }
});

test("regression: closing the pool waits for fence-error cleanup already in progress", async () => {
  let release!: () => void;
  const finish = new Promise<void>((done) => (release = done));
  const { fence, opened } = fakeFence(async (rec) => { await finish; rec.closed = true; });
  const pool = new FencePool(fence, () => ({}) as never);
  const first = pool.request(us, "step", {});
  await tick();
  opened[0].fail("step", new CodedError("gone", "fence"));
  await assert.rejects(first, /gone/);
  let stopped = false;
  const closing = pool.close().then(() => { stopped = true; });
  try {
    await tick();
    assert.equal(stopped, false, "shutdown must not leave a forgotten fence's cleanup running");
  } finally {
    release();
    await closing;
  }
});

test("regression: closing while a fence opens leaves no stale open-time or version metadata", async () => {
  let release!: () => void;
  const ready = new Promise<void>((done) => (release = done));
  const { fence } = fakeFence();
  const pool = new FencePool(fence, () => ({}) as never, () => ready, undefined, () => ({ "@alice/tool": "1" }));
  const opening = pool.handle(us);
  const closing = pool.close(us.id);
  await tick();
  release();
  await opening;
  await closing;
  assert.deepEqual(pool.openedAt(), {});
  assert.deepEqual(pool.loadedVersions(), {});
});

/** Only a fence error means the agent is gone. Anything else -- a tool that threw, a step that refused -- is
 *  the fence working perfectly and reporting a failure, and closing it over that would cost the person their
 *  gateway, their terminal and their shell sessions for someone else's bug. */
test("an error that is not a fence error leaves the fence open", async () => {
  const { fence, opened } = fakeFence();
  const pool = new FencePool(fence, () => ({}) as never);
  const first = pool.request(us, "step", {});
  await tick();
  opened[0].fail("step", new CodedError("unknown tool: shell", "tool"));
  await assert.rejects(first, /unknown tool/);
  await tick();
  assert.equal(opened[0].closed, false);
  const second = pool.request(us, "step", {});
  await tick();
  assert.equal(opened.length, 1, "the same fence serves the next request");
  opened[0].answer("step");
  assert.equal(await second, "step from fence 1");
});

/**
 * The cleanup must never become a second way to get stuck. The caller is reporting a fence error; a close
 * that hangs or throws is not its problem, and a rejected close that nobody caught would fail this run by
 * itself -- which is the assertion, since an unhandled rejection is a test failure here.
 */
test("a close that never returns, or throws, costs the caller nothing", async () => {
  for (const closing of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("the kill went wrong"))]) {
    const { fence, opened } = fakeFence(closing);
    const pool = new FencePool(fence, () => ({}) as never);
    const first = pool.request(us, "step", {});
    await tick();
    const started = Date.now();
    opened[0].fail("step", new CodedError("gone", "fence"));
    await assert.rejects(first, /gone/);
    assert.ok(Date.now() - started < 100, "the caller is not made to wait for the funeral");
  }
  await tick();
});
