import { z } from "zod";
import { MessagesInputSchema } from "./messages.js";

export const UserRoleSchema = z.enum(["system", "admin", "user"]);
export const UserStatusSchema = z.enum(["active", "suspended"]);
export const UserRecordSchema = z.object({ id: z.string().min(1), role: UserRoleSchema, status: UserStatusSchema, createdAt: z.string() });
export const AuthUserSchema = UserRecordSchema.pick({ id: true, role: true });
export const SessionInfoSchema = z.object({ id: z.string().min(1), user: z.string().min(1), parent: z.string().optional() });
export const SessionRecordSchema = z.looseObject({
  ...SessionInfoSchema.shape,
  createdAt: z.string(), updatedAt: z.string(), turns: z.number().int().nonnegative(),
  conversation: MessagesInputSchema,
  harness: z.record(z.string(), z.unknown()),
  /** Present while a turn is running; a persisted unfinished turn was interrupted. */
  turn: z.looseObject({
    id: z.string().min(1), startedAt: z.string(), input: z.string().optional(), messages: MessagesInputSchema.optional(),
  }).optional(),
});
export const SessionSummaryRefSchema = z.looseObject({
  ...SessionInfoSchema.shape,
  createdAt: z.string(), updatedAt: z.string(), turns: z.number().int().nonnegative(),
  first: z.string(), last: z.string(), running: z.boolean(),
});
export const SessionSummarySchema = SessionSummaryRefSchema.omit({ running: true });
