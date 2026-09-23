// The conversation and the provider request: what a model sees and what it answers.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  package: string;
  export: string;
}

/** The parameterized provider request. Built by steps, sent by the harness's call step through `kernel.providers.call`. */
export interface ProviderCall {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  params: Record<string, unknown>;
  /**
   * Hints, keyed by concern (for example `cache`, `withheld`). Never sent to the API and never read by the
   * kernel, which carries the call as data: a provider reads the keys it understands, and the harness's call
   * step reads `withheld`, the names of tools a scoping step took out of `tools` and still honours by name.
   */
  hints?: Record<string, unknown>;
}

/**
 * What a provider streams. `reasoning` is a reasoning model's thinking, and it is a kind of its own rather
 * than more `text`: it is not the answer, it is not sent back on the next turn, and mixing it into the reply
 * would put a wall of deliberation above every sentence the model meant to say. A provider that has no such
 * thing simply never yields it.
 */
export type ProviderEvent =
  /** Optional inspection capture: the serialized request body, without transport headers. */
  | { type: "request"; body: Record<string, unknown>; at: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string };

export interface ModelDescriptor {
  id: string;
  name?: string;
  provider?: string;
}

/** The models a userspace can call, and the configured default. */
export interface ModelChoices {
  model: string;
  models: ModelDescriptor[];
}
