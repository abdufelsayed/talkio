import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createAgent, type AgentEvent, type Message } from "talkio";
import { describe, expect, it, vi } from "vitest";

import { createFakeSTT, createFakeTTS, createLLMContextProbe } from "@talkio/testkit";

import { aiSdk } from "../src";

type StreamPart = Parameters<
  typeof simulateReadableStream<
    Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer T>
      ? T
      : never
  >
>[0]["chunks"][number];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textReply(text: string) {
  const chunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
  return { stream: simulateReadableStream({ chunks }) };
}

function toolReply(toolCallId: string, toolName: string, input: unknown) {
  const chunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
  return { stream: simulateReadableStream({ chunks }) };
}

/** Replies to each call in turn. The mock's own array form skips the first reply. */
function scripted(...replies: Array<() => ReturnType<typeof textReply>>) {
  let next = 0;
  return async () => {
    const reply = replies[next++];
    if (!reply) throw new Error("No scripted reply left");
    return reply();
  };
}

const conversation: Message[] = [
  { role: "system", content: "You are Ava." },
  { role: "user", content: [{ type: "text", text: "Find me a flight." }] },
];

describe("aiSdk", () => {
  it("streams text as tokens and completes", async () => {
    const model = new MockLanguageModelV3({ doStream: textReply("Sure, one moment.") });
    const probe = createLLMContextProbe({ messages: conversation });

    await aiSdk(model).generate(probe.context);

    expect(probe.tokens).toEqual(["Sure, one moment."]);
    expect(probe.completions).toEqual([undefined]);
    expect(model.doStreamCalls[0]?.prompt).toEqual([
      { role: "system", content: "You are Ava." },
      { role: "user", content: [{ type: "text", text: "Find me a flight." }] },
    ]);
    expect(model.doStreamCalls[0]?.tools).toBeUndefined();
  });

  it("reports tool calls without running them, with JSON Schema tools wrapped", async () => {
    const model = new MockLanguageModelV3({
      doStream: toolReply("t1", "think", { request: "Flights to Berlin" }),
    });
    const inputSchema = {
      type: "object",
      properties: { request: { type: "string" } },
      required: ["request"],
    };
    const probe = createLLMContextProbe({
      messages: conversation,
      tools: { think: { description: "Hand work to the thinker", inputSchema } },
    });

    await aiSdk(model).generate(probe.context);

    expect(probe.toolCalls).toEqual([
      { toolCallId: "t1", toolName: "think", input: { request: "Flights to Berlin" } },
    ]);
    expect(probe.completions).toHaveLength(1);
    expect(model.doStreamCalls[0]?.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "think",
        description: "Hand work to the thinker",
        inputSchema,
      }),
    ]);
  });

  it("reports a call whose input does not parse as invalid, so the tool does not run", async () => {
    const chunks: StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "searchFlights", input: '{"to": BER' },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ];
    const model = new MockLanguageModelV3({
      doStream: { stream: simulateReadableStream({ chunks }) },
    });
    const probe = createLLMContextProbe({
      messages: conversation,
      tools: { searchFlights: { inputSchema: { type: "object", properties: {} } } },
    });

    await aiSdk(model).generate(probe.context);

    expect(probe.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "c1",
        toolName: "searchFlights",
        error: expect.any(String),
      }),
    ]);
    expect(probe.errors).toEqual([]);
    expect(probe.completions).toHaveLength(1);
  });

  it("reports reasoning and provider data, and sends them back as the AI SDK expects", async () => {
    const signed = { anthropic: { signature: "sig" } };
    const thought = { google: { thoughtSignature: "abc" } };
    const chunks: StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "Search first." },
      { type: "reasoning-end", id: "r", providerMetadata: signed },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "searchFlights",
        input: "{}",
        providerMetadata: thought,
      },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ];
    const model = new MockLanguageModelV3({
      doStream: scripted(
        () => ({ stream: simulateReadableStream({ chunks }) }),
        () => textReply("Done."),
      ),
    });
    const tools = { searchFlights: { inputSchema: { type: "object", properties: {} } } };
    const first = createLLMContextProbe({ messages: conversation, tools });

    await aiSdk(model).generate(first.context);

    expect(first.reasoning).toEqual([{ text: "Search first.", providerOptions: signed }]);
    expect(first.toolCalls).toEqual([
      { toolCallId: "c1", toolName: "searchFlights", input: {}, providerOptions: thought },
    ]);

    const second = createLLMContextProbe({
      tools,
      messages: [
        ...conversation,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Search first.", providerOptions: signed },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "searchFlights",
              input: {},
              providerOptions: thought,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "searchFlights",
              output: { type: "text", value: "MS 787" },
            },
          ],
        },
      ],
    });
    await aiSdk(model).generate(second.context);

    expect(model.doStreamCalls[1]?.prompt.at(-2)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Search first.", providerOptions: signed },
        expect.objectContaining({ type: "tool-call", toolCallId: "c1", providerOptions: thought }),
      ],
      providerOptions: undefined,
    });
  });

  it("reports a failed call as an error", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("rate limited");
      },
    });
    const probe = createLLMContextProbe({ messages: conversation });

    await aiSdk(model).generate(probe.context);

    expect(probe.errors.map((error) => error.message)).toEqual(["rate limited"]);
    expect(probe.completions).toEqual([]);
  });

  it("passes settings through to every call", async () => {
    const model = new MockLanguageModelV3({ doStream: textReply("Hi.") });
    const probe = createLLMContextProbe({ messages: conversation });

    await aiSdk(model, { temperature: 0.2, maxOutputTokens: 64 }).generate(probe.context);

    expect(model.doStreamCalls[0]).toMatchObject({ temperature: 0.2, maxOutputTokens: 64 });
  });

  it("runs a whole talker and thinker conversation through the AI SDK", async () => {
    const talker = new MockLanguageModelV3({
      modelId: "talker",
      doStream: scripted(
        () => toolReply("t1", "think", { request: "Flights to Berlin" }),
        () => textReply("Let me look that up."),
        () => textReply("I found MS 787, leaving at 9:40."),
      ),
    });
    const thinker = new MockLanguageModelV3({
      modelId: "thinker",
      doStream: scripted(
        () => toolReply("c1", "searchFlights", { to: "BER" }),
        () => textReply("MS 787 leaves at 9:40."),
      ),
    });
    const searchFlights = tool({
      description: "Search flights",
      inputSchema: jsonSchema<{ to: string }>({
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      }),
      execute: async ({ to }) => [{ flight: "MS 787", to, departs: "09:40" }],
    });
    const stt = createFakeSTT();
    const tts = createFakeTTS();
    const events: AgentEvent[] = [];
    const agent = createAgent({
      stt: stt.provider,
      tts: tts.provider,
      talker: aiSdk(talker),
      thinker: aiSdk(thinker),
      instructions: "You are Ava, a travel agent.",
      tools: { searchFlights },
      onEvent: (event) => events.push(event),
    });

    const finishSpeaking = async (text: string) => {
      await vi.waitFor(() => expect(tts.requestedTexts.at(-1)).toBe(text));
      tts.emitAudio(new Uint8Array([1]).buffer);
      tts.complete();
    };

    agent.start();
    stt.emitTranscript("find me a flight to Berlin", true);
    await finishSpeaking("Let me look that up.");
    await finishSpeaking("I found MS 787, leaving at 9:40.");

    expect(events.filter((event) => event.type === "agent:error")).toEqual([]);
    // Speech joins the timeline once heard, so where the first reply lands among
    // the thinker's entries depends on how fast the thinker was.
    const timeline = agent.getSnapshot().timeline;
    expect(timeline.filter((entry) => entry.type === "agent-speech")).toEqual([
      { type: "agent-speech", text: "Let me look that up.", cutOff: false },
      { type: "agent-speech", text: "I found MS 787, leaving at 9:40.", cutOff: false },
    ]);
    expect(timeline.filter((entry) => entry.type !== "agent-speech")).toEqual([
      { type: "user-speech", text: "find me a flight to Berlin" },
      { type: "think", id: "t1", request: "Flights to Berlin" },
      { type: "tool-call", id: "c1", name: "searchFlights", input: { to: "BER" } },
      {
        type: "tool-result",
        id: "c1",
        name: "searchFlights",
        output: { type: "json", value: [{ flight: "MS 787", to: "BER", departs: "09:40" }] },
      },
      { type: "thinker-text", text: "MS 787 leaves at 9:40." },
    ]);
    // The thinker's step sits where it read the timeline, before or after the
    // talker's first reply depending on which came first.
    const thinkerPrompt = thinker.doStreamCalls[1]?.prompt ?? [];
    const step = thinkerPrompt.findIndex((message) => message.role === "assistant");
    expect(thinkerPrompt.slice(step, step + 2)).toEqual([
      {
        role: "assistant",
        content: [
          expect.objectContaining({
            type: "tool-call",
            toolCallId: "c1",
            toolName: "searchFlights",
            input: { to: "BER" },
          }),
        ],
      },
      {
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "c1",
            output: { type: "json", value: [{ flight: "MS 787", to: "BER", departs: "09:40" }] },
          }),
        ],
      },
    ]);
    const lastTalkerPrompt = talker.doStreamCalls[2]?.prompt ?? [];
    expect(lastTalkerPrompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(lastTalkerPrompt)).toContain("<thinker>MS 787 leaves at 9:40.</thinker>");
    expect(JSON.stringify(lastTalkerPrompt.at(-1))).toContain("<note>");
    agent.stop();
  });
});
