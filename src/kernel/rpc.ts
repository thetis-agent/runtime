import { z } from "zod";
import { RpcArgumentsSchema } from "../contracts/schemas/rpc.js";
import { AssetUploadSchema, ProviderCallInputSchema } from "../contracts/schemas/index.js";
import { parseSchema } from "../lib/validation.js";
import { normalizeTurnInput } from "../lib/content.js";
import { SYSTEM_USER, type KernelRpc, type ModelChoices, type Userspace } from "../contracts/index.js";
import { assert, CodedError } from "../lib/error.js";
import { assertStoreDoc, storeId } from "../lib/store.js";
import type { KernelServices } from "./kernel.js";

const OPERATOR = "operator.";

/** What a fence's handler needs of the kernel: identity, packages, sessions, providers, tokens, the store and the configuration. */
export type RpcServices = Pick<KernelServices, "users" | "packages" | "sessions" | "providers" | "auth" | "store" | "settings" | "assets">;

/**
 * What code inside a fence may ask the kernel to do. Identity is the fence: every method acts as the
 * userspace's own user, so a package can only install into its own scope, drive its own sessions, and
 * resolve login tokens that name its own user. An admin's fence may also call operator methods
 * (`operator.<method>`, the table the command line uses); the kernel checks the role, so a gateway
 * hiding a button is a courtesy. The system userspace alone may log people in.
 */
export function createRpcHandler(us: Userspace, k: RpcServices, operator?: KernelRpc, models?: (us: Userspace) => Promise<ModelChoices>): KernelRpc {
  const system = us.id === SYSTEM_USER;
  return async (method, raw, emit, signal) => {
    const payload = parseSchema(z.record(z.string(), z.unknown()), raw ?? {}, `${method} arguments`, "rpc");
    const actor = k.users.authorize(us.id);
    if (method.startsWith(OPERATOR)) {
      const op = method.slice(OPERATOR.length);
      assert(operator, "no operator channel is configured", "rpc");
      // One exception to the role: a person may reload their own workspace, because the code it is holding is
      // theirs to put right. Their own id, named: the control table reads no `user` as the system userspace,
      // which is nobody's own. It checks the target again, so this opens nothing wider.
      const own = op === "fence.reload" && payload.user === us.id;
      assert(own || actor.role !== "user", "only an admin may use operator methods", "unauthorized");
      return operator(op, { ...payload, actor: us.id }, emit);
    }
    const args = parseSchema(RpcArgumentsSchema, payload, `${method} arguments`, "rpc");
    const text = (key: string) => parseSchema(z.string(), args[key], `${method}.${key}`, "rpc");
    const input = () => normalizeTurnInput(args.input);
    // The fence names its package and a sub-namespace; the prefix is the kernel's, so nothing a fence sends can leave its own tree.
    const space = () => k.store.open(storeId("userspaces", us.id, text("package"), args.namespace ?? "default"));
    /** A fence configures only what is installed in it; the system fence's own layer is the system layer. */
    const target = () => {
      const name = text("name");
      assert(k.packages.installed(us).some((p) => p.name === name), `${name} is not installed in ${us.id}`, "not-found");
      return { name, ...(system ? {} : { user: us.id }) };
    };
    switch (method) {
      case "packages.install":
        return k.packages.install(us, actor, text("source"));
      case "packages.uninstall":
        await k.packages.uninstall(us, text("name"));
        return null;
      // A fence un-forks only its own userspace, which is what it is: the person clicking "go back to the
      // shipped package" in their own marketplace page. The gateway serving that click is very often the
      // package being replaced, so the answer to this call is routinely lost; see `PackageManager.unfork`.
      case "packages.unfork":
        return k.packages.unfork(us, text("name"), args.deleteFiles ?? false);
      case "packages.delete":
        return k.packages.delete(us, text("name"));
      case "packages.list":
        return k.packages.listFor(us);
      case "packages.catalog":
        return k.packages.catalog();
      case "sessions.create":
        return k.sessions.create(us.id, { parent: args.parent });
      case "assets.put":
        return k.assets.put(us.id, parseSchema(AssetUploadSchema, args.upload, "assets.put upload", "rpc"), args.grant);
      case "assets.read":
        return k.assets.read(us.id, text("id"), args.grant);
      case "sessions.complete":
        return k.sessions.complete(us.id, text("session"), input());
      case "sessions.askText":
        return k.sessions.askText(us.id, text("session"), input());
      case "sessions.ask":
        return k.sessions.ask(us.id, text("session"), input());
      case "sessions.send": {
        // A fence that drops the call cancels the turn it started, so nothing streams into the void.
        const session = text("session");
        const cancel = () => void k.sessions.cancel(us.id, session);
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          for await (const event of k.sessions.send(us.id, session, input(), { model: args.model || undefined })) emit?.(event);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
        return null;
      }
      case "models":
        assert(models, "no model list is configured", "rpc");
        return models(us);
      case "providers.call": {
        // Routed to the provider's own fence with its own configuration: the caller never sees the key.
        const request = parseSchema(ProviderCallInputSchema, args.call, "providers.call needs a call with a model", "rpc");
        const provider = await k.providers.resolve(us, request.model);
        await k.assets.during(us.id, provider.userspace.id, request.messages, (grant) =>
          k.providers.call(provider, request, (e) => emit?.(e), signal, grant));
        return null;
      }
      case "sessions.cancel":
        return k.sessions.cancel(us.id, text("session"));
      case "sessions.delete":
        await k.sessions.delete(us.id, text("session"));
        return null;
      case "sessions.list":
        return k.sessions.list(us.id);
      case "sessions.inspect":
        return k.sessions.inspect(us.id, text("session"));
      case "sessions.watch":
        return k.sessions.watch(us.id, (m) => emit?.(m), signal);
      case "store.get":
        return (await space().get(text("key"))) ?? null;
      case "store.set": {
        const doc = args.doc;
        assertStoreDoc(doc);
        await space().set(text("key"), doc);
        return null;
      }
      case "store.delete":
        await space().delete(text("key"));
        return null;
      case "store.list":
        return space().list(args.prefix);
      case "store.clear":
        await space().clear();
        return null;
      case "config.show":
        return k.settings.show(target());
      case "config.set":
        return k.settings.set(target(), text("key"), args.value, us.id, true);
      case "config.unset":
        return k.settings.unset(target(), text("key"), us.id);
      case "config.effective":
        return k.settings.effective(us, target().name);
      case "auth.login": {
        assert(system, "only the system userspace may log people in", "unauthorized");
        const r = await k.auth.login(text("id"), text("password"));
        return r ? { token: r.token, user: { id: r.user.id, role: r.user.role } } : null;
      }
      case "auth.authenticate": {
        const user = k.auth.authenticate(text("token"));
        return user && (system || user.id === us.id) ? { id: user.id, role: user.role } : null;
      }
      case "auth.logout": {
        const user = k.auth.authenticate(text("token"));
        if (user && (system || user.id === us.id)) k.auth.logout(text("token"));
        return null;
      }
      default:
        throw new CodedError(`unknown kernel method: ${method}`, "rpc");
    }
  };
}
