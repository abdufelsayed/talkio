import { describe, expect, it } from "vitest";

import {
  historyStart,
  shouldWakeTalker,
  stepEntries,
  talkerMessages,
  thinkerMessages,
  uniqueCallId,
  type ThinkerStep,
} from "../../src/agent/timeline";
import type { Message, TimelineEntry } from "../../src/types/common";
import type { ThinkerStepContent } from "../../src/types/events";

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

function call(toolCallId: string, toolName: string, input: unknown = {}) {
  return { type: "tool-call" as const, toolCallId, toolName, input };
}

function result(toolCallId: string, toolName: string, value: string) {
  return {
    type: "tool-result" as const,
    toolCallId,
    toolName,
    output: { type: "text" as const, value },
  };
}

/** The talker's view when the user has heard everything. */
function talkerView(entries: TimelineEntry[]): Message[] {
  return talkerMessages(entries, entries.length);
}

/** Builds a timeline the way the agent does, recording each thinker step. */
function conversation() {
  const timeline: TimelineEntry[] = [];
  const steps: ThinkerStep[] = [];
  const builder = {
    timeline,
    steps,
    add(...entries: TimelineEntry[]) {
      timeline.push(...entries);
      return builder;
    },
    /** A thinker step that read everything so far, or only the first `readThrough` entries. */
    step(content: ThinkerStepContent, readThrough = timeline.length) {
      const entries = stepEntries(content);
      steps.push({
        readThrough,
        start: timeline.length,
        end: timeline.length + entries.length,
        content,
      });
      timeline.push(...entries);
      return builder;
    },
    result(id: string, name: string, value: string) {
      timeline.push({ type: "tool-result", id, name, output: { type: "text", value } });
      return builder;
    },
    thinkerView: () => thinkerMessages(timeline, steps),
  };
  return builder;
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
    const messages = talkerView(flightsSearch);

    expect(messages).toEqual([
      user("Find me a flight to Berlin on Friday."),
      {
        role: "assistant",
        content: [call("t1", "think", { request: "Flights to Berlin on Friday" })],
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
    const messages = conversation()
      .add(
        { type: "user-speech", text: "Find me a flight to Berlin on Friday." },
        { type: "think", id: "t1", request: "Flights to Berlin on Friday" },
        { type: "agent-speech", text: "Sure, let me look.", cutOff: false },
      )
      .step([call("c1", "searchFlights", { to: "BER" }), call("c2", "getBagPolicy")])
      .add({ type: "user-speech", text: "Actually, make it Saturday." })
      .result("c1", "searchFlights", "MS 787")
      .result("c2", "getBagPolicy", "One bag included.")
      .step([{ type: "text", text: "Friday has MS 787. Checking Saturday." }])
      .thinkerView();

    expect(messages).toEqual([
      user(
        "Find me a flight to Berlin on Friday.",
        "<request>Flights to Berlin on Friday</request>",
        "<agent_said>Sure, let me look.</agent_said>",
      ),
      {
        role: "assistant",
        content: [call("c1", "searchFlights", { to: "BER" }), call("c2", "getBagPolicy")],
      },
      {
        role: "tool",
        content: [
          result("c1", "searchFlights", "MS 787"),
          result("c2", "getBagPolicy", "One bag included."),
        ],
      },
      user("Actually, make it Saturday."),
      assistant("Friday has MS 787. Checking Saturday."),
    ]);
    expectAnsweredToolCalls(messages);
  });

  it("shows a step right after what it read, so a request made meanwhile is still open", () => {
    const thread = conversation().add(
      { type: "user-speech", text: "Find me a flight to Berlin." },
      { type: "think", id: "t1", request: "Flights to Berlin" },
    );
    const read = thread.timeline.length;
    thread
      .add(
        { type: "user-speech", text: "And a hotel." },
        { type: "think", id: "t2", request: "A hotel in Berlin" },
      )
      .step([{ type: "text", text: "MS 787 leaves at 9:40." }], read);

    expect(thread.thinkerView()).toEqual([
      user("Find me a flight to Berlin.", "<request>Flights to Berlin</request>"),
      assistant("MS 787 leaves at 9:40."),
      user("And a hotel.", "<request>A hotel in Berlin</request>"),
    ]);
  });

  it("keeps sequential steps apart, so a call never reads as made before the result it used", () => {
    const messages = conversation()
      .add({ type: "think", id: "t1", request: "Book the cheapest flight" })
      .step([call("c1", "searchFlights")])
      .result("c1", "searchFlights", "MS 787")
      .step([call("c2", "bookFlight", { flight: "MS 787" })])
      .result("c2", "bookFlight", "Booked")
      .thinkerView();

    expect(messages.slice(1)).toEqual([
      { role: "assistant", content: [call("c1", "searchFlights")] },
      { role: "tool", content: [result("c1", "searchFlights", "MS 787")] },
      { role: "assistant", content: [call("c2", "bookFlight", { flight: "MS 787" })] },
      { role: "tool", content: [result("c2", "bookFlight", "Booked")] },
    ]);
  });

  it("gives the thinker back its reasoning and provider data with the calls they led to", () => {
    const signed = { anthropic: { signature: "sig" } };
    const thought = { google: { thoughtSignature: "abc" } };
    const messages = conversation()
      .add({ type: "think", id: "t1", request: "Flights" })
      .step([
        { type: "reasoning", text: "Search first.", providerOptions: signed },
        { type: "text", text: "Searching." },
        { ...call("c1", "searchFlights"), providerOptions: thought },
      ])
      .result("c1", "searchFlights", "MS 787")
      .step([
        { type: "reasoning", text: "Done.", providerOptions: signed },
        { type: "text", text: "MS 787." },
      ])
      .thinkerView();

    expect(messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Search first.", providerOptions: signed },
          { type: "text", text: "Searching." },
          { ...call("c1", "searchFlights"), providerOptions: thought },
        ],
      },
      { role: "tool", content: [result("c1", "searchFlights", "MS 787")] },
      assistant("MS 787."),
    ]);
  });

  it("answers a thinker call that has no result yet", () => {
    const messages = conversation()
      .add({ type: "think", id: "t1", request: "Flights" })
      .step([call("c1", "search")])
      .thinkerView();

    expect(messages[2]).toEqual({
      role: "tool",
      content: [result("c1", "search", "Still running.")],
    });
  });

  it("tells each reader where the user cut the agent off", () => {
    const entries: TimelineEntry[] = [
      { type: "agent-speech", text: "You can get a full refund", cutOff: true },
    ];

    expect(talkerView(entries).slice(1)).toEqual([
      assistant("You can get a full refund"),
      user("<event>The user cut you off. They heard only the text above.</event>"),
    ]);
    expect(thinkerMessages(entries, [])).toEqual([
      user('<agent_said cut_off="true">You can get a full refund</agent_said>'),
    ]);
  });

  it("renders tool errors and denials as text for the talker", () => {
    const messages = talkerView([
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
    ]);

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

    expect(talkerView(entries)).toEqual([failure]);
    expect(thinkerMessages(entries, [])).toEqual([failure]);
  });

  it("opens with the user when the agent spoke first", () => {
    expect(
      talkerView([
        { type: "agent-speech", text: "Hi, this is Ava.", cutOff: false },
        { type: "silence", ms: 5000 },
      ]),
    ).toEqual([
      user("<event>The conversation started.</event>"),
      assistant("Hi, this is Ava."),
      user("<event>Nobody has spoken for 5 seconds.</event>"),
    ]);
  });

  it("drops speech that nobody heard", () => {
    expect(
      talkerView([
        { type: "user-speech", text: "  " },
        { type: "agent-speech", text: "", cutOff: true },
      ]),
    ).toEqual([]);
  });
});

describe("thinker steps on the timeline", () => {
  it("adds a finished step's text and keeps narration beside tool calls in the step", () => {
    expect(stepEntries([{ type: "text", text: " MS 787 leaves at 9:40. " }])).toEqual([
      { type: "thinker-text", text: "MS 787 leaves at 9:40." },
    ]);
    expect(
      stepEntries([
        { type: "reasoning", text: "Search first." },
        { type: "text", text: "Let me search." },
        call("c1", "searchFlights", { to: "BER" }),
      ]),
    ).toEqual([{ type: "tool-call", id: "c1", name: "searchFlights", input: { to: "BER" } }]);
    expect(stepEntries([{ type: "reasoning", text: "Nothing new." }])).toEqual([]);
  });

  it("gives a repeated or missing tool call id a fresh one", () => {
    const used = new Set(["call_0", "call_0_2"]);
    expect(uniqueCallId("call_1", used)).toBe("call_1");
    expect(uniqueCallId("call_0", used)).toBe("call_0_3");
    expect(uniqueCallId("", used)).toBe("call_2");
  });
});

describe("history window", () => {
  const words = "word ".repeat(2000);
  const longCall = (count: number): TimelineEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      type: "user-speech",
      text: `${index} ${words}`,
    }));

  it("shows the whole timeline while it fits", () => {
    expect(historyStart(longCall(5))).toBe(0);
  });

  it("drops the oldest entries of a long call and says so", () => {
    const entries = longCall(40);
    const start = historyStart(entries);
    const messages = talkerView(entries);

    expect(start).toBeGreaterThan(0);
    expect(textsOf(messages[0])[0]).toBe(
      "<event>Earlier parts of the conversation are not shown.</event>",
    );
    expect(textsOf(messages[0]).at(-1)).toBe(`39 ${words}`);
    expect(JSON.stringify(entries.slice(start)).length).toBeLessThanOrEqual(100_000);
  });

  it("keeps the same start while the call grows a little, so prompt caches still match", () => {
    const entries = longCall(40);
    const start = historyStart(entries);

    expect(historyStart([...entries, { type: "user-speech", text: "ok" }])).toBe(start);
  });

  it("still shows a thinker step whose entries are newer than the start", () => {
    const thread = conversation().add(...longCall(40));
    const read = 2;
    thread.step([{ type: "text", text: "Found it." }], read);

    expect(thread.thinkerView().at(0)).toMatchObject({ role: "user" });
    expect(thread.thinkerView()).toContainEqual(assistant("Found it."));
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

  it("wakes for the first thinker failure since the user spoke, not the ones after", () => {
    const entries: TimelineEntry[] = [
      { type: "user-speech", text: "Find a flight." },
      { type: "thinker-error", message: "Model overloaded" },
      { type: "agent-speech", text: "Sorry, let me try again.", cutOff: false },
      { type: "thinker-error", message: "Model overloaded" },
    ];

    expect(shouldWakeTalker(entries, 1)).toBe(true);
    expect(shouldWakeTalker(entries, 3)).toBe(false);
    expect(
      shouldWakeTalker(
        [
          ...entries,
          { type: "user-speech", text: "Try once more." },
          { type: "thinker-error", message: "Model overloaded" },
        ],
        4,
      ),
    ).toBe(true);
  });

  it("ignores entries the talker already spoke after", () => {
    const entries: TimelineEntry[] = [
      { type: "thinker-text", text: "Done." },
      { type: "agent-speech", text: "It's done.", cutOff: false },
    ];

    expect(shouldWakeTalker(entries, 0)).toBe(true);
    expect(shouldWakeTalker(entries, 1)).toBe(false);
  });

  it("adds a delivery note only to a run that follows news the user has not heard", () => {
    const note =
      "<note>The thinker posted since you last spoke. Tell the user what is new unless you already have.</note>";
    const entries: TimelineEntry[] = [
      { type: "user-speech", text: "Any news?" },
      { type: "thinker-text", text: "MS 787 at 210 euros." },
    ];

    expect(talkerMessages(entries, 0)).toEqual([
      user("Any news?", "<thinker>MS 787 at 210 euros.</thinker>", note),
    ]);
    expect(talkerMessages(entries, 2)).toEqual([
      user("Any news?", "<thinker>MS 787 at 210 euros.</thinker>"),
    ]);
  });
});

function textsOf(message: Message | undefined): string[] {
  if (!message || typeof message.content === "string" || message.role === "tool") return [];
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}
