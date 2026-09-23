// The bubblewrap command line for one fence, and the launch gate around it.
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { SYSTEM_USER, type Mount, type Userspace } from "../contracts/index.js";
import type { FenceCgroup } from "./cgroup.js";
import { FENCE_DOCKER_SOCKET } from "./docker.js";
import { orderIntents, renderIntents, resolveGrants, validateIntents, type MountIntent } from "./plan.js";
import { FENCE_SSH_AUTH_SOCK, FENCE_SSH_CONFIG, FENCE_SSH_DIR, FENCE_SSH_KNOWN_HOSTS, type FenceSsh } from "./ssh.js";

/** The OS directories every fence may read. Missing ones are skipped. */
const OS_DIRS = ["/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];
const READY_MS = 10_000;

export interface BwrapLayout {
  /** Host paths the agent may read besides the OS (the package tree, for system packages). */
  readOnly: string[];
  /** Host paths masked with an empty tmpfs even if a parent is bound (the service-plane data dir). */
  hidden: string[];
  /** Writable for the system userspace, read-only for every other fence. */
  sharedDir: string;
  /** The resolver file bound over /etc/resolv.conf in egress mode. */
  resolvConf: string;
  network: "egress" | "none" | "host";
  /**
   * This fence's own cgroup directory, the path inside the fence it is bound read-only at, and whether the
   * fence gets a cgroup namespace of its own. Undefined when the kernel has no delegated cgroup (limits
   * off) or the host runs cgroups v1; then the bind and the namespace are both simply left out.
   */
  cgroup?: FenceCgroup;
  /**
   * The host's Docker socket, bound into the fence at `FENCE_DOCKER_SOCKET`. Undefined for no Docker.
   * Socket access is host root; see `docker.ts` for why it is offered anyway.
   */
  dockerSocket?: string;
  /** The per-fence ssh agent socket and the client files that go with it. Undefined when this fence has no ssh grant. */
  ssh?: FenceSsh;
}

export function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Whether a fence can have its own cgroup namespace: the kernel has to offer one (Linux 4.6 and later,
 * which is what `/proc/self/ns/cgroup` being there means) and this bubblewrap has to know the flag and be
 * allowed to use it. The second half is answered by running it rather than by reading a version number: an
 * older bubblewrap rejects the unknown option, and a kernel that refuses `CLONE_NEWCGROUP` in a user
 * namespace fails the clone, and either way the probe is not exit 0. A false answer is never fatal — the
 * fence is then built the way it was before the namespace existed, with the group at the path
 * `/proc/self/cgroup` names.
 */
export function hasCgroupNamespace(): boolean {
  if (!existsSync("/proc/self/ns/cgroup")) return false;
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-cgroup", "--", "true"], { stdio: "ignore" });
  return probe.status === 0;
}

/** The directory the running Node binary was installed under, so the fence sees the same runtime. */
export function nodePrefix(): string {
  return dirname(dirname(process.execPath));
}

/**
 * The mount plan for `us`: every path the fence sees, as data. Nothing here depends on the order the
 * entries are written in -- `orderIntents` puts them parents-first, which is the only order in which each
 * one survives. See `plan.ts` for why that matters and what it cost to learn.
 */
export function fencePlan(us: Userspace, layout: BwrapLayout): MountIntent[] {
  const intents: MountIntent[] = [
    { kind: "dev", target: "/dev", why: "the fence's own /dev" },
    { kind: "proc", target: "/proc", why: "the fence's own /proc" },
    { kind: "tmpfs", target: "/tmp", why: "an empty /tmp, never the host's" },
  ];
  for (const dir of [...OS_DIRS, nodePrefix(), ...layout.readOnly]) {
    if (!existsSync(dir)) continue;
    const link = linkTarget(dir);
    intents.push(link ? { kind: "symlink", target: dir, source: link, why: "the operating system" } : { kind: "ro", target: dir, source: dir, why: "the operating system" });
  }
  // Masks are declared after the binds they sit inside and are ordered by depth, so a mask beneath a bound
  // parent applies and a bind beneath a mask still shows through. Writing them first, which is what the
  // hand-ordered list did, is what let `/opt` swallow the mask over `$THETIS_HOME`.
  for (const dir of layout.hidden) intents.push({ kind: "tmpfs", target: dir, why: "fence.hidden" });
  if (existsSync(layout.sharedDir)) {
    intents.push({ kind: us.id === SYSTEM_USER ? "rw" : "ro", target: layout.sharedDir, source: layout.sharedDir, why: "the shared directory" });
  }
  if (layout.network === "egress" && existsSync(layout.resolvConf)) {
    intents.push({ kind: "ro", target: "/etc/resolv.conf", source: layout.resolvConf, why: "the egress resolver" });
  }
  // The fence's own cgroup and nothing else of the host's tree: how an agent reads its own `memory.max`,
  // `memory.current` and `memory.events` and can tell an OOM kill from a transient failure, and how a
  // language runtime sizes its heap for the fence rather than for the machine. Read-only, so it is
  // self-knowledge and not control. Where it goes is decided in `cgroup.ts` and goes with `--unshare-cgroup`
  // below; the two are one choice, because a runtime resolves its group by appending its `/proc/self/cgroup`
  // line to the mount point. Optional because `Cgroups.place` creates the directory while the launch gate
  // is still shut, and because limits being off must never keep a fence from starting.
  if (layout.cgroup) intents.push({ kind: "ro", target: layout.cgroup.dest, source: layout.cgroup.dir, optional: true, why: "this fence's cgroup" });
  // Always at the path the Docker CLI reads by default, whatever the socket is called on the host, so
  // `docker` and `docker compose` work with nothing configured. A unix socket is filesystem and not network,
  // so this works in network mode `none` too; read-only still permits `connect`, which needs write
  // permission on the inode rather than on the mount, and does stop the fence replacing the socket.
  if (layout.dockerSocket) intents.push({ kind: "ro", target: FENCE_DOCKER_SOCKET, source: layout.dockerSocket, optional: true, why: "fence.docker" });
  // The agent socket, the known hosts the kernel vouches for, and the client options that make ssh fail
  // fast instead of hanging on a prompt. The private key is never among them: it stays with the agent, on
  // the other side of this socket. See `ssh.ts`.
  if (layout.ssh) {
    // An empty /etc/ssh first: `/etc` is bound read-only, so there is nowhere to put these two otherwise,
    // and the fence is then left with exactly the client configuration the kernel wrote and no host
    // defaults beneath it. Ordering by depth is what lets this sit inside the read-only bind above it.
    intents.push({ kind: "tmpfs", target: FENCE_SSH_DIR, why: "room for the ssh client files" });
    intents.push({ kind: "ro", target: FENCE_SSH_AUTH_SOCK, source: layout.ssh.sock, optional: true, why: "an ssh grant" });
    intents.push({ kind: "ro", target: FENCE_SSH_CONFIG, source: layout.ssh.config, optional: true, why: "the ssh client options" });
    intents.push({ kind: "ro", target: FENCE_SSH_KNOWN_HOSTS, source: layout.ssh.knownHosts, optional: true, why: "the known hosts" });
  }
  intents.push({ kind: "rw", target: us.root, source: us.root, why: "the userspace" });
  // Declared last, so a granted path wins over a read-only bind of the same path, and marked `grant`, so a
  // read-only bind *inside* one is bound read-write instead of quietly taking that subtree back. Depth
  // decides the rest. See `resolveGrants` in plan.ts for which binds a grant does not win over.
  for (const m of us.mounts ?? []) intents.push({ kind: m.mode === "rw" ? "rw" : "ro", target: m.path, source: m.path, grant: true, why: `a ${m.mode} mount` });
  return intents;
}

/** The bubblewrap arguments that give `us` a read-only host, a writable userspace, and its namespaces. */
export function bwrapArgs(us: Userspace, layout: BwrapLayout, env: Record<string, string>, log?: (line: string) => void): string[] {
  const ordered = orderIntents(resolveGrants(fencePlan(us, layout)));
  // A conflict is reported and never fatal: the plan still renders, and the operator learns which entry
  // took the path. Silence here is what the old list gave, and silence is what made the mask bug survive.
  for (const c of validateIntents(ordered)) log?.(`[fence] ${us.id}: mount plan conflict at ${c.target}: ${c.message}`);
  const args = renderIntents(ordered);
  args.push("--chdir", us.home);
  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts");
  // The cgroup namespace makes the group the fence is already in -- `Cgroups.place` put it there while the
  // launch gate was shut -- the root of the hierarchy it can see: `/proc/self/cgroup` inside reads `0::/`,
  // and `/sys/fs/cgroup` is a cgroup2 filesystem holding the fence's own files rather than a tmpfs with a
  // bind buried in it. That is what lets .NET find its limit at all: it picks the cgroup version by
  // `statfs` on the mount point, and only this layout answers v2. It is unshared only when the group is
  // bound at the root, because each is wrong without the other, and only when the kernel and this
  // bubblewrap both have it (`hasCgroupNamespace`); otherwise the fence keeps the layout it had before.
  if (layout.cgroup?.namespace) args.push("--unshare-cgroup");
  args.push("--cap-drop", "ALL", "--disable-userns", "--die-with-parent", "--new-session");
  if (layout.network === "none") args.push("--unshare-net");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  return args;
}

/** The mounts of `us` whose host path exists. A missing one is logged and skipped, so the fence still opens. */
export function presentMounts(us: Userspace, log: (line: string) => void): Mount[] {
  return (us.mounts ?? []).filter((m) => {
    if (existsSync(m.path)) return true;
    log(`[fence] ${us.id}: mount ${m.path} does not exist on the host; skipped`);
    return false;
  });
}

/**
 * Wraps a bubblewrap command in the launch gate. fd 5 is the gate: the launcher waits for a line on it
 * before it execs. fd 6 says the launcher runs, and so its namespaces exist. In egress mode `unshare`
 * makes the private network namespace before bubblewrap runs, because slirp4netns cannot enter one
 * bubblewrap made itself.
 */
export function launcherCommand(inner: string[], network: BwrapLayout["network"]): string[] {
  const script = 'printf ready >&6; read -r go <&5 || exit 97; exec "$@"';
  const shell = ["/bin/sh", "-c", script, "sh", ...inner];
  return network === "egress" ? ["unshare", "--map-root-user", "--net", "--", ...shell] : shell;
}

/** Resolves once the launcher script reports that it runs (and so its namespaces exist). */
export function launcherReady(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the sandbox launcher did not start")), READY_MS);
    // Node types the stdio tuple with five slots; the launcher has seven.
    (child.stdio as unknown as (Readable | null)[])[6]?.once("data", () => {
      clearTimeout(timer);
      done();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the sandbox launcher exited (${code})`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

function linkTarget(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}
