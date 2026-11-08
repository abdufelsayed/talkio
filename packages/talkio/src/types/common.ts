import type { AgentMachineContext } from "../agent/context";

type DataContent = string | Uint8Array | ArrayBuffer | Buffer;

type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
type JSONObject = { [key: string]: JSONValue | undefined };
type JSONArray = JSONValue[];
/** Provider-specific data on a message part, passed through to the provider untouched. */
export type ProviderOptions = Record<string, JSONObject>;

export interface TextPart {
  type: "text";
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ImagePart {
  type: "image";
  image: DataContent | URL;
  mediaType?: string;
  providerOptions?: ProviderOptions;
}

export interface FilePart {
  type: "file";
  data: DataContent | URL;
  filename?: string;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
  providerExecuted?: boolean;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

export type ToolResultOutput =
  | { type: "text"; value: string; providerOptions?: ProviderOptions }
  | { type: "json"; value: JSONValue; providerOptions?: ProviderOptions }
  | { type: "execution-denied"; reason?: string; providerOptions?: ProviderOptions }
  | { type: "error-text"; value: string; providerOptions?: ProviderOptions }
  | { type: "error-json"; value: JSONValue; providerOptions?: ProviderOptions }
  | { type: "content"; value: ToolResultContentValue[] };

type ToolResultContentValue =
  | { type: "text"; text: string; providerOptions?: ProviderOptions }
  | {
      type: "file-data";
      data: string;
      mediaType: string;
      filename?: string;
      providerOptions?: ProviderOptions;
    }
  | { type: "file-url"; url: string; providerOptions?: ProviderOptions }
  | { type: "file-id"; fileId: string | Record<string, string>; providerOptions?: ProviderOptions }
  | { type: "image-data"; data: string; mediaType: string; providerOptions?: ProviderOptions }
  | { type: "image-url"; url: string; providerOptions?: ProviderOptions }
  | {
      type: "image-file-id";
      fileId: string | Record<string, string>;
      providerOptions?: ProviderOptions;
    }
  | { type: "custom"; providerOptions?: ProviderOptions };

export interface ToolApprovalRequest {
  type: "tool-approval-request";
  approvalId: string;
  toolCallId: string;
}

export interface ToolApprovalResponse {
  type: "tool-approval-response";
  approvalId: string;
  approved: boolean;
  reason?: string;
  providerExecuted?: boolean;
}

export type UserContent = string | Array<TextPart | ImagePart | FilePart>;
export type AssistantContent =
  | string
  | Array<
      TextPart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart | ToolApprovalRequest
    >;
export type ToolContent = Array<ToolResultPart | ToolApprovalResponse>;

export interface SystemMessage {
  role: "system";
  content: string;
  providerOptions?: ProviderOptions;
}

export interface UserMessage {
  role: "user";
  content: UserContent;
  providerOptions?: ProviderOptions;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent;
  providerOptions?: ProviderOptions;
}

export interface ToolMessage {
  role: "tool";
  content: ToolContent;
  providerOptions?: ProviderOptions;
}

/**
 * Union of all message types in a conversation.
 *
 * Messages form the conversation history that is passed to the LLM provider.
 * The agent automatically manages the message history as the conversation progresses.
 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * One entry of the conversation timeline: the append-only record of the
 * conversation that the talker and the thinker both read.
 *
 * - `user-speech`: a user turn.
 * - `agent-speech`: what the user heard the agent say; `cutOff` when they
 *   interrupted it.
 * - `think`: the talker handed `request` to the thinker.
 * - `thinker-text`: what the thinker wrote: findings, progress, or a question.
 * - `tool-call` / `tool-result`: a tool the thinker ran.
 * - `thinker-error`: the thinker failed.
 * - `silence`: nobody spoke for `ms`.
 */
export type TimelineEntry =
  | { type: "user-speech"; text: string }
  | { type: "agent-speech"; text: string; cutOff: boolean }
  | { type: "think"; id: string; request: string }
  | { type: "thinker-text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: ToolResultOutput }
  | { type: "thinker-error"; message: string }
  | { type: "silence"; ms: number };

/**
 * Output produced when the agent reaches its final state.
 */
export interface AgentMachineOutput {
  /** The conversation timeline. */
  timeline: AgentMachineContext["timeline"];
  /** Number of user turns in the conversation. */
  turnCount: number;
}
