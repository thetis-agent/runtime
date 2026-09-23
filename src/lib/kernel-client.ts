import { z } from "zod";
import type { KernelClient, KernelRpc } from "../contracts/index.js";
import { AssetRefSchema, AssetDownloadSchema, PackageInfoSchema, DeletedPackageSchema, SessionSummaryRefSchema, SessionRecordSchema, MessageSchema, TurnEventSchema, WatchedTurnEventSchema, ModelChoicesSchema, ProviderEventSchema, ConfigReportSchema, AuthUserSchema } from "../contracts/schemas/index.js";
import { parseSchema } from "./validation.js";

const VoidReplySchema = z.null().optional().transform(() => undefined);
const SessionInspectionSchema = SessionRecordSchema.extend({ status: z.enum(["idle", "running"]) });
const LoginReplySchema = z.object({ token: z.string(), user: AuthUserSchema }).nullable();

/** One client mapping for in-process hosts and fence RPC transports. */
export function kernelClient(transport: KernelRpc): KernelClient {
  const rpc = async <S extends z.ZodType>(method: string, schema: S, args?: unknown, onEvent?: (e: unknown) => void, signal?: AbortSignal): Promise<z.output<S>> =>
    parseSchema(schema, await transport(method, args, onEvent, signal), `${method} reply`, "rpc");
  return {
    assets: {
      put: (upload) => rpc("assets.put", AssetRefSchema, { upload }),
      read: (id) => rpc("assets.read", AssetDownloadSchema, { id }),
    },
    packages: {
      install: (source) => rpc("packages.install", PackageInfoSchema, { source }),
      uninstall: (name) => rpc("packages.uninstall", VoidReplySchema, { name }),
      delete: (name) => rpc("packages.delete", DeletedPackageSchema, { name }),
      unfork: (name, deleteFiles) => rpc("packages.unfork", PackageInfoSchema, { name, deleteFiles }),
      list: () => rpc("packages.list", z.array(PackageInfoSchema)),
    },
    operator: {
      call: (method, args, onEvent) => transport(`operator.${method}`, args ?? {}, onEvent),
    },
    sessions: {
      create: (parent) => rpc("sessions.create", SessionSummaryRefSchema, { parent }),
      complete: (session, input) => rpc("sessions.complete", MessageSchema, { session, input }),
      askText: (session, input) => rpc("sessions.askText", z.string(), { session, input }),
      ask: (session, input) => rpc("sessions.ask", z.string(), { session, input }),
      send: (session, input, onEvent, opts, signal) => rpc("sessions.send", VoidReplySchema, { session, input, model: opts?.model }, (e) => onEvent(parseSchema(TurnEventSchema, e, "sessions.send event", "rpc")), signal),
      cancel: (session) => rpc("sessions.cancel", z.boolean(), { session }),
      delete: (session) => rpc("sessions.delete", VoidReplySchema, { session }),
      list: () => rpc("sessions.list", z.array(SessionSummaryRefSchema)),
      inspect: (session) => rpc("sessions.inspect", SessionInspectionSchema, { session }),
      // Settles only when the fence closes: the pending call has no timer, so it may stay open for the life of this process.
      watch: (onEvent) => rpc("sessions.watch", VoidReplySchema, {}, (e) => onEvent(parseSchema(WatchedTurnEventSchema, e, "sessions.watch event", "rpc"))),
    },
    models: () => rpc("models", ModelChoicesSchema),
    providers: {
      call: (call, onEvent, signal) => rpc("providers.call", VoidReplySchema, { call }, (e) => onEvent(parseSchema(ProviderEventSchema, e, "providers.call event", "rpc")), signal),
    },
    config: {
      show: (name) => rpc("config.show", ConfigReportSchema, { name }),
      set: (name, key, value) => rpc("config.set", ConfigReportSchema, { name, key, value }),
      unset: (name, key) => rpc("config.unset", ConfigReportSchema, { name, key }),
      effective: (name) => rpc("config.effective", z.record(z.string(), z.unknown()), { name }),
    },
    auth: {
      login: (id, password) => rpc("auth.login", LoginReplySchema, { id, password }),
      authenticate: (token) => rpc("auth.authenticate", AuthUserSchema.nullable(), { token }),
      logout: (token) => rpc("auth.logout", VoidReplySchema, { token }),
    },
  };
}
