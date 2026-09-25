import { z } from "zod";
import { ControlArgumentsSchema, ControlCallerSchema } from "../contracts/schemas/rpc.js";
import { UserRoleSchema, UserStatusSchema } from "../contracts/schemas/identity.js";
import { parseSchema } from "../lib/validation.js";
import { normalizeTurnInput } from "../lib/content.js";
import { resolve } from "node:path";
import { SYSTEM_USER, type KernelRpc, type PackageInfo, type UserRecord } from "../contracts/index.js";
import { assert, CodedError } from "../lib/error.js";
import { newestMtime } from "../lib/freshness.js";
import { isSupervised } from "../lib/restart.js";
import { assertUserIdFitsSockets } from "../lib/socket-paths.js";
import { applyInPlace, classifyChanges } from "../lib/config-tiers.js";
import { forkOf } from "../lib/pkg-fs.js";
import { CONFIG_TIERS, loadConfig } from "./config.js";
import type { KernelServices } from "./kernel.js";

/**
 * Operator scope: everything the command line does, against one running kernel. The same handler serves
 * an in-process kernel, the control socket, and an admin's fence through `operator.*`, so every path
 * runs the same checks and leaves the same journal rows.
 */
export function createControlHandler(k: KernelServices): KernelRpc {
  return async (method, raw, emit) => {
    const caller = parseSchema(ControlCallerSchema, raw ?? {}, `${method} arguments`, "rpc");
    const user = () => caller.user ?? SYSTEM_USER;
    const us = () => k.sessions.userspaceFor(k.users.authorize(user()));
    /** Who performs the operation: the named actor (an admin over the operator channel, the operator from the CLI), else the target user. */
    const actor = () => k.users.authorize(caller.actor ?? user());
    /** Every operator act leaves one row, with who did it and to whom. */
    const journal = (kind: string, target: string, data?: Record<string, unknown>) => {
      k.journal.append({ kind, actor: caller.actor ?? "operator", target, data });
    };
    if (method.startsWith("host.")) {
      // `host.<name>.<export>`: a host package's method, run by the host process. The kernel checks who
      // is calling and writes the row; what the method does and with what is the package's, so the
      // arguments are never journalled here (a key's material travels this way). Only an admin, for the
      // same reason as `restart.request`: `rpc.ts` admits the system userspace, which has no business
      // granting anything.
      const [name, exp, ...rest] = method.slice("host.".length).split(".");
      if (name && exp && !rest.length) {
        if (caller.actor) assert(actor().role === "admin", "only an admin may call a host package", "unauthorized");
        journal("host.call", user(), { name, method: exp });
        return k.hosts.call(name, exp, { ...caller, ...(caller.actor ? { actor: caller.actor } : {}) });
      }
      throw new CodedError(`unknown control method: ${method}`, "rpc");
    }
    const a = parseSchema(ControlArgumentsSchema, caller, `${method} arguments`, "rpc");
    const text = (key: string) => parseSchema(z.string(), a[key], `${method}.${key}`, "rpc");
    /** The configuration layer named: a person's own, or the system layer when none or the system user is named. */
    const layer = () => (a.user && k.users.authorize(a.user).id !== SYSTEM_USER ? a.user : undefined);
    const configTarget = () => ({ name: text("name"), user: layer() });
    switch (method) {
      case "ping":
        return "pong";
      case "users.list":
        return k.users.list();
      case "users.create": {
        // The id is half of a socket path -- `<home>/userspaces/<id>/run/term.sock` -- and this is the one
        // moment both halves are known and a shorter one can still be chosen. Every way a person is admitted
        // comes through here: the command line, an admin's `operator.*`, the browser.
        assertUserIdFitsSockets(k.config.home, text("id"));
        const rec = k.users.create(text("id"), a.role);
        journal("user.create", rec.id, { role: rec.role });
        await k.services.ensure(rec.id);
        return rec;
      }
      case "users.remove":
        await k.removeUser(text("id"));
        journal("user.remove", text("id"));
        return null;
      case "users.setStatus": {
        const status = parseSchema(UserStatusSchema, a.status, "users.setStatus.status", "rpc");
        journal("user.status", text("id"), { status });
        return k.users.setStatus(text("id"), status);
      }
      case "users.setRole": {
        const role = parseSchema(UserRoleSchema, a.role, "users.setRole.role", "rpc");
        journal("user.role", text("id"), { role });
        return k.users.setRole(text("id"), role);
      }
      case "users.passwd":
        await k.auth.setPassword(text("id"), text("password"));
        journal("user.password", text("id"));
        return null;
      case "packages.list":
        return k.packages.listFor(us());
      case "packages.install": {
        const info = await k.packages.install(us(), actor(), text("source"));
        journal("package.install", user(), { name: info.name, version: info.version, source: text("source") });
        return info;
      }
      case "packages.uninstall":
        await k.packages.uninstall(us(), text("name"));
        journal("package.uninstall", user(), { name: text("name") });
        return null;
      case "packages.unfork": {
        const info = await k.packages.unfork(us(), text("name"), a.deleteFiles ?? false);
        journal("package.unfork", user(), { name: text("name"), origin: info.name, files: a.deleteFiles ?? false });
        return info;
      }
      case "packages.promote": {
        const owner = us();
        const promoted = await k.packages.promote(owner, text("name"));
        await k.packages.uninstall(owner, text("name"));
        const sweep = await installEverywhere(k, promoted);
        journal("package.promote", user(), { name: text("name"), promoted, ...sweep });
        return { name: promoted, ...sweep };
      }
      case "packages.installEveryone":
        return installEveryone(k, actor(), text("source"), journal);
      case "packages.unmarkEveryone": {
        // The mark comes off and new people stop being seeded with it; everyone who has it keeps it: taking a
        // package out of a running workspace is that person's decision, or a `packages.uninstall` naming them.
        // Only an admin's mark is this method's to undo -- the `"*"` list is the configuration's, a promotion
        // is the promoted copy's -- and a page offering to undo what it cannot is the trap `everyoneBy` exists to avoid.
        const by = k.packages.catalog().find((p) => p.name === text("name"))?.everyoneBy;
        assert(by !== "config", `${text("name")} is everyone's by the installation's configuration (systemPackages "*"); edit that instead`, "invalid");
        assert(by !== "promoted", `${text("name")} is everyone's because it is promoted; remove the promoted copy instead`, "invalid");
        k.packages.markEveryone(text("name"), false);
        journal("package.everyone", text("name"), { on: false });
        return null;
      }
      case "fence.reload": {
        // `_system` is a legal target, unlike a grant: the providers and the sign-in page live in it,
        // and are otherwise out of reach without a new daemon. `authorize` refuses the unknown and the suspended.
        const target = k.users.authorize(user());
        // A person may put their own workspace back on the code that is on disk; anyone else's is an admin's
        // call. A call with no named actor came over the control socket, whose 0600 holder is the operator.
        assert(actor().role !== "user" || actor().id === target.id, "a person may reload only their own workspace", "unauthorized");
        journal("fence.reload", target.id);
        k.providers.forget(target.id);
        await k.services.reload(target.id);
        return { user: target.id, ...serviceState(installedIn(k, target.id), k.services.notRunning.get(target.id) ?? []) };
      }
      case "restart.request": {
        // Only an admin, asserted here rather than left to `rpc.ts`, which admits any non-user and so admits
        // the system userspace: that fence has no business ending every turn on this host. A call with no
        // named actor came over the control socket, whose 0600 holder is the operator, as with every command.
        if (a.actor) assert(actor().role === "admin", "only an admin may restart the daemon", "unauthorized");
        const reason = String(a.reason ?? "").trim();
        assert(reason, "a restart needs a reason: it is shown to everyone waiting and recorded", "invalid");
        // The latch wrote every sentence, refusals included; passing them through is what keeps the host, the
        // page and the model reading the same words about the same latch.
        const armed = k.restart.arm(reason, caller.actor ?? "operator");
        journal(`restart.${armed.state}`, "daemon", { reason, ...(armed.why ? { why: armed.why } : {}) });
        return armed;
      }
      case "restart.status":
        return { ...k.restart.status(), policy: k.restartPolicy() };
      case "restart.cancel": {
        // The same assert as `restart.request`, for the same reason. Calling one off is the safer direction,
        // but an armed restart is an admin's decision and the system userspace is not one.
        if (a.actor) assert(actor().role === "admin", "only an admin may call off a restart", "unauthorized");
        const { was } = k.restart.cancel();
        // Nothing pending is not an event: only a restart actually called off leaves a row.
        if (was) journal("restart.cancel", "daemon", { reason: was.reason, by: was.by });
        return { cancelled: !!was, was: was ?? null };
      }
      case "status":
        return status(k);
      case "journal.tail":
        return k.journal.tail(Math.min(1000, Number(a.limit ?? 200) || 200), { actor: a.actor_filter, target: a.target, kind: a.kind });
      case "config.get":
        return redact(k.config);
      case "config.list":
        return k.settings.list(layer());
      case "config.show":
        return k.settings.show(configTarget());
      case "config.set":
        return k.settings.set(configTarget(), text("key"), a.value, caller.actor ?? "operator");
      case "config.unset":
        return k.settings.unset(configTarget(), text("key"), caller.actor ?? "operator");
      case "config.reload": {
        // The whole file is read again, not only `packages[*]`. What that reaches depends on how each key
        // is consumed: `CONFIG_TIERS` says which, `applyInPlace` writes the new values into the object the
        // kernel bound at boot -- so every holder of it, and of any object inside it, sees them without
        // being handed a new reference -- and the fences are closed when a key they are built from moved.
        // Keys that are read once into a socket or a driver are named in the answer instead of silently
        // doing nothing, which is the failure this replaces.
        const next = loadConfig(k.config.home, k.config.projectRoot);
        const tiers = classifyChanges(k.config, next, CONFIG_TIERS);
        // The layer as it stands, kept before applyInPlace rewrites it. The settings service holds
        // `config.packages` by reference -- that is what makes a key written straight into it live -- so
        // after the rewrite it has no way of its own to tell what moved, and asking it plainly was asking
        // it to diff that object against itself. See ConfigService.reload.
        const wasPackages = structuredClone(k.config.packages);
        applyInPlace(k.config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
        const settings = await k.settings.reload(k.config.packages, wasPackages);
        if (tiers.fence.length) for (const u of k.users.list()) await k.services.reload(u.id);
        journal("config.reload", SYSTEM_USER, { ...tiers });
        return { ...settings, ...tiers };
      }
      case "models":
        return k.providers.listModels(us());
      case "sessions.create":
        return k.sessions.create(user(), { parent: a.parent });
      case "sessions.list":
        return k.sessions.list(user());
      case "sessions.inspect":
        return k.sessions.inspect(user(), text("session"));
      case "sessions.cancel":
        return k.sessions.cancel(user(), text("session"));
      case "sessions.delete":
        await k.sessions.delete(user(), text("session"));
        journal("session.delete", user(), { session: text("session") });
        return null;
      case "sessions.send": {
        for await (const event of k.sessions.send(user(), text("session"), normalizeTurnInput(a.input), { model: a.model || undefined })) emit?.(event);
        return null;
      }
      default:
        throw new CodedError(`unknown control method: ${method}`, "rpc");
    }
  };
}

type JournalFn = (kind: string, target: string, data?: Record<string, unknown>) => void;

/** What a sweep across the fleet did: the userspaces the package reached, and the people whose fork of it was left in place. */
type Sweep = { userspaces: string[]; forks: { user: string; fork: string }[] };

const installedIn = (k: KernelServices, id: string): PackageInfo[] => k.packages.listFor(k.userspaces.pathFor(id));

/** What an open fence is holding that the disk has moved past: the packages a reload would bring up to date. */
const changedIn = (installed: PackageInfo[]): { name: string; loaded: string; onDisk: string }[] =>
  installed.flatMap((p) => (p.loadedVersion && p.loadedVersion !== p.version ? [{ name: p.name, loaded: p.loadedVersion, onDisk: p.version }] : []));

/** What a workspace's declared services are actually doing, split by whether the last start of each worked:
 *  the ones running, and the ones that are not, each with the moment it failed and what it said. The two are
 *  answered together and never folded into one -- reporting the declarations as the running set is how a dead
 *  `@thetis/marketplace` read as healthy for seventeen minutes. `down` comes from the supervisor, which is
 *  the only thing here that ever tried to start anything. */
const serviceState = (list: PackageInfo[], down: { name: string; since: string; error: string }[]) => ({ services: list.filter((p) => p.thetis.service && !down.some((d) => d.name === p.name)).map((p) => p.name), down });

/** A moment as the rest of the service plane writes them, and null for one nobody knows. */
const moment = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

/**
 * What is running, and whether it is the code on disk. `stale` is the whole point: someone who deployed and
 * saw nothing change learns here which process is still holding the code it replaced, and what to do about
 * it — a workspace reloads, the daemon needs a new process.
 */
function status(k: KernelServices): unknown {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const codeAt = newestMtime([resolve(k.config.projectRoot, "dist/src"), resolve(k.config.systemPackagesDir, "gateway-cli/dist/src")]);
  const opened = k.fences.openedAt?.() ?? {};
  return {
    // Supervision is read here and never inside a fence: the fence hands package code an env allowlist, so a
    // tool would see no INVOCATION_ID and wrongly conclude that nothing would restart the daemon.
    // `restartPolicy` is the deployed unit's `Restart=`, not this checkout's file: it decides whether a clean
    // exit comes back, and an operator who cannot see it finds out when a restart is first attempted.
    daemon: { startedAt: moment(startedAt), uptimeSecs: Math.round(process.uptime()), supervised: isSupervised(), restartPolicy: k.restartPolicy(), codeAt: moment(codeAt), stale: codeAt > startedAt },
    // The armed restart, as the statusbar chip and `thetis restart status` show it, and null when there is none.
    restart: k.restart.status().pending ?? null,
    workspaces: k.users
      .list()
      .filter((u) => k.userspaces.exists(u.id))
      .map((u) => {
        const installed = installedIn(k, u.id);
        const openedAt = opened[u.id] ?? 0;
        const code = newestMtime(installed.map((p) => p.root));
        // A workspace with no fence open is never stale: the next request opens it on the code that is there then.
        // `down` rides here beside `stale` and `changed` for the same reason those do: the three of them are
        // every way a workspace can differ from what someone assumes it is, and each says since when.
        return { user: u.id, openedAt: moment(openedAt), codeAt: moment(code), stale: openedAt > 0 && code > openedAt, ...serviceState(installed, k.services.notRunning.get(u.id) ?? []), changed: changedIn(installed) };
      }),
  };
}

/**
 * Makes a package the default for everyone. A shipped system package is marked and linked into every
 * person. Anything else is installed for the actor first and then promoted, which copies it under
 * @thetis for everyone.
 */
async function installEveryone(k: KernelServices, who: UserRecord, source: string, journal: JournalFn): Promise<{ name: string } & Sweep> {
  if (k.packages.systemPackageDir(source)) {
    // Link first: the registry record the mark lives on exists only once someone has the package.
    const sweep = await installEverywhere(k, source);
    k.packages.markEveryone(source, true);
    journal("package.everyone", source, { ...sweep });
    return { name: source, ...sweep };
  }
  const own = k.sessions.userspaceFor(who);
  const info = await k.packages.install(own, who, source);
  if (info.name.startsWith("@thetis/")) {
    const sweep = await installEverywhere(k, info.name);
    journal("package.everyone", info.name, { source, ...sweep });
    return { name: info.name, ...sweep };
  }
  const promoted = await k.packages.promote(own, info.name);
  await k.packages.uninstall(own, info.name);
  const sweep = await installEverywhere(k, promoted);
  journal("package.promote", who.id, { name: info.name, promoted, source, ...sweep });
  return { name: promoted, ...sweep };
}

/**
 * Installs a system package into every existing person's userspace, and says who it left alone. A person
 * holding a fork of that package is one the kernel refuses -- see `PackageManager.displace` for why that
 * is a refusal and not a second displacement -- and a fleet-wide sweep must not stop halfway through
 * because one person made a private decision months ago. So the question is asked before each install
 * rather than caught after it, and the people it names are carried out with the answer.
 *
 * Both halves of that answer matter, and to different people. Whoever ran the sweep is acting on people
 * who are not at the keyboard: `userspaces` alone would let them walk away believing a package is
 * everywhere when it is not, which is how a gateway comes to be the default for everyone except the three
 * people who never hear about it. `forks` names those three, in the answer and in the journal row, so the
 * admin can go and talk to them. What the people themselves see is on their own package listing, where the
 * fork's row says the package it was copied from is now everyone's default.
 */
async function installEverywhere(k: KernelServices, name: string): Promise<Sweep> {
  const people = k.users.list().filter((u) => u.role !== "system" && k.userspaces.exists(u.id));
  const forks = people.map((u) => ({ user: u.id, fork: forkOf(k.registry.installedIn(u.id), name) })).filter((f): f is { user: string; fork: string } => !!f.fork);
  const userspaces = people.filter((u) => !forks.some((f) => f.user === u.id)).map((u) => u.id);
  for (const id of userspaces) await k.packages.install(k.userspaces.pathFor(id), k.users.authorize(SYSTEM_USER), name);
  return { userspaces, forks };
}

const SECRET = /key|secret|token|password/i;

/** A copy of a value with every string under a secret-looking key replaced, for display. */
export function redact<T>(value: T, key = ""): T {
  if (typeof value === "string") return (SECRET.test(key) && value ? "•••" : value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)])) as T;
  return value;
}
