import type { KernelClient, KernelRpc, ProviderEvent, TurnEvent, WatchedTurnEvent } from "../contracts/index.js";

/** One client mapping for in-process hosts and fence RPC transports. */
export function kernelClient(transport: KernelRpc): KernelClient {
  const rpc = <T>(method: string, args?: unknown, onEvent?: (e: unknown) => void, signal?: AbortSignal) => transport(method, args, onEvent, signal) as Promise<T>;
  return {
    assets: {
      put: (upload) => rpc("assets.put", { upload }),
      read: (id) => rpc("assets.read", { id }),
    },
    packages: {
      install: (source) => rpc("packages.install", { source }),
      uninstall: (name) => rpc("packages.uninstall", { name }),
      delete: (name) => rpc("packages.delete", { name }),
      unfork: (name, deleteFiles) => rpc("packages.unfork", { name, deleteFiles }),
      list: () => rpc("packages.list"),
    },
    operator: {
      call: (method, args, onEvent) => rpc(`operator.${method}`, args ?? {}, onEvent),
    },
    sessions: {
      create: (parent) => rpc("sessions.create", { parent }),
      complete: (session, input) => rpc("sessions.complete", { session, input }),
      askText: (session, input) => rpc("sessions.askText", { session, input }),
      ask: (session, input) => rpc("sessions.ask", { session, input }),
      send: (session, input, onEvent, opts, signal) => rpc("sessions.send", { session, input, model: opts?.model }, (e) => onEvent(e as TurnEvent), signal),
      cancel: (session) => rpc("sessions.cancel", { session }),
      delete: (session) => rpc("sessions.delete", { session }),
      list: () => rpc("sessions.list"),
      inspect: (session) => rpc("sessions.inspect", { session }),
      // Settles only when the fence closes: the pending call has no timer, so it may stay open for the life of this process.
      watch: (onEvent) => rpc("sessions.watch", {}, (e) => onEvent(e as WatchedTurnEvent)),
    },
    models: () => rpc("models"),
    providers: {
      call: (call, onEvent, signal) => rpc("providers.call", { call }, (e) => onEvent(e as ProviderEvent), signal),
    },
    config: {
      show: (name) => rpc("config.show", { name }),
      set: (name, key, value) => rpc("config.set", { name, key, value }),
      unset: (name, key) => rpc("config.unset", { name, key }),
      effective: (name) => rpc("config.effective", { name }),
    },
    auth: {
      login: (id, password) => rpc("auth.login", { id, password }),
      authenticate: (token) => rpc("auth.authenticate", { token }),
      logout: (token) => rpc("auth.logout", { token }),
    },
  };
}
