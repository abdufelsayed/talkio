/**
 * Conversation history helpers. Messages are never mutated.
 *
 * @module agent/history
 */

import type { Message } from "../types/common";

export const DEFAULT_MAX_MESSAGES = 100;

/** Keeps the newest messages within `maxMessages`, always preserving system messages. */
export function trimHistory(messages: Message[], maxMessages = DEFAULT_MAX_MESSAGES): Message[] {
  if (messages.length <= maxMessages) return messages;
  const system = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  const keep = Math.max(0, maxMessages - system.length);
  return [...system, ...conversation.slice(conversation.length - keep)];
}

/**
 * Appends a user message. With `merge`, a trailing user message is extended
 * instead: the caller knows the agent said nothing audible since then, so to
 * the listener it is one continuous turn.
 */
export function appendUserMessage(
  messages: Message[],
  text: string,
  options: { merge: boolean; maxMessages?: number },
): Message[] {
  const content = text.trim();
  if (!content) return messages;
  const last = messages.at(-1);
  if (options.merge && last?.role === "user" && typeof last.content === "string") {
    const merged: Message = { role: "user", content: `${last.content} ${content}` };
    return trimHistory([...messages.slice(0, -1), merged], options.maxMessages);
  }
  return trimHistory([...messages, { role: "user", content }], options.maxMessages);
}

export function appendAssistantMessage(
  messages: Message[],
  text: string,
  maxMessages?: number,
): Message[] {
  const content = text.trim();
  if (!content) return messages;
  return trimHistory([...messages, { role: "assistant", content }], maxMessages);
}
