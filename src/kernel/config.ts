import { relative, resolve } from "node:path";
import { KernelConfigPatchSchema, KernelConfigSchema, type KernelConfig } from "../contracts/schemas/kernel-config.js";
import { parseSchema } from "../lib/validation.js";
export type { FenceConfig, KernelConfig } from "../contracts/schemas/kernel-config.js";
import type { ConfigTier } from "../lib/config-tiers.js";
import { readJson, writeJson } from "../lib/json.js";

/** The file layer as it is on disk now: exactly what `thetis.config.json` says. `config.reload` reads it again. */
export function packagesLayer(home: string): Record<string, Record<string, unknown>> {
  const raw = parseSchema(KernelConfigPatchSchema, readJson<unknown>(configPath(home), {}), "kernel configuration");
  return raw.packages ?? {};
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
  const stored = parseSchema(KernelConfigPatchSchema, readJson<unknown>(configPath(home), {}), "kernel configuration");
  const { packages, ...rest } = stored;
  const merged = {
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
  const resolved = parseSchema(KernelConfigSchema, interpolate(merged, env), "kernel configuration");
  return { ...resolved, packages: packages ?? {} };
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

function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env);
    return out;
  }
  return value;
}
