import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKernel, defaultConfig, T, type Fences } from "../../src/index.js";
import { memoryStore } from "../../src/lib/store.js";

test("the public runtime can boot with injected adapters and no installed extensions", async () => {
  const home = mkdtempSync(join(tmpdir(), "thetis-runtime-"));
  const config = defaultConfig(home, join(home, "empty-installation"));
  config.systemPackages = {};
  config.storage.driver = "@test/not-installed";
  const requests: string[] = [];
  const closed: (string | undefined)[] = [];
  const fences: Fences = {
    async handle() { throw new Error("No userspace process is needed for an empty pipeline"); },
    async request(_userspace, operation) { requests.push(operation); return undefined; },
    async close(user) { closed.push(user); },
  };
  const store = memoryStore();
  const hosts = { async call() { return "injected host"; } };

  try {
    const kernel = await createKernel(config, (container) => {
      container.bind(T.store, () => store);
      container.bind(T.fences, () => fences);
      container.bind(T.hosts, () => hosts);
      container.bind(T.log, () => () => {});
      container.bind(T.fence, () => { throw new Error("The default process adapter must not be resolved"); });
    });
    try {
      assert.equal(kernel.store, store);
      assert.equal(kernel.fences, fences);
      assert.equal(kernel.hosts, hosts);
      kernel.users.create("alice");
      const session = kernel.sessions.create("alice");
      const events = [];
      for await (const event of kernel.sessions.send("alice", session.id, "hello")) events.push(event);
      assert.equal(events[0].type, "turn.start");
      assert.equal(events.at(-1)?.type, "turn.end");
      assert.ok(!events.some((event) => event.type === "error"));
      assert.equal(kernel.sessions.inspect("alice", session.id).conversation[0].content, "hello");
      assert.deepEqual(requests, []);
    } finally {
      await kernel.shutdown();
    }
    assert.deepEqual(closed, [undefined]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
