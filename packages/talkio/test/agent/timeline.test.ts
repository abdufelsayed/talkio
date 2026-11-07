import { describe, expect, it } from "vitest";

import { encodeTimeline, shouldWakeTalker, talkerMessages } from "../../src/agent/timeline";
import type { Message, TimelineEntry } from "../../src/types/common";

const flightsSearch: TimelineEntry[] = [
  { type: "user-speech", text: "Find me a flight to Berlin on Friday." },
  { type: "think", id: "t1", request: "Flights to Berlin on Friday" },
  { type: "agent-speech", text: "Sure, let me look.", cutOff: false },
  { type: "tool-call", id: "c1", name: "searchFlights", input: { to: "BER", date: "Fri" } },
  { type: "tool-call", id: "c2", name: "getBagPolicy", input: {} },
  { type: "user-speech", text: "Actually, make it Saturday." },
  {
    type: "tool-result",
    id: "c1",
    name: "searchFlights",
    output: { type: "json", value: [{ flight: "MS 787", eur: 210 }] },
  },
  {
    type: "tool-result",
    id: "c2",
    name: "getBagPolicy",
    output: { type: "text", value: "One bag included." },
  },
  { type: "thinker-text", text: "Friday has MS 787 at 210 euros. Checking Saturday." },
];

function user(...texts: string[]): Message {
  return { role: "user", content: texts.map((text) => ({ type: "text", text })) };
}

function assistant(...texts: string[]): Message {
  return { role: "assistant", content: texts.map((text) => ({ type: "text", text })) };
}

/** Providers reject a tool call that the very next message does not answer. */
function expectAnsweredToolCalls(messages: Message[]) {
  messages.forEach((message, index) => {
    const callIds =
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))
        : [];
    const next = messages[index + 1];
    const resultIds =
      next?.role === "tool"
        ? next.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
        : [];
    expect(resultIds).toEqual(callIds);
  });
}

describe("timeline encoding", () => {
  it("shows the talker its own think calls as tool calls and the thinker's work as text", () => {
    const messages = encodeTimeline(flightsSearch, "talker");

    expect(messages).toEqual([
      user("Find me a flight to Berlin on Friday."),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "think",
            input: { request: "Flights to Berlin on Friday" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "think",
            output: { type: "text", value: "Started." },
          },
        ],
      },
      assistant("Sure, let me look."),
      user(
        '<thinker_tool_call name="searchFlights">{"to":"BER","date":"Fri"}</thinker_tool_call>',
        '<thinker_tool_call name="getBagPolicy">{}</thinker_tool_call>',
        "Actually, make it Saturday.",
        '<thinker_tool_result name="searchFlights">[{"flight":"MS 787","eur":210}]</thinker_tool_result>',
        '<thinker_tool_result name="getBagPolicy">One bag included.</thinker_tool_result>',
        "<thinker>Friday has MS 787 at 210 euros. Checking Saturday.</thinker>",
      ),
    ]);
    expectAnsweredToolCalls(messages);
  });

  it("shows the thinker its own calls, answered right away even when the user spoke meanwhile", () => {
    const messages = encodeTimeline(flightsSearch, "thinker");

    expect(messages).toEqual([
      user(
        "Find me a flight to Berlin on Friday.",
        "<request>Flights to Berlin on Friday</request>",
        "<agent_said>Sure, let me look.</agent_said>",
      ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "searchFlights",
            input: { to: "BER", date: "Fri" },
          },
          { type: "tool-call", toolCallId: "c2", toolName: "getBagPolicy", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "searchFlights",
            output: { type: "json", value: [{ flight: "MS 787", eur: 210 }] },
          },
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "getBagPolicy",
            output: { type: "text", value: "One bag included." },
          },
        ],
      },
      user("Actually, make it Saturday."),
      assistant("Friday has MS 787 at 210 euros. Checking Saturday."),
    ]);
    expectAnsweredToolCalls(messages);
  });

  it("starts a new assistant message for text that follows answered calls", () => {
    const messages = encodeTimeline(
      [
        { type: "thinker-text", text: "Searching." },
        { type: "tool-call", id: "c1", name: "search", input: {} },
        { type: "tool-result", id: "c1", name: "search", output: { type: "text", value: "ok" } },
        { type: "thinker-text", text: "Found it." },
      ],
      "thinker",
    );

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Searching." },
      { type: "tool-call", toolCallId: "c1", toolName: "search", input: {} },
    ]);
    expect(messages[3]).toEqual(assistant("Found it."));
    expectAnsweredToolCalls(messages);
  });

  it("answers a thinker call that has no result yet", () => {
    const messages = encodeTimeline(
      [{ type: "tool-call", id: "c1", name: "search", input: {} }],
      "thinker",
    );

    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: "Still running." },
        },
      ],
    });
  });

  it("tells each reader where the user cut the agent off", () => {
    const entries: TimelineEntry[] = [
      { type: "agent-speech", text: "You can get a full refund", cutOff: true },
    ];

    expect(encodeTimeline(entries, "talker").slice(1)).toEqual([
      assistant("You can get a full refund"),
      user("<event>The user cut you off. They heard only the text above.</event>"),
    ]);
    expect(encodeTimeline(entries, "thinker")).toEqual([
      user('<agent_said cut_off="true">You can get a full refund</agent_said>'),
    ]);
  });

  it("renders tool errors and denials as text for the talker", () => {
    const messages = encodeTimeline(
      [
        {
          type: "tool-result",
          id: "c1",
          name: "refund",
          output: { type: "error-text", value: "Order not found" },
        },
        {
          type: "tool-result",
          id: "c2",
          name: "refund",
          output: { type: "execution-denied", reason: "Over limit" },
        },
      ],
      "talker",
    );

    expect(messages).toEqual([
      user(
        '<thinker_tool_result name="refund">Error: Order not found</thinker_tool_result>',
        '<thinker_tool_result name="refund">Denied: Over limit</thinker_tool_result>',
      ),
    ]);
  });

  it("tells both readers when the thinker failed", () => {
    const entries: TimelineEntry[] = [{ type: "thinker-error", message: "Model overloaded" }];
    const failure = user("<event>The thinker failed: Model overloaded</event>");

    expect(encodeTimeline(entries, "talker")).toEqual([failure]);
    expect(encodeTimeline(entries, "thinker")).toEqual([failure]);
  });

  it("opens with the user when the agent spoke first", () => {
    expect(
      encodeTimeline(
        [
          { type: "agent-speech", text: "Hi, this is Ava.", cutOff: false },
          { type: "silence", ms: 5000 },
        ],
        "talker",
      ),
    ).toEqual([
      user("<event>The conversation started.</event>"),
      assistant("Hi, this is Ava."),
      user("<event>Nobody has spoken for 5 seconds.</event>"),
    ]);
  });

  it("drops speech that nobody heard", () => {
    expect(
      encodeTimeline(
        [
          { type: "user-speech", text: "  " },
          { type: "agent-speech", text: "", cutOff: true },
        ],
        "talker",
      ),
    ).toEqual([]);
  });
});

describe("talker wake rule", () => {
  it("wakes for thinker text, thinker errors, and silence, not for tool activity", () => {
    expect(shouldWakeTalker([{ type: "silence", ms: 8000 }], 0)).toBe(true);
    expect(shouldWakeTalker([{ type: "thinker-text", text: "Done." }], 0)).toBe(true);
    expect(shouldWakeTalker([{ type: "thinker-error", message: "timeout" }], 0)).toBe(true);
    expect(shouldWakeTalker([{ type: "user-speech", text: "hello" }], 0)).toBe(false);
    expect(
      shouldWakeTalker(
        [
          { type: "tool-call", id: "c1", name: "search", input: {} },
          { type: "tool-result", id: "c1", name: "search", output: { type: "text", value: "" } },
          { type: "agent-speech", text: "Still looking.", cutOff: false },
        ],
        0,
      ),
    ).toBe(false);
  });

  it("ignores entries the talker already spoke after", () => {
    const entries: TimelineEntry[] = [
      { type: "thinker-text", text: "Done." },
      { type: "agent-speech", text: "It's done.", cutOff: false },
    ];

    expect(shouldWakeTalker(entries, 0)).toBe(true);
    expect(shouldWakeTalker(entries, 1)).toBe(false);
  });

  it("adds a delivery note only to a run that follows new thinker text", () => {
    const note =
      "<note>The thinker posted since you last spoke. Tell the user what is new unless you already have.</note>";
    const entries: TimelineEntry[] = [
      { type: "user-speech", text: "Any news?" },
      { type: "thinker-text", text: "MS 787 at 210 euros." },
    ];

    expect(talkerMessages(entries, 0)).toEqual([
      user("Any news?", "<thinker>MS 787 at 210 euros.</thinker>", note),
    ]);
    expect(talkerMessages(entries, 2)).toEqual(encodeTimeline(entries, "talker"));
  });
});
