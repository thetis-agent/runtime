// The host's Docker socket in a fence: which socket is chosen, where it is bound, and that the daemon
// really answers through it. Socket access is host root by design; see `src/docker.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "../../src/contracts/index.js";
import { bwrapArgs, hasBwrap, type BwrapLayout } from "../../src/sandbox/bwrap.js";
import { dockerSocket, FENCE_DOCKER_SOCKET } from "../../src/sandbox/docker.js";

function space(root: string): Userspace {
  return { id: "alice", root, home: root, store: join(root, "store"), run: join(root, "run"), mounts: [] } as unknown as Userspace;
}

const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };
const quiet = () => {};

/** A listening unix socket, so the probe sees a real socket rather than a regular file. */
function socketAt(path: string): { close(): void } {
  const server = createServer();
  server.listen(path);
  return { close: () => server.close() };
}

test("the socket is bound read-only at the path the Docker CLI looks at by default", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), { ...layout, dockerSocket: "/run/user/1000/docker.sock" }, {});
  const i = args.findIndex((a, n) => a === "--ro-bind-try" && args[n + 1] === "/run/user/1000/docker.sock");
  assert.ok(i >= 0, `no --ro-bind-try of the docker socket in ${args.join(" ")}`);
  // Whatever it is called on the host, it appears at the default path, so `docker` needs no DOCKER_HOST.
  assert.equal(args[i + 2], FENCE_DOCKER_SOCKET);
  // A bind of a parent directory lands on top of what was mounted beneath it, so the socket has to come
  // after every read-only bind above it. The userspace bind is the next one after.
  assert.ok(i < args.indexOf("--chdir"), "the socket is bound before the userspace and after the OS");
  // Read-only, and never `--bind`: the fence may speak to the socket, not unlink it or put its own there.
  assert.equal(args.filter((a, n) => a === "--bind" && args[n + 2] === FENCE_DOCKER_SOCKET).length, 0);
});

test("no socket, no bind, and no trace of Docker in the arguments", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), layout, {});
  assert.ok(!args.includes(FENCE_DOCKER_SOCKET), `the fence was given a socket it should not have: ${args.join(" ")}`);
});

test('"off" never binds, whatever the host has', () => {
  assert.equal(dockerSocket("off", "/var/run/docker.sock", quiet), undefined);
});

test('"auto" picks a usable socket and is silent about a host with no Docker', () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-docker-"));
  const sock = join(dir, "docker.sock");
  const server = socketAt(sock);
  try {
    assert.equal(dockerSocket("auto", sock, quiet, {}), sock);

    // A regular file at the path is not a socket, and a socket the kernel cannot write is one it cannot
    // connect to — both are "no Docker" rather than a bind that hands the fence a permission error.
    const notASocket = join(dir, "regular");
    writeFileSync(notASocket, "");
    assert.equal(dockerSocket("auto", notASocket, quiet, {}), undefined, "a named path that is not a socket is no Docker, not a reason to look elsewhere");
    chmodSync(sock, 0o400);
    assert.equal(dockerSocket("auto", sock, quiet, {}), undefined, "a socket with no write permission is unusable");
  } finally {
    chmodSync(sock, 0o600);
    server.close();
  }
});

test('"auto" reads DOCKER_HOST, and prefers what the operator named over it', () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-docker-env-"));
  const fromEnv = join(dir, "env.sock");
  const named = join(dir, "named.sock");
  const a = socketAt(fromEnv);
  const b = socketAt(named);
  try {
    assert.equal(dockerSocket("auto", undefined, quiet, { DOCKER_HOST: `unix://${fromEnv}` }), fromEnv);
    assert.equal(dockerSocket("auto", named, quiet, { DOCKER_HOST: `unix://${fromEnv}` }), named);
    // A TCP endpoint names no path and cannot be bound, so it is not a candidate at all. What the probe then
    // settles on is whatever this host has in the usual places, which is not this test's business.
    const tcp = dockerSocket("auto", undefined, quiet, { DOCKER_HOST: "tcp://10.0.0.5:2375" });
    assert.ok(tcp === undefined || tcp.startsWith("/"), `a tcp endpoint was taken for a path: ${tcp}`);
    assert.ok(!tcp?.includes("10.0.0.5"), `a tcp endpoint was taken for a path: ${tcp}`);
  } finally {
    a.close();
    b.close();
  }
});

test('"on" binds a socket the probe rejects, and says why', () => {
  const lines: string[] = [];
  const path = dockerSocket("on", "/nonexistent/docker.sock", (l) => lines.push(l), {});
  // A daemon that starts after the kernel leaves nothing usable now and a working socket later; the bind is
  // `-try`, so naming a path that is missing at open costs the fence nothing.
  assert.equal(path, "/nonexistent/docker.sock");
  assert.match(lines.join("\n"), /not a socket the kernel can use/);
});

test("the daemon answers through the bind, in a fence with no network at all", { skip: !hasBwrap() || (!dockerSocket("auto", undefined, quiet) && "no usable docker socket on this host") }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-docker-e2e-"));
  const sock = dockerSocket("auto", undefined, quiet) as string;
  const args = bwrapArgs(space(tmp), { ...layout, network: "none", dockerSocket: sock }, { HOME: tmp, PATH: "/usr/local/bin:/usr/bin:/bin" });
  // A unix socket is filesystem and not network: `--unshare-net` leaves the fence with no route anywhere and
  // the daemon still answers. And connecting works through a read-only bind, because that needs write
  // permission on the inode, which the mount's read-only flag does not govern.
  const run = spawnSync("bwrap", [...args, "--", "docker", "version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
  assert.match(run.stdout.trim(), /^\d+\./, `no server version through the bound socket: ${run.stdout}`);
});
