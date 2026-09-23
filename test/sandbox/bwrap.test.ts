// The fence's own cgroup, bound read-only inside it: the two layouts (with a cgroup namespace and
// without), where the argument list puts each, how the host is asked which one it can have, and what the
// agent — and a language runtime sizing its heap — can then read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "../../src/contracts/index.js";
import { bwrapArgs, hasBwrap, hasCgroupNamespace, type BwrapLayout } from "../../src/sandbox/bwrap.js";
import { CGROUP_MOUNT, fenceMount, limitValues } from "../../src/sandbox/cgroup.js";

function space(root: string): Userspace {
  return { id: "alice", root, home: root, store: join(root, "store"), run: join(root, "run"), mounts: [] } as unknown as Userspace;
}

const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };
/** What a delegated kernel under `thetis-runtime.service` names one fence's group. */
const FENCE_DIR = `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`;

/** The index of a flag followed by its first operand, or -1. */
function at(args: string[], flag: string, src?: string): number {
  return args.findIndex((a, i) => a === flag && (src === undefined || args[i + 1] === src));
}

/** This process's own cgroup v2 directory, when the host has one and it is readable. */
function ownCgroupDir(): string | undefined {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    const dir = line && join(CGROUP_MOUNT, line.slice(3).trim());
    return dir && existsSync(join(dir, "memory.max")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

test("with a cgroup namespace the group is the mount root; without one it is the path /proc/self/cgroup names", () => {
  // A runtime resolves its own group by appending the `/proc/self/cgroup` line to the mount point. The
  // namespace makes that line `0::/`, so the group belongs at the mount point itself — how every container
  // has it, and the only layout in which .NET's `statfs` on the mount point answers "cgroup v2".
  const namespaced = fenceMount(FENCE_DIR, true);
  assert.equal(namespaced.dest, CGROUP_MOUNT);
  assert.equal(namespaced.namespace, true);

  // Without the namespace the fence still sees the host's line, so the group has to sit at exactly that
  // path. The leaf at the mount root and no namespace is the combination that crashed .NET.
  const plain = fenceMount(FENCE_DIR, false);
  assert.equal(plain.dest, `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`);
  assert.equal(plain.dest, plain.dir, "the mount point is the same inside the fence as on the host");
  assert.equal(plain.namespace, false);
  assert.notEqual(plain.dest, CGROUP_MOUNT, "never the mount root without the namespace: that is what broke .NET");
});

test("the fence's own cgroup is bound read-only at the mount root, with the namespace, before the userspace", () => {
  const root = "/srv/thetis/users/alice";
  const args = bwrapArgs(space(root), { ...layout, cgroup: fenceMount(FENCE_DIR, true) }, {});

  const bind = at(args, "--ro-bind-try", FENCE_DIR);
  assert.ok(bind >= 0, `no --ro-bind-try of the fence cgroup in ${args.join(" ")}`);
  assert.equal(args[bind + 2], CGROUP_MOUNT);
  // The whole cgroup tree is named exactly twice — the source and the destination of this one read-only
  // bind — so no part of the host's tree beside this fence's own group is reachable, and nothing writable
  // is mounted there.
  assert.deepEqual(args.filter((a) => a.startsWith(CGROUP_MOUNT)), [FENCE_DIR, CGROUP_MOUNT]);
  for (const writable of ["--bind", "--dev-bind", "--bind-try", "--dev-bind-try", "--tmpfs"]) {
    assert.equal(at(args, writable, FENCE_DIR), -1, `the cgroup is never ${writable}`);
  }

  // The namespace and the bind at the root go together: each is wrong without the other.
  assert.ok(args.includes("--unshare-cgroup"), "the mount root is only correct inside a cgroup namespace");
  assert.ok(args.indexOf("--unshare-cgroup") > args.indexOf("--unshare-user"), "with the other namespace flags");

  // The bind sits after the read-only host and before the writable userspace, so a later bind cannot be
  // shadowed by it. `-try` and not `--ro-bind`: the directory appears while the launch gate is still shut,
  // and when limits are off it never appears at all. Neither case may fail the fence.
  assert.ok(bind > at(args, "--proc", "/proc"), "after the OS view");
  assert.ok(bind < at(args, "--bind", root), "before the userspace bind");
  assert.ok(bind < args.indexOf("--unshare-user"), "before the namespace flags");
});

test("without the namespace the fence keeps the older layout: the group at the path /proc/self/cgroup names", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), { ...layout, cgroup: fenceMount(FENCE_DIR, false) }, {});
  const bind = at(args, "--ro-bind-try", FENCE_DIR);
  assert.ok(bind >= 0);
  assert.equal(args[bind + 2], `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`);
  // Bubblewrap makes the intermediate directories of a destination itself, so the nested path needs no
  // `--dir` of its own.
  assert.equal(args.includes(CGROUP_MOUNT), false, "/sys/fs/cgroup itself is never a bind destination here");
  assert.equal(args.includes("--unshare-cgroup"), false, "no namespace, so the group is not at the root");
});

test("no delegated cgroup means no bind and no namespace, and never the host's whole tree", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), layout, {});
  assert.equal(args.includes(CGROUP_MOUNT), false, "nothing is mounted at /sys/fs/cgroup");
  assert.equal(args.includes("--ro-bind-try"), false);
  assert.equal(args.includes("--unshare-cgroup"), false, "the namespace is only taken with the group at the root");
  // Mode `none` never reaches here, and cgroups v1 and an undelegated kernel both leave `cgroup` unset.
  assert.equal(args.some((a) => a.startsWith("/sys")), false, "no part of /sys is bound");
});

test("the namespace probe answers for this host, and its yes is the truth", { skip: !hasBwrap() && "bubblewrap is not available" }, () => {
  const supported = hasCgroupNamespace();
  assert.equal(typeof supported, "boolean");
  if (!supported) return; // An old kernel or bubblewrap: the fence falls back, which the tests above cover.
  const run = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-cgroup", "--", "cat", "/proc/self/cgroup"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "0::/", "inside the namespace the fence's own group is the root of what it sees");
});

test("under bubblewrap the agent reads its own limits at the root, sees no sibling, and cannot write", { skip: !hasBwrap() && "bubblewrap is not available" }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-cgroup-"));
  const root = join(tmp, "userspace");
  const dir = join(tmp, "fence-alice");
  mkdirSync(root);
  mkdirSync(dir);
  mkdirSync(join(tmp, "fence-bob"));
  // Stands in for the fence's group: `Cgroups.place` writes the same file names into the real one.
  writeFileSync(join(dir, "memory.max"), "1073741824\n");
  writeFileSync(join(dir, "memory.events"), "oom 0\noom_kill 3\n");

  const namespaced = hasCgroupNamespace();
  const dest = namespaced ? CGROUP_MOUNT : fenceMount(FENCE_DIR, false).dest;
  const args = bwrapArgs(space(root), { ...layout, cgroup: { dir, dest, namespace: namespaced } }, {});
  const show = `cat ${dest}/memory.max ${dest}/memory.events; ls ${CGROUP_MOUNT}; ls /sys`;
  const read = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /1073741824/);
  assert.match(read.stdout, /oom_kill 3/);
  assert.equal(read.stdout.includes("fence-bob"), false, "no sibling fence's group is reachable");
  assert.equal(read.stdout.trim().split("\n").pop(), "fs", "only /sys/fs exists inside; no other part of /sys");

  const write = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", `echo 1 > ${dest}/memory.max`], { encoding: "utf8" });
  assert.notEqual(write.status, 0, "the fence must not be able to change its own limits");
  assert.match(write.stderr, /[Rr]ead-only/);
});

const dotnet = spawnSync("sh", ["-c", "command -v dotnet"], { encoding: "utf8" }).stdout.trim();
const own = ownCgroupDir();
const toolchain = !hasBwrap() ? "bubblewrap is not available" : !dotnet ? "dotnet is not installed" : !own ? "no readable cgroup v2 group" : false;

/** `dotnet --version` `runs` times over one argument list; every run has to be a clean exit 0. */
function dotnetRuns(args: string[], runs: number): void {
  for (let i = 0; i < runs; i++) {
    const run = spawnSync("bwrap", [...args, "--", dotnet, "--version"], { encoding: "utf8" });
    assert.equal(run.status, 0, `run ${i + 1}: exit ${run.status} signal ${run.signal}\n${run.stderr}`);
    assert.doesNotMatch(run.stderr, /munmap_chunk|Segmentation fault|Aborted|double free/, `run ${i + 1}`);
  }
}

test("a runtime that resolves its own cgroup starts every time, and finds a cgroup v2 filesystem", { skip: toolchain || (!hasCgroupNamespace() && "no cgroup namespace on this host") }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-dotnet-"));
  // The cgroup this process is in stands in for the fence's group; inside the namespace it is the root of
  // the hierarchy, exactly as `fence-<user>` is for a fence.
  const args = bwrapArgs(space(tmp), { ...layout, cgroup: fenceMount(own as string, true) }, { HOME: tmp, PATH: "/usr/local/bin:/usr/bin:/bin" });
  dotnetRuns(args, 10);

  // What the runtime reads: `0::/`, the mount point a cgroup2 filesystem — which is how .NET decides it is
  // on cgroups v2 at all — and this group's own limit there. Bound at the root without the namespace, the
  // mount point is the tmpfs bubblewrap made, .NET concludes cgroups v1, finds no v1 hierarchy, and sizes
  // its heap from the host's memory instead.
  const show = `cat /proc/self/cgroup; stat -f -c %T ${CGROUP_MOUNT}; cat ${CGROUP_MOUNT}/memory.max`;
  const read = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  const [line, fs, limit] = read.stdout.trim().split("\n");
  assert.equal(line, "0::/", "the fence's own group is the root of the hierarchy it can see");
  assert.equal(fs, "cgroup2fs");
  assert.equal(limit, readFileSync(join(own as string, "memory.max"), "utf8").trim(), "the host's value for this group");
});

test("the fallback layout still starts that runtime, every time", { skip: toolchain }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-dotnet-plain-"));
  // Detection forced off: the host path layout of the previous release, which has to stay crash-free —
  // this is what a kernel or bubblewrap without cgroup namespaces gets. The fence then sees the host's
  // `/proc/self/cgroup` line and the group under the mount point at exactly that path.
  const args = bwrapArgs(space(tmp), { ...layout, cgroup: fenceMount(own as string, false) }, { HOME: tmp, PATH: "/usr/local/bin:/usr/bin:/bin" });
  dotnetRuns(args, 10);

  const show = `cat /proc/self/cgroup; cat ${CGROUP_MOUNT}$(sed -n 's/^0:://p' /proc/self/cgroup)/memory.max`;
  const read = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim().split("\n")[0], `0::${(own as string).slice(CGROUP_MOUNT.length)}`, "the host's path, no namespace");
});

test("memoryMb auto means no ceiling, and swap is only capped when memory is", () => {
  // The default: the fence may use the whole machine, the way a container started without --memory does.
  // The group is still created and still accounts, so memory.current, memory.peak and the oom_kill counter
  // keep working; what goes away is the ceiling, not the bookkeeping.
  const auto = limitValues({ memoryMb: "auto", pids: 512, cpuPercent: 200 });
  assert.equal(auto.memoryMax, "max");
  // Zero swap exists to stop a fence sliding out from under its ceiling. With no ceiling there is nothing
  // to slide out of, and a zero there would be a limit nobody asked for, stricter than the host's own.
  assert.equal(auto.swapMax, "max");
  // A number still limits, and the other two are unaffected by the memory setting either way.
  const capped = limitValues({ memoryMb: 8192, pids: 512, cpuPercent: 200 });
  assert.equal(capped.memoryMax, String(8192 * 1024 * 1024));
  assert.equal(capped.swapMax, "0");
  assert.equal(capped.pidsMax, auto.pidsMax);
  assert.equal(capped.cpuMax, auto.cpuMax);
});

test("the floors still apply to a limit that is a number", () => {
  const tiny = limitValues({ memoryMb: 1, pids: 1, cpuPercent: 0 });
  assert.equal(tiny.memoryMax, String(16 * 1024 * 1024), "a fence under 16 MiB cannot start at all");
  assert.equal(tiny.pidsMax, "8");
  assert.equal(tiny.cpuMax, "1000 100000");
});
