// What systemd would actually do if this process exited. A host fact, read from the host, and the guard the
// restart feature most needs: the unit file in this checkout is not the unit that is running. If the deployed
// unit still says `Restart=on-failure`, every other guard passes, the latch promises a restart, and the clean
// exit takes the installation down for good while the model's last words are "I'll be right back".
//
// This is mechanism and would belong in @thetis/runtime/lib, except that it is a fact about the host process rather
// than about Thetis, and @thetis/runtime is where wiring and host facts live.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Long enough for a busy dbus, short enough that a startup banner never hangs on it. */
const TIMEOUT_MS = 2_000;

/** The user manager's own unit. A unit run by it sits underneath; the manager is never the unit we want. */
const USER_MANAGER = /^user@\d+\.service$/;

export interface DeployedUnit {
  unit: string;
  /** True when a user manager owns the unit, so `systemctl` has to be asked with `--user` to have heard of it. */
  user: boolean;
}

/**
 * The systemd unit this process runs under, from its own cgroup, or null when it is not in one.
 *
 * A cgroup v2 line is `0::/system.slice/thetis-runtime.service/kernel`. Two traps in that path, which is why
 * this is not simply a split: `Delegate=yes` hands the unit's cgroup to the kernel, which puts its children in
 * sub-cgroups, so the last *segment* is `kernel` rather than a unit; and a unit run by a user manager sits
 * under `user@1000.service`, so the *first* `.service` segment is that manager, whose own `Restart=always`
 * would be a confident wrong answer. The innermost `.service` is the unit in both cases.
 *
 * Anything with no unit in it — a login session scope, a container, a cgroup v1 line, a process sitting
 * directly in the user manager — answers null, and that null is what makes the latch refuse rather than guess.
 */
export function deployedUnit(cgroupFile = "/proc/self/cgroup"): DeployedUnit | null {
  let text: string;
  try {
    text = readFileSync(cgroupFile, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const services = (line.split(":")[2] ?? "").split("/").filter((segment) => segment.endsWith(".service"));
    const unit = services[services.length - 1];
    if (unit && !USER_MANAGER.test(unit)) return { unit, user: services.some((segment) => USER_MANAGER.test(segment)) };
  }
  return null;
}

/** How long a reading is trusted. Short, because the value changes underneath a running daemon: see below. */
const CACHE_MS = 5_000;
let cached: { policy: string | null; at: number } | undefined;

/**
 * The deployed `Restart=` of the unit running this process — `always`, `on-failure`, `no`, … — or null when it
 * could not be read, which the latch treats exactly as it treats a policy that is not `always`: it refuses,
 * because "we could not tell whether the process would come back" is not a reason to exit.
 *
 * Re-read, not remembered. An earlier version cached this for the life of the process, reasoning that the
 * value cannot change without a `systemctl daemon-reload` and that an operator doing one would restart the
 * daemon anyway. That is exactly backwards in the one case that matters: an operator runs `daemon-reload`
 * *because* a restart was refused for the policy, and a daemon holding the old reading would then go on
 * refusing — the only way out being the manual restart this exists to avoid, with `status` reporting a
 * value that is no longer true. So it is read again, with a short cache to keep a polling page cheap.
 */
export function deployedRestartPolicy(): string | null {
  const now = Date.now();
  if (!cached || now - cached.at >= CACHE_MS) cached = { policy: readPolicy(), at: now };
  return cached.policy;
}

function readPolicy(): string | null {
  const deployed = deployedUnit();
  if (!deployed) return null;
  try {
    // `show` needs no privilege and asks the unit nothing, so this is safe to run at startup.
    const argv = [...(deployed.user ? ["--user"] : []), "show", "-p", "Restart", "--value", deployed.unit];
    const out = execFileSync("systemctl", argv, { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}
