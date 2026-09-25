import { contentText, normalizeMessage, normalizeTurnInput } from "../../lib/content.js";
import type { Message, TurnInput, SessionRecord, SessionSummaryRef, TurnEvent, TurnOptions, UserRecord, Userspace, WatchedTurnEvent } from "../../contracts/index.js";
import { AsyncQueue } from "../../lib/async.js";
import { assert } from "../../lib/error.js";
import { newId, now } from "../../lib/ids.js";
import { summarize, type SessionStore } from "../../lib/session-store.js";
import { TurnTaps } from "../../lib/turn-taps.js";
import type { UserspaceLayout } from "../../lib/userspace-layout.js";
import type { PackageManager } from "../packages/manager.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { UserStore } from "../users.js";

/** The shape of a session id. The store checks it before an id becomes a file name. */
export const SESSION_ID = /^s_[a-f0-9]+$/;

export type SessionRef = SessionSummaryRef;

export type { TurnInput } from "../../contracts/index.js";

/** The session API: the only surface gateways and subagent-spawning steps use. Every call is authorized against a user. */
export class SessionApi {
  /** Each running turn: how to stop it, and when it has ended, saved and all. */
  private readonly running = new Map<string, { control: AbortController; done: Promise<void> }>();
  /** Every turn's events also reach the user's watchers (`watch`), whoever started the turn. */
  private readonly taps = new TurnTaps();

  constructor(
    private readonly users: UserStore,
    private readonly userspaces: UserspaceLayout,
    private readonly packages: PackageManager,
    private readonly store: SessionStore,
    private readonly runner: PipelineRunner,
  ) {}

  /** Ensures the user's userspace exists and is seeded. Called on a user's first turn. */
  userspaceFor(user: UserRecord): Userspace {
    const fresh = !this.userspaces.exists(user.id);
    const us = this.userspaces.ensure(user.id);
    if (fresh || this.packages.installed(us).length === 0) this.packages.seedSystem(us);
    return us;
  }

  /** The authorized user's userspace: what every session call starts from. */
  private space(userId: string): Userspace {
    return this.userspaceFor(this.users.authorize(userId));
  }

  create(userId: string, opts: { parent?: string } = {}): SessionRef {
    const us = this.space(userId);
    if (opts.parent) this.load(us, opts.parent);
    const stamp = now();
    const rec: SessionRecord = { id: newId("s"), user: us.id, parent: opts.parent, createdAt: stamp, updatedAt: stamp, turns: 0, conversation: [], harness: {} };
    this.store.save(us.sessions, rec);
    return { ...summarize(rec), running: false };
  }

  /** `opts.model` names the model for this turn; steps may still change `call.model`. Empty means the configured default. */
  send(userId: string, sessionId: string, input: TurnInput, opts: TurnOptions = {}): AsyncIterable<TurnEvent> {
    const us = this.space(userId);
    const session = this.load(us, sessionId);
    const key = `${userId}/${sessionId}`;
    assert(!this.running.has(key), `session ${sessionId} already has a turn in progress`, "busy");
    const control = new AbortController();
    const messages = normalizeTurnInput(input);
    const queue = new AsyncQueue<TurnEvent>();
    const emit = this.taps.emitter(userId, { session: sessionId, parent: session.parent, input: messages.map((m) => contentText(m.content)).join("\n"), messages }, (e) => queue.push(e));
    const done = this.runner
      .runTurn(us, session, messages, emit, control.signal, opts)
      .then(() => queue.close(), (err: unknown) => queue.close(err))
      .finally(() => this.running.delete(key));
    this.running.set(key, { control, done });
    return queue;
  }

  /** Stops the running turn of a session. Returns false when no turn is running. The turn ends with an `error` event of code `cancelled`. */
  cancel(userId: string, sessionId: string): boolean {
    this.users.authorize(userId);
    const turn = this.running.get(`${userId}/${sessionId}`);
    if (!turn) return false;
    turn.control.abort();
    return true;
  }

  /**
   * Removes a session's record and its index entry. A running turn is cancelled first and waited for, so its
   * closing save lands before the removal and not after it.
   */
  async delete(userId: string, sessionId: string): Promise<void> {
    const us = this.space(userId);
    this.load(us, sessionId);
    const turn = this.running.get(`${userId}/${sessionId}`);
    if (turn) {
      turn.control.abort();
      await turn.done;
    }
    this.store.remove(us.sessions, sessionId);
  }

  /**
   * Cancels every turn running in a user's sessions and waits for each one's closing save: what a reload of
   * that workspace does before it closes the fence, so a turn ends as a cancel with its partial result kept
   * rather than dying with the process. Answers the session ids it cancelled.
   */
  async cancelAll(userId: string): Promise<string[]> {
    const mine = [...this.running].filter(([key]) => key.startsWith(`${userId}/`));
    for (const [, turn] of mine) turn.control.abort();
    await Promise.all(mine.map(([, turn]) => turn.done.catch(() => {})));
    return mine.map(([key]) => key.slice(userId.length + 1));
  }

  /**
   * Every turn running anywhere, as `user/session`. Ids and not a count, because the one caller that waits
   * on this — a restart, which ends them all — must be able to name whose turn it cut.
   */
  inFlight(): string[] {
    return [...this.running.keys()];
  }

  /** Runs a turn to completion and returns the final assistant message without losing parts. */
  async complete(userId: string, sessionId: string, input: TurnInput): Promise<Message> {
    let last: Message = { role: "assistant", content: [] };
    for await (const e of this.send(userId, sessionId, input)) {
      if (e.type === "message" && e.message.role === "assistant") last = normalizeMessage(e.message);
      if (e.type === "error") throw new Error(e.message);
    }
    return last;
  }

  async askText(userId: string, sessionId: string, input: TurnInput): Promise<string> {
    return contentText((await this.complete(userId, sessionId, input)).content);
  }

  /** @deprecated Use askText for a text projection or complete for structured output. */
  ask(userId: string, sessionId: string, input: TurnInput): Promise<string> {
    return this.askText(userId, sessionId, input);
  }

  inspect(userId: string, sessionId: string): SessionRecord & { status: "idle" | "running" } {
    const rec = this.load(this.space(userId), sessionId);
    return { ...rec, status: this.running.has(`${userId}/${sessionId}`) ? "running" : "idle" };
  }

  /** Every session, from the index beside the records: no record is opened to draw a list. */
  list(userId: string): SessionRef[] {
    return this.store
      .summaries(this.space(userId).sessions)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => ({ ...s, running: this.running.has(`${userId}/${s.id}`) }));
  }

  /**
   * Every turn event of every session of the user, whoever started the turn, each stamped with its session,
   * the parent when it is a subagent, and on `turn.start` the text it was sent and when. A turn already in
   * progress is delivered from its start first, so a watcher that arrives mid-turn misses nothing. Resolves
   * when `signal` aborts.
   */
  watch(userId: string, fn: (m: WatchedTurnEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.taps.watch(this.users.authorize(userId).id, fn, signal);
  }

  /** A session of this userspace only: another user's id is unknown here, whatever it names elsewhere. */
  private load(us: Userspace, id: string): SessionRecord {
    const rec = this.store.load(us.sessions, id);
    assert(rec, `unknown session ${id} for user ${us.id}`, "not-found");
    return rec;
  }
}
