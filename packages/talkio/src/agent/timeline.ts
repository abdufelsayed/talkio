/**
 * Conversation Timeline
 *
 * One append-only log of the conversation, read by both the talker and the
 * thinker. Each reader sees its own tool calls as native tool calls and
 * everything else as tagged text, because providers reject tool calls for
 * tools the request does not declare and require each result to directly
 * follow its call.
 *
 * The thinker's history is rebuilt from its steps rather than from its
 * entries: each step appears right after what it read, with the reasoning and
 * provider data the model must get back, even when the user spoke while the
 * step ran and their words reached the timeline first.
 *
 * @module agent/timeline
 */

import type {
  AssistantMessage,
  Message,
  TextPart,
  TimelineEntry,
  ToolCallPart,
  ToolResultOutput,
  ToolResultPart,
  UserMessage,
} from "../types/common";
import type { ThinkerStepContent } from "../types/events";

export const THINK_TOOL_NAME = "think";

export const THINK_STARTED: ToolResultOutput = { type: "text", value: "Started." };
// The thinker reads the timeline between its steps, when its calls have
// results, but a single open call makes every provider reject the request.
const TOOL_RUNNING: ToolResultOutput = { type: "text", value: "Still running." };
const DELIVERY_NOTE =
  "The thinker posted since you last spoke. Tell the user what is new unless you already have.";
const OMITTED = "Earlier parts of the conversation are not shown.";

/**
 * About 25,000 tokens of the newest entries: enough for a long call, small
 * enough for every model's context window and for a fast first token.
 */
const HISTORY_BUDGET = 100_000;

/** One thinker step, kept so the thinker's history shows it where it happened. */
export interface ThinkerStep {
  /** The timeline length the step read. */
  readThrough: number;
  /** Where the step's entries sit on the timeline. */
  start: number;
  end: number;
  content: ThinkerStepContent;
}

/**
 * The entries a thinker step adds: its tool calls, or the text it finished
 * with. Text written alongside tool calls narrates the work, so it stays in
 * the thinker's own history and does not reach the talker.
 */
export function stepEntries(content: ThinkerStepContent): TimelineEntry[] {
  const calls = content.filter((part): part is ToolCallPart => part.type === "tool-call");
  if (calls.length > 0) {
    return calls.map((call) => ({
      type: "tool-call",
      id: call.toolCallId,
      name: call.toolName,
      input: call.input,
    }));
  }
  const text = content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text ? [{ type: "thinker-text", text }] : [];
}

/**
 * A tool call id not in `used`. Some providers number calls from zero in every
 * response, and a repeated id would attach one call's result to another.
 */
export function uniqueCallId(id: string, used: ReadonlySet<string>): string {
  if (id && !used.has(id)) return id;
  const base = id || "call";
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix++;
  return `${base}_${suffix}`;
}

/** The ids of the tool calls already in a history. */
export function toolCallIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Whether the talker has something to react to once nobody is speaking: an
 * entry after `since` that wakes it. The end of the user's turn wakes it
 * separately, and the thinker's tool calls only add context.
 */
export function shouldWakeTalker(entries: readonly TimelineEntry[], since: number): boolean {
  for (let index = since; index < entries.length; index++) {
    if (wakesTalker(entries, index)) return true;
  }
  return false;
}

function wakesTalker(entries: readonly TimelineEntry[], index: number): boolean {
  switch (entries[index]?.type) {
    case "thinker-text":
    case "silence":
      return true;
    case "thinker-error":
      return isFirstFailureSinceUserSpoke(entries, index);
    default:
      return false;
  }
}

/**
 * A thinker that keeps failing would otherwise keep the talker apologizing
 * and asking it again. After the first failure, the talker hears of the next
 * ones when the user speaks.
 */
function isFirstFailureSinceUserSpoke(entries: readonly TimelineEntry[], index: number): boolean {
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const type = entries[earlier]?.type;
    if (type === "user-speech") return true;
    if (type === "thinker-error") return false;
  }
  return true;
}

/**
 * The history for one talker run. When the thinker posted since the user last
 * heard the talker, the run ends with a note that is not saved to the
 * timeline, because fast models tend to skip results that arrive late.
 */
export function talkerMessages(entries: readonly TimelineEntry[], heardSince: number): Message[] {
  const from = historyStart(entries);
  const history = new History();
  for (let index = from; index < entries.length; index++) {
    const entry = entries[index];
    if (entry) addTalkerEntry(history, entry);
  }
  const posted = entries
    .slice(heardSince)
    .some((entry) => entry.type === "thinker-text" || entry.type === "thinker-error");
  if (posted) history.user(tag("note", DELIVERY_NOTE));
  return history.messages(from > 0);
}

/** The history for one thinker step. */
export function thinkerMessages(
  entries: readonly TimelineEntry[],
  steps: readonly ThinkerStep[],
): Message[] {
  const from = historyStart(entries);
  const results = new Map<string, ToolResultOutput>();
  for (const entry of entries) {
    if (entry.type === "tool-result") results.set(entry.id, entry.output);
  }
  const history = new History();
  let next = 0;
  for (let index = from; index <= entries.length; index++) {
    while (next < steps.length && Math.max(steps[next]?.readThrough ?? 0, from) <= index) {
      const step = steps[next++];
      if (step && step.end > from) history.step(step.content, results);
    }
    const entry = entries[index];
    if (entry) addThinkerEntry(history, entry);
  }
  return history.messages(from > 0);
}

function addTalkerEntry(history: History, entry: TimelineEntry): void {
  switch (entry.type) {
    case "agent-speech":
      if (!entry.text.trim()) return;
      history.assistantText(entry.text);
      if (entry.cutOff) {
        history.user(tag("event", "The user cut you off. They heard only the text above."));
      }
      return;
    case "think":
      history.toolCall(
        {
          type: "tool-call",
          toolCallId: entry.id,
          toolName: THINK_TOOL_NAME,
          input: { request: entry.request },
        },
        THINK_STARTED,
      );
      return;
    case "thinker-text":
      if (entry.text.trim()) history.user(tag("thinker", entry.text));
      return;
    case "tool-call":
      history.user(tag("thinker_tool_call", stringify(entry.input), { name: entry.name }));
      return;
    case "tool-result":
      history.user(
        tag("thinker_tool_result", renderToolOutput(entry.output), { name: entry.name }),
      );
      return;
    default:
      addSharedEntry(history, entry);
  }
}

function addThinkerEntry(history: History, entry: TimelineEntry): void {
  switch (entry.type) {
    case "agent-speech": {
      if (!entry.text.trim()) return;
      const attributes: Record<string, string> = entry.cutOff ? { cut_off: "true" } : {};
      history.user(tag("agent_said", entry.text, attributes));
      return;
    }
    case "think":
      history.user(tag("request", entry.request));
      return;
    case "thinker-text":
    case "tool-call":
    case "tool-result":
      // The thinker's own work comes from its steps.
      return;
    default:
      addSharedEntry(history, entry);
  }
}

function addSharedEntry(
  history: History,
  entry: Extract<TimelineEntry, { type: "user-speech" | "thinker-error" | "silence" }>,
): void {
  switch (entry.type) {
    case "user-speech":
      if (entry.text.trim()) history.user(entry.text);
      return;
    case "thinker-error":
      history.user(tag("event", `The thinker failed: ${entry.message}`));
      return;
    case "silence":
      history.user(tag("event", `Nobody has spoken for ${Math.round(entry.ms / 1000)} seconds.`));
  }
}

/**
 * Where the history the models see starts: they see at most about
 * `HISTORY_BUDGET` characters of the newest entries. The start moves in steps
 * of half the budget, so the history keeps its beginning between moves and
 * providers can reuse their prompt cache.
 */
export function historyStart(entries: readonly TimelineEntry[]): number {
  const sizes = entries.map((entry) => JSON.stringify(entry).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= HISTORY_BUDGET) return 0;
  const step = HISTORY_BUDGET / 2;
  const cut = Math.ceil((total - HISTORY_BUDGET) / step) * step;
  let dropped = 0;
  for (let index = 0; index < entries.length; index++) {
    if (dropped >= cut) return index;
    dropped += sizes[index] ?? 0;
  }
  return Math.max(0, entries.length - 1);
}

/** Builds a message history in one pass, grouping parts the way providers expect. */
class History {
  readonly #messages: Message[] = [];
  #user: Array<TextPart> | null = null;
  #assistant: Array<TextPart | ToolCallPart> = [];
  #results: ToolResultPart[] = [];

  user(text: string): void {
    this.#flushAssistant();
    if (!this.#user) {
      this.#user = [];
      this.#messages.push({ role: "user", content: this.#user } satisfies UserMessage);
    }
    this.#user.push(textPart(text));
  }

  assistantText(text: string): void {
    this.#user = null;
    // Text after answered calls is a new reply, not part of the call message.
    if (this.#results.length > 0) this.#flushAssistant();
    this.#assistant.push(textPart(text));
  }

  toolCall(call: ToolCallPart, output: ToolResultOutput): void {
    this.#user = null;
    this.#assistant.push(call);
    this.#results.push({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    });
  }

  /** One model step as its own message, so sequential steps never read as parallel calls. */
  step(content: ThinkerStepContent, results: ReadonlyMap<string, ToolResultOutput>): void {
    const calls = content.filter((part): part is ToolCallPart => part.type === "tool-call");
    // Providers need reasoning back only with the calls it led to.
    const parts = calls.length > 0 ? content : content.filter((part) => part.type === "text");
    if (parts.length === 0) return;
    this.#flushAssistant();
    this.#user = null;
    this.#messages.push({ role: "assistant", content: [...parts] } satisfies AssistantMessage);
    if (calls.length === 0) return;
    this.#messages.push({
      role: "tool",
      content: calls.map((call) => ({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: results.get(call.toolCallId) ?? TOOL_RUNNING,
      })),
    });
  }

  /**
   * The finished history. Some providers reject a conversation that opens
   * with the model, as one that starts with a greeting from `agent.say()`
   * would, so it always opens with the user.
   */
  messages(trimmed: boolean): Message[] {
    this.#flushAssistant();
    const opening = trimmed ? OMITTED : "The conversation started.";
    if (!trimmed && this.#messages[0]?.role !== "assistant") return [...this.#messages];
    const first = this.#messages[0];
    if (first?.role === "user" && Array.isArray(first.content)) {
      return [
        { role: "user", content: [textPart(tag("event", opening)), ...first.content] },
        ...this.#messages.slice(1),
      ];
    }
    return [{ role: "user", content: [textPart(tag("event", opening))] }, ...this.#messages];
  }

  #flushAssistant(): void {
    if (this.#assistant.length > 0) {
      this.#messages.push({ role: "assistant", content: this.#assistant });
    }
    if (this.#results.length > 0) this.#messages.push({ role: "tool", content: this.#results });
    this.#assistant = [];
    this.#results = [];
  }
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
