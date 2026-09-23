// Resource limits per fence through cgroup v2. The kernel process must sit in a delegated cgroup
// (systemd `Delegate=yes` on the unit, or `systemd-run --user --scope -p Delegate=yes`). Without one
// the fences run unlimited and the kernel says so once.
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Where the cgroup v2 filesystem is mounted — on the host, and inside every fence. */
export const CGROUP_MOUNT = "/sys/fs/cgroup";

export interface FenceLimits {
  /**
   * The memory ceiling of one fence in megabytes, or `"auto"` for none: the fence may then use the whole
   * machine, the way a container does when it is started without `--memory`. `"auto"` is the default. The
   * group is still created and still accounts, so `memory.current`, `memory.peak` and the `oom_kill`
   * counter all keep working; what goes away is the ceiling, not the bookkeeping.
   */
  memoryMb: number | "auto";
  pids: number;
  cpuPercent: number;
}

export interface Placement {
  attach(pid: number): void;
  release(): void;
}

/** One fence's own cgroup: where it is on the host, and where the fence has to see it. */
export interface FenceCgroup {
  /** The host directory of this fence's group. */
  dir: string;
  /**
   * Where `dir` is bound inside the fence. A runtime finds its group by concatenating the cgroup mount
   * point with its own `/proc/self/cgroup` line — .NET does — so the group has to sit at exactly the path
   * that concatenation names, and which path that is depends on `namespace`.
   */
  dest: string;
  /**
   * True when the fence also gets its own cgroup namespace (`bwrap --unshare-cgroup`). The namespace makes
   * the group the fence is already in the root of its own cgroup hierarchy, so `/proc/self/cgroup` inside
   * reads `0::/` and the concatenation lands on the mount point: `dest` is then the mount root, as in any
   * container. False when the kernel or bubblewrap has no cgroup namespace, and then the group has to be
   * bound at the full host path instead, because that is what `/proc/self/cgroup` still reports inside.
   * The two go together: the leaf at the mount root without the namespace makes the concatenation name a
   * directory that does not exist, .NET's probe reads garbage, and the runtime aborts
   * (`munmap_chunk(): invalid pointer`, sometimes a segfault) at random inside every fence.
   */
  namespace: boolean;
}

const CONTROLLERS = ["memory", "pids", "cpu"];
/** What cgroup v2 writes into a `.max` file to mean no limit at all. */
const NO_LIMIT = "max";

/** One fence's limits as the control files spell them. Pure, so the decision can be read and tested on its own. */
export function limitValues(limits: FenceLimits): { memoryMax: string; swapMax: string; pidsMax: string; cpuMax: string } {
  // Swap is capped at zero only when memory is: the point of that zero is to stop a fence sliding out from
  // under its ceiling into swap, and with no ceiling there is nothing to slide out of. Leaving it at zero
  // under an unlimited memory setting would be a limit nobody asked for, and a stricter one than the host's
  // own default.
  const unlimited = limits.memoryMb === "auto";
  return {
    memoryMax: unlimited ? NO_LIMIT : String(Math.max(16, limits.memoryMb as number) * 1024 * 1024),
    swapMax: unlimited ? NO_LIMIT : "0",
    pidsMax: String(Math.max(8, limits.pids)),
    cpuMax: `${Math.max(1, limits.cpuPercent) * 1000} 100000`,
  };
}

/**
 * Where a fence's cgroup directory has to appear inside the fence — derived here, so only this file knows
 * how a cgroup path is spelled. With a cgroup namespace the fence's own group is the root of the hierarchy
 * it can see, so it belongs at the mount point itself; without one, `/proc/self/cgroup` inside the fence
 * still reports the host's path, and the group has to appear under the mount point at exactly that path.
 * Either way the fence, and any runtime resolving its own limits, finds it by that concatenation.
 */
export function fenceMount(dir: string, namespace: boolean): FenceCgroup {
  return { dir, dest: namespace ? CGROUP_MOUNT : join(CGROUP_MOUNT, relative(CGROUP_MOUNT, dir)), namespace };
}

export class Cgroups {
  private constructor(private readonly root: string) {}

  /** Adopts the kernel's own delegated cgroup: moves the kernel into a child and enables the controllers for siblings. */
  static detect(log: (line: string) => void): Cgroups | undefined {
    try {
      const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
      if (!line) return undefined;
      const root = resolve(CGROUP_MOUNT, "." + line.slice(3).trim());
      const available = readFileSync(resolve(root, "cgroup.controllers"), "utf8").split(/\s+/);
      const missing = CONTROLLERS.filter((c) => !available.includes(c));
      if (missing.length) throw new Error(`controllers not delegated: ${missing.join(", ")}`);
      mkdirSync(resolve(root, "kernel"), { recursive: true });
      writeFileSync(resolve(root, "kernel", "cgroup.procs"), String(process.pid));
      writeFileSync(resolve(root, "cgroup.subtree_control"), CONTROLLERS.map((c) => `+${c}`).join(" "));
      log(`[fence] resource limits on: ${root}`);
      return new Cgroups(root);
    } catch (err) {
      log(`[fence] resource limits off: ${(err as Error).message} (run the kernel in a delegated cgroup to enable them)`);
      return undefined;
    }
  }

  /** Where one fence's own group lives on the host. `place` creates it. */
  fenceDir(id: string): string {
    return resolve(this.root, `fence-${id}`);
  }

  /** That directory and where the fence has to see it, given whether the fence gets a cgroup namespace. `place` creates it. */
  fence(id: string, namespace: boolean): FenceCgroup {
    return fenceMount(this.fenceDir(id), namespace);
  }

  /** A limited group for one fence. `attach` moves a process into it; `release` removes the group once it is empty. */
  place(id: string, limits: FenceLimits): Placement {
    const dir = this.fenceDir(id);
    const v = limitValues(limits);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "memory.max"), v.memoryMax);
    if (existsSync(resolve(dir, "memory.swap.max"))) writeFileSync(resolve(dir, "memory.swap.max"), v.swapMax);
    writeFileSync(resolve(dir, "pids.max"), v.pidsMax);
    writeFileSync(resolve(dir, "cpu.max"), v.cpuMax);
    return {
      attach: (pid) => writeFileSync(resolve(dir, "cgroup.procs"), String(pid)),
      release: () => {
        try {
          rmdirSync(dir);
        } catch {
          // Processes still exiting keep the group populated; the next open of this fence reuses it.
        }
      },
    };
  }
}
