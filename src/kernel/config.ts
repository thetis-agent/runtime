import { relative, resolve } from "node:path";
import type { StepRef } from "../contracts/index.js";
import type { ConfigTier } from "../lib/config-tiers.js";
import { readJson, writeJson } from "../lib/json.js";

export interface FenceConfig {
  sandbox: "auto" | "bwrap" | "none";
  network: "auto" | "egress" | "none" | "host";
  /** Per-fence resource limits. `memoryMb: "auto"` is no memory ceiling at all, and is the default. */
  limits: { memoryMb: number | "auto"; pids: number; cpuPercent: number };
  /** Host paths every fence may read besides the OS. */
  readOnly: string[];
  /** Host paths masked inside every fence. */
  hidden: string[];
  /**
   * Whether every fence is given the host's Docker socket. `auto` binds one when the kernel can use it,
   * `on` binds it whether or not the probe passes, `off` never does. Socket access is host root: see
   * `src/sandbox/docker.ts`, which says what socket access gives away.
   */
  docker: "auto" | "on" | "off";
  /** The host Docker socket to bind, when it is not in one of the usual places. */
  dockerSocket?: string;
}

export interface KernelConfig {
  /** Service-plane data directory: users, registry, userspaces. */
  home: string;
  /** The checkout the derived paths below are resolved against. Derived, never written to the file, and the
   * second thing `config.reload` needs in order to read the file again the way it was first read. */
  projectRoot: string;
  /** Where the shipped @thetis/* packages live. */
  systemPackagesDir: string;
  /** Where promoted packages live: user packages made the default for everyone. Derived: `<home>/packages`. */
  promotedPackagesDir: string;
  /** Writable by the system userspace, read-only in every other fence. Derived: `<home>/shared`. */
  sharedDir: string;
  /** Path of the userspace agent entry the fence boots. */
  agentPath: string;
  model: string;
  /** The phases the enumerator walks, in order. `call` shapes the request; `execute` is where a harness's step sends it. */
  phases: string[];
  enumerator?: StepRef;
  /** System packages installed into userspaces: "*" applies to every userspace, a user id to that one. */
  systemPackages: Record<string, string[]>;
  /**
   * The file layer of per-package configuration. `${VAR}` references stay as written; the config service
   * resolves them at read time. Empty by default: a package's own defaults are in its manifest, never here.
   */
  packages: Record<string, Record<string, unknown>>;
  /** The storage driver: a package of type `storage`, loaded by the host, never installed into a fence. */
  storage: { driver: string };
  /** The `.env` file whose variables `${VAR}` references resolve against. Derived: `<projectRoot>/.env`. */
  envFile: string;
  fence: FenceConfig;
  /** The door: the one host port, which routes to the login target and to each person's gateway socket. */
  door: { host: string; port: number };
  /** The restart Thetis may ask for: whether this installation allows one at all, and the two clocks that make it safe. */
  control: { allowRestart: boolean; minUptimeSecs: number; quietWaitMs: number };
  requestTimeoutMs: number;
}

/** The file layer as it is on disk now: exactly what `thetis.config.json` says. `config.reload` reads it again. */
export function packagesLayer(home: string): Record<string, Record<string, unknown>> {
  return readJson<Partial<KernelConfig>>(configPath(home), {}).packages ?? {};
}

export function defaultConfig(home: string, projectRoot: string): KernelConfig {
  return {
    home,
    projectRoot,
    systemPackagesDir: resolve(projectRoot, "packages"),
    promotedPackagesDir: resolve(home, "packages"),
    sharedDir: resolve(home, "shared"),
    agentPath: resolve(projectRoot, "dist/src/userspace-agent/agent.js"),
    model: "anthropic/claude-sonnet-5",
    phases: ["history", "prompt", "tools", "call", "execute", "after"],
    systemPackages: {
      "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/tools-files", "@thetis/tools-plan", "@thetis/terminal", "@thetis/gateway-web", "@thetis/ui-tools", "@thetis/ui-context", "@thetis/projects", "@thetis/ui-admin", "@thetis/ui-marketplace", "@thetis/skills", "@thetis/skills-thetis", "@thetis/skills-hybrid", "@thetis/tool-groups", "@thetis/ui-skills"],
      _system: ["@thetis/provider-openrouter", "@thetis/gateway-login", "@thetis/marketplace"],
    },
    packages: {},
    storage: { driver: "@thetis/store-toml" },
    envFile: resolve(projectRoot, ".env"),
    fence: {
      sandbox: "auto",
      network: "auto",
      limits: { memoryMb: "auto", pids: 512, cpuPercent: 200 },
      readOnly: [resolve(projectRoot, "dist/src"), resolve(projectRoot, "package.json"), resolve(projectRoot, "packages"), resolve(projectRoot, "node_modules"), resolve(home, "packages")],
      hidden: [home],
      docker: "auto",
    },
    door: { host: "127.0.0.1", port: 8777 },
    control: { allowRestart: true, minUptimeSecs: 60, quietWaitMs: 120_000 },
    requestTimeoutMs: 600_000,
  };
}

/**
 * What it takes to put a change to each key into service.
 *
 * The tier is a property of how the key's consumer reads it, not of what the key is about. `model` is read
 * by the runner on every turn and `phases` by the enumerator on every enumerate, so writing the new value
 * into the held configuration is the whole of it. `fence.*` is read by `ProcessFence` on every open, so
 * closing the fences is the whole of it. `door` is a bound socket and `storage` a driver instantiated at
 * boot; those want a new process and there is no cheaper honest answer.
 *
 * A key with no declaration is treated as `boot`, which is why the derived paths are not listed: they come
 * from `projectRoot` at load time, never from the file, and are never reported as changed. Adding a key
 * here is how it becomes live; forgetting to is how it stays safe.
 */
export const CONFIG_TIERS: Record<string, ConfigTier> = {
  model: "dispatch",
  phases: "dispatch",
  enumerator: "dispatch",
  systemPackages: "dispatch",
  packages: "dispatch",
  // The latch reads `config.control` through the held object on every use, so writing into it in place reaches it.
  control: "dispatch",
  fence: "fence",
  // Read once into a listening socket, and once into a storage driver the whole kernel is built on.
  door: "boot",
  storage: "boot",
  // Read when a fence opens and held by that `ProcessHandle` for its life, so the fences have to be closed
  // for a new value to be in force -- which is exactly what the `fence` tier does.
  requestTimeoutMs: "fence",
};

export function configPath(home: string): string {
  return resolve(home, "thetis.config.json");
}

/**
 * Loads config from disk over the defaults, interpolating ${ENV_VAR} references from the environment.
 * `packages` is the exception: it keeps its references, because the config service resolves them on
 * every read, so a variable that arrives later is seen without a restart; and it has no defaults to sit
 * over, because a package's defaults are its manifest's.
 */
export function loadConfig(home: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const defaults = defaultConfig(home, projectRoot);
  const stored = readJson<Partial<KernelConfig>>(configPath(home), {});
  const { packages, ...rest } = stored;
  const merged: KernelConfig = {
    ...defaults,
    ...rest,
    home,
    projectRoot: defaults.projectRoot,
    // The one derived path a data directory may override, because it decides which secrets the whole
    // installation runs on. The default is the checkout's `.env`, which is where `deploy/install.sh` puts
    // the provider key and what every ordinary installation wants. A second data directory under the same
    // checkout inherits that key without being told, which is how a throwaway daemon for a test came to
    // spend real money on a real account; such a home sets `envFile` to opt out. A relative value is
    // resolved against the home, so the file stays valid when the checkout moves.
    envFile: stored.envFile ? resolve(home, stored.envFile) : defaults.envFile,
    storage: { ...defaults.storage, ...(stored.storage ?? {}) },
    fence: {
      ...defaults.fence,
      ...(stored.fence ?? {}),
      limits: { ...defaults.fence.limits, ...(stored.fence?.limits ?? {}) },
    },
    door: { ...defaults.door, ...(stored.door ?? {}) },
    control: { ...defaults.control, ...(stored.control ?? {}) },
  };
  return { ...interpolate(merged, env), packages: packages ?? {} };
}

/** Writes the config without derived paths, so the file stays valid when the checkout moves. */
export function saveConfig(config: KernelConfig): void {
  const { home, projectRoot, systemPackagesDir, promotedPackagesDir, sharedDir, agentPath, envFile, fence, ...portable } = config;
  writeJson(configPath(home), {
    ...portable,
    // Kept only when it is not the default, and relative to the home, so it survives the checkout moving.
    ...(envFile === defaultConfig(home, projectRoot).envFile ? {} : { envFile: relative(home, envFile) || ".env" }),
    fence: { sandbox: fence.sandbox, network: fence.network, limits: fence.limits, docker: fence.docker, ...(fence.dockerSocket ? { dockerSocket: fence.dockerSocket } : {}) },
  });
}

function interpolate<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env);
    return out as T;
  }
  return value;
}
