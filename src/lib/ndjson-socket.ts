// A request/reply server and client over a Unix socket, speaking the frames of `rpc-frames`.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { callHandler, encodeFrame, FrameIdSchema, PendingCalls, readFrames, RpcRequestSchema, type RpcHandler } from "./rpc-frames.js";
import { parseSchema } from "./validation.js";
import { errorMessage } from "./error.js";

/** Serves one handler to every client of a Unix socket. Access is by file permission: the socket is mode 0600. */
export class RpcSocketServer {
  private server?: Server;
  /** Connected clients, so close() can end them: `Server.close` alone waits for an open `thetis chat`. */
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly path: string,
    private readonly handler: RpcHandler,
    private readonly log: (line: string) => void = () => {},
    /**
     * A secret every caller has to present, or undefined to admit anyone who can open the socket.
     *
     * The socket's `0600` defends it against other users. It has never defended against a process running
     * as the *same* user, and on this host every fence is one: the daemon and its fences all run as the
     * unit's `User=`. That is not hypothetical -- a fence reached this socket and had `users.list`
     * answered, for two days, when a masking bug left the data directory visible inside fences.
     *
     * Two things that sound like the fix are not. `SO_PEERCRED` is not exposed by Node's `net` at all,
     * and even if it were it would report a fence's uid as the daemon's own and distinguish nothing. What
     * does work is a secret kept somewhere no fence can read -- the host's `/run`, since bubblewrap gives
     * each fence a fresh one -- which is what the host passes here.
     */
    private readonly token?: string,
  ) {}

  async listen(): Promise<void> {
    if (existsSync(this.path)) unlinkSync(this.path);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((done, fail) => server.once("error", fail).listen(this.path, done));
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      const closed = new Promise<void>((done) => server.close(() => done()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const write = (msg: unknown) => socket.writable && socket.write(encodeFrame(msg));
    readFrames(socket, (msg) => {
      const route = FrameIdSchema.safeParse(msg);
      if (!route.success) return;
      const id = route.data.id;
      // Carried on every frame rather than exchanged once on connect, so that a command line and a daemon
      // of different vintages still work: an older daemon ignores the extra field, and an older caller is
      // refused with a sentence that says what to do rather than a dropped connection.
      if (this.token && msg.token !== this.token) {
        this.log("[socket] a caller without the control token was refused");
        write({ id, error: "this caller did not present the control token; run the command line from the same host as the daemon, and as the user it runs as", code: "unauthorized" });
        return;
      }
      try {
        const request = parseSchema(RpcRequestSchema, msg, "RPC request");
        void callHandler(this.handler, request.method, request.args, (event) => write({ id, event })).then((outcome) => write({ id, ...outcome }));
      } catch (error) {
        write({ id, error: errorMessage(error), code: "invalid" });
      }
    });
    socket.on("error", (err) => this.log(`[socket] ${err.message}`));
  }
}

export interface RpcSocketClient {
  call: RpcHandler;
  close(): void;
}

/** Connects to a server. Resolves undefined when there is none (no socket file, or a stale one). */
export function connectRpcSocket(path: string, token?: string): Promise<RpcSocketClient | undefined> {
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((done) => {
    const socket = createConnection(path);
    const pending = new PendingCalls("c");
    socket.once("error", () => done(undefined));
    socket.once("connect", () => {
      readFrames(socket, (msg) => void pending.receive(msg));
      socket.on("close", () => pending.failAll(new Error("the server closed the connection")));
      done({
        call: (method, args, emit) => {
          const { id, result } = pending.open({ onEvent: emit });
          socket.write(encodeFrame({ id, method, args, ...(token ? { token } : {}) }));
          return result;
        },
        close: () => socket.end(),
      });
    });
  });
}
