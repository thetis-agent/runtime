import type { AssetAccess } from "./assets.js";
import type { Fences, StoreDriver } from "../contracts/index.js";
import type { Journal } from "../lib/journal.js";
import type { MountStore } from "../lib/mounts.js";
import type { SshStore } from "../lib/ssh.js";
import type { RestartLatch } from "../lib/restart.js";
import type { UserspaceLayout } from "../lib/userspace-layout.js";
import type { AuthService } from "./auth.js";
import type { KernelConfig } from "./config.js";
import type { PackageManager } from "./packages/manager.js";
import type { PackageRegistry } from "./packages/registry.js";
import type { ProviderRegistry } from "./providers.js";
import type { ServiceSupervisor } from "./services.js";
import type { SessionApi } from "./sessions/api.js";
import type { ConfigService } from "./settings.js";
import type { UserStore } from "./users.js";

/**
 * The host packages, as the operator table reaches them: `host.<name>.<export>` dispatches here after the
 * kernel has checked the caller and journalled the call. The host process binds it, like `store`; the
 * kernel knows no package by name.
 */
export interface HostExtensions {
  call(name: string, method: string, args: Record<string, unknown>): Promise<unknown>;
  /** The exports a person may call about themselves, as the package's manifest declares them (`thetis.host.self`); none when it declares none. */
  selfExports(name: string): string[];
}

/** One running kernel. The host constructs it; the kernel does not depend on its composition root. */
export interface KernelServices {
  config: KernelConfig;
  users: UserStore;
  auth: AuthService;
  services: ServiceSupervisor;
  userspaces: UserspaceLayout;
  /** The host paths an admin has granted into each person's fence. */
  mounts: MountStore;
  ssh: SshStore;
  packages: PackageManager;
  registry: PackageRegistry;
  providers: ProviderRegistry;
  sessions: SessionApi;
  /** Per-package configuration: the layers, who may set what, and what a package's code receives. */
  settings: ConfigService;
  /** The service plane's document store. The kernel holds the driver's interface only; the host loaded it. */
  store: StoreDriver;
  assets: AssetAccess;
  /** The host packages. The kernel holds the interface only; the host loads each one by name. */
  hosts: HostExtensions;
  fences: Fences;
  journal: Journal;
  /** The latch behind a restart Thetis can ask for. Arming is not restarting: only the serving daemon acts on it. */
  restart: RestartLatch;
  /** What the deployed systemd unit says a clean exit means, or null when that could not be read. A host fact, injected. */
  restartPolicy(): string | null;
  /** Removes the user: its password and sessions, its fence, its packages, its grants, its settings and its userspace. */
  removeUser(id: string): Promise<void>;
  /** Closes every fence, writes out every record, and closes the store. */
  shutdown(): Promise<void>;
}
