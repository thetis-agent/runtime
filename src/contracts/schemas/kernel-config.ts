import { z } from "zod";
import { StepRefSchema } from "./pipeline.js";

const SandboxSchema = z.enum(["auto", "bwrap", "none"]);
const NetworkSchema = z.enum(["auto", "egress", "none", "host"]);
const DockerSchema = z.enum(["auto", "on", "off"]);
const MemoryLimitSchema = z.union([z.number().positive(), z.literal("auto")]);
const LimitsSchema = z.looseObject({ memoryMb: MemoryLimitSchema, pids: z.number().int().positive(), cpuPercent: z.number().positive() });

export const FenceConfigSchema = z.looseObject({
  sandbox: SandboxSchema,
  network: NetworkSchema,
  /** Per-fence resource limits. `memoryMb: "auto"` leaves memory unlimited. */
  limits: LimitsSchema,
  /** Host paths every fence may read besides the OS. */
  readOnly: z.array(z.string()),
  /** Host paths masked inside every fence. */
  hidden: z.array(z.string()),
  /** `auto` binds Docker when usable; `on` binds it regardless of the probe; `off` never binds it. Socket access is host root. */
  docker: DockerSchema,
  dockerSocket: z.string().optional(),
});

export const PackagesLayerSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
export const KernelConfigSchema = z.looseObject({
  /** Service-plane data directory: users, registry, userspaces. */
  home: z.string(),
  /** Checkout used to derive runtime paths and to reload the configuration. */
  projectRoot: z.string(),
  /** Where shipped @thetis/* packages live. */
  systemPackagesDir: z.string(),
  /** Promoted packages: `<home>/packages`. */
  promotedPackagesDir: z.string(),
  /** Writable by the system userspace, read-only in other fences: `<home>/shared`. */
  sharedDir: z.string(),
  /** Userspace agent entry booted by every fence. */
  agentPath: z.string(),
  model: z.string(),
  /** Ordered enumeration phases. Custom phases and an empty pipeline are allowed. */
  phases: z.array(z.string().min(1)),
  enumerator: StepRefSchema.optional(),
  /** `*` applies to every userspace; other keys identify individual userspaces. */
  systemPackages: z.record(z.string(), z.array(z.string().min(1))),
  /** File-layer package values keep `${VAR}` references for the config service to resolve on each read. */
  packages: PackagesLayerSchema,
  storage: z.looseObject({ driver: z.string().min(1) }),
  /** Defaults to `<projectRoot>/.env`; relative overrides resolve against `home`. */
  envFile: z.string(),
  fence: FenceConfigSchema,
  door: z.looseObject({ host: z.string(), port: z.number().int().min(0).max(65535) }),
  control: z.looseObject({ allowRestart: z.boolean(), minUptimeSecs: z.number().nonnegative(), quietWaitMs: z.number().nonnegative() }),
  requestTimeoutMs: z.number().positive(),
});

// String enum settings may contain environment references until the merged configuration is resolved.
const EnvReferenceSchema = z.string().regex(/\$\{[A-Z0-9_]+\}/);
const FenceConfigPatchSchema = FenceConfigSchema.partial().extend({
  sandbox: z.union([SandboxSchema, EnvReferenceSchema]).optional(),
  network: z.union([NetworkSchema, EnvReferenceSchema]).optional(),
  docker: z.union([DockerSchema, EnvReferenceSchema]).optional(),
  limits: LimitsSchema.partial().extend({ memoryMb: z.union([MemoryLimitSchema, EnvReferenceSchema]).optional() }).optional(),
});
export const KernelConfigPatchSchema = KernelConfigSchema.partial().extend({
  fence: FenceConfigPatchSchema.optional(),
  storage: KernelConfigSchema.shape.storage.partial().optional(),
  door: KernelConfigSchema.shape.door.partial().optional(),
  control: KernelConfigSchema.shape.control.partial().optional(),
});

export type FenceConfig = z.infer<typeof FenceConfigSchema>;
export type KernelConfig = z.infer<typeof KernelConfigSchema>;
