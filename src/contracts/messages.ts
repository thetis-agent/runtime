import type { z } from "zod";
import type { RoleSchema, ToolCallSchema, MessageSchema, ToolSpecSchema, ProviderCallSchema, ProviderEventSchema, ModelDescriptorSchema, ModelChoicesSchema } from "./schemas/messages.js";
import type { ContentPart } from "./content.js";
// The conversation and the provider request: what a model sees and what it answers.

export type Role = z.infer<typeof RoleSchema>;

export type ToolCall = z.infer<typeof ToolCallSchema>;

export type Message = z.infer<typeof MessageSchema>;

/** Legacy text is accepted at API boundaries and normalized immediately. */
export type MessageInput = Pick<Message, "role" | "id" | "extensions" | "toolCalls" | "toolCallId" | "name"> & { content: string | ContentPart[] };
export type TurnInput = string | MessageInput | MessageInput[];

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/** The parameterized provider request. Built by steps, sent by the harness's call step through `kernel.providers.call`. */
export type ProviderCall = z.infer<typeof ProviderCallSchema>;

/**
 * What a provider streams. `reasoning` is a reasoning model's thinking, and it is a kind of its own rather
 * than more `text`: it is not the answer, it is not sent back on the next turn, and mixing it into the reply
 * would put a wall of deliberation above every sentence the model meant to say. A provider that has no such
 * thing simply never yields it.
 */
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/** The models a userspace can call, and the configured default. */
export type ModelChoices = z.infer<typeof ModelChoicesSchema>;
