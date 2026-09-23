import assert from "node:assert/strict";
import { test } from "node:test";
import { Enumerator } from "../dist/src/kernel/pipeline/enumerator.js";
import { defaultConfig } from "../dist/src/kernel/config.js";
import { normalizeMessages } from "../dist/src/lib/content.js";
import { kernelClient } from "../dist/src/lib/kernel-client.js";
import { createRpcHandler } from "../dist/src/kernel/rpc.js";
import { createControlHandler } from "../dist/src/kernel/control.js";

test("enumerator validates unknown entries before checking declared exports", () => {
  const enumerator = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined);
  const packages = [{ name: "@test/steps", thetis: { steps: [{ id: "load", export: "load", phase: "prompt" }] } }];
  for (const entry of [null, [], { package: "@test/steps", export: "load", id: 42 }, { package: "@test/steps", export: "load", phase: {} }]) {
    assert.throws(() => enumerator.validate([entry], packages), error => error.code === "enumerator");
  }
});

test("RPC rejects absent identifiers and string booleans before invoking services", async () => {
  let invoked = false;
  const rpc = createRpcHandler({ id: "alice" }, {
    users: { authorize: () => ({ id: "alice", role: "user" }) },
    packages: { unfork: () => { invoked = true; } },
    sessions: { inspect: () => { invoked = true; } },
  });
  for (const [method, args] of [["sessions.inspect", {}], ["sessions.inspect", []], ["packages.unfork", { name: "@test/pkg", deleteFiles: "false" }]]) {
    await assert.rejects(rpc(method, args), error => error.code === "rpc");
  }
  assert.equal(invoked, false);
});

test("operator rejects invalid roles and deleteFiles values before journaling or mutation", async () => {
  let invoked = false;
  const control = createControlHandler({
    users: { authorize: () => ({ id: "alice", role: "admin" }), setRole: () => { invoked = true; } },
    sessions: { userspaceFor: () => ({ id: "alice" }) },
    packages: { unfork: () => { invoked = true; return { name: "@test/pkg" }; } },
    journal: { append: () => { invoked = true; } },
  });
  for (const [method, args] of [["users.setRole", { id: "alice", role: 42 }], ["users.setRole", { id: "alice" }], ["packages.unfork", { name: "@test/pkg", deleteFiles: "false" }]]) {
    await assert.rejects(control(method, args), error => error.code === "rpc");
  }
  assert.equal(invoked, false);
});

test("host extensions retain authority over their own argument shapes", async () => {
  const control = createControlHandler({ journal: { append() {} }, hosts: { call: async (_name, _export, args) => args } });
  const input = { id: 42, role: { application: "custom" }, payload: [1, 2] };
  assert.deepEqual(await control("host.custom.run", input), input);
});

test("uninstalling a fork keeps the client's void reply contract when the service restores its origin", async () => {
  const rpc = createRpcHandler({ id: "alice" }, {
    users: { authorize: () => ({ id: "alice", role: "user" }) },
    packages: { uninstall: async () => ({ name: "@test/origin" }) },
  });
  assert.equal(await kernelClient(rpc).packages.uninstall("@alice/fork"), undefined);
});

test("messages reject malformed tool calls instead of trusting a Message assertion", () => {
  for (const toolCalls of ["calls", [null], [{ id: "t", name: "read", args: [] }], [{ id: "t", name: 42, args: {} }]]) {
    assert.throws(() => normalizeMessages([{ role: "assistant", content: [], toolCalls }]), error => error.code === "invalid");
  }
});

test("client validates model replies and streamed events before exposing typed values", async () => {
  const client = kernelClient(async (method, args, emit) => {
    if (method === "models") return { model: "test", models: [{ id: 42 }] };
    emit?.({ type: "usage", usage: { tokens: "many" } });
    return null;
  });
  await assert.rejects(client.models(), /models/);
  let emitted = false;
  await assert.rejects(client.sessions.send("s", "hello", () => { emitted = true; }), /usage/);
  assert.equal(emitted, false);
});
