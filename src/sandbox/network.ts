// Outbound-only networking for a fence. The fence runs inside a private network namespace made by
// `unshare` before bubblewrap starts; slirp4netns gives that namespace a user-mode NAT with no route
// to the host's loopback. Nothing inside can bind a host port.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";

export const SLIRP = "/usr/bin/slirp4netns";
const READY_MS = 10_000;
/** slirp4netns answers DNS on this address inside the namespace. */
const RESOLV_CONF = "nameserver 10.0.2.3\noptions timeout:2 attempts:2\n";

export function hasSlirp(): boolean {
  return existsSync(SLIRP);
}

/** Writes the resolver file that is bound over /etc/resolv.conf in egress mode. */
export function writeResolvConf(file: string): void {
  writeFileSync(file, RESOLV_CONF);
}

export interface Egress {
  pid: number;
  stop(): void;
}

/** Attaches a NAT to the network namespace of `pid` and resolves once the interface is configured. */
export function startEgress(pid: number, log: (line: string) => void): Promise<Egress> {
  return new Promise((done, fail) => {
    const args = ["--configure", "--disable-host-loopback", "--enable-sandbox", "--enable-seccomp", "--ready-fd=3", String(pid), "tap0"];
    const child: ChildProcess = spawn(SLIRP, args, { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill("SIGKILL");
        fail(err);
      } else done({ pid: child.pid ?? 0, stop: () => child.kill("SIGTERM") });
    };
    const timer = setTimeout(() => finish(new Error("slirp4netns did not report ready in time")), READY_MS);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    (child.stdio[3] as Readable | null)?.on("data", () => finish());
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`slirp4netns exited (${code}): ${stderr.replace(/WARNING[^\n]*\n?/g, "").trim().slice(0, 300)}`));
      else if (code !== 0 && code !== null) log(`[fence] egress helper for pid ${pid} exited (${code})`);
    });
  });
}
