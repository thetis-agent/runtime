import { z } from "zod";
import { FailureKindSchema, MessagesInputSchema } from "./messages.js";

export const UserRoleSchema = z.enum(["system", "admin", "user"]);
export const UserStatusSchema = z.enum(["active", "suspended"]);
export const UserRecordSchema = z.object({ id: z.string().min(1), role: UserRoleSchema, status: UserStatusSchema, createdAt: z.string() });
export const AuthUserSchema = UserRecordSchema.pick({ id: true, role: true });
export const SessionInfoSchema = z.object({ id: z.string().min(1), user: z.string().min(1), parent: z.string().optional() });
/** Why a turn stopped short of its end. An unknown word from a newer writer reads as `failed`, never as an unreadable record. */
export const InterruptedWhySchema = z.enum(["provider", "failed", "reload", "restart", "crash", "yield"]);
export const InterruptedSchema = z.looseObject({
  turn: z.string(), at: z.string(),
  error: z.looseObject({ message: z.string(), code: z.string().optional(), kind: FailureKindSchema.catch("other").optional(), retryable: z.boolean().optional() }),
  why: InterruptedWhySchema.catch("failed").optional(),
  /** The turn stopped at a round boundary: nothing partial, no tool call left unanswered. */
  clean: z.boolean().optional(),
  /** For a yield: what the turn paused for, a restart of Thetis or an update of this person's space. */
  for: z.enum(["restart", "reload"]).catch("restart").optional(),
  /** How many automatic resumes the chain this turn belongs to already had. Absent: none. */
  resumes: z.number().int().nonnegative().optional(),
});
export const SessionRecordSchema = z.looseObject({
  ...SessionInfoSchema.shape,
  createdAt: z.string(), updatedAt: z.string(), turns: z.number().int().nonnegative(),
  conversation: MessagesInputSchema,
  harness: z.record(z.string(), z.unknown()),
  /** Present while a turn is running; a persisted unfinished turn was interrupted. */
  turn: z.looseObject({
    id: z.string().min(1), startedAt: z.string(), input: z.string().optional(), messages: MessagesInputSchema.optional(),
    /** The checkpoint: what the running step has streamed so far, saved about once a second. A crash keeps it. */
    streamed: MessagesInputSchema.optional(),
    /** The automatic resumes of this turn's chain before it; carried into `interrupted.resumes`. */
    resumes: z.number().int().nonnegative().optional(),
  }).optional(),
  /**
   * The last turn did not finish, and `why`: a provider error, a failed step, a reload, a restart, a crash, or a
   * clean yield. A person's Stop and a budget cut leave no mark. What it had streamed was kept. Cleared when the
   * next turn starts; a turn with no input over it is the resume.
   */
  interrupted: InterruptedSchema.optional(),
});
export const SessionSummaryRefSchema = z.looseObject({
  ...SessionInfoSchema.shape,
  createdAt: z.string(), updatedAt: z.string(), turns: z.number().int().nonnegative(),
  first: z.string(), last: z.string(), running: z.boolean(),
  /** A copy of the record's `interrupted`, in brief, so a scanner never opens every record. */
  interrupted: z.looseObject({ why: InterruptedWhySchema.catch("failed"), at: z.string(), resumes: z.number().int().nonnegative().optional(), kind: FailureKindSchema.catch("other").optional() }).optional(),
});
export const SessionSummarySchema = SessionSummaryRefSchema.omit({ running: true });
