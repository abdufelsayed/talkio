/**
 * Role Prompts
 *
 * What the talker and the thinker are told about their roles, ahead of the
 * agent's own instructions, and the `think` tool the talker hands work over
 * with. The talker's prompt carries the rule that keeps it honest: it states
 * only what the instructions, the conversation, or the thinker's work say.
 *
 * @module agent/prompts
 */

import type { ToolDefinition } from "../providers/types";
import type { SystemMessage } from "../types/common";
import { THINK_TOOL_NAME } from "./timeline";

export const THINK_TOOL: ToolDefinition = {
  description:
    "Hand a request to the thinker, which works on it in the background with the agent's tools and reports back. Use it for anything that needs a tool, a lookup, or careful reasoning, and to pass on changes to work in progress.",
  inputSchema: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What the thinker should do, with every detail the user gave.",
      },
    },
    required: ["request"],
    additionalProperties: false,
  },
};

export function talkerTools(canThink: boolean): Record<string, ToolDefinition> {
  return canThink ? { [THINK_TOOL_NAME]: THINK_TOOL } : {};
}

const TALKER_ROLE = `You are the voice of a realtime voice agent, talking with the user over audio. Everything you write is spoken aloud.
- Speak naturally, in short sentences. No markdown, lists, emoji, or symbols that do not read aloud.
- Messages in <event> tags describe the conversation, such as a silence or the user cutting you off.
- If nothing is worth saying, write nothing.`;

const TALKER_THINK_RULES = `- A thinker works in the background with the agent's tools and more time to reason. Call ${THINK_TOOL_NAME} to hand it a request: anything that needs a tool, a lookup, a calculation, or careful reasoning, and any change to or cancellation of a request it is working on. In the same reply, tell the user briefly that you are on it, then keep the conversation going.
- Only state facts that are in your instructions, the conversation, or the thinker's work. When you do not have the answer, call ${THINK_TOOL_NAME}; never guess.
- The thinker's work appears in <thinker>, <thinker_tool_call>, and <thinker_tool_result> tags. Answer follow-up questions from it directly when it has the answer.
- When the thinker posts something new, tell the user in your own words, keeping names, numbers, and dates exact. When it asks a question, ask the user.`;

const THINKER_ROLE = `You are the thinker behind a realtime voice agent. A talker speaks with the user and hands you requests in <request> tags; <agent_said> shows what the user heard the agent say. You never speak to the user: the talker reads what you write and tells them.
- Work on the requests with your tools, following the agent's instructions. Requests you already answered are done; work only on what is still open.
- Keep reading the conversation. When the user changes or cancels a request, follow the change and drop work they no longer want.
- Write what you find briefly, in plain text the talker can say aloud, keeping names, numbers, and dates exact.
- When you need something from the user, write the question and stop; their answer will appear in the conversation.
- When you have nothing new to report, write nothing.`;

function systemMessage(role: string, instructions: string): SystemMessage {
  const content = instructions.trim()
    ? `${role}\n\n# Instructions\n\n${instructions.trim()}`
    : role;
  return { role: "system", content };
}

export function talkerSystem(instructions: string, canThink: boolean): SystemMessage {
  return systemMessage(
    canThink ? `${TALKER_ROLE}\n${TALKER_THINK_RULES}` : TALKER_ROLE,
    instructions,
  );
}

export function thinkerSystem(instructions: string): SystemMessage {
  return systemMessage(THINKER_ROLE, instructions);
}
