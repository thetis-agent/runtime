import { SYSTEM_USER, type Fences, type ModelDescriptor, type PackageInfo, type ProviderCall, type ProviderEvent, type Userspace } from "../contracts/index.js";
import { CodedError } from "../lib/error.js";
import type { UserspaceLayout } from "../lib/userspace-layout.js";
import type { PackageManager } from "./packages/manager.js";
import type { Settings } from "./settings.js";

export interface ResolvedProvider {
  userspace: Userspace;
  pkg: PackageInfo;
}

const MODELS_TTL_MS = 5 * 60_000;

/**
 * Aggregates what every installed provider advertises and routes a call to the userspace
 * the provider runs in: the caller's own fence for user providers, the system fence otherwise.
 */
export class ProviderRegistry {
  private readonly models = new Map<string, { at: number; list: ModelDescriptor[] }>();

  constructor(
    private readonly settings: Settings,
    private readonly packages: PackageManager,
    private readonly userspaces: UserspaceLayout,
    private readonly fences: Fences,
  ) {}

  /** Providers visible to a userspace: its own first, then the system userspace's. */
  candidates(us: Userspace): ResolvedProvider[] {
    const spaces = us.id === SYSTEM_USER ? [us] : [us, this.userspaces.pathFor(SYSTEM_USER)];
    const seen = new Set<string>();
    const out: ResolvedProvider[] = [];
    for (const space of spaces) {
      if (!this.userspaces.exists(space.id)) continue;
      for (const pkg of this.packages.installed(space)) {
        if (pkg.type === "provider" && !seen.has(pkg.name)) {
          seen.add(pkg.name);
          out.push({ userspace: space, pkg });
        }
      }
    }
    return out;
  }

  async listModels(us: Userspace): Promise<ModelDescriptor[]> {
    const all: ModelDescriptor[] = [];
    for (const p of this.candidates(us)) all.push(...(await this.modelsOf(p)).map((m) => ({ ...m, provider: p.pkg.name })));
    return all;
  }

  async resolve(us: Userspace, model: string): Promise<ResolvedProvider> {
    const candidates = this.candidates(us);
    if (candidates.length === 0) throw new CodedError("no provider package is installed", "provider");
    for (const p of candidates) if ((await this.modelsOf(p)).some((m) => m.id === model)) return p;
    for (const p of candidates) if ((await this.modelsOf(p)).some((m) => m.id === "*")) return p;
    throw new CodedError(`no installed provider serves model "${model}"`, "provider");
  }

  async call(p: ResolvedProvider, call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal, assetGrant?: string): Promise<void> {
    await this.fences.request(p.userspace, "provider.call", await this.payload(p, { call, assetGrant }), (e) => onEvent(e as ProviderEvent), signal);
  }

  /**
   * Drops what a userspace's providers advertised. The cache lives in this process, so it outlives the
   * fence it describes: without this, a reloaded provider keeps serving the model list of the code it
   * replaced. A user id holds no colon, so the prefix is the key's first field.
   */
  forget(id: string): void {
    for (const key of this.models.keys()) if (key.startsWith(`${id}:`)) this.models.delete(key);
  }

  private async modelsOf(p: ResolvedProvider): Promise<ModelDescriptor[]> {
    const key = `${p.userspace.id}:${p.pkg.name}`;
    const cached = this.models.get(key);
    if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.list;
    const raw = await this.fences.request(p.userspace, "provider.models", await this.payload(p, {}));
    const entry = { at: Date.now(), list: Array.isArray(raw) ? (raw as ModelDescriptor[]) : [] };
    this.models.set(key, entry);
    return entry.list;
  }

  /** The configuration is read for every call, so a changed key reaches the provider with no restart. */
  private async payload(p: ResolvedProvider, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { package: p.pkg.name, export: p.pkg.thetis.export ?? "createProvider", config: await this.settings.effective(p.userspace, p.pkg.name), ...extra };
  }
}
