import type { ToolOutput } from "./content.js";
import type { AssetClient, ProviderContext } from "./assets.js";
// What package code sees inside the fence: the environment, the kernel client, and the shapes of a step, a tool,
// a service, a provider, and an enumerator. The userspace agent builds these; package authors implement them.
import type { Message, TurnInput, ModelChoices, ModelDescriptor, ProviderCall, ProviderEvent } from "./messages.js";
import type { DeletedPackage, PackageInfo } from "./packages.js";
import type { AuthUser, SessionInfo, SessionRecord, SessionSummaryRef, UserRole } from "./identity.js";
import type { StepContext, StepResult, TurnEvent, TurnOptions, WatchedTurnEvent } from "./pipeline.js";
import type { ToolSpec } from "./messages.js";
import type { ConfigReport } from "./config.js";
import type { Store } from "./storage.js";

export interface PackageQuery {
  has(name: string): boolean;
  get(name: string): PackageInfo | undefined;
  list(type?: string): PackageInfo[];
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Filesystem, processes and the kernel, all scoped to the fence. */
export interface StepEnv {
  cwd: string;
  root: string;
  store: string;
  /** The shared directory: written by the system userspace, read by every fence. */
  shared: string;
  exec(cmd: string, opts?: ExecOptions): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Documents this package keeps, in the service-plane store, under a namespace the kernel prefixes with
   * the fence's user and this package's name: a package reaches only what it wrote, and a delete of the
   * package or of the user clears it. `namespace` names a sub-namespace, default `default`.
   */
  storage(namespace?: string): Store;
  /**
   * Runs a tool export of a package installed in this fence, under that package's own env, the way the
   * agent runs one for the kernel. This is how a harness's call step runs what the model asked for: in the
   * caller's fence, with the tool package's effective configuration (`kernel.config.effective`) passed in.
   */
  invokeTool(ref: Pick<ToolSpec, "package" | "export" | "name">, args: Record<string, unknown>, opts: { session: SessionInfo; config: Record<string, unknown>; signal?: AbortSignal }): Promise<ToolOutput>;
  kernel: KernelClient;
}

/**
 * The kernel as seen from inside a fence. Identity is the fence: every call acts as the userspace's
 * own user. `operator.call` runs a control method (the table the command line uses) and is allowed
 * when that user is an admin. `auth.login` is for the system userspace; `auth.authenticate` answers a
 * fence only about its own user.
 */
export interface KernelClient {
  assets: AssetClient;
  packages: {
    install(source: string): Promise<PackageInfo>;
    uninstall(name: string): Promise<void>;
    /** Uninstalls a package of the fence's own scope and deletes its files under the home. Restores what it replaced. */
    delete(name: string): Promise<DeletedPackage>;
    /**
     * Puts a fork's userspace back on the package it was forked from, and answers with that package. The
     * fork's files stay unless `deleteFiles` says otherwise. When the fork is the gateway the caller is
     * being asked through, this call's answer is lost with the gateway: see `PackageManager.unfork`.
     */
    unfork(name: string, deleteFiles?: boolean): Promise<PackageInfo>;
    list(): Promise<PackageInfo[]>;
  };
  operator: {
    /** Extension methods own their result shapes; callers validate the unknown reply with their schema. */
    call(method: string, args?: Record<string, unknown>, onEvent?: (event: unknown) => void): Promise<unknown>;
  };
  sessions: {
    create(parent?: string): Promise<SessionSummaryRef>;
    complete(session: string, input: TurnInput): Promise<Message>;
    askText(session: string, input: TurnInput): Promise<string>;
    /** @deprecated Use askText for an explicit text projection, or complete for structured output. */
    ask(session: string, input: TurnInput): Promise<string>;
    /** `signal` ends the call and cancels the turn it started. */
    send(session: string, input: TurnInput, onEvent: (event: TurnEvent) => void, opts?: TurnOptions, signal?: AbortSignal): Promise<void>;
    cancel(session: string): Promise<boolean>;
    /** Removes a session's record. A running turn is cancelled first. */
    delete(session: string): Promise<void>;
    list(): Promise<SessionSummaryRef[]>;
    inspect(session: string): Promise<SessionRecord & { status: "idle" | "running" }>;
    /**
     * Every turn event of every session of this person, from the moment of the call: turns started by
     * anyone, subagents included. Resolves when the fence closes. A caller that wants the events for as
     * long as it lives calls once and never awaits it.
     */
    watch(onEvent: (m: WatchedTurnEvent) => void): Promise<void>;
  };
  /** The models the fence's own providers serve, and the default. */
  models(): Promise<ModelChoices>;
  providers: {
    /**
     * Sends one request to the provider that serves `call.model` (the fence's own, else the system's) and
     * streams its events back. The provider runs in its own fence with its own configuration; this fence never
     * sees the key. `signal` ends the stream and the provider's request with it.
     */
    call(call: ProviderCall, onEvent: (event: ProviderEvent) => void, signal?: AbortSignal): Promise<void>;
  };
  /**
   * This person's own configuration layer for a package installed in this fence. `show` reports every key's
   * state with secrets redacted; `set` and `unset` change the person's layer, secrets included, and the kernel
   * refuses a key the package declared `scope: "system"`. `effective` is what that package's code receives,
   * secrets included: the fence is one person's authority, so a package in it may load another's config the
   * way the web gateway runs another package's UI commands.
   */
  config: {
    show(name: string): Promise<ConfigReport>;
    set(name: string, key: string, value: unknown): Promise<ConfigReport>;
    unset(name: string, key: string): Promise<ConfigReport>;
    effective(name: string): Promise<Record<string, unknown>>;
  };
  auth: {
    login(id: string, password: string): Promise<{ token: string; user: AuthUser } | null>;
    authenticate(token: string): Promise<AuthUser | null>;
    logout(token: string): Promise<void>;
  };
}

export interface PackageStepContext extends Omit<StepContext, "packages"> {
  packages: PackageQuery;
  env: StepEnv;
  /** Streams one event to whoever is watching the turn, as it is. The kernel relays it and reads only `usage` and `error`. */
  emit(event: TurnEvent): void;
  /** Aborted when the turn is stopped while this step runs. A step that is waiting on something stops it here and returns what it has. */
  signal: AbortSignal;
}

export type Step = (ctx: PackageStepContext) => Promise<StepResult | void>;

export interface ToolEnv extends StepEnv {
  session: SessionInfo;
  config: Record<string, unknown>;
  /** Aborted when the turn is stopped while the tool runs. A tool that started something stops it here. */
  signal?: AbortSignal;
}

export type Tool = (args: Record<string, unknown>, env: ToolEnv) => Promise<ToolOutput>;

/** What a UI command handler receives: the fence environment, who asked, and which conversation is on screen. */
export interface UiCommandEnv extends StepEnv {
  user: string;
  role: UserRole;
  /** The session the page named, already checked to be the person's own. */
  session?: string;
  /** The configuration of the package that declared the command, as its steps and tools receive it. */
  config: Record<string, unknown>;
}
export type UiCommandResult = { text?: string; data?: unknown } | string | void;
/** The export a `ui.commands[]` entry names. The web gateway calls it when the package's own page asks. */
export type UiCommand = (args: Record<string, unknown>, env: UiCommandEnv) => Promise<UiCommandResult>;

/** What a streaming handler receives on top of a command's: the life of the subscription. */
export interface UiStreamEnv extends UiCommandEnv {
  /** Aborted when the browser closes the subscription. A handler that waits should stop when it fires. */
  signal: AbortSignal;
}
/** The export a `ui.commands[]` entry with `stream: true` names. Each value it yields is one event on the page. */
export type UiStream = (args: Record<string, unknown>, env: UiStreamEnv) => AsyncIterable<unknown>;

export interface ServiceEnv extends StepEnv {
  config: Record<string, unknown>;
  log(line: string): void;
}

export interface ServiceHandle {
  stop?(): Promise<void> | void;
}

/** The export a `service` declaration names. Runs inside the agent process of its userspace. */
export type Service = (env: ServiceEnv) => Promise<ServiceHandle | void>;

export interface Provider {
  models(): Promise<ModelDescriptor[]>;
  /**
   * One request, as a stream of events. `signal` is the caller giving up: the provider stops the HTTP request
   * itself, rather than being abandoned mid-`await` with its socket still open. Breaking out of the iteration
   * is not enough on its own -- an async generator parked on an `await` does not see a `return()` until it
   * reaches a `yield`, so a request that produces nothing at all would never notice -- which is why the signal
   * is a parameter and not something the caller can arrange from outside.
   */
  call(call: ProviderCall, signal?: AbortSignal, context?: ProviderContext): AsyncIterable<ProviderEvent>;
}

export interface EnumeratorContext {
  session: SessionInfo;
  packages: PackageQuery;
  phases: string[];
}
