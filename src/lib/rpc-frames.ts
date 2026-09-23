// Newline-delimited JSON request/reply framing, shared by the control socket, the fence, and the agent.
// A request is `{ id, method, args }`; the replies are `{ id, event }`* and then one `{ id, result }` or
// `{ id, error, code }`. The same shape flows in both directions of the fence under other key names:
// kernel to agent `{ id, op, payload }`, agent to kernel `{ rpc, method, args }`. Each direction has one
// cancel frame that names a request in flight: `{ cancel: id }` from the kernel aborts an operation in the
// agent, and `{ rpcCancel: rpc }` from the agent aborts a call the kernel is serving. Both abort the
// signal the handler was given; the reply, if one still comes, is delivered as any other.
// One frame carries nothing at all: `{ id, alive: true }`, the heartbeat a fence sends while it is working
// on a request. It exists so that a caller which times a call can tell a fence that is wedged from one that
// is busy and quiet -- a build running under a tool emits nothing for minutes and is perfectly alive. A
// heartbeat is not an event and is never relayed to anyone: it only tells the caller that the other end is
// still there, through `alive(id)` below.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EventSink } from "../contracts/index.js";
import { CodedError, errorCode, errorMessage } from "./error.js";

/** `signal` aborts when the caller is gone; a handler that streams until then watches it. Servers that have no such moment pass none. */
export type RpcHandler = (method: string, args: unknown, emit?: EventSink, signal?: AbortSignal) => Promise<unknown>;

export type Frame = Record<string, unknown>;

/** A reply as it arrives: one of `event`, `result`, or `error` is present. */
export interface ReplyFrame {
  id: string;
  event?: unknown;
  result?: unknown;
  error?: unknown;
  code?: unknown;
}

export type Outcome = { result: unknown } | { error: string; code?: string };

/** What a caller attaches to a call it opens. `cleanup` runs once, when the call settles for any reason. */
export interface OpenCall {
  onEvent?: EventSink;
  cleanup?: () => void;
  /**
   * Runs whenever anything at all arrives for this call: an event, the result, the error, or a bare
   * heartbeat. A caller that measures silence resets its clock here and nowhere else. It is separate from
   * `onEvent` on purpose -- `onEvent` is optional and most callers pass none, so a liveness clock hung off
   * it would never be reset for them, which is exactly how a fence request that was streaming happily was
   * once killed for being ten minutes old.
   */
  onLive?: () => void;
}

interface Pending {
  /** The caller's own object, kept by reference: it may set `cleanup` after `open` returns. */
  call: OpenCall;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** The calls in flight on one connection, keyed by id. */
export class PendingCalls {
  private readonly calls = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly prefix: string) {}

  get size(): number {
    return this.calls.size;
  }

  open(call: OpenCall = {}): { id: string; result: Promise<unknown> } {
    const id = `${this.prefix}${++this.seq}`;
    const result = new Promise<unknown>((resolve, reject) => this.calls.set(id, { call, resolve, reject }));
    return { id, result };
  }

  /** Routes one reply to its call. Returns false when no call has that id. */
  receive(frame: ReplyFrame, defaultCode = "rpc"): boolean {
    const id = String(frame.id);
    const p = this.calls.get(id);
    if (!p) return false;
    p.call.onLive?.();
    if ("event" in frame) {
      p.call.onEvent?.(frame.event);
      return true;
    }
    if (frame.error !== undefined) {
      const code = typeof frame.code === "string" ? frame.code : defaultCode;
      return this.settle(id, undefined, new CodedError(String(frame.error), code));
    }
    return this.settle(id, frame.result);
  }

  /** A heartbeat for one call: it carries nothing, so it does nothing but say that the other end is there.
   *  Returns false when no call has that id, which is the ordinary race of a beat crossing the result. */
  alive(id: string): boolean {
    const p = this.calls.get(id);
    if (!p) return false;
    p.call.onLive?.();
    return true;
  }

  settle(id: string, result: unknown, error?: unknown): boolean {
    const p = this.calls.get(id);
    if (!p) return false;
    this.calls.delete(id);
    p.call.cleanup?.();
    if (error) p.reject(error);
    else p.resolve(result);
    return true;
  }

  failAll(error: unknown): void {
    for (const id of [...this.calls.keys()]) this.settle(id, undefined, error);
  }
}

/** Runs one request and turns the outcome into the reply fields, so every server answers the same way. */
export async function callHandler(handler: RpcHandler, method: string, args: unknown, emit?: EventSink, signal?: AbortSignal): Promise<Outcome> {
  try {
    return { result: (await handler(method, args, emit, signal)) ?? null };
  } catch (err) {
    return { error: errorMessage(err), code: errorCode(err) };
  }
}

export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/** Reads frames off a stream one line at a time. A line that is not a JSON object goes to `onStray`. */
export function readFrames(input: Readable, onFrame: (msg: Frame) => void, onStray?: (line: string) => void): void {
  createInterface({ input }).on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      onStray?.(line);
      return;
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)) onFrame(msg as Frame);
    else onStray?.(line);
  });
}
