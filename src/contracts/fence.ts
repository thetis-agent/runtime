// The fence: the boundary around one userspace. The kernel depends on these interfaces; the sandbox package implements them.
import type { Userspace } from "./identity.js";

export type EventSink = (event: unknown) => void;

/**
 * A request from inside the fence back to the kernel (package install, subagent spawn, a gateway's session calls).
 * `emit` streams events back before the result. `signal` aborts when the fence that asked is gone, so a method
 * that streams for the life of the fence knows when to stop.
 */
export type KernelRpc = (method: string, args: unknown, emit?: EventSink, signal?: AbortSignal) => Promise<unknown>;

/** A live channel into one userspace. Every crossing of the fence goes through here. */
export interface FenceHandle {
  /** Sends one operation. An aborted `signal` cancels it: the agent is told, and the promise rejects with code `cancelled`. */
  request(op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface Fence {
  open(userspace: Userspace, rpc: KernelRpc): Promise<FenceHandle>;
}

/** The open fences, one per userspace. What the kernel asks of the pool; the sandbox package provides it. */
export interface Fences {
  /** The handle for a userspace, opening the fence on first use. */
  handle(us: Userspace): Promise<FenceHandle>;
  /** Sends one request into the userspace's fence, opening it first when needed. */
  request(us: Userspace, op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown>;
  /** Closes one fence, or every fence when no id is given. */
  close(id?: string): Promise<void>;
  /** When each open fence opened, by userspace. A pool that keeps no times reports nothing open, and a reader then says nothing rather than guessing. */
  openedAt?(): Record<string, number>;
  /** What each open fence read when it opened: version by package name, by userspace. A userspace with no fence open is absent. */
  loadedVersions?(): Record<string, Record<string, string>>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
