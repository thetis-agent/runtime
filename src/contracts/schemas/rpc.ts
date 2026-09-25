import { z } from "zod";
import { UserRoleSchema, UserStatusSchema } from "./identity.js";

/** Common kernel method arguments; method handlers require the fields they actually consume. */
export const RpcArgumentsSchema = z.looseObject({
  user: z.string().optional(), package: z.string().optional(), namespace: z.string().optional(),
  name: z.string().optional(), source: z.string().optional(), parent: z.string().optional(),
  id: z.string().optional(), grant: z.string().optional(), session: z.string().optional(),
  model: z.string().optional(), key: z.string().optional(), prefix: z.string().optional(),
  token: z.string().optional(), password: z.string().optional(), deleteFiles: z.boolean().optional(),
});

export const ControlArgumentsSchema = RpcArgumentsSchema.extend({
  actor: z.string().optional(), role: UserRoleSchema.optional(), status: UserStatusSchema.optional(),
  reason: z.string().optional(), actor_filter: z.string().optional(), target: z.string().optional(), kind: z.string().optional(),
  /** `fence.reload`: cancel the turns running in that workspace first, instead of refusing while one runs. */
  force: z.boolean().optional(),
  limit: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
});

export const ControlCallerSchema = z.looseObject({ user: z.string().optional(), actor: z.string().optional() });
