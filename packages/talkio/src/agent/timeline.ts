/**
 * Conversation Timeline
 *
 * One append-only log of the conversation, read by both the talker and the
 * thinker. Each reader sees its own tool calls as native tool calls and
 * everything else as tagged text, because providers reject tool calls for
 * tools the request does not declare and require each result to directly
 * follow its call.
 *
 * @module agent/timeline
 */

import type {
  Message,
  TextPart,
  TimelineEntry,
  ToolCallPart,
  ToolResultOutput,
  ToolResultPart,
} from "../types/common";

export type TimelineReader = "talker" | "thinker";

export const THINK_TOOL_NAME = "think";

const THINK_STARTED: ToolResultOutput = { type: "text", value: "Started." };
// The thinker reads the timeline between its steps, when its calls have
// results, but a single open call makes every provider reject the request.
const TOOL_RUNNING: ToolResultOutput = { type: "text", value: "Still running." };
const DELIVERY_NOTE =
  "The thinker posted since you last spoke. Tell the user what is new unless you already have.";

type Piece =
  | { kind: "user-text"; text: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-call"; call: ToolCallPart; result: ToolResultPart };

/** Encodes the timeline as the message history `reader` sees. */
export function encodeTimeline(
  entries: readonly TimelineEntry[],
  reader: TimelineReader,
): Message[] {
  const results = new Map<string, ToolResultOutput>();
  for (const entry of entries) {
    if (entry.type === "tool-result") results.set(entry.id, entry.output);
  }

  let messages: Message[] = [];
  let assistantParts: Array<TextPart | ToolCallPart> = [];
  let toolResults: ToolResultPart[] = [];

  const flushAssistant = () => {
    if (assistantParts.length > 0) {
      messages = [...messages, { role: "assistant", content: assistantParts }];
    }
    if (toolResults.length > 0) messages = [...messages, { role: "tool", content: toolResults }];
    assistantParts = [];
    toolResults = [];
  };

  for (const piece of entries.flatMap((entry) => piecesOf(entry, reader, results))) {
    if (piece.kind === "user-text") {
      flushAssistant();
      messages = appendUserText(messages, piece.text);
    } else if (piece.kind === "assistant-text") {
      if (toolResults.length > 0) flushAssistant();
      assistantParts = [...assistantParts, textPart(piece.text)];
    } else {
      assistantParts = [...assistantParts, piece.call];
      toolResults = [...toolResults, piece.result];
    }
  }
  flushAssistant();
  // Some providers reject a conversation that opens with the model, as one
  // that starts with a greeting from `agent.say()` would.
  return messages[0]?.role === "assistant"
    ? [
        { role: "user", content: [textPart(tag("event", "The conversation started."))] },
        ...messages,
      ]
    : messages;
}

/**
 * Whether an entry should make the talker speak once nobody is speaking. The
 * end of the user's turn wakes it separately, and the thinker's tool calls
 * only add context.
 */
export function wakesTalker(entry: TimelineEntry): boolean {
  return (
    entry.type === "thinker-text" || entry.type === "thinker-error" || entry.type === "silence"
  );
}

/**
 * Whether the talker has something to react to. `since` is the timeline
 * length when the talker started its last run that the user heard in full.
 */
export function shouldWakeTalker(entries: readonly TimelineEntry[], since: number): boolean {
  return entries.slice(since).some(wakesTalker);
}

/**
 * The history for one talker run. When the thinker posted since the talker
 * last spoke, the run ends with a note that is not saved to the timeline,
 * because fast models tend to skip results that arrive late.
 */
export function talkerMessages(entries: readonly TimelineEntry[], since: number): Message[] {
  const messages = encodeTimeline(entries, "talker");
  const thinkerPosted = entries
    .slice(since)
    .some((entry) => entry.type === "thinker-text" || entry.type === "thinker-error");
  return thinkerPosted ? appendUserText(messages, tag("note", DELIVERY_NOTE)) : messages;
}

function piecesOf(
  entry: TimelineEntry,
  reader: TimelineReader,
  results: ReadonlyMap<string, ToolResultOutput>,
): Piece[] {
  switch (entry.type) {
    case "thinker-error":
      return [userText(tag("event", `The thinker failed: ${entry.message}`))];
    case "silence":
      return [
        userText(tag("event", `Nobody has spoken for ${Math.round(entry.ms / 1000)} seconds.`)),
      ];
    case "user-speech":
      return entry.text.trim() ? [userText(entry.text)] : [];
    case "agent-speech":
      if (!entry.text.trim()) return [];
      if (reader === "thinker") {
        const attributes: Record<string, string> = entry.cutOff ? { cut_off: "true" } : {};
        return [userText(tag("agent_said", entry.text, attributes))];
      }
      return entry.cutOff
        ? [
            assistantText(entry.text),
            userText(tag("event", "The user cut you off. They heard only the text above.")),
          ]
        : [assistantText(entry.text)];
    case "think":
      return reader === "talker"
        ? [toolCall(entry.id, THINK_TOOL_NAME, { request: entry.request }, THINK_STARTED)]
        : [userText(tag("request", entry.request))];
    case "thinker-text":
      if (!entry.text.trim()) return [];
      return reader === "thinker"
        ? [assistantText(entry.text)]
        : [userText(tag("thinker", entry.text))];
    case "tool-call":
      return reader === "thinker"
        ? [toolCall(entry.id, entry.name, entry.input, results.get(entry.id) ?? TOOL_RUNNING)]
        : [userText(tag("thinker_tool_call", stringify(entry.input), { name: entry.name }))];
    case "tool-result":
      return reader === "thinker"
        ? []
        : [
            userText(
              tag("thinker_tool_result", renderToolOutput(entry.output), { name: entry.name }),
            ),
          ];
  }
}

function appendUserText(messages: Message[], text: string): Message[] {
  const last = messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { role: "user", content: [...last.content, textPart(text)] }];
  }
  return [...messages, { role: "user", content: [textPart(text)] }];
}

function userText(text: string): Piece {
  return { kind: "user-text", text };
}

function assistantText(text: string): Piece {
  return { kind: "assistant-text", text };
}

function toolCall(id: string, name: string, input: unknown, output: ToolResultOutput): Piece {
  return {
    kind: "tool-call",
    call: { type: "tool-call", toolCallId: id, toolName: name, input },
    result: { type: "tool-result", toolCallId: id, toolName: name, output },
  };
}

function textPart(text: string): TextPart {
  return { type: "text", text };
}

function tag(name: string, body: string, attributes: Record<string, string> = {}): string {
  const attributeText = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join("");
  return `<${name}${attributeText}>${body}</${name}>`;
}

function renderToolOutput(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return stringify(output.value);
    case "error-text":
      return `Error: ${output.value}`;
    case "error-json":
      return `Error: ${stringify(output.value)}`;
    case "execution-denied":
      return output.reason ? `Denied: ${output.reason}` : "Denied.";
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
  }
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
