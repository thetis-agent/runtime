// The environment a package's code receives, scoped to that package. The agent holds one base `StepEnv`
// for the fence; storage is the one field that must know which package runs, because the kernel keys a
// package's documents by its name. This seam exists so the scoping can be tested without booting the agent.
import type { StepEnv, Store } from "../contracts/index.js";

/** A call to the kernel, as the agent's `rpc` makes it: events stream to `onEvent`, and an aborted `signal` cancels it. */
export type Rpc = <T = unknown>(method: string, args?: unknown, onEvent?: (e: unknown) => void, signal?: AbortSignal) => Promise<T>;

/** The five store methods as `store.*` calls, each naming the package so the kernel can prefix the namespace. */
export function storageClient(rpc: Rpc, pkg: string, namespace?: string): Store {
  const scope = { package: pkg, namespace };
  return {
    // The wire has no `undefined`; the kernel answers `null` for a missing document.
    get: async <T extends object>(key: string) => (await rpc<T | null>("store.get", { ...scope, key })) ?? undefined,
    set: (key, doc) => rpc("store.set", { ...scope, key, doc }),
    delete: (key) => rpc("store.delete", { ...scope, key }),
    list: (prefix) => rpc<string[]>("store.list", { ...scope, prefix }),
    clear: () => rpc("store.clear", scope),
  };
}

/** What the base env answers: a stray use of storage outside package code fails loudly rather than reaching nothing. */
export function noStorage(): never {
  throw new Error("storage() needs the package that runs; use the env a step, tool or service receives");
}

/** The base env with storage bound to `pkg`. */
export function buildEnvFor(base: StepEnv, rpc: Rpc, pkg: string): StepEnv {
  return { ...base, storage: (namespace) => storageClient(rpc, pkg, namespace) };
}
