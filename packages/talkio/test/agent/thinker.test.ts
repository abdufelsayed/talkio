import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../../src/providers/types";
import type { Message } from "../../src/types/common";
import { audioChunk, createTestAgent, type TestAgent } from "../helpers/agent-harness";

const DELIVERY_NOTE =
  "<note>The thinker posted since you last spoke. Tell the user what is new unless you already have.</note>";

function user(...texts: string[]): Message {
  return { role: "user", content: texts.map((text) => ({ type: "text", text })) };
}

function textsOf(message: Message | undefined): string[] {
  if (!message || typeof message.content === "string" || message.role === "tool") return [];
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

function searchFlights(execute: Tool["execute"] = () => [{ flight: "MS 787", departs: "09:40" }]) {
  return { searchFlights: { description: "Search flights", inputSchema: {}, execute } };
}

/** The talker says `sentence` and the user hears all of it. */
function say(harness: TestAgent, sentence: string) {
  harness.llm.emitSentence(sentence, 0);
  harness.tts.emitAudio(audioChunk(1));
  harness.tts.complete();
  harness.llm.complete(sentence);
}

/** The user asks for flights and the talker hands the request to the thinker. */
function askForFlights(harness: TestAgent) {
  harness.agent.start();
  harness.stt.emitTranscript("find me a flight to Berlin", true);
  harness.llm.toolCall({
    toolCallId: "t1",
    toolName: "think",
    input: { request: "Flights to Berlin" },
  });
  harness.llm.complete();
  say(harness, "Let me look that up.");
}

describe("talker and thinker", () => {
  it("hands work to the thinker and keeps talking", () => {
    const harness = createTestAgent({ tools: searchFlights(), instructions: "You are Ava." });
    const { agent, stt, llm, thinker } = harness;
    agent.start();
    stt.emitTranscript("find me a flight to Berlin", true);

    expect(Object.keys(llm.getContext()?.tools ?? {})).toEqual(["think"]);
    expect(llm.system).toContain("Call think to hand it a request");
    expect(llm.system).toContain("# Instructions\n\nYou are Ava.");

    llm.toolCall({ toolCallId: "t1", toolName: "think", input: { request: "Flights to Berlin" } });
    expect(thinker?.generations).toBe(1);
    expect(thinker?.system).toContain("You are the thinker behind a realtime voice agent.");
    expect(thinker?.system).toContain("# Instructions\n\nYou are Ava.");
    expect(Object.keys(thinker?.getContext()?.tools ?? {})).toEqual(["searchFlights"]);
    expect(thinker?.messages).toEqual([
      user("find me a flight to Berlin", "<request>Flights to Berlin</request>"),
    ]);

    llm.complete();
    expect(llm.generations).toBe(2);
    expect(llm.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "think",
            input: { request: "Flights to Berlin" },
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
    ]);
    say(harness, "Let me look that up.");
    expect(harness.ofType("agent-turn:ended")).toMatchObject([{ text: "Let me look that up." }]);
    agent.stop();
  });

  it("runs the thinker's tools and wakes the talker with what it found", async () => {
    const execute = vi.fn(() => [{ flight: "MS 787", departs: "09:40" }]);
    const harness = createTestAgent({ tools: searchFlights(execute) });
    const { agent, llm, thinker } = harness;
    askForFlights(harness);

    thinker?.toolCall({ toolCallId: "c1", toolName: "searchFlights", input: { to: "BER" } });
    thinker?.complete();
    await vi.waitFor(() => expect(thinker?.generations).toBe(2));
    expect(execute).toHaveBeenCalledWith(
      { to: "BER" },
      expect.objectContaining({ toolCallId: "c1", abortSignal: expect.any(AbortSignal) }),
    );
    expect(llm.generations).toBe(2);

    thinker?.complete("MS 787 leaves at 9:40.");
    await vi.waitFor(() => expect(llm.generations).toBe(3));
    expect(agent.getSnapshot().timeline).toEqual([
      { type: "user-speech", text: "find me a flight to Berlin" },
      { type: "think", id: "t1", request: "Flights to Berlin" },
      { type: "agent-speech", text: "Let me look that up.", cutOff: false },
      { type: "tool-call", id: "c1", name: "searchFlights", input: { to: "BER" } },
      {
        type: "tool-result",
        id: "c1",
        name: "searchFlights",
        output: { type: "json", value: [{ flight: "MS 787", departs: "09:40" }] },
      },
      { type: "thinker-text", text: "MS 787 leaves at 9:40." },
    ]);
    expect(textsOf(llm.messages.at(-1))).toEqual([
      '<thinker_tool_call name="searchFlights">{"to":"BER"}</thinker_tool_call>',
      '<thinker_tool_result name="searchFlights">[{"flight":"MS 787","departs":"09:40"}]</thinker_tool_result>',
      "<thinker>MS 787 leaves at 9:40.</thinker>",
      DELIVERY_NOTE,
    ]);

    say(harness, "I found MS 787, leaving at 9:40.");
    expect(llm.generations).toBe(3);
    expect(harness.ofType("agent-turn:ended").map((event) => event.text)).toEqual([
      "Let me look that up.",
      "I found MS 787, leaving at 9:40.",
    ]);
    agent.stop();
  });

  it("waits for the user to finish before delivering, and delivers in the reply", async () => {
    const harness = createTestAgent({ vad: true, tools: searchFlights() });
    const { llm, thinker, vad, stt } = harness;
    askForFlights(harness);

    vad?.emitSpeechStart();
    stt.emitTranscript("is it", false);
    vad?.emitSpeechEnd(400);
    thinker?.complete("MS 787 leaves at 9:40.");
    await vi.waitFor(() =>
      expect(harness.agent.getSnapshot().timeline.at(-1)).toMatchObject({ type: "thinker-text" }),
    );
    expect(llm.generations).toBe(2);

    stt.emitTranscript("is it a direct flight", true);
    expect(llm.generations).toBe(3);
    expect(textsOf(llm.messages.at(-1))).toEqual([
      "<thinker>MS 787 leaves at 9:40.</thinker>",
      "is it a direct flight",
      DELIVERY_NOTE,
    ]);
    say(harness, "Yes, MS 787 at 9:40 is direct.");
    expect(llm.generations).toBe(3);
    harness.agent.stop();
  });

  it("brings the news up again when the user cut off its delivery", async () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, thinker, stt, tts, clock } = harness;
    askForFlights(harness);
    thinker?.complete("MS 787 leaves at 9:40.");
    await vi.waitFor(() => expect(llm.generations).toBe(3));

    llm.emitSentence("I found a flight.", 0);
    // 100ms of 24kHz 16-bit mono audio, so the cut lands mid-reply.
    tts.emitAudio(new ArrayBuffer(4800));
    clock.increment(20);
    stt.emitTranscript("wait", true);

    expect(llm.generations).toBe(4);
    expect(textsOf(llm.messages.at(-1)).at(-1)).toBe(DELIVERY_NOTE);
    harness.agent.stop();
  });

  it("lets a new request join the run in progress", async () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, thinker, stt } = harness;
    askForFlights(harness);

    stt.emitTranscript("make it Saturday", true);
    llm.toolCall({ toolCallId: "t2", toolName: "think", input: { request: "Saturday instead" } });
    llm.complete();
    say(harness, "Sure, Saturday.");
    expect(thinker?.generations).toBe(1);

    thinker?.complete("");
    await vi.waitFor(() => expect(thinker?.generations).toBe(2));
    expect(textsOf(thinker?.messages.at(-1)).slice(-3)).toEqual([
      "make it Saturday",
      "<request>Saturday instead</request>",
      "<agent_said>Sure, Saturday.</agent_said>",
    ]);
    thinker?.complete("");
    await vi.waitFor(() =>
      expect(harness.ofType("timeline:entry").map((event) => event.entry.type)).not.toContain(
        "thinker-text",
      ),
    );
    harness.agent.stop();
  });

  it("starts a new run for a request that arrives after the thinker finished", async () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, thinker, stt } = harness;
    askForFlights(harness);
    thinker?.complete("MS 787 leaves at 9:40.");
    await vi.waitFor(() => expect(llm.generations).toBe(3));
    say(harness, "MS 787 leaves at 9:40.");

    stt.emitTranscript("and a hotel", true);
    llm.toolCall({ toolCallId: "t2", toolName: "think", input: { request: "A hotel in Berlin" } });
    expect(thinker?.generations).toBe(2);
    harness.agent.stop();
  });

  it("gives the thinker a tool's error as its result", async () => {
    const harness = createTestAgent({
      tools: searchFlights(() => {
        throw new Error("Flight API is down");
      }),
    });
    const { thinker } = harness;
    askForFlights(harness);

    thinker?.toolCall({ toolCallId: "c1", toolName: "searchFlights", input: {} });
    thinker?.toolCall({ toolCallId: "c2", toolName: "bookHotel", input: {} });
    thinker?.complete();
    await vi.waitFor(() => expect(thinker?.generations).toBe(2));
    expect(
      harness.agent.getSnapshot().timeline.filter((entry) => entry.type === "tool-result"),
    ).toEqual([
      {
        type: "tool-result",
        id: "c1",
        name: "searchFlights",
        output: { type: "error-text", value: "Flight API is down" },
      },
      {
        type: "tool-result",
        id: "c2",
        name: "bookHotel",
        output: { type: "error-text", value: "Unknown tool: bookHotel" },
      },
    ]);
    harness.agent.stop();
  });

  it("reports a failed thinker and lets the talker tell the user", async () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, thinker } = harness;
    askForFlights(harness);

    thinker?.error(new Error("Model overloaded"));
    await vi.waitFor(() => expect(llm.generations).toBe(3));
    expect(harness.ofType("agent:error")).toMatchObject([
      { source: "thinker", error: { message: "Model overloaded" } },
    ]);
    expect(harness.agent.getSnapshot().timeline.at(-1)).toEqual({
      type: "thinker-error",
      message: "Model overloaded",
    });
    expect(textsOf(llm.messages.at(-1)).slice(-2)).toEqual([
      "<event>The thinker failed: Model overloaded</event>",
      DELIVERY_NOTE,
    ]);
    harness.agent.stop();
  });

  it("does not wake a talker that failed again at once", async () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, thinker } = harness;
    askForFlights(harness);
    thinker?.complete("MS 787 leaves at 9:40.");
    await vi.waitFor(() => expect(llm.generations).toBe(3));

    llm.error(new Error("Talker overloaded"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(llm.generations).toBe(3);
    expect(harness.ofType("agent:error")).toMatchObject([{ source: "talker" }]);
    harness.agent.stop();
  });

  it("aborts running tools when the agent stops", async () => {
    let signal: AbortSignal | undefined;
    const harness = createTestAgent({
      tools: searchFlights((_input: never, options) => {
        signal = options.abortSignal;
        return new Promise(() => {});
      }),
    });
    askForFlights(harness);
    harness.thinker?.toolCall({ toolCallId: "c1", toolName: "searchFlights", input: {} });
    harness.thinker?.complete();
    await vi.waitFor(() => expect(signal).toBeDefined());

    harness.agent.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("answers a tool the talker does not have with an error", () => {
    const harness = createTestAgent({ tools: searchFlights() });
    const { llm, stt, agent } = harness;
    agent.start();
    stt.emitTranscript("book it", true);
    llm.toolCall({ toolCallId: "x1", toolName: "bookFlight", input: {} });
    llm.complete();

    expect(llm.messages.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "x1",
          toolName: "bookFlight",
          output: { type: "error-text", value: "Unknown tool: bookFlight" },
        },
      ],
    });
    expect(agent.getSnapshot().timeline).toEqual([{ type: "user-speech", text: "book it" }]);
    agent.stop();
  });

  it("answers think as an unknown tool when there is no thinker", () => {
    const harness = createTestAgent();
    const { llm, stt, agent } = harness;
    agent.start();
    stt.emitTranscript("find me a flight", true);
    llm.toolCall({ toolCallId: "t1", toolName: "think", input: { request: "Flights" } });
    llm.complete();

    expect(llm.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [{ output: { type: "error-text", value: "Unknown tool: think" } }],
    });
    expect(agent.getSnapshot().timeline).toEqual([
      { type: "user-speech", text: "find me a flight" },
    ]);
    agent.stop();
  });

  it("gives the talker no tools when there is no thinker", () => {
    const harness = createTestAgent({ instructions: "You are Ava." });
    harness.agent.start();
    harness.stt.emitTranscript("hello", true);

    expect(harness.llm.getContext()?.tools).toEqual({});
    expect(harness.llm.system).not.toContain("think");
    expect(harness.llm.system).toContain("# Instructions\n\nYou are Ava.");
    harness.agent.stop();
  });
});
