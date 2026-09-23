import { test } from "node:test";
import assert from "node:assert/strict";
import { RestartLatch, isSupervised } from "../../src/lib/restart.js";
import type { FireReport, RefusalCode, RestartConfig } from "../../src/lib/restart.js";

/** What systemd sets, and the only way `isSupervised` can be true. */
const SUPERVISED: NodeJS.ProcessEnv = { INVOCATION_ID: "c0ffee" };

/** The phrase every refusal ends with: the one that stops a model inventing a second attempt. */
const NOTHING_HAPPENED = /Nothing was armed and nothing is going to happen\.$/;

/**
 * Lets the poll interval run a few times. The latch's clock is injected, so a test never waits for the real
 * deadline — this waits only for `pollMs: 1` ticks to read the clock the test has already moved.
 */
const ticks = (): Promise<void> => new Promise((done) => setTimeout(done, 10));

function build(opts: {
  config?: Partial<RestartConfig>;
  env?: NodeJS.ProcessEnv;
  policy?: () => string | null;
  listen?: boolean;
  now?: () => number;
  inFlight?: () => string[];
} = {}): { latch: RestartLatch; fired: FireReport[] } {
  const fired: FireReport[] = [];
  const latch = new RestartLatch({
    config: { minUptimeSecs: 0, pollMs: 1, ...opts.config },
    inFlight: opts.inFlight ?? (() => []),
    env: opts.env ?? SUPERVISED,
    policy: opts.policy,
    now: opts.now ?? (() => 0),
  });
  if (opts.listen !== false) latch.onFire((r) => fired.push(r));
  return { latch, fired };
}

test("restart latch: it waits for the installation to go quiet, then fires one announce later", async () => {
  let t = 0;
  let running = ["s_busy"];
  const { latch, fired } = build({ now: () => t, inFlight: () => running });
  const armed = latch.arm("the new provider code is on disk", "u_alice");
  assert.equal(armed.state, "armed");
  assert.equal(armed.pending?.deadlineAt, 120_000);
  assert.match(armed.message, /Nothing has happened yet/);

  t = 1_000;
  await ticks();
  assert.equal(latch.status().pending?.firesAt, undefined, "nothing counts down while a turn is running");

  running = [];
  t = 2_000;
  await ticks();
  assert.equal(latch.status().pending?.firesAt, 12_000, "quiet starts a ten-second countdown");
  assert.equal(fired.length, 0, "the countdown is announced before anything happens");

  running = ["s_late"];
  t = 11_999;
  await ticks();
  assert.equal(latch.status().pending?.firesAt, 12_000, "a turn that starts during the countdown does not postpone it");
  assert.equal(fired.length, 0);

  t = 12_000;
  await ticks();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].quiet, true);
  assert.equal(fired[0].waitedMs, 12_000);
  assert.deepEqual(fired[0].cut, ["s_late"], "the turn that arrived late is still a turn that got cut");
  assert.equal(latch.status().pending, undefined);
  latch.close();
});

test("restart latch: the deadline fires it anyway, and the report names the turns it cut", async () => {
  let t = 0;
  const { latch, fired } = build({ now: () => t, inFlight: () => ["s_a", "s_b"] });
  latch.arm("the daemon is wedged", "u_alice");

  t = 119_999;
  await ticks();
  assert.equal(fired.length, 0);
  assert.equal(latch.status().pending?.firesAt, undefined, "it never went quiet, so no countdown ever started");

  t = 120_000;
  await ticks();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].quiet, false);
  assert.equal(fired[0].waitedMs, 120_000);
  assert.deepEqual(fired[0].cut, ["s_a", "s_b"]);
  latch.close();
});

test("restart latch: a second arm is contention, not a failure, and does not move the countdown", async () => {
  let t = 0;
  const { latch, fired } = build({ now: () => t });
  latch.arm("the first reason", "u_alice");
  await ticks();
  assert.equal(latch.status().pending?.firesAt, 10_000);

  t = 5_000;
  const again = latch.arm("the second reason", "u_bob");
  assert.equal(again.state, "again");
  assert.equal(again.why, undefined);
  assert.equal(again.pending?.reason, "the first reason");
  assert.equal(again.pending?.firesAt, 10_000, "asking again does not delay what is already armed");
  assert.match(again.message, /already armed: the first reason \(asked by u_alice\)/);
  assert.match(again.message, /changed nothing/);
  assert.match(again.message, /nothing is broken and nothing needs fixing/);

  t = 10_000;
  await ticks();
  assert.equal(fired.length, 1, "one latch, one firing");
  assert.equal(fired[0].reason, "the first reason");
  latch.close();
});

test("restart latch: cancel disarms it and the handler never runs", async () => {
  let t = 0;
  const { latch, fired } = build({ now: () => t });
  latch.arm("a reason since withdrawn", "u_alice");
  const { was } = latch.cancel();
  assert.equal(was?.reason, "a reason since withdrawn");
  assert.equal(latch.status().pending, undefined);
  assert.equal(latch.status().armable, true);

  t = 500_000;
  await ticks();
  assert.equal(fired.length, 0, "a cancelled latch has no clocks left to run");
  assert.equal(latch.cancel().was, undefined, "cancelling nothing is not an error");
});

test("restart latch: every refusal names its own reason, arms nothing, and says nothing happened", async () => {
  const cases: { why: RefusalCode; says: RegExp; opts: Parameters<typeof build>[0] }[] = [
    { why: "off", says: /switched off in this installation's configuration/, opts: { config: { allowRestart: false } } },
    { why: "unsupervised", says: /was not started by systemd/, opts: { env: {} } },
    { why: "no-listener", says: /short-lived command/, opts: { listen: false } },
    { why: "young", says: /up for 0 seconds, and a restart is refused below 60 seconds/, opts: { config: { minUptimeSecs: 60 } } },
    { why: "policy", says: /`Restart=on-failure`, not `Restart=always`/, opts: { policy: () => "on-failure" } },
    { why: "policy", says: /could not be read/, opts: { policy: () => null } },
  ];
  for (const c of cases) {
    const { latch, fired } = build(c.opts);
    const result = latch.arm("a good reason", "u_alice");
    assert.equal(result.state, "refused", c.why);
    assert.equal(result.why, c.why);
    assert.equal(result.pending, undefined);
    assert.match(result.message, c.says);
    assert.match(result.message, NOTHING_HAPPENED);
    const state = latch.status();
    assert.equal(state.armable, false, c.why);
    assert.equal(state.why, c.why);
    assert.equal(state.pending, undefined);
    await ticks();
    assert.deepEqual(fired, [], `${c.why} started no clocks`);
    latch.close();
  }
});

test("restart latch: the poll interval never keeps the process alive", () => {
  const { latch } = build();
  assert.equal((latch as unknown as { timer?: NodeJS.Timeout }).timer, undefined, "an unarmed latch polls nothing");
  latch.arm("a reason", "u_alice");
  const timer = (latch as unknown as { timer?: NodeJS.Timeout }).timer;
  assert.ok(timer, "arming starts the poll");
  assert.equal(timer.hasRef(), false, "the latch must never be the thing holding the daemon open");
  latch.cancel();
  assert.equal((latch as unknown as { timer?: NodeJS.Timeout }).timer, undefined);
});

test("restart latch: supervision is what systemd puts in the environment, and status reports it", () => {
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ INVOCATION_ID: "x" }), true);
  assert.equal(isSupervised({ JOURNAL_STREAM: "8:123" }), true);
  const { latch } = build({ now: () => 90_000, config: { minUptimeSecs: 60 } });
  const state = latch.status();
  assert.equal(state.supervised, true);
  assert.equal(state.startedAt, 90_000);
  assert.equal(state.uptimeSecs, 0, "the latch is built as the daemon starts, so uptime counts from there");
  assert.equal(state.armable, false, "and it is too young to restart");
  assert.equal(build({ env: {} }).latch.status().supervised, false);
});

test("restart latch: the configuration is read through the object it was given, so a reload written into it in place is seen", () => {
  let t = 0;
  const control: Partial<RestartConfig> = { allowRestart: true, minUptimeSecs: 60, quietWaitMs: 120_000 };
  const latch = new RestartLatch({ config: control, inFlight: () => [], env: SUPERVISED, now: () => t });
  latch.onFire(() => {});
  assert.equal(latch.status().why, "young");
  control.minUptimeSecs = 0;
  assert.equal(latch.status().armable, true, "minUptimeSecs changed after construction");
  control.allowRestart = false;
  assert.equal(latch.arm("x", "u").why, "off", "allowRestart changed after construction");
  control.allowRestart = true;
  control.quietWaitMs = 5_000;
  const armed = latch.arm("x", "u");
  assert.equal(armed.state, "armed");
  assert.equal(armed.pending?.deadlineAt, 5_000, "quietWaitMs changed after construction");
  latch.cancel();
  delete control.quietWaitMs;
  assert.equal(latch.arm("x", "u").pending?.deadlineAt, 120_000, "a key the object lacks falls back to the default");
  latch.close();
});
