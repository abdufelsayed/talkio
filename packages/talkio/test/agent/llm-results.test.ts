import { describe, expect, it, vi } from "vitest";
import { SimulatedClock } from "xstate";

import { createAgent, type LLMContext, type LLMFunction } from "../../src";
import type { PublicAgentEvent } from "../../src/types/events";
import { audioChunk } from "../helpers/agent-harness";
import { createFakeSTT, createFakeTTS } from "../helpers/fake-providers";

/** A text stream the test feeds chunk by chunk. */
function createTextStream() {
  const queue: Array<IteratorResult<string>> = [];
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let returned = false;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const stream: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          if (failure) throw failure;
          const next = queue.shift();
          if (next) return next;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return {
    stream,
    push: (text: string) => {
      queue.push({ done: false, value: text });
      notify();
    },
    end: () => {
      queue.push({ done: true, value: undefined });
      notify();
    },
    fail: (error: Error) => {
      failure = error;
      notify();
    },
    get returned() {
      return returned;
    },
  };
}

function createLLMAgent(llm: LLMFunction) {
  const stt = createFakeSTT();
  const tts = createFakeTTS();
  const events: PublicAgentEvent[] = [];
  const agent = createAgent({
    stt: stt.provider,
    llm,
    tts: tts.provider,
    clock: new SimulatedClock(),
    onEvent: (event) => events.push(event),
  });
  agent.start();
  const ofType = <T extends PublicAgentEvent["type"]>(type: T) =>
    events.filter((event): event is PublicAgentEvent & { type: T } => event.type === type);
  return { agent, stt, tts, ofType };
}

describe("LLM results", () => {
  it.each(["returned", "resolved"])("speaks a stream of text the function %s", async (how) => {
    const text = createTextStream();
    const { agent, stt, tts, ofType } = createLLMAgent(
      (): ReturnType<LLMFunction> =>
        how === "returned" ? text.stream : Promise.resolve(text.stream),
    );

    stt.emitTranscript("what time is it", true);
    text.push("It is ");
    text.push("noon. Anything ");
    text.push("else?");
    await vi.waitFor(() =>
      expect(ofType("agent-turn:sentence").map((event) => event.sentence)).toEqual(["It is noon."]),
    );
    text.end();
    await vi.waitFor(() => expect(ofType("agent-turn:sentence")).toHaveLength(2));

    tts.emitAudio(audioChunk(1));
    tts.complete();
    tts.emitAudio(audioChunk(2));
    tts.complete();
    expect(tts.requestedTexts).toEqual(["It is noon.", "Anything else?"]);
    expect(ofType("agent-turn:token").map((event) => event.token)).toEqual([
      "It is ",
      "noon. Anything ",
      "else?",
    ]);
    expect(ofType("agent-turn:ended")).toMatchObject([{ text: "It is noon. Anything else?" }]);
    expect(agent.getSnapshot().messages.at(-1)).toEqual({
      role: "assistant",
      content: "It is noon. Anything else?",
    });
    agent.stop();
  });

  it("completes with the streamed tokens when complete is called without text", async () => {
    const { agent, stt, tts, ofType } = createLLMAgent((ctx) => {
      ctx.token("Sure. ");
      ctx.token("Done.");
      ctx.complete();
    });

    stt.emitTranscript("go", true);
    await vi.waitFor(() => expect(ofType("agent-turn:sentence")).toHaveLength(2));
    tts.emitAudio(audioChunk(1));
    tts.complete();
    tts.emitAudio(audioChunk(2));
    tts.complete();
    expect(tts.requestedTexts).toEqual(["Sure.", "Done."]);
    expect(ofType("agent-turn:ended")).toMatchObject([{ text: "Sure. Done." }]);
    agent.stop();
  });

  it("reports an error the stream throws", async () => {
    const text = createTextStream();
    const { agent, stt, ofType } = createLLMAgent(() => text.stream);

    stt.emitTranscript("hello", true);
    text.push("Hel");
    text.fail(new Error("rate limited"));
    await vi.waitFor(() =>
      expect(ofType("agent:error")).toMatchObject([
        { source: "llm", error: { message: "rate limited" } },
      ]),
    );
    agent.stop();
  });

  it("reports a rejected promise", async () => {
    const { agent, stt, ofType } = createLLMAgent(async () => {
      throw new Error("bad request");
    });

    stt.emitTranscript("hello", true);
    await vi.waitFor(() =>
      expect(ofType("agent:error")).toMatchObject([
        { source: "llm", error: { message: "bad request" } },
      ]),
    );
    agent.stop();
  });

  it("stops reading the stream and reports nothing once the generation is aborted", async () => {
    const generations: Array<{ ctx: LLMContext; text: ReturnType<typeof createTextStream> }> = [];
    const { agent, stt, ofType } = createLLMAgent((ctx) => {
      const text = createTextStream();
      generations.push({ ctx, text });
      return text.stream;
    });

    stt.emitTranscript("tell me a story", true);
    const first = generations[0];
    first?.text.push("Once ");
    await vi.waitFor(() => expect(ofType("agent-turn:token")).toHaveLength(1));
    stt.emitTranscript("actually never mind", true);
    expect(first?.ctx.signal.aborted).toBe(true);
    expect(generations).toHaveLength(2);

    first?.text.push("upon ");
    await vi.waitFor(() => expect(first?.text.returned).toBe(true));
    expect(ofType("agent-turn:token")).toHaveLength(1);
    expect(ofType("agent:error")).toHaveLength(0);
    agent.stop();
  });

  it("ignores a rejection after the generation was aborted", async () => {
    const rejects: Array<(error: Error) => void> = [];
    const { agent, stt, ofType } = createLLMAgent(
      () => new Promise<void>((_resolve, reject) => rejects.push(reject)),
    );

    stt.emitTranscript("tell me a story", true);
    stt.emitTranscript("actually never mind", true);
    expect(rejects).toHaveLength(2);
    rejects[0]?.(new Error("The operation was aborted"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ofType("agent:error")).toHaveLength(0);
    agent.stop();
  });
});
