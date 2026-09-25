import { linkDir } from "../lib/pkg-fs.js";
import { FileAssetStore } from "../lib/assets.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_USER, type AssetStore, type Fence, type Fences, type HostEnv, type KernelRpc, type StoreDriver, type Userspace } from "../contracts/index.js";
import {
  AssetAccess, AuthService, ConfigService, createControlHandler, createRpcHandler, Enumerator, PackageManager, PackageRegistry, PipelineRunner,
  ProviderRegistry, ServiceSupervisor, SessionApi, SESSION_ID, UserStore, type HostExtensions, type KernelConfig, type KernelServices,
} from "../kernel/index.js";
import { EnvFile, LayeredConfig, type EnvSource } from "../lib/config.js";
import { Container, token } from "../lib/container.js";
import { Journal } from "../lib/journal.js";
import { SessionStore } from "../lib/session-store.js";
import { MountStore } from "../lib/mounts.js";
import { SshStore } from "../lib/ssh.js";
import { RestartLatch } from "../lib/restart.js";
import { storeId } from "../lib/store.js";
import { UserspaceLayout } from "../lib/userspace-layout.js";
import { Cgroups, FencePool, ProcessFence } from "../sandbox/index.js";
import { HostPackages } from "./host-packages.js";
import { assertMigrated } from "./migrate.js";
import { deployedRestartPolicy } from "./policy.js";
import { flushRecords, loadStoreDriver, openRecords, type Records } from "./store.js";

/** Tokens for every service. Bind a different factory to replace a component. */
export const T = {
  config: token<KernelConfig>("config"),
  log: token<(line: string) => void>("log"),
  /** The storage driver. Unbound until `createKernel` loads the configured package; a test binds `memoryStore()` instead. */
  store: token<StoreDriver>("store"),
  assetStore: token<AssetStore>("assetStore"),
  assets: token<AssetAccess>("assets"),
  /** The host packages, loaded per call by name; a test binds a fake `call`. */
  hosts: token<HostExtensions>("hosts"),
  records: token<Records>("records"),
  env: token<EnvSource>("env"),
  settings: token<ConfigService>("settings"),
  users: token<UserStore>("users"),
  auth: token<AuthService>("auth"),
  services: token<ServiceSupervisor>("services"),
  userspaces: token<UserspaceLayout>("userspaces"),
  mounts: token<MountStore>("mounts"),
  ssh: token<SshStore>("ssh"),
  fence: token<Fence>("fence"),
  fences: token<Fences>("fences"),
  registry: token<PackageRegistry>("registry"),
  packages: token<PackageManager>("packages"),
  providers: token<ProviderRegistry>("providers"),
  sessionStore: token<SessionStore>("sessionStore"),
  enumerator: token<Enumerator>("enumerator"),
  runner: token<PipelineRunner>("runner"),
  sessions: token<SessionApi>("sessions"),
  journal: token<Journal>("journal"),
  restart: token<RestartLatch>("restart"),
  cgroups: token<Cgroups | undefined>("cgroups"),
};

export interface Kernel extends KernelServices {
  /** The container, for tests and tools that look inside. */
  container: Container;
}

/**
 * Composition root. `configure` may rebind any token before services are resolved. The store is the one
 * token resolved here rather than lazily: loading the driver is an import and opening the records is a read
 * of every document, and both are asynchronous, which is why building a kernel is.
 */
export async function createKernel(config: KernelConfig, configure?: (c: Container) => void): Promise<Kernel> {
  assertMigrated(config.home);
  mkdirSync(config.home, { recursive: true });
  const c = new Container();
  bindServices(c, config);
  configure?.(c);
  if (!c.has(T.store)) {
    const driver = await loadStoreDriver(config, c.get(T.log));
    c.bind(T.store, () => driver);
  }
  const records = await openRecords(c.get(T.store));
  c.bind(T.records, () => records);
  const kernel = kernelOf(c);
  kernel.packages.observe(kernel.services);
  // What a package kept in the store and in a person's configuration layer goes with the package's files;
  // what the system layer held for a package follows its promoted copy.
  kernel.packages.observe({
    deleted: async (us, name) => {
      await kernel.settings.forgetPackage(us.id, name);
      await kernel.store.open(storeId("userspaces", us.id, name)).clear();
    },
    promoted: (from, to) => kernel.settings.copySystem(from, to),
  });
  // A changed key reaches a provider on its next call and a step or tool on its next run; a service read
  // its configuration when it started, so it starts again. The model list is forgotten with it: a provider
  // may serve different models under a different key.
  kernel.settings.onChange(async ({ affected }) => {
    for (const { user, package: name } of affected) {
      kernel.providers.forget(user);
      await kernel.services.restart(user, name);
    }
  });
  mkdirSync(config.promotedPackagesDir, { recursive: true });
  mkdirSync(config.sharedDir, { recursive: true });
  kernel.sessions.userspaceFor(kernel.users.authorize(SYSTEM_USER));
  return { ...kernel, container: c };
}

function bindServices(c: Container, config: KernelConfig): void {
  c.bind(T.config, () => config);
  c.bind(T.assetStore, (c) => new FileAssetStore(resolve(c.get(T.config).home, "assets")));
  c.bind(T.assets, (c) => new AssetAccess(c.get(T.assetStore)));
  c.bind(T.log, () => (line: string) => process.stderr.write(line + "\n"));
  c.bind(T.users, (c) => new UserStore(c.get(T.records).users));
  c.bind(T.auth, (c) => new AuthService(c.get(T.records).credentials, c.get(T.records).tokens, c.get(T.users)));
  c.bind(T.mounts, (c) => new MountStore(c.get(T.records).mounts));
  c.bind(T.ssh, (c) => new SshStore(c.get(T.records).ssh));
  // Every Userspace the layout hands out carries its mounts and its ssh grants, so a fence binds them and
  // loads them wherever it is opened from.
  c.bind(T.userspaces, (c) => new UserspaceLayout(c.get(T.config).home, (id) => c.get(T.mounts).get(id), (id) => c.get(T.ssh).get(id),
    (us) => linkDir(resolve(us.root, "node_modules/@thetis/runtime"), c.get(T.config).projectRoot, us.root),
  ));
  c.bind(T.journal, (c) => new Journal(c.get(T.config).home));
  c.bind(T.env, (c) => new EnvFile(c.get(T.config).envFile));
  // The file layer lives in the service, which `config.reload` replaces; the layers read it from there.
  c.bind(T.settings, (c) => {
    const settings: ConfigService = new ConfigService(
      c.get(T.config).packages,
      new LayeredConfig(c.get(T.store), () => settings.filePackages),
      c.get(T.env), c.get(T.packages), c.get(T.registry), c.get(T.userspaces), c.get(T.journal),
    );
    return settings;
  });
  c.bind(T.cgroups, (c) => (c.get(T.config).fence.sandbox === "none" ? undefined : Cgroups.detect(c.get(T.log))));
  c.bind(T.fence, (c) => processFence(c));
  // The last reader is what makes a shipped package's version bump visible: the pool stamps each fence it
  // opens with the versions installed at that moment, and the kernel's lists say which of them the code on
  // disk has since left behind.
  c.bind(T.fences, (c) => new FencePool(
    c.get(T.fence), (us) => rpcFor(c, us), (us, h) => c.get(T.services).opened(us, h), (us) => c.get(T.userspaces).pathFor(us.id),
    (us) => Object.fromEntries(c.get(T.packages).installed(us).map((p) => [p.name, p.version])),
  ));
  c.bind(T.services, (c) => {
    return new ServiceSupervisor(c.get(T.settings), c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.fences), c.get(T.log), c.get(T.journal));
  });
  c.bind(T.registry, (c) => new PackageRegistry(c.get(T.records).registry));
  c.bind(T.packages, (c) => new PackageManager(c.get(T.config), c.get(T.registry), c.get(T.fences), () => c.get(T.userspaces).pathFor(SYSTEM_USER)));
  c.bind(T.providers, (c) => new ProviderRegistry(c.get(T.settings), c.get(T.packages), c.get(T.userspaces), c.get(T.fences)));
  c.bind(T.sessionStore, () => new SessionStore(SESSION_ID));
  c.bind(T.enumerator, (c) => new Enumerator(c.get(T.config), c.get(T.fences)));
  c.bind(T.runner, (c) => {
    return new PipelineRunner(c.get(T.config), c.get(T.settings), c.get(T.enumerator), c.get(T.packages), c.get(T.fences), c.get(T.sessionStore), c.get(T.journal));
  });
  c.bind(T.sessions, (c) => new SessionApi(c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.sessionStore), c.get(T.runner)));
  // Armed here, fired nowhere: only `serve()` registers a handler, and the latch refuses to arm without one,
  // so a kernel built by `thetis send`, `thetis chat` or the bench cannot be talked into killing its command.
  // The deployed policy is a host fact and is read here, in the daemon: a tool inside a fence sees neither the
  // cgroup it is in nor systemd, and would have to take the unit file in the checkout on trust.
  c.bind(T.restart, (c) => new RestartLatch({ config: c.get(T.config).control, inFlight: () => c.get(T.sessions).inFlight(), policy: deployedRestartPolicy }));
  c.bind(T.hosts, (c) => new HostPackages(c.get(T.config), hostEnv(c), c.get(T.log)));
}

/**
 * What a host package's method receives besides its arguments: the service-plane home, the people, the
 * grant records the fence reads when it opens, the journal, and a fence reload -- the same pair `fence.reload`
 * runs, so a changed grant reaches the fence and a provider that read a key is asked again.
 */
function hostEnv(c: Container): HostEnv {
  return {
    home: c.get(T.config).home,
    root: c.get(T.config).projectRoot,
    users: { get: (id) => c.get(T.users).get(id), list: () => c.get(T.users).list() },
    records: { mounts: c.get(T.mounts), ssh: c.get(T.ssh) },
    journal: (row) => c.get(T.journal).append({ kind: row.kind, actor: row.actor ?? "operator", target: row.target, data: row.data }),
    reloadFence: async (user) => {
      c.get(T.providers).forget(user);
      await c.get(T.services).reload(user);
    },
    log: c.get(T.log),
  };
}

/** The process fence, configured from `config.fence`. The resolver file lives next to the rest of the data. */
function processFence(c: Container): ProcessFence {
  const cfg = c.get(T.config);
  return new ProcessFence({
    agentPath: cfg.agentPath,
    // The configuration object itself, not a copy of its values: `config.reload` writes the file layer
    // into it in place, so the next fence to open is built from the new settings with nothing else to
    // wire. `CONFIG_TIERS` in `src/kernel/config.ts` says which keys that reaches.
    fence: cfg.fence,
    sharedDir: cfg.sharedDir,
    resolvConf: resolve(cfg.home, "fence-resolv.conf"),
    sshDir: resolve(cfg.home, "fence-ssh"),
    cgroups: () => c.get(T.cgroups),
    requestTimeoutMs: () => cfg.requestTimeoutMs,
    log: c.get(T.log),
  });
}

/**
 * The kernel as one fence sees it. The services are resolved when the fence opens, not when the pool is
 * built, which breaks the cycle between the pool and the session API. The operator table is admitted to
 * an admin's fence by the RPC handler; the kernel checks the role.
 */
function rpcFor(c: Container, us: Userspace): KernelRpc {
  const k = kernelOf(c);
  const models = async (space: Userspace) => ({ model: c.get(T.config).model, models: await c.get(T.providers).listModels(space) });
  return createRpcHandler(us, k, createControlHandler(k), models);
}

/** Every service of one container, as the kernel interface. Resolving them here is what boots the kernel. */
function kernelOf(c: Container): KernelServices {
  return {
    config: c.get(T.config),
    users: c.get(T.users),
    auth: c.get(T.auth),
    services: c.get(T.services),
    userspaces: c.get(T.userspaces),
    mounts: c.get(T.mounts),
    ssh: c.get(T.ssh),
    packages: c.get(T.packages),
    registry: c.get(T.registry),
    providers: c.get(T.providers),
    sessions: c.get(T.sessions),
    settings: c.get(T.settings),
    store: c.get(T.store),
    assets: c.get(T.assets),
    hosts: c.get(T.hosts),
    fences: c.get(T.fences),
    journal: c.get(T.journal),
    restart: c.get(T.restart),
    restartPolicy: deployedRestartPolicy,
    async removeUser(id) {
      c.get(T.users).remove(id);
      // Before anything else that is keyed by the id, because the id can come back: `users add qa` after a
      // `users remove qa` is a new account to everyone who sees it, and it must not inherit the password or
      // the live sessions of the person who had that id before. `remove` above threw if there was no user,
      // so a mistyped id never reaches this and never costs anyone their password.
      c.get(T.auth).forget(id);
      await c.get(T.fences).close(id);
      c.get(T.registry).forgetUserspace(id);
      c.get(T.mounts).set(id, []);
      c.get(T.ssh).set(id, []);
      await c.get(T.settings).forgetUser(id);
      await c.get(T.store).open(storeId("userspaces", id)).clear();
      await c.get(T.assets).forget(id);
      c.get(T.userspaces).remove(id);
      // The two directories the service plane keeps per person outside any store namespace: the ssh files
      // `ProcessFence` writes for the fence (`fence-ssh/<id>`), and the private keys the host holds for them
      // (`fence-keys/<id>`, written by `ssh.keygen` and `ssh.import` in @thetis/host-grants). The grants
      // above are gone, so nothing loads these again -- but they are key material, and `ssh.keygen` keeps
      // an existing key rather than replacing it, so a re-added id would be handed the previous person's
      // private key and told it is their own. The id is a validated user id: `users.remove` above proved
      // there was a record, and a record only exists for an id that matched `USER_ID`.
      for (const dir of ["fence-ssh", "fence-keys"]) rmSync(resolve(c.get(T.config).home, dir, id), { recursive: true, force: true });
      // The model list this process cached for the userspace, which would otherwise be served to whoever
      // is given the id next, for as long as it stays warm.
      c.get(T.providers).forget(id);
    },
    async shutdown() {
      await c.get(T.fences).close();
      await flushRecords(c.get(T.records));
      await c.get(T.store).close?.();
    },
  };
}
