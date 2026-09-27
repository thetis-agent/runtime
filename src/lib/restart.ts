// The latch behind a restart the model can ask for. The whole point is that arming is not restarting: a tool
// that exited the process immediately would kill the very turn that called it, and the person would see a
// turn that simply stopped. So `arm` only sets a latch and returns a sentence; every running turn, the caller's
// included, pauses at its next round boundary (`turns.yielding`), and only then does the latch call its handler
// — which resolves the same promise SIGINT resolves, so the ordinary shutdown path runs and `Restart=always`
// turns the clean exit into a restart. The paused turns continue by themselves when the new process is up.
//
// Two clocks, because "wait until nothing is running" and "do not wait forever" are different promises. The
// deadline is fixed at arming time; the countdown starts on the first tick where nothing is in flight and is
// never re-tested afterwards, or a busy installation would defer a restart forever while calling it pending.
//
// The refusal sentences live here rather than in the tool package, so that forking the tool cannot change
// what the kernel says about itself. Each says what happened, why, and what to do instead, and each ends by
// making clear that nothing happened — the sentence that stops a model inventing a second attempt.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseSchema } from "./validation.js";

const RestartConfigSchema = z.object({
  allowRestart: z.boolean(),
  minUptimeSecs: z.number().nonnegative(),
  quietWaitMs: z.number().nonnegative(),
  announceMs: z.number().nonnegative(),
  pollMs: z.number().int().positive(),
});

export interface RestartConfig {
  /** The legacy `control.allow_restart`: an installation may withhold this entirely. */
  allowRestart: boolean;
  /**
   * The legacy `control.min_uptime_secs` from `/opt/thetis/crates/thetis/src/settings/schema.rs`, carried
   * forward with its reason: it is what makes "restart → it did not help → restart" terminate.
   */
  minUptimeSecs: number;
  /**
   * How long a restart waits for every turn to end before it goes anyway: two minutes; see `cut`. An armed
   * restart asks running turns to stop at their next round boundary (`turns.yielding`), so most end in
   * seconds; a turn inside one long tool call is what the deadline is for. A drained reload waits as long.
   */
  quietWaitMs: number;
  /** The announced countdown once it is quiet: long enough that the Cancel button is a real offer. */
  announceMs: number;
  /** How often the two clocks are read. Fine enough that the countdown a page shows is not visibly wrong. */
  pollMs: number;
}

const DEFAULTS: RestartConfig = {
  allowRestart: true,
  minUptimeSecs: 60,
  quietWaitMs: 120_000,
  announceMs: 10_000,
  pollMs: 250,
};

/** An armed restart, exactly as the status endpoint and the statusbar chip show it. */
export interface Pending {
  reason: string;
  by: string;
  at: number;
  /** `at + quietWaitMs`: the moment it goes whether or not anything is still running. */
  deadlineAt: number;
  /** Set on the first tick where nothing is in flight, and never moved after that. */
  firesAt?: number;
}

export interface RestartState {
  startedAt: number;
  uptimeSecs: number;
  supervised: boolean;
  armable: boolean;
  /** Why it is not armable, when it is not. The same code `arm` would refuse with. */
  why?: RefusalCode;
  pending?: Pending;
}

export type RefusalCode = "off" | "unsupervised" | "no-listener" | "young" | "policy" | "updating";

/** What a restart asked for while an update installs is told. `@thetis/host-update` says the same words. */
export const UPDATING = "An update is installing; Thetis restarts by itself when it is done.";

/** A lock whose heartbeat is older than this has nothing behind it; `@thetis/host-update` breaks it on its next job. */
const UPDATE_LOCK_STALE_MS = 30 * 60_000;

/**
 * Whether an update job holds `<home>/update/lock` (`@thetis/host-update`): the file names the process that took
 * it, and its modification time is the job's heartbeat. A restart then would come up on a half-installed
 * checkout, so `restart.request` refuses; the job arms the latch itself when it is done (`HostEnv.restart`).
 */
export function updateInstalling(home: string, now = Date.now()): boolean {
  const file = join(home, "update", "lock");
  try {
    const beat = statSync(file).mtimeMs;
    const pid = Number((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid);
    if (now - beat >= UPDATE_LOCK_STALE_MS || !Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No lock, a half-written one, or a process that is gone (`ESRCH`); `EPERM` is a live process of another user.
    return (err as { code?: string }).code === "EPERM";
  }
}

export type ArmResult = { state: "armed" | "again" | "refused"; why?: RefusalCode; message: string; pending?: Pending };

export interface FireReport {
  reason: string;
  by: string;
  /** True when it fired because the installation went quiet, false when the deadline took it. */
  quiet: boolean;
  waitedMs: number;
  /** The turns still running as it fired, so the record can name whose turn it cut. */
  cut: string[];
}

/**
 * Whether systemd started this process. Evaluated in the daemon and nowhere else: the fence hands package
 * code an env allowlist, so a tool inside a fence cannot see these and would wrongly conclude "not
 * supervised". `INVOCATION_ID` is set by systemd for every unit; `JOURNAL_STREAM` when its output is
 * journalled, which is the default.
 */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.INVOCATION_ID || env.JOURNAL_STREAM);
}

export class RestartLatch {
  /** Held by reference and read on every use, so `config.reload` writing into it in place is seen. */
  private readonly given: Partial<RestartConfig>;
  private readonly inFlight: () => string[];
  private readonly policy?: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly startedAt: number;
  private handler?: (r: FireReport) => void;
  private pending?: Pending;
  private timer?: NodeJS.Timeout;

  constructor(opts: {
    config?: Partial<RestartConfig>;
    /** The ids of every turn running anywhere: ids, not a count, so the deadline branch can name them. */
    inFlight: () => string[];
    /** The deployed systemd `Restart=` policy, or null when it could not be read. */
    policy?: () => string | null;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  }) {
    this.given = opts.config ?? {};
    this.inFlight = opts.inFlight;
    this.policy = opts.policy;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    // The latch is built while the daemon starts, so its own construction is the process's start for the
    // purpose of `minUptimeSecs` — and is a clock the tests can inject.
    this.startedAt = this.now();
  }

  /**
   * Required before arming. Only the serving daemon installs one; `thetis send`, `thetis chat` and the bench
   * each build an in-process kernel where "restart" would mean "kill the command", so leaving this unset is
   * what makes them refuse automatically rather than by a check someone can forget.
   */
  onFire(handler: (r: FireReport) => void): void {
    this.handler = handler;
  }

  /** What the object holds now, over the defaults for the keys it lacks. Never cached: a reload must reach it. */
  private get config(): RestartConfig {
    const c: Record<string, unknown> = { ...DEFAULTS };
    for (const [k, v] of Object.entries(this.given)) if (v !== undefined) c[k] = v;
    return parseSchema(RestartConfigSchema, c, "restart configuration");
  }

  arm(reason: string, by: string): ArmResult {
    if (this.pending) return { state: "again", message: again(this.pending, this.now()), pending: this.pending };
    const why = this.refusal();
    if (why) return { state: "refused", why, message: this.refusalMessage(why) };
    const at = this.now();
    this.pending = { reason, by, at, deadlineAt: at + this.config.quietWaitMs };
    // Never the thing keeping the process alive: a latch nobody cancels must not hold a daemon open, for the
    // same reason the shutdown backstop in `gateway-cli/src/index.ts` is unref'd.
    this.timer = setInterval(() => this.tick(), this.config.pollMs);
    this.timer.unref();
    return { state: "armed", message: armed(this.pending, this.config), pending: this.pending };
  }

  /** Disarms. Returns the row that was pending, so the caller can journal what it called off. */
  cancel(): { was?: Pending } {
    const was = this.pending;
    this.disarm();
    return { was };
  }

  status(): RestartState {
    const why = this.pending ? undefined : this.refusal();
    return {
      startedAt: this.startedAt,
      uptimeSecs: this.uptimeSecs(),
      supervised: isSupervised(this.env),
      armable: !why,
      ...(why ? { why } : {}),
      ...(this.pending ? { pending: this.pending } : {}),
    };
  }

  /**
   * The armed restart, or undefined: what every running turn is asked about at each round boundary (an armed
   * restart drains), so it reads one field and nothing else -- no clock, no policy, no environment.
   */
  armed(): Pending | undefined {
    return this.pending;
  }

  /** On shutdown. The process is going anyway, so a pending restart is moot; leaving it would be a lie. */
  close(): void {
    this.disarm();
  }

  private uptimeSecs(): number {
    return Math.floor((this.now() - this.startedAt) / 1000);
  }

  private refusal(): RefusalCode | null {
    if (!this.config.allowRestart) return "off";
    if (!isSupervised(this.env)) return "unsupervised";
    if (!this.handler) return "no-listener";
    if (this.uptimeSecs() < this.config.minUptimeSecs) return "young";
    if (this.policy && this.policy() !== "always") return "policy";
    return null;
  }

  private tick(): void {
    const p = this.pending;
    if (!p) return;
    const now = this.now();
    if (p.firesAt === undefined && this.inFlight().length === 0) {
      p.firesAt = Math.min(now + this.config.announceMs, p.deadlineAt);
    }
    if (p.firesAt !== undefined && now >= p.firesAt) return this.fire(true);
    if (now >= p.deadlineAt) return this.fire(false);
  }

  private fire(quiet: boolean): void {
    const p = this.pending;
    const handler = this.handler;
    if (!p || !handler) return;
    // Read in flight once more, on both branches: a turn that started during the countdown does not postpone
    // the restart, but it is still a turn that got cut, and the record should say so.
    const report: FireReport = { reason: p.reason, by: p.by, quiet, waitedMs: this.now() - p.at, cut: this.inFlight() };
    this.disarm();
    handler(report);
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private refusalMessage(why: RefusalCode): string {
    switch (why) {
      case "off":
        return (
          "Refused, and nothing was restarted: restarts are switched off in this installation's configuration " +
          "(`control.allowRestart`), which only the operator can change, at the host. If the running code is " +
          "stale, reloading a workspace puts new service code into service without a restart, and that is the " +
          "cheaper fix in any case. Nothing was armed and nothing is going to happen."
        );
      case "unsupervised":
        return (
          "Refused, and nothing was restarted: this daemon was not started by systemd, so exiting would stop Thetis " +
          "rather than restart it — nothing would bring it back. Ask the person to restart it themselves at " +
          "the host, or reload the workspace instead, which replaces its service code in place. Nothing was " +
          "armed and nothing is going to happen."
        );
      case "no-listener":
        return (
          "Refused, and nothing was restarted: this process has no restart handler, which means it is a short-lived " +
          "command rather than the serving daemon, and a restart here would only kill the command we are " +
          "running inside. Whatever needs new code, ask for it in the running installation. Nothing was armed " +
          "and nothing is going to happen."
        );
      case "young":
        return (
          `Refused, and nothing was restarted: this daemon has been up for ${this.uptimeSecs()} seconds, and a restart ` +
          `is refused below ${this.config.minUptimeSecs} seconds so that "restart, it did not help, restart" ` +
          "cannot become a loop. If the last restart did not fix this, something else is wrong and another one " +
          `will not find it; wait past ${this.config.minUptimeSecs} seconds and ask again if you still want it. ` +
          "Nothing was armed and nothing is going to happen."
        );
      case "policy":
        return policyRefusal(this.policy?.() ?? null);
      case "updating":
        return UPDATING;
    }
  }
}

function policyRefusal(policy: string | null): string {
  const said =
    policy === null
      ? "the restart policy of the systemd unit that runs this daemon could not be read, so there is no way " +
        "to know whether the process would come back"
      : `the systemd unit that runs this daemon says \`Restart=${policy}\`, not \`Restart=always\`, so this ` +
        "process would exit and stay down";
  return (
    `Refused, and nothing was restarted: ${said}. Only the operator can put that right, at the host, and until they ` +
    "do, a restart would take this installation offline for good rather than bring it back. Nothing was " +
    "armed and nothing is going to happen."
  );
}

/**
 * How long, past the countdown, until Thetis answers again: the clean exit, systemd's `RestartSec=2`, and a new
 * process opening its sockets. An estimate, so the sentence says "about".
 */
const BACK_MS = 10_000;

/**
 * What arming says. It is true from the moment it is said: `turns.yielding()` answers "restart" at once, so the
 * turn that armed it pauses at its next round boundary and its reply is finished only after the restart. So
 * this never promises that the reply reaches anyone first.
 */
function armed(p: Pending, config: RestartConfig): string {
  return (
    `Restart armed: ${p.reason} (asked by ${p.by}). Running replies pause at their next safe point and continue ` +
    `by themselves when Thetis is back (about ${secs(config.announceMs + BACK_MS)} s). Until it fires it can be ` +
    "called off, from the Cancel button on the page or `thetis restart cancel` at the host; do not arm a second one."
  );
}

function again(p: Pending, now: number): string {
  const when =
    p.firesAt === undefined
      ? `It fires as soon as every turn has finished, and in at most ${secs(p.deadlineAt - now)} seconds whatever happens`
      : `It is counting down now and fires in about ${secs(p.firesAt - now)} seconds`;
  return (
    `A restart is already armed: ${p.reason} (asked by ${p.by}). ${when}. Asking again changed nothing — it ` +
    "neither delayed that restart nor armed a second one, and there is no second attempt to make. This is two " +
    "requests meeting, not a fault: nothing is broken and nothing needs fixing. If the earlier reason no " +
    "longer holds, call it off with `thetis restart cancel` rather than arming anything."
  );
}

function secs(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}
