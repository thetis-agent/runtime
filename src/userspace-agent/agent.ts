import { kernelClient } from "../lib/kernel-client.js";
// The guest side of the fence. One instance per userspace, booted by the kernel's fence.
// It loads package modules from the userspace store and runs steps, tools, enumerators
// and providers on the kernel's behalf. Protocol: newline-delimited JSON on stdin/stdout.
import { exec as cpExec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EnumeratorContext, ExecOptions, KernelClient, PackageInfo, PackageQuery, PackageStepContext,
  Provider, ProviderCall, ProviderEvent, ServiceEnv, ServiceHandle, SessionInfo, StepContext, StepEnv, ToolEnv, TurnEvent, WatchedTurnEvent,
} from "../contracts/index.js";
import { CodedError } from "../lib/error.js";
import { StepResultSchema } from "../contracts/schemas/pipeline.js";
import { parseSchema } from "../lib/validation.js";
import { encodeFrame, PendingCalls, readFrames, type Frame, type OpenCall } from "../lib/rpc-frames.js";
import { buildEnvFor, noStorage } from "./env.js";

const ROOT = process.env.THETIS_USERSPACE ?? process.cwd();
const HOME = process.env.THETIS_HOME_DIR ?? ROOT;
const STORE = process.env.THETIS_STORE ?? resolve(ROOT, "store");
const SHARED = process.env.THETIS_SHARED ?? resolve(ROOT, "shared");
const MAX_OUTPUT = 30_000;
/** What the services get to stop on SIGTERM. The kernel kills the agent 2 s after it asks (the fence's
 *  exit grace), and a service that has not finished by then is worse off for being waited on. */
const STOP_DEADLINE_MS = 1_000;
/**
 * How often this agent says it is alive while it is working on a request. The kernel times a request by the
 * silence on it and not by how long the work takes -- a `step` is a whole turn, and a tool running a build
 * is quiet for minutes while being perfectly healthy -- so the one thing it needs from here is proof that
 * this process is still turning. The kernel derives the interval from the silence it allows (a tenth of it)
 * and passes it in; the fallback is for a run started without it, and is well inside any sane budget.
 */
const HEARTBEAT_MS = Number(process.env.THETIS_HEARTBEAT_MS) > 0 ? Number(process.env.THETIS_HEARTBEAT_MS) : 5_000;
/**
 * How long an operation that is not one of the long ones may run before this agent stops it and fails it.
 *
 * The heartbeat above is what keeps a healthy fence from being killed for being busy, and it is unconditional:
 * it beats for as long as the operation runs. That took the kernel's timer away as a bound on everything, so
 * a step that awaits something which never resolves would keep the fence beating and nothing would ever end
 * the turn. The allowance puts the bound back where it belongs -- in here, on the operation itself, so what
 * fails is the package that hung and not the workspace, which keeps its gateway, its terminal and its
 * sessions. Only the operations that are legitimately long are exempt; see `allowanceFor`.
 *
 * The kernel passes half of the silence it allows a fence (`requestTimeoutMs`), so the two never disagree:
 * the operation's own failure always comes first, and a person is told which package hung rather than that
 * their fence died. The fallback is for a run started without it.
 */
const STEP_DEADLINE_MS = Number(process.env.THETIS_STEP_DEADLINE_MS) > 0 ? Number(process.env.THETIS_STEP_DEADLINE_MS) : 300_000;

const writeOut = process.stdout.write.bind(process.stdout);
for (const k of ["log", "info", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);
const send = (m: unknown) => void writeOut(encodeFrame(m));

// ---- kernel RPC (fence -> kernel) ----
// `{ rpcEvent }` lines stream to `onEvent` before the `{ rpcResult }` line settles the call. An aborted
// `signal` sends `{ rpcCancel }`, which aborts the kernel's side of the call, and settles the call here at
// once with code `cancelled`: a step that was stopped must not wait for tokens the kernel is dropping.
const rpcPending = new PendingCalls("k");
function rpc<T = unknown>(method: string, args?: unknown, onEvent?: (e: unknown) => void, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new CodedError(`${method} cancelled`, "cancelled"));
  const call: OpenCall = { onEvent };
  const { id, result } = rpcPending.open(call);
  call.cancel = () => send({ rpcCancel: id });
  const onAbort = () => {
    send({ rpcCancel: id });
    rpcPending.settle(id, undefined, new CodedError(`${method} cancelled`, "cancelled"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  call.cleanup = () => signal?.removeEventListener("abort", onAbort);
  send({ rpc: id, method, args });
  return result as Promise<T>;
}

const kernel = kernelClient(rpc);

// ---- environment handed to package code ----
function exec(cmd: string, opts: ExecOptions = {}, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const cwd = opts.cwd ? resolve(HOME, opts.cwd) : HOME;
    const env = { ...process.env, ...(opts.env ?? {}) };
    cpExec(cmd, { cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, shell: "/bin/bash", signal }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      res({ code, stdout: cap(String(stdout)), stderr: cap(String(stderr) + (err && !stderr ? `\n${err.message}` : "")) });
    });
  });
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

const env: StepEnv = {
  cwd: HOME,
  root: ROOT,
  store: STORE,
  shared: SHARED,
  exec,
  readFile: (p) => readFile(resolve(HOME, p), "utf8"),
  writeFile: async (p, content) => {
    const file = resolve(HOME, p);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  },
  storage: noStorage,
  invokeTool: async (ref, args, opts) => {
    const fn = await loadExport(ref.package, ref.export);
    const toolEnv: ToolEnv = { ...envFor(ref.package), session: opts.session, config: opts.config ?? {}, signal: opts.signal };
    return fn(args ?? {}, toolEnv) as Promise<string | object>;
  },
  kernel,
};

/** The env for code of `pkg`: the base env with storage under that package's name. */
const envFor = (pkg: string) => buildEnvFor(env, rpc, pkg);

function packageQuery(list: PackageInfo[]): PackageQuery {
  return {
    has: (name) => list.some((p) => p.name === name),
    get: (name) => list.find((p) => p.name === name),
    list: (type) => (type ? list.filter((p) => p.type === type) : list),
  };
}

// ---- module loading from the userspace store ----
async function loadExport(pkg: string, name: string): Promise<(...a: unknown[]) => unknown> {
  const dir = resolve(STORE, "node_modules", pkg);
  const manifest = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")) as { main?: string };
  const main = resolve(dir, manifest.main ?? "index.js");
  const { mtimeMs } = await stat(main);
  const mod = (await import(`${pathToFileURL(main).href}?v=${mtimeMs}`)) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== "function") throw new Error(`${pkg} does not export a function named "${name}"`);
  return fn as (...a: unknown[]) => unknown;
}

const providers = new Map<string, Promise<Provider>>();
function provider(pkg: string, exp: string, config: unknown): Promise<Provider> {
  const key = `${pkg}#${exp}:${JSON.stringify(config)}`;
  let p = providers.get(key);
  if (!p) {
    p = loadExport(pkg, exp).then((factory) => factory(config) as Provider);
    providers.set(key, p);
  }
  return p;
}

// ---- operations the kernel dispatches ----
// Each request carries an AbortSignal. The kernel sends `{ cancel: <id> }` to abort it; `exec` kills its
// process, a step sees it as `ctx.signal`, and `provider.call` stops reading the stream, which closes the
// provider's iterator. A tool runs only inside a step, through `env.invokeTool`: the kernel never asks for one.
type Emit = (event: unknown) => void;

/** What each operation carries. The kernel is the only sender; the shapes are the contracts' own types. */
interface ExportRef {
  package: string;
  export: string;
}
interface Payloads {
  ping: Record<string, never>;
  exec: { cmd: string; cwd?: string; timeoutMs?: number };
  step: ExportRef & { ctx: StepContext; phase?: string };
  enumerate: ExportRef & { ctx: { session: SessionInfo; packages: PackageInfo[]; phases: string[] } };
  "service.start": ExportRef & { config?: Record<string, unknown> };
  "service.stop": { package: string };
  shutdown: Record<string, never>;
  "provider.models": ExportRef & { config: unknown };
  "provider.call": ExportRef & { config: unknown; call: ProviderCall; assetGrant?: string };
}
type Op = keyof Payloads;
type Handler<K extends Op> = (p: Payloads[K], emit: Emit, signal: AbortSignal) => Promise<unknown>;

const ops: { [K in Op]: Handler<K> } = {
  ping: async () => "pong",
  exec: (p, _emit, signal) => exec(p.cmd, { cwd: p.cwd, timeoutMs: p.timeoutMs }, signal),
  // The step's events go back as `{ id, event }` frames, which the kernel relays as turn events.
  step: async (p, emit, signal) => {
    const fn = await loadExport(p.package, p.export);
    const ctx: PackageStepContext = { ...p.ctx, packages: packageQuery(p.ctx.packages), env: envFor(p.package), emit: (event: TurnEvent) => emit(event), signal };
    const raw = await fn(ctx);
    if (raw == null) return null;
    const result = parseSchema(StepResultSchema, raw, `step ${p.package}#${p.export} returned an invalid result`, "step");
    return { conversation: result.conversation, call: result.call, harness: result.harness };
  },
  enumerate: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const ctx: EnumeratorContext = { session: p.ctx.session, packages: packageQuery(p.ctx.packages), phases: p.ctx.phases };
    return fn(ctx);
  },
  "service.start": async (p) => {
    if (services.has(p.package)) return "running";
    const fn = await loadExport(p.package, p.export);
    const serviceEnv: ServiceEnv = { ...envFor(p.package), config: p.config ?? {}, log: (line) => console.error(`[${p.package}] ${line}`) };
    services.set(p.package, (await fn(serviceEnv)) as ServiceHandle | void);
    return "started";
  },
  "service.stop": async (p) => {
    const handle = services.get(p.package);
    services.delete(p.package);
    await handle?.stop?.();
    return "stopped";
  },
  // The fence is closing. It asks rather than signals, because bwrap does not forward SIGTERM to the process
  // inside it, and a service that is never told leaves its socket on disk for the door to trip over.
  shutdown: async () => (await stopServices(), "stopped"),
  "provider.models": async (p) => (await provider(p.package, p.export, p.config)).models(),
  // The signal is handed to the provider, not only checked between events. A provider that is waiting on a
  // connection which produces nothing reaches no event, so the check below would never run: the only thing
  // that ends such a request is the provider aborting its own fetch, which it can do only if it has the signal.
  "provider.call": async (p, emit, signal) => {
    const prov = await provider(p.package, p.export, p.config);
    for await (const e of prov.call(p.call, signal, { assets: {
      put: (upload) => rpc("assets.put", { upload, grant: p.assetGrant }, undefined, signal),
      read: (id) => rpc("assets.read", { id, grant: p.assetGrant }, undefined, signal),
    } })) {
      if (signal.aborted) break;
      emit(e as ProviderEvent);
    }
    return null;
  },
};

function isOp(op: string): op is Op {
  return Object.hasOwn(ops, op);
}

/** The phase a step is running in: what the kernel said, else what the package's own manifest declares for
 *  that export. A step has to be declared to be scheduled, so between the two the phase is always known. */
function phaseOf(p: Payloads["step"]): string | undefined {
  if (typeof p.phase === "string") return p.phase;
  return p.ctx?.packages?.find((x) => x.name === p.package)?.thetis?.steps?.find((s) => s.export === p.export)?.phase;
}

/**
 * How long this operation gets before the agent stops it, or 0 for no limit. Three are exempt and each for
 * its own reason.
 *
 * `provider.call` and the `execute` step are the turn's long work by design -- a model answering, tools
 * running under it, a build that says nothing for twenty minutes -- and both are watched from the inside,
 * where the thing that is slow can be asked about instead of killed. A deadline over them would be the
 * ten-minute cap on a working turn all over again.
 *
 * `exec` carries its own timeout (`timeoutMs`, and a default) and always settles, so it is bounded already,
 * and a package build is deliberately allowed to run longer than this allowance.
 *
 * Everything else is fast by nature: a step that builds a prompt, lists tools or records the call, an
 * enumerator, a service starting, a provider listing its models. A minute of that is not slowness, it is a
 * bug, and it gets the allowance. A step whose phase nothing names is treated as one of these: an unnamed
 * phase is a package that did not say what it is, and guessing "unbounded" is how a turn hangs for ever.
 */
function allowanceFor(op: Op, payload: Payloads[Op]): number {
  if (op === "provider.call" || op === "exec") return 0;
  if (op === "step" && phaseOf(payload as Payloads["step"]) === "execute") return 0;
  return STEP_DEADLINE_MS;
}

/** What a person is told when an operation runs past its allowance. It names the package and the export,
 *  because this is that package's bug and not a failure of the fence, which is still serving everything else. */
function overdue(op: Op, payload: Payloads[Op], limit: number): Error {
  const p = payload as { package?: string; export?: string };
  const what = p.package ? `${p.package}#${p.export ?? "?"}` : `the ${op} operation`;
  const where = op === "step" ? ` in the ${phaseOf(payload as Payloads["step"]) ?? "unnamed"} phase` : "";
  const err = new Error(
    `${what}${where} did not finish within ${limit < 1_000 ? `${limit} ms` : `${Math.round(limit / 1000)} s`} and was stopped. Only the execute phase may run long; a step that builds a prompt, lists tools or records the call is expected to take milliseconds, so this is a bug in that package rather than a slow turn. The workspace is unaffected: its other services, sessions and this fence are still running.`,
  );
  // The stack would be this timer's, which tells nobody anything about the code that hung; the sentence is
  // the whole diagnosis, and it is what the kernel relays to the person.
  err.stack = err.message;
  return err;
}

const inflight = new Map<string, AbortController>();
/** Running services by package name. They live as long as this process, which is as long as the fence. */
const services = new Map<string, ServiceHandle | void>();

/** Stops every service and forgets it. Settled rather than all: one service that throws on the way out must
 *  not keep the others from being asked, and each of them has a socket to take with it. */
async function stopServices(): Promise<void> {
  const handles = [...services.values()];
  services.clear();
  const results = await Promise.allSettled(handles.map(async (h) => h?.stop?.()));
  for (const r of results) if (r.status === "rejected") console.error(`agent: a service did not stop: ${String(r.reason)}`);
}

async function dispatch(msg: Frame): Promise<void> {
  const { id, op, payload } = msg as { id: string; op: string; payload?: unknown };
  const control = new AbortController();
  inflight.set(id, control);
  // The beat runs for exactly as long as the operation does, so what it reports is this request still being
  // worked on and not merely a process that exists. Unreferenced: it must never be the reason this process
  // stays up, and a request that outlives everything else is still the kernel's to end, not ours.
  const beat = setInterval(() => send({ id, alive: true }), HEARTBEAT_MS).unref();
  let clock: NodeJS.Timeout | undefined;
  try {
    if (!isOp(op)) throw new Error(`unknown op: ${op}`);
    // The frame was read once at the boundary; the kernel built it from the contracts' types, so the
    // payload is trusted to be the shape the operation declares.
    const handler = ops[op] as Handler<Op>;
    const p = (payload ?? {}) as Payloads[Op];
    const work = handler(p, (event) => send({ id, event }), control.signal);
    // The allowance is raced against the work, not enforced inside it: the point is to end an operation that
    // is not going to end by itself, and one that ignores its signal would sit there being asked nicely for
    // ever. The signal is aborted first all the same, so work that does watch it stops rather than running on
    // unwatched. A late rejection from `work` is consumed by the race and never goes unhandled.
    const limit = allowanceFor(op, p);
    const result = await (limit
      ? Promise.race([
          work,
          new Promise<never>((_, fail) => {
            clock = setTimeout(() => {
              control.abort();
              fail(overdue(op, p, limit));
            }, limit).unref();
          }),
        ])
      : work);
    send({ id, result: result === undefined ? null : result });
  } catch (err) {
    // The stack goes back whole: package code failed, and its author needs the trace.
    send({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err), code: err instanceof CodedError ? err.code : undefined });
  } finally {
    clearInterval(beat);
    clearTimeout(clock);
    inflight.delete(id);
  }
}

readFrames(process.stdin, (msg) => {
  if (typeof msg.cancel === "string") return void inflight.get(msg.cancel)?.abort();
  if (typeof msg.rpcEvent === "string") return void rpcPending.receive({ id: msg.rpcEvent, event: msg.event });
  if (typeof msg.rpcResult === "string") return void rpcPending.receive({ ...msg, id: msg.rpcResult });
  void dispatch(msg);
}, (line) => console.error(`agent: bad line ${line.slice(0, 80)}`));
process.stdin.on("end", () => process.exit(0));

/**
 * The belt to the `shutdown` op's braces. A fence that closes asks for the stop over the protocol, which is
 * the only way in when bwrap holds this process; a run without a sandbox gets the signal instead, and either
 * way a service that is never told leaves its socket on disk for the door to trip over. The process leaves on
 * the deadline whatever the services do.
 */
process.once("SIGTERM", () => {
  const leave = () => process.exit(0);
  const timer = setTimeout(leave, STOP_DEADLINE_MS);
  void stopServices().then(() => {
    clearTimeout(timer);
    leave();
  });
});
