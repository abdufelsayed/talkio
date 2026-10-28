import { createAgent, type PublicAgentEvent, type TurnDetectorInput } from "talkio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSTTProviderConformance,
  createFakeLLM,
  createFakeTTS,
  createFakeVAD,
  createSTTContextProbe,
  installMockWebSocket,
  type MockWebSocketController,
} from "@talkio/testkit";

import { createDeepgram, createDeepgramFlux } from "../src";

let webSocketController: MockWebSocketController | undefined;

function mockWebSocket(): MockWebSocketController {
  webSocketController = installMockWebSocket();
  return webSocketController;
}

function turnInfo(event: string, transcript: string, confidence = 0.1): string {
  return JSON.stringify({
    type: "TurnInfo",
    request_id: "request",
    sequence_id: 1,
    event,
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 1,
    transcript,
    words: [],
    end_of_turn_confidence: confidence,
    ...(event === "EndOfTurn" ? { trigger: "model" } : {}),
  });
}

afterEach(() => {
  webSocketController?.restore();
  webSocketController = undefined;
});

describe("@talkio/deepgram Flux", () => {
  it("declares native turn detection and Flux input formats", () => {
    const flux = createDeepgram({ apiKey: "test-key" }).flux();

    assertSTTProviderConformance(flux, { expectedName: "Deepgram Flux" });
    expect(flux.metadata.turnDetection).toBe(true);
    expect(flux.metadata.defaultInputFormat).toEqual({
      encoding: "linear16",
      sampleRate: 16000,
      channels: 1,
    });
    expect(flux.metadata.supportedInputFormats).toContainEqual({
      encoding: "mulaw",
      sampleRate: 8000,
      channels: 1,
    });
    expect(flux.metadata.supportedInputFormats).toContainEqual({
      encoding: "linear16",
      sampleRate: 44100,
      channels: 1,
    });
  });

  it("connects to /v2/listen with turn detection parameters", () => {
    const sockets = mockWebSocket();
    const flux = createDeepgramFlux({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "flux-general-multi",
      eotThreshold: 0.8,
      eagerEotThreshold: 0.5,
      eotTimeoutMs: 3000,
      keyterms: ["Talkio", "barge-in"],
      languageHints: ["en", "es"],
    });

    flux.start(
      createSTTContextProbe({ audioFormat: { encoding: "mulaw", sampleRate: 8000 } }).context,
    );
    const socket = sockets.nextSocket();
    const url = new URL(socket.url);

    expect(socket.protocols).toEqual(["token", "test-key"]);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://deepgram.test/v2/listen");
    expect(url.searchParams.get("model")).toBe("flux-general-multi");
    expect(url.searchParams.get("encoding")).toBe("mulaw");
    expect(url.searchParams.get("sample_rate")).toBe("8000");
    expect(url.searchParams.get("eot_threshold")).toBe("0.8");
    expect(url.searchParams.get("eager_eot_threshold")).toBe("0.5");
    expect(url.searchParams.get("eot_timeout_ms")).toBe("3000");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Talkio", "barge-in"]);
    expect(url.searchParams.getAll("language_hint")).toEqual(["en", "es"]);
    flux.stop();
  });

  it("rejects settings Deepgram would refuse", () => {
    expect(() => createDeepgramFlux({ eotThreshold: 0.4 })).toThrow(RangeError);
    expect(() => createDeepgramFlux({ eagerEotThreshold: 0.95 })).toThrow(RangeError);
    expect(() => createDeepgramFlux({ eotTimeoutMs: 100 })).toThrow(RangeError);
    expect(() => createDeepgramFlux({ eotThreshold: 0.6, eagerEotThreshold: 0.7 })).toThrow(
      "must not exceed eotThreshold",
    );
    expect(() => createDeepgramFlux({ languageHints: ["es"] })).toThrow("flux-general-multi");
  });

  it("maps Flux turn events to transcripts, speech events, and turn signals", () => {
    const sockets = mockWebSocket();
    const flux = createDeepgramFlux({ apiKey: "test-key", baseUrl: "deepgram.test" });
    const probe = createSTTContextProbe();
    flux.start(probe.context);
    const socket = sockets.nextSocket();

    const early = new Uint8Array([1]).buffer;
    flux.sendAudio(early);
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent[0]).toBe(early);

    socket.receive(JSON.stringify({ type: "Connected", request_id: "request", sequence_id: 0 }));
    socket.receive(turnInfo("Update", ""));
    socket.receive(turnInfo("StartOfTurn", "Hi I"));
    socket.receive(turnInfo("Update", "Hi I"));
    socket.receive(turnInfo("Update", "Hi I need to cancel", 0.3));
    socket.receive(turnInfo("EagerEndOfTurn", "Hi I need to cancel", 0.5));
    socket.receive(turnInfo("TurnResumed", "Hi I need to cancel my plan", 0.1));
    socket.receive(turnInfo("EndOfTurn", "Hi I need to cancel my plan.", 0.8));

    expect(probe.speechStarts).toBe(1);
    expect(probe.speechEnds).toBe(1);
    expect(probe.transcripts).toEqual([
      { text: "Hi I", isFinal: false },
      { text: "Hi I need to cancel", isFinal: false },
      { text: "Hi I need to cancel my plan", isFinal: false },
      { text: "Hi I need to cancel my plan.", isFinal: true },
    ]);
    expect(probe.turnSignals).toEqual([
      { type: "probability", probability: 0.1 },
      { type: "probability", probability: 0.3 },
      { type: "eagerEnd", transcript: "Hi I need to cancel" },
      { type: "resumed" },
      { type: "end", transcript: "Hi I need to cancel my plan." },
    ]);

    socket.receive(
      JSON.stringify({ type: "Error", sequence_id: 9, code: "BAD_AUDIO", description: "bad" }),
    );
    expect(probe.errors[0]?.message).toContain("BAD_AUDIO");

    flux.stop();
    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.closeCalls).toBe(1);
  });

  it("sends no KeepAlive messages, which Deepgram documents only for /v1/listen", () => {
    vi.useFakeTimers();
    try {
      const sockets = mockWebSocket();
      const flux = createDeepgramFlux({ apiKey: "test-key", baseUrl: "deepgram.test" });
      flux.start(createSTTContextProbe().context);
      const socket = sockets.nextSocket();
      socket.open();
      vi.advanceTimersByTime(20_000);
      expect(socket.sent).toHaveLength(0);
      flux.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers audio while connecting", () => {
    const sockets = mockWebSocket();
    const flux = createDeepgramFlux({ apiKey: "test-key", baseUrl: "deepgram.test" });
    flux.start(createSTTContextProbe().context);
    const socket = sockets.nextSocket(0);
    const early = new Uint8Array([2]).buffer;
    flux.sendAudio(early);
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toBe(early);
    flux.stop();
  });

  it("ends the turn a dropped stream was in once it reconnects", () => {
    vi.useFakeTimers();
    try {
      const sockets = mockWebSocket();
      const flux = createDeepgramFlux({ apiKey: "test-key", baseUrl: "deepgram.test" });
      const probe = createSTTContextProbe();
      flux.start(probe.context);
      const first = sockets.nextSocket(0);
      first.open();
      first.receive(turnInfo("StartOfTurn", "I want to"));
      first.receive(turnInfo("Update", "I want to book"));
      first.closeFromServer(1011, "internal error");
      expect(probe.speechEnds).toBe(0);

      vi.advanceTimersByTime(250);
      sockets.nextSocket(1).open();
      expect(probe.transcripts.at(-1)).toEqual({ text: "I want to book", isFinal: true });
      expect(probe.speechEnds).toBe(1);
      expect(probe.turnSignals.at(-1)).toEqual({ type: "end", transcript: "I want to book" });
      expect(probe.errors).toHaveLength(0);
      flux.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an agent prepare its reply on EagerEndOfTurn and play it on EndOfTurn", () => {
    const sockets = mockWebSocket();
    const llm = createFakeLLM();
    const tts = createFakeTTS();
    const events: PublicAgentEvent[] = [];
    const agent = createAgent({
      stt: createDeepgramFlux({
        apiKey: "test-key",
        baseUrl: "deepgram.test",
        eagerEotThreshold: 0.5,
      }),
      llm: llm.provider,
      tts: tts.provider,
      onEvent: (event) => events.push(event),
    });
    agent.start();
    const socket = sockets.nextSocket();
    socket.open();

    socket.receive(turnInfo("StartOfTurn", "what time"));
    socket.receive(turnInfo("EagerEndOfTurn", "what time is it", 0.55));
    expect(llm.generations).toBe(1);
    llm.emitSentence("It is noon.", 0);
    tts.emitAudio(new Uint8Array([3]).buffer);
    expect(events.some((event) => event.type === "agent-turn:audio")).toBe(false);

    socket.receive(turnInfo("EndOfTurn", "what time is it", 0.9));
    expect(llm.generations).toBe(1);
    expect(events.filter((event) => event.type === "user-turn:ended")).toMatchObject([
      { text: "what time is it" },
    ]);
    expect(events.filter((event) => event.type === "agent-turn:audio")).toHaveLength(1);
    agent.stop();
  });

  describe("turnDetector", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function createFluxAgent(
      detectors: (flux: ReturnType<typeof createDeepgramFlux>) => TurnDetectorInput,
    ) {
      const sockets = mockWebSocket();
      const flux = createDeepgramFlux({ apiKey: "test-key", baseUrl: "deepgram.test" });
      const vad = createFakeVAD();
      const llm = createFakeLLM();
      const clock = { increment: (ms: number) => vi.advanceTimersByTime(ms) };
      const events: PublicAgentEvent[] = [];
      const agent = createAgent({
        stt: flux,
        llm: llm.provider,
        tts: createFakeTTS().provider,
        vad: vad.provider,
        turnDetector: detectors(flux),
        turnTaking: { minDelayMs: 400, maxDelayMs: 2500 },
        onEvent: (event) => events.push(event),
      });
      agent.start();
      const socket = sockets.nextSocket();
      socket.open();
      const ended = () => events.filter((event) => event.type === "user-turn:ended");
      return { agent, socket, vad, llm, clock, ended };
    }

    it("ends the turn on EndOfTurn when it is the only detector", () => {
      const { agent, socket, vad, clock, ended } = createFluxAgent((flux) => flux.turnDetector);
      vad.emitSpeechStart();
      socket.receive(turnInfo("StartOfTurn", "what time"));
      socket.receive(turnInfo("Update", "what time is it", 0.95));
      vad.emitSpeechEnd();
      clock.increment(10_000);
      expect(ended()).toHaveLength(0);

      socket.receive(turnInfo("EndOfTurn", "what time is it", 0.95));
      expect(ended()).toMatchObject([{ text: "what time is it" }]);
      agent.stop();
    });

    it("prepares a reply on EagerEndOfTurn and drops it on TurnResumed", () => {
      const { agent, socket, vad, llm } = createFluxAgent((flux) => flux.turnDetector);
      vad.emitSpeechStart();
      socket.receive(turnInfo("StartOfTurn", "I need"));
      socket.receive(turnInfo("EagerEndOfTurn", "I need a taxi", 0.6));
      expect(llm.generations).toBe(1);
      expect(llm.getContext()?.isSpeculative()).toBe(true);

      socket.receive(turnInfo("TurnResumed", "I need a taxi"));
      expect(llm.aborted).toBe(true);
      agent.stop();
    });

    it("lets another detector end the turn before Flux does", () => {
      const { agent, socket, vad, clock, ended } = createFluxAgent((flux) => [
        flux.turnDetector,
        () => 0.95,
      ]);
      vad.emitSpeechStart();
      socket.receive(turnInfo("StartOfTurn", "book a table"));
      socket.receive(turnInfo("Update", "book a table", 0.1));
      vad.emitSpeechEnd();
      clock.increment(400);
      expect(ended()).toMatchObject([{ text: "book a table" }]);

      socket.receive(turnInfo("EndOfTurn", "book a table", 0.9));
      expect(ended()).toHaveLength(1);
      agent.stop();
    });

    it("mixes Flux's confidence with the other detectors", () => {
      const { agent, socket, vad, clock, ended } = createFluxAgent((flux) => [
        flux.turnDetector,
        () => 0,
      ]);
      vad.emitSpeechStart();
      socket.receive(turnInfo("StartOfTurn", "that's all"));
      vad.emitSpeechEnd();
      socket.receive(turnInfo("Update", "that's all", 0.95));
      clock.increment(400);
      expect(ended()).toMatchObject([{ text: "that's all" }]);
      agent.stop();
    });

    it("still ends the turn on EndOfTurn when combined", () => {
      const { agent, socket, vad, ended } = createFluxAgent((flux) => [flux.turnDetector, () => 0]);
      vad.emitSpeechStart();
      socket.receive(turnInfo("StartOfTurn", "my number is"));
      vad.emitSpeechEnd();
      socket.receive(turnInfo("EndOfTurn", "my number is five", 0.9));
      expect(ended()).toMatchObject([{ text: "my number is five" }]);
      agent.stop();
    });
  });
});
