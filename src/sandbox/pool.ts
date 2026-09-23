import type { EventSink, Fence, FenceHandle, Fences, KernelRpc, Userspace } from "../contracts/index.js";
import { errorCode } from "../lib/error.js";
import type { SandboxHandle } from "./handle.js";

/** How long a close waits for the fence to fall quiet before it closes it regardless. */
const DRAIN_MS = 30_000;

/**
 * Keeps at most one open fence per userspace, opening lazily and re-opening after a crash. A close is
 * a drain first: it waits for a moment when nothing is in flight inside the fence (a tool call the
 * model is waiting on, a subagent's step under it), up to `DRAIN_MS`, then closes. Requests keep going
 * into the old fence until that moment, because a request kept waiting could be one the request in
 * flight depends on. A fence is opened with the userspace as it is now (`refresh`), not as the caller
 * last saw it, so a request that reopens one after a bind gets the new mounts.
 */
export class FencePool implements Fences {
  private readonly handles = new Map<string, Promise<FenceHandle>>();
  /** When each open fence opened, for the reader that asks what code a running fence is holding. */
  private readonly opened = new Map<string, number>();
  /** What each open fence read when it opened: version by package name. The versions a reload would replace. */
  private readonly loaded = new Map<string, Record<string, string>>();
  /** The requests in flight per userspace, so a close can wait for a quiet moment. */
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();
  /** A close in progress per userspace; a second close joins it. */
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    private readonly fence: Fence,
    private readonly rpcFor: (us: Userspace) => KernelRpc,
    private readonly onOpen?: (us: Userspace, handle: FenceHandle) => Promise<void>,
    private readonly refresh: (us: Userspace) => Userspace = (us) => us,
    /** What the userspace's packages are at this moment, by name. Read once per open; the pool never interprets it. */
    private readonly versionsOf: (us: Userspace) => Record<string, string> = () => ({}),
  ) {}

  /** The handle for a userspace, opening the fence on first use. `onOpen` runs on the new handle before anyone else uses it. */
  handle(stale: Userspace): Promise<FenceHandle> {
    const held = this.handles.get(stale.id);
    if (held) return held;
    // During the drain the old handle remains usable for nested work. After it is forgotten, its
    // services must finish stopping before another fence can bind those same socket paths.
    const closing = this.closing.get(stale.id);
    if (closing) return closing.then(() => this.handle(stale));
    const us = this.refresh(stale);
    const opening: Promise<FenceHandle> = this.fence
      .open(us, this.rpcFor(us))
      .then(async (handle) => {
        await this.onOpen?.(us, handle);
        const sandboxed = handle as Partial<SandboxHandle>;
        // The fence stamps the handle with the moment its agent was spawned, which is when its modules were
        // read; a fence that stamps nothing is taken to have opened now.
        this.opened.set(us.id, sandboxed.openedAt ?? Date.now());
        // Read here, beside the moment: what the agent inside this fence has in hand until the fence is replaced.
        this.loaded.set(us.id, this.versionsOf(us));
        // A dead agent is forgotten as soon as it dies, not when something next fails on it: a corpse in the
        // map is a userspace nothing can reopen, because whoever asks for a handle is handed the corpse.
        void sandboxed.gone?.then(() => {
          if (this.handles.get(us.id) === opening) this.forget(us.id);
        });
        return handle;
      })
      .catch((err: unknown) => {
        this.forget(us.id);
        throw err;
      });
    this.handles.set(us.id, opening);
    return opening;
  }

  /**
   * Sends one request, dropping the handle *and closing it* if the agent died, so the next call reopens a
   * fence rather than adding one. Forgetting alone leaked the whole fence: the map entry went and the agent
   * did not, so a turn that ended with a `fence` error left a process running unattached, still LISTENing on
   * that workspace's `run/web.sock`, still holding its cgroup and its ssh agent, while the next request
   * opened a second fence whose gateway could not bind the socket the first one had. Found live, forty
   * minutes after the turn that orphaned it, on a workspace `status` was reporting as having no fence open.
   */
  async request(us: Userspace, op: string, payload: unknown, onEvent?: EventSink, signal?: AbortSignal): Promise<unknown> {
    const h = await this.handle(us);
    const opening = this.handles.get(us.id);
    const pending = h.request(op, payload, onEvent, signal);
    let set = this.inflight.get(us.id);
    if (!set) this.inflight.set(us.id, (set = new Set()));
    set.add(pending);
    try {
      return await pending;
    } catch (err) {
      // Dispatched, never awaited, and its failure swallowed: `close` asks the agent to stop its services,
      // waits out the SIGTERM grace and kills whatever is left, which is seconds this caller must not spend
      // -- it is here to report a fence error, and the cleanup of a fence that has already gone wrong must
      // never become a second way for it to get stuck. The bound is the handle's own: `close` gives the
      // agent `exitGraceMs` after SIGTERM and then SIGKILLs it, so nothing here waits forever.
      if (errorCode(err) === "fence") {
        // Another request may already have retired this handle and opened its replacement.
        // Failed fences skip the drain, but replacement requests still wait for their services to stop.
        if (this.handles.get(us.id) === opening) void this.closeOne(us.id, false);
      }
      throw err;
    } finally {
      set.delete(pending);
    }
  }

  /** Closes one fence, or every fence at once: each drains and waits for its agent, so they are not waited for in turn. */
  async close(id?: string): Promise<void> {
    const ids = id ? [id] : [...new Set([...this.handles.keys(), ...this.closing.keys()])];
    await Promise.all(ids.map((key) => this.closeOne(key)));
  }

  /** Waits for a quiet moment, then closes. A second close of the same fence while one is under way joins it. */
  private closeOne(id: string, drain = true): Promise<void> {
    const under = this.closing.get(id);
    if (under) return under;
    const done = (drain ? this.quiet(id) : Promise.resolve())
      .then(() => {
        const h = this.handles.get(id);
        this.forget(id);
        return h?.then((x) => x.close()).catch(() => {});
      })
      .finally(() => {
        // An opening fence can finish its hook and stamp metadata after the first forget above.
        this.forget(id);
        this.closing.delete(id);
      });
    this.closing.set(id, done);
    return done;
  }

  /** Resolves at the first moment nothing is in flight inside the fence, or after `DRAIN_MS`, whichever comes first. */
  private async quiet(id: string): Promise<void> {
    const deadline = Date.now() + DRAIN_MS;
    for (let set = this.inflight.get(id); set?.size && Date.now() < deadline; set = this.inflight.get(id)) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((done) => { timer = setTimeout(done, deadline - Date.now()); });
      await Promise.race([Promise.allSettled([...set]).then(() => undefined), timeout]).finally(() => clearTimeout(timer));
    }
  }

  /** The open fences and when each opened, by userspace. A userspace with no fence open is absent. */
  openedAt(): Record<string, number> {
    return Object.fromEntries(this.opened);
  }

  /** What each open fence read when it opened, by userspace. A userspace with no fence open is absent. */
  loadedVersions(): Record<string, Record<string, string>> {
    return Object.fromEntries(this.loaded);
  }

  private forget(id: string): void {
    this.handles.delete(id);
    this.opened.delete(id);
    this.loaded.delete(id);
  }
}
