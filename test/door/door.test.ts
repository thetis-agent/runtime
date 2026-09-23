// The door in front of a gateway that streams forever: closing the door must not wait for the stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createDoor } from "../../src/door/index.js";

function listen(server: Server, at: string | number): Promise<void> {
  return new Promise((done, fail) => server.once("error", fail).listen(at, done));
}

function close(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

test("closing the door ends an open event stream and its upstream request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-door-"));
  const socket = join(dir, "web.sock");
  let upstreamClosed: () => void = () => {};
  const closedUpstream = new Promise<void>((done) => (upstreamClosed = done));
  const gateway = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: snapshot\ndata: {}\n\n");
    req.socket.once("close", () => upstreamClosed());
  });
  const door = createDoor({ loginSocket: join(dir, "login.sock"), socketFor: (u) => (u === "alice" ? socket : undefined) });
  await listen(gateway, socket);
  await listen(door, 0);
  try {
    const port = (door.address() as AddressInfo).port;
    const stream = await new Promise<IncomingMessage>((done) => get(`http://127.0.0.1:${port}/alice/api/events`, done));
    assert.equal(stream.statusCode, 200);
    await new Promise<void>((done) => stream.once("data", () => done()));
    const streamEnded = new Promise<void>((done) => stream.once("close", () => done()));

    const started = Date.now();
    await close(door);
    assert.ok(Date.now() - started < 1000, `the door closed in ${Date.now() - started} ms`);
    await streamEnded;
    await closedUpstream;
  } finally {
    door.closeAllConnections();
    await close(gateway);
    rmSync(dir, { recursive: true, force: true });
  }
});
