// The door: the one host port. It copies bytes between the browser and unix sockets it never
// authenticates against: `/login`, `/logout` and `/` go to the login target, `/<person>/...` goes to
// that person's own gateway. A path prefix is routing, never authority; each gateway rechecks the
// cookie with the kernel, which answers a fence only about its own user.
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";

export interface DoorOptions {
  /** The unix socket of the login target. */
  loginSocket: string;
  /** The unix socket of a person's gateway, or undefined when there is no such person. */
  socketFor(user: string): string | undefined;
  /**
   * Opens a userspace whose gateway socket is not there. The door is the only thing that notices, and it
   * routes to a socket only the fence creates, so without this a person whose fence failed to reopen stays
   * dark until an operator intervenes. Absent: a missing socket is reported and nothing is opened.
   */
  ensure?(user: string): Promise<void>;
  /** The userspace whose fence serves the login page, so `ensure` can reopen that one too. */
  loginUser?: string;
  log?: (line: string) => void;
}

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
/** How long one request waits for a fence to open before it gives up and says the gateway is not running. */
const OPEN_DEADLINE_MS = 30_000;
/** After a failed open, requests are answered without trying again for this long: a page asks for twenty
 *  files, and twenty attempts to spawn a fence that cannot start is a worse answer than a prompt one. */
const OPEN_COOLDOWN_MS = 5_000;

/** What to do about a connection that is refused: whose fence to open, and whether that has been tried. */
interface Recover {
  user: string;
  tried: boolean;
}

export function createDoor(opts: DoorOptions): Server {
  const log = opts.log ?? (() => {});
  const failedAt = new Map<string, number>();
  /** Whether it is worth asking for a fence at all: there is somewhere to ask, and the last attempt for this
   *  person was not a moment ago. The cooldown is what keeps a page of twenty files to one attempt. */
  const worthOpening = (user: string | undefined): user is string => !!user && !!opts.ensure && Date.now() - (failedAt.get(user) ?? 0) >= OPEN_COOLDOWN_MS;
  const server = createServer((req, res) => route(req, res));
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  // close() alone waits for every open connection, and an event stream through the door never ends on its
  // own. The door closes them itself; each response then fires `close`, which tears down its upstream request.
  const close = server.close.bind(server);
  server.close = (cb) => {
    close(cb);
    server.closeAllConnections();
    return server;
  };

  function route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/login" || path === "/logout" || path.startsWith("/login/")) return forward(req, res, opts.loginSocket, "the login page", opts.loginUser);
    const user = path.split("/")[1] ?? "";
    // A stranger is a 404 and never an open: `socketFor` answers only for a person the kernel knows.
    const socket = USER_ID.test(user) ? opts.socketFor(user) : undefined;
    if (!socket) return reply(res, 404, "There is nobody here by that name.");
    if (path === `/${user}`) {
      res.writeHead(303, { Location: `/${user}/` });
      res.end();
      return;
    }
    forward(req, res, socket, `${user}'s gateway`, user);
  }

  function forward(req: IncomingMessage, res: ServerResponse, socketPath: string, what: string, user?: string): void {
    if (existsSync(socketPath)) return send(req, res, socketPath, what, user ? { user, tried: false } : undefined);
    if (!worthOpening(user)) return reply(res, 503, `${what} is not running.`);
    // One attempt, with a deadline of its own: the pool keeps one open per userspace, so a burst of
    // requests shares it and the door needs no lock. The body waits unread in the socket meanwhile.
    void open(user).then(() => {
      if (res.writableEnded || res.destroyed) return;
      if (existsSync(socketPath)) return send(req, res, socketPath, what, { user, tried: true });
      // Opened, and still no socket: the fence came up without its gateway. That counts as a failed open, or
      // every file a page asks for would ask again.
      failedAt.set(user, Date.now());
      reply(res, 503, `${what} is not running.`);
    });
  }

  async function open(user: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, fail) => {
        // Unreferenced: the deadline must not be a reason for the process to stay alive while it is stopping.
        timer = setTimeout(() => fail(new Error(`opening it took longer than ${OPEN_DEADLINE_MS} ms`)), OPEN_DEADLINE_MS).unref();
      });
      await Promise.race([opts.ensure!(user), deadline]);
      failedAt.delete(user);
    } catch (err) {
      failedAt.set(user, Date.now());
      log(`[door] ${user}'s workspace did not open: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function send(req: IncomingMessage, res: ServerResponse, socketPath: string, what: string, recover?: Recover, bodyless = false): void {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const up = httpRequest({ socketPath, path: req.url, method: req.method, headers }, (upstream) => {
      const out: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(upstream.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
      res.writeHead(upstream.statusCode ?? 502, out);
      upstream.pipe(res);
      upstream.on("error", () => res.end());
    });
    up.on("error", (err) => {
      // A socket file that a killed fence never unlinked: the address is there and nothing answers it, which
      // is a fence that is missing rather than a gateway that is broken, so it is opened like one. Only for a
      // request with no body to replay, and only once — a second refusal is an answer, not a loop.
      const code = (err as NodeJS.ErrnoException).code;
      const missing = (code === "ECONNREFUSED" || code === "ENOENT") && !res.headersSent && (req.method === "GET" || req.method === "HEAD");
      if (recover && missing && !recover.tried && worthOpening(recover.user)) {
        return void open(recover.user).then(() => {
          if (res.writableEnded || res.destroyed) return;
          send(req, res, socketPath, what, { user: recover.user, tried: true }, true);
        });
      }
      // Opened and still refused: remembered, or every file a page asks for would ask again.
      if (recover?.tried && missing) failedAt.set(recover.user, Date.now());
      log(`[door] ${req.method} ${req.url} -> ${socketPath}: ${err.message}`);
      if (!res.headersSent) reply(res, 502, `${what} did not answer.`);
      else res.end();
    });
    // A retry has nothing to pipe: it is sent only for a request whose body was not there to be read.
    if (bodyless) up.end();
    else req.pipe(up);
    res.on("close", () => up.destroy());
  }

  return server;
}

function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text + "\n");
}
