// The control token: who is refused, who is admitted, and that a daemon without one still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRpcSocket, RpcSocketServer } from "../../src/lib/ndjson-socket.js";

const handler = async (method: string) => `ran ${method}`;

async function serverOn(token?: string): Promise<{ path: string; stop: () => Promise<void>; log: string[] }> {
  const path = join(mkdtempSync(join(tmpdir(), "thetis-token-")), "ctl.sock");
  const log: string[] = [];
  const server = new RpcSocketServer(path, handler, (l) => log.push(l), token);
  await server.listen();
  return { path, stop: () => server.close(), log };
}

test("a caller presenting the token is served, and one without it is refused", async (t) => {
  const s = await serverOn("the-secret");
  t.after(() => s.stop());

  const good = await connectRpcSocket(s.path, "the-secret");
  assert.equal(await good?.call("users.list", {}), "ran users.list");
  good?.close();

  // The refusal is an answer, not a dropped connection: a caller of the wrong vintage gets a sentence
  // saying what to do rather than a socket that closes on it.
  const none = await connectRpcSocket(s.path);
  await assert.rejects(() => none!.call("users.list", {}) as Promise<unknown>, /did not present the control token/);
  none?.close();

  const wrong = await connectRpcSocket(s.path, "not-the-secret");
  await assert.rejects(() => wrong!.call("users.list", {}) as Promise<unknown>, /did not present the control token/);
  wrong?.close();
  assert.equal(s.log.filter((l) => l.includes("without the control token")).length, 2);
});

test("a daemon with no token admits anyone who can open the socket, as it always did", async (t) => {
  // An installation with no usable run directory keeps its command line rather than losing it to a
  // hardening measure: this is defence in depth behind a 0600 socket, not the only lock on the door.
  const s = await serverOn(undefined);
  t.after(() => s.stop());
  const plain = await connectRpcSocket(s.path);
  assert.equal(await plain?.call("users.list", {}), "ran users.list");
  plain?.close();
  // And a caller that presents one anyway is not punished for it, which is what lets a new command line
  // talk to a daemon that has not been restarted yet.
  const carrying = await connectRpcSocket(s.path, "a-token-from-somewhere");
  assert.equal(await carrying?.call("users.list", {}), "ran users.list");
  carrying?.close();
});
