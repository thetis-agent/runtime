// The kernel's public surface. Authority only: who may do what. The vocabulary is in @thetis/runtime/contracts,
// the mechanism in @thetis/runtime/lib and @thetis/runtime/sandbox, and the wiring in @thetis/runtime.
export { CodedError as KernelError } from "../lib/error.js";
export { defaultConfig, loadConfig, saveConfig, configPath, packagesLayer, type KernelConfig } from "./config.js";
export { UserStore } from "./users.js";
export { AuthService, type Credential, type TokenRecord } from "./auth.js";
export { ServiceSupervisor } from "./services.js";
export { ConfigService, type Affected, type ConfigChange, type ConfigTarget, type Settings } from "./settings.js";
export { createRpcHandler, type RpcServices } from "./rpc.js";
export { createControlHandler, redact, reloadWorkspace } from "./control.js";
export { PackageRegistry } from "./packages/registry.js";
export { PackageManager, type PackageListener } from "./packages/manager.js";
export { readManifest, validateManifest } from "./packages/manifest.js";
export { ProviderRegistry, type ResolvedProvider } from "./providers.js";
export { SessionApi, SESSION_ID, type SessionRef, type TurnInput } from "./sessions/api.js";
export { Enumerator } from "./pipeline/enumerator.js";
export { PipelineRunner } from "./pipeline/runner.js";
export type { HostExtensions, KernelServices } from "./kernel.js";
export { AssetAccess } from "./assets.js";
