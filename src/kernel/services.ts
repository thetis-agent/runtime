import type { FenceHandle, Fences, PackageInfo, Userspace } from "../contracts/index.js";
import { errorMessage } from "../lib/error.js";
import type { Journal } from "../lib/journal.js";
import type { UserspaceLayout } from "../lib/userspace-layout.js";
import type { PackageManager } from "./packages/manager.js";
import type { Settings } from "./settings.js";
import type { UserStore } from "./users.js";

/**
 * Starts the services that installed packages declare, inside the fence of the userspace that holds them.
 * Armed by `boot()` only, so one-shot commands never start a gateway. A service lives as long as its fence:
 * the pool calls `opened` whenever a fence opens, which covers both boot and a restart after a crash.
 */
export class ServiceSupervisor {
  private enabled = false;
  /**
   * What a workspace is meant to be running and is not: by userspace, the services whose last start threw,
   * with the moment it did and what it said. Real state and not a declaration, which is the whole reason it
   * is kept here -- `status` used to list the installed packages that declare a service and call that the
   * running ones, so `@thetis/marketplace` failing to start at boot read as healthy for seventeen minutes
   * and the marketplace index went stale with nobody told. An entry goes the moment that service does start.
   */
  readonly notRunning = new Map<string, { name: string; since: string; error: string }[]>();

  constructor(
    private readonly settings: Settings,
    private readonly users: UserStore,
    private readonly userspaces: UserspaceLayout,
    private readonly packages: PackageManager,
    private readonly fences: Fences,
    private readonly log: (line: string) => void,
    private readonly journal: Journal,
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Arms the supervisor and starts every declared service, opening fences as needed. Every known person
   * gets a userspace here, seeded with the system packages, so their gateway runs before their first
   * visit. Starting twice is harmless: the agent keeps one instance per package.
   */
  async boot(): Promise<void> {
    this.enabled = true;
    for (const user of this.users.list()) {
      if (user.status !== "active") continue;
      await this.ensure(user.id);
    }
  }

  /** Makes sure a person's userspace exists, is seeded, and runs its services when the supervisor is armed. */
  async ensure(id: string): Promise<void> {
    const fresh = !this.userspaces.exists(id);
    const us = this.userspaces.ensure(id);
    if (fresh || this.packages.installed(us).length === 0) this.packages.seedSystem(us);
    if (this.enabled && this.packages.installed(us).some((p) => p.thetis.service)) await this.opened(us, await this.fences.handle(us));
  }

  /**
   * Puts the code on disk into service: the fence closes and `ensure` opens it again. A service needs a
   * whole new process, because its module graph is read once when its agent starts, and the `?v=<mtime>`
   * the agent imports with versions only a package's entry module.
   */
  async reload(id: string): Promise<void> {
    await this.fences.close(id);
    await this.ensure(id);
  }

  /**
   * A service starts over with its configuration as it is now, in the fence it already runs in. Its
   * configuration is read once when it starts, so a change reaches it no other way. The fence stays:
   * the person's other services, gateway and shell sessions are not the ones that changed.
   */
  async restart(id: string, name: string): Promise<void> {
    if (!this.enabled || !this.userspaces.exists(id)) return;
    const us = this.userspaces.pathFor(id);
    const pkg = this.packages.installed(us).find((p) => p.name === name);
    if (!pkg?.thetis.service) return;
    await this.uninstalled(us, pkg);
    await this.start(us, pkg);
  }

  /** Fence hook: starts every service of the userspace on the handle that just opened. */
  async opened(us: Userspace, handle: FenceHandle): Promise<void> {
    if (!this.enabled) return;
    for (const pkg of this.packages.installed(us)) if (pkg.thetis.service) await this.start(us, pkg, handle);
  }

  /** Package hook: a service package installed while the supervisor runs starts at once. */
  async installed(us: Userspace, pkg: PackageInfo): Promise<void> {
    if (this.enabled && pkg.thetis.service) await this.start(us, pkg);
  }

  /** Package hook: an uninstalled service stops before its link disappears. */
  async uninstalled(us: Userspace, pkg: PackageInfo): Promise<void> {
    if (!this.enabled || !pkg.thetis.service) return;
    await this.fences.request(us, "service.stop", { package: pkg.name }).catch((err: unknown) => {
      this.log(`[services] ${pkg.name} in ${us.id} did not stop: ${errorMessage(err)}`);
    });
    this.journal.append({ kind: "service.stop", target: us.id, data: { package: pkg.name } });
  }

  private async start(us: Userspace, pkg: PackageInfo, handle?: FenceHandle): Promise<void> {
    const service = pkg.thetis.service;
    if (!service) return;
    const payload = { package: pkg.name, export: service.export, config: await this.settings.effective(us, pkg.name) };
    try {
      const result = await (handle ? handle.request("service.start", payload) : this.fences.request(us, "service.start", payload));
      this.notRunning.set(us.id, (this.notRunning.get(us.id) ?? []).filter((d) => d.name !== pkg.name));
      if (result === "started") {
        this.log(`[services] started ${pkg.name} in ${us.id}`);
        this.journal.append({ kind: "service.start", target: us.id, data: { package: pkg.name } });
      }
    } catch (err) {
      // Remembered, not only logged and journalled: a line that scrolled past at boot is not a way for
      // anyone to find out that their gateway or their marketplace is dead right now.
      this.notRunning.set(us.id, [...(this.notRunning.get(us.id) ?? []).filter((d) => d.name !== pkg.name), { name: pkg.name, since: new Date().toISOString(), error: errorMessage(err) }]);
      this.log(`[services] ${pkg.name} in ${us.id} failed to start: ${errorMessage(err)}`);
      this.journal.append({ kind: "service.fail", target: us.id, data: { package: pkg.name, error: errorMessage(err) } });
    }
  }
}
