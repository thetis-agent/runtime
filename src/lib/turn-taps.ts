// Fan-out of turn events per user: the mechanism behind `sessions.watch`. A tap is a watcher a caller
// registered for one user; an emitter wraps a turn's event sink so every event also reaches that user's
// watchers, stamped with the session it belongs to. Who may watch whom is the kernel's question, not this one.
//
// A turn in progress is also kept, event by event, until it ends: a watcher that arrives in the middle of
// one (a gateway restarted under a running turn, say) is first handed everything that turn has said so
// far, stamped exactly as the live events were, and then follows it live. Only running turns are kept.
import type { Message, TurnEvent, WatchedTurnEvent } from "../contracts/index.js";

/** What every event of one turn is stamped with. `input` rides on `turn.start` only. */
export type TapMeta = { session: string; parent?: string; input?: string; messages?: Message[] };

export type Watcher = (m: WatchedTurnEvent) => void;

interface Running {
  meta: TapMeta;
  startedAt: string;
  events: TurnEvent[];
}

export class TurnTaps {
  private readonly watchers = new Map<string, Set<Watcher>>();
  /** The turns in progress, by `user/session`, with what they have emitted so far. */
  private readonly running = new Map<string, Running>();

  /**
   * Delivers the turns already in progress for the user, from their start, then every later event.
   * Resolves when `signal` aborts, after the watcher is removed. Without a signal it never resolves.
   */
  watch(user: string, fn: Watcher, signal?: AbortSignal): Promise<void> {
    for (const [key, run] of this.running) {
      if (key.startsWith(`${user}/`)) for (const e of run.events) fn(stamp(run, e));
    }
    let set = this.watchers.get(user);
    if (!set) this.watchers.set(user, (set = new Set()));
    set.add(fn);
    return new Promise((done) => {
      if (!signal) return;
      const remove = () => {
        this.remove(user, fn);
        done();
      };
      if (signal.aborted) remove();
      else signal.addEventListener("abort", remove, { once: true });
    });
  }

  /** How many watchers a user has. */
  count(user: string): number {
    return this.watchers.get(user)?.size ?? 0;
  }

  /**
   * Wraps an emit: `inner` gets every event, then the user's watchers get it stamped with `meta`.
   * A watcher that throws is dropped, not propagated: the turn is the caller's, and a broken tap must not end it.
   */
  emitter(user: string, meta: TapMeta, inner: (e: TurnEvent) => void): (e: TurnEvent) => void {
    const key = `${user}/${meta.session}`;
    return (e) => {
      inner(e);
      let run = this.running.get(key);
      if (e.type === "turn.start" || !run) this.running.set(key, (run = { meta, startedAt: new Date().toISOString(), events: [] }));
      run.events.push(e);
      if (e.type === "turn.end") this.running.delete(key);
      const set = this.watchers.get(user);
      if (!set) return;
      const m = stamp(run, e);
      for (const fn of [...set]) {
        try {
          fn(m);
        } catch {
          this.remove(user, fn);
        }
      }
    };
  }

  private remove(user: string, fn: Watcher): void {
    const set = this.watchers.get(user);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.watchers.delete(user);
  }
}

/** One event as a watcher sees it: the session, the parent when there is one, and on `turn.start` the input and the start time. */
function stamp(run: Running, e: TurnEvent): WatchedTurnEvent {
  const m: WatchedTurnEvent = { session: run.meta.session, event: e };
  if (run.meta.parent) m.parent = run.meta.parent;
  if (e.type === "turn.start") {
    if (run.meta.input !== undefined) m.input = run.meta.input;
    if (run.meta.messages) m.messages = run.meta.messages;
    m.startedAt = run.startedAt;
  }
  return m;
}
