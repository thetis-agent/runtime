import { z } from "zod";

export const ConfigTypeSchema = z.enum(["string", "number", "boolean", "object", "array"], {
  error: "type must be one of string, number, boolean, object, array",
});

export const ConfigLayerSchema = z.enum(["default", "file", "system", "user"]);

export const ConfigValueSchemas = {
  string: z.string(), number: z.number(), boolean: z.boolean(),
  object: z.record(z.string(), z.unknown()), array: z.array(z.unknown()),
};

export const ConfigDeclSchema = z.strictObject({
  type: ConfigTypeSchema,
  /** Secrets are never shown or echoed by tools. */
  secret: z.boolean({ error: "secret must be true or false" }).optional(),
  /** A missing required value is reported before the package is invoked. */
  required: z.boolean({ error: "required must be true or false" }).optional(),
  default: z.unknown().optional(),
  /** Only an admin can set a system-scoped value; a user layer cannot override it. */
  scope: z.enum(["system", "user"], { error: "scope must be system or user" }).optional(),
  help: z.string({ error: "help must be a string" }).optional(),
});

export const ConfigKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a key is a bare identifier");
export const ConfigDeclsSchema = z.record(ConfigKeySchema, ConfigDeclSchema);

export const ConfigKeyStateSchema = z.looseObject({
  key: z.string(),
  state: z.enum(["set", "missing", "unset"]),
  /** Secret literals are omitted; a pure environment reference can be shown. */
  value: z.unknown().optional(),
  redacted: z.literal(true).optional(),
  source: ConfigLayerSchema.optional(),
  inheritedFrom: z.string().optional(),
  /** Names of unresolved environment references, never their values. */
  missing: z.array(z.string()).optional(),
  secret: z.boolean(),
  declared: z.boolean(),
  type: ConfigTypeSchema.optional(),
  required: z.boolean().optional(),
  scope: z.enum(["system", "user"]).optional(),
  help: z.string().optional(),
});

export const ConfigReportSchema = z.looseObject({
  package: z.string(),
  user: z.string().optional(),
  inherits: z.array(z.string()),
  keys: z.array(ConfigKeyStateSchema),
  summary: z.string(),
  broken: z.boolean(),
});
