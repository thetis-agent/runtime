// Public library entry point. Importing it starts no daemon, server, or userspace.
export * from "./host/index.js";
export { Container, token, type Token, type Factory } from "./lib/container.js";
export type { Fence, Fences, FenceHandle, StoreDriver, KernelRpc, TurnEvent } from "./contracts/index.js";
