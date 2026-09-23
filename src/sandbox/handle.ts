// One live agent process, and the frames that cross it in both directions.
import type { ChildProcess } from "node:child_process";
import type { EventSink, FenceHandle, KernelRpc, Userspace } from "../contracts/index.js";
import { CodedError, errorMessage } from "../lib/error.js";
import { callHandler, encodeFrame, PendingCalls, readFrames, type Frame, type OpenCall } from "../lib/rpc-frames.js";

/** What this package's handles carry beyond the fence contract: when the agent was spawned, and a promise
 *  that resolves when it is gone. A `Fence` that returns a plainer handle simply offers neither. */
export interface SandboxHandle extends FenceHandle {
  openedAt: number;
  gone: Promise<void>;
}

export interface HandleOptions {
  /**
   * How long a request may go without a single sign of life from the fence before the fence is taken to be
   * dead. It is not a limit on the work: a `step` runs a whole turn, so a limit on its duration is a limit
   * on every model call, tool run and subagent under it added together, which is how a turn doing real work
   * came to be killed at ten minutes and lose everything it had done.
   */
  requestTimeoutMs: number;
  /** How often the agent was told to report itself alive, only so the error can say what was expected. Derived by `heartbeatFor`. */
  heartbeatMs?: number;
  /** How long `close` waits for the agent to exit after SIGTERM before it kills it. */
  exitGraceMs?: number;
  /** How long a cancelled request may still answer before it is settled as cancelled. Default `CANCEL_GRACE_MS`. */
  cancelGraceMs?: number;
  log: (line: string) => void;
}

const EXIT_GRACE_MS = 2_000;
/**
 * How long a cancelled request is given to answer. The cancel reaches a step as its signal, and a step that
 * was stopped returns what it has: the text streamed so far, the tool calls closed. Settling at once would
 * throw that away, so the reply is waited for; one that never comes settles with code `cancelled` here.
 */
export const CANCEL_GRACE_MS = 5_000;
/**
 * How long the agent is given to answer `shutdown`. The ask exists because the signal does not arrive: with
 * bubblewrap the child of this process is the sandbox, and `bwrap --unshare-pid` does not forward SIGTERM to
 * the agent inside it, so a service's `stop()` — and the socket it unlinks — runs only when it is asked for
 * over the protocol. Well inside the exit grace, because a fence that will not answer must still die on time.
 */
const SHUTDOWN_MS = 500;

/**
 * How often a fence reports itself alive while it is working on a request, given the silence it is allowed:
 * a tenth of it, and never more than 15 seconds. Two properties are wanted and both follow from the tenth.
 * A live fence cannot be mistaken for a dead one -- it has to miss ten beats in a row, which a process whose
 * event loop is turning does not do -- and the heartbeat costs nothing worth counting: one short line every
 * 15 seconds per request in flight, against a stream that carries a token at a time. The floor is for the
 * tests and for anyone who configures a very short timeout: three beats inside the budget, at least.
 */
export const heartbeatFor = (requestTimeoutMs: number): number => Math.max(50, Math.min(15_000, Math.floor(requestTimeoutMs / 10)));

/**
 * What a person is told when a fence stops answering. The old text -- "fence request step timed out" -- said
 * nothing anyone could act on, and it was a lie besides: the request had not run out of time, it had been
 * working for ten minutes. This one says how long the silence was, how far into the work it fell, whether
 * the fence had ever answered at all, and what a live one would have been doing in that gap.
 */
function silentFence(op: string, user: string, elapsed: number, quiet: number, signs: number, beat: number): string {
  const before = signs
    ? `though it had been answering until then -- ${signs} frames in ${duration(elapsed)} of work`
    : `and it had not answered at all in the ${duration(elapsed)} since it was sent`;
  return `the fence for ${user} stopped answering: nothing from the ${op} request for ${duration(quiet)}, ${before}. A working fence reports itself alive every ${duration(beat)} even while it is busy, so its agent process is wedged or gone.`;
}

function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} s`;
  return `${Math.floor(secs / 60)} m ${secs % 60} s`;
}

/**
 * Kernel to agent: `{ id, op, payload }`, answered by `{ id, event }`* and `{ id, result | error }`;
 * `{ cancel: id }` aborts one request. Agent to kernel: `{ rpc, method, args }`, answered by
 * `{ rpcEvent, event }`* and `{ rpcResult, result | error, code }`; `{ rpcCancel: rpc }` aborts one call.
 */
export class ProcessHandle implements FenceHandle {
  private readonly pending = new PendingCalls("r");
  /** Aborts when the agent is gone: every RPC it opened is served with a signal that follows it, so a kernel method that streams for the life of the fence ends with it. */
  private readonly life = new AbortController();
  /** The RPCs the agent opened and the kernel is still serving, by the agent's id, so `{ rpcCancel }` can abort one. */
  private readonly served = new Map<string, AbortController>();
  /** Resolves when the agent process is gone, so the pool can forget a handle the moment it is a corpse. */
  readonly gone: Promise<void>;
  private closed = false;
  /** Set before the stop is asked for, because `closed` cannot be: the ask itself goes through `request`. */
  private closing = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly us: Userspace,
    private readonly rpc: KernelRpc,
    private readonly opts: HandleOptions,
    private readonly cleanup: (() => void)[] = [],
  ) {
    if (child.stdout) readFrames(child.stdout, (msg) => this.onFrame(msg), (line) => opts.log(`[${us.id}] stray output: ${line}`));
    if (child.stderr) readFrames(child.stderr, () => {}, (line) => opts.log(`[${us.id}] ${line}`));
    child.on("exit", (code) => this.onExit(code));
    this.gone = new Promise((done) => child.once("exit", () => done()).once("error", () => done()));
  }

  /**
   * One request into the fence. The timer on it asks one question and only one: is the fence still there.
   * It measures silence, never work. Every frame for this call resets it -- an event, the result, and the
   * bare `{ id, alive: true }` heartbeat the agent sends while it is working -- through `onLive`, which
   * fires whether or not the caller wanted events, because most callers here pass no `onEvent` at all.
   *
   * A fence that has really stopped answering is stopped the way an abort stops it, not settled where it
   * stands: it is told `{ cancel: id }` and given the grace, so the step returns the text it streamed and
   * the tool calls it closed instead of the caller being handed an error and nothing else.
   */
  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodedError(`fence for ${this.us.id} is closed`, "fence"));
    if (signal?.aborted) return Promise.reject(new CodedError(`fence request ${op} cancelled`, "cancelled"));
    const call: OpenCall = { onEvent };
    const { id, result } = this.pending.open(call);
    const budget = this.opts.requestTimeoutMs;
    const beat = this.opts.heartbeatMs ?? heartbeatFor(budget);
    const started = Date.now();
    let lastSign = started;
    let signs = 0;
    let timer: NodeJS.Timeout;
    let grace: NodeJS.Timeout | undefined;
    let dead: CodedError | undefined;
    call.onLive = () => {
      lastSign = Date.now();
      signs += 1;
    };
    // The agent is told; its reply within the grace is delivered as any other, since a stopped step returns what it kept.
    const stop = (err: CodedError) => {
      this.send({ cancel: id });
      grace = setTimeout(() => this.pending.settle(id, undefined, err), this.opts.cancelGraceMs ?? CANCEL_GRACE_MS);
    };
    // Armed for the whole budget and re-armed for what is left of it whenever a sign of life arrives, rather
    // than cleared and set again per frame: a streaming step sends thousands of them.
    const watch = () => {
      const quiet = Date.now() - lastSign;
      if (quiet < budget) {
        timer = setTimeout(watch, budget - quiet);
        return;
      }
      dead = new CodedError(silentFence(op, this.us.id, Date.now() - started, quiet, signs, beat), "fence");
      // Not announced during a close: the `shutdown` ask has its own short deadline, and a fence being taken
      // down on purpose going quiet is the expected case, not news. `close` says what became of it either way.
      if (!this.closing) this.opts.log(`[fence] ${dead.message}`);
      stop(dead);
    };
    const onAbort = () => stop(new CodedError(`fence request ${op} cancelled`, "cancelled"));
    timer = setTimeout(watch, budget);
    signal?.addEventListener("abort", onAbort, { once: true });
    call.cleanup = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    };
    this.send({ id, op, payload });
    // A fence that answered the cancel hands back what it kept, and the caller would otherwise carry on as
    // though nothing had happened: this is the one place that knows the work was cut short, so it says so
    // once, on the call's own event sink, in the same words the rejection would have carried.
    return result.then((value) => {
      if (dead) onEvent?.({ type: "error", message: dead.message, code: "fence" });
      return value;
    });
  }

  /**
   * Stops the services, then asks the agent to exit and waits until it has; one that is still there after the
   * grace period is killed. The stop is asked for rather than signalled, for the reason at `SHUTDOWN_MS`.
   */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await this.shutdown();
    this.closed = true;
    const killer = setTimeout(() => {
      this.opts.log(`[fence] ${this.us.id}: agent did not exit on SIGTERM; killed`);
      this.child.kill("SIGKILL");
    }, this.opts.exitGraceMs ?? EXIT_GRACE_MS);
    this.child.kill("SIGTERM");
    await this.gone;
    clearTimeout(killer);
  }

  /** Asks the agent to stop its services. A refusal, a silence or a deadline is logged and then ignored: the
   *  close carries on regardless, because a fence that cannot be asked still has to go. */
  private async shutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new CodedError(`it did not answer within ${SHUTDOWN_MS} ms`, "fence")), SHUTDOWN_MS).unref();
      });
      await Promise.race([this.request("shutdown", {}), deadline]);
    } catch (err) {
      this.opts.log(`[fence] ${this.us.id}: the services were not stopped before the close (${errorMessage(err)})`);
    } finally {
      clearTimeout(timer);
    }
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(encodeFrame(msg));
  }

  private onFrame(msg: Frame): void {
    if (typeof msg.rpc === "string") {
      void this.serveRpc(msg.rpc, String(msg.method), msg.args);
      return;
    }
    if (typeof msg.rpcCancel === "string") {
      this.served.get(msg.rpcCancel)?.abort();
      return;
    }
    // A heartbeat carries nothing and settles nothing; it only resets the liveness timer of the call it names.
    if (msg.alive !== undefined) {
      this.pending.alive(String(msg.id));
      return;
    }
    // Package code raised the error: the agent reports it without a code.
    this.pending.receive({ id: String(msg.id), ...msg }, "package");
  }

  /** Each call is served with its own signal: `{ rpcCancel }` aborts that one, and the agent's exit aborts them all. */
  private async serveRpc(rid: string, method: string, args: unknown): Promise<void> {
    const control = new AbortController();
    const onLife = () => control.abort();
    this.life.signal.addEventListener("abort", onLife, { once: true });
    this.served.set(rid, control);
    try {
      const outcome = await callHandler(this.rpc, method, args, (event) => this.send({ rpcEvent: rid, event }), control.signal);
      this.send({ rpcResult: rid, ...outcome });
    } finally {
      this.served.delete(rid);
      this.life.signal.removeEventListener("abort", onLife);
    }
  }

  private onExit(code: number | null): void {
    this.closed = true;
    this.life.abort();
    for (const fn of this.cleanup) fn();
    this.pending.failAll(new CodedError(`userspace agent for ${this.us.id} exited (${code ?? "signal"})`, "fence"));
  }
}
