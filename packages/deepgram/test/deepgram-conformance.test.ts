import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSTTProviderConformance,
  assertTTSProviderConformance,
  createSTTContextProbe,
  createTTSContextProbe,
  installMockWebSocket,
  type MockWebSocketController,
} from "@talkio/testkit";

import { createDeepgram, createDeepgramSTT, createDeepgramTTS } from "../src";

let webSocketController: MockWebSocketController | undefined;

function mockWebSocket(): MockWebSocketController {
  webSocketController = installMockWebSocket();
  return webSocketController;
}

function deepgramTranscript(text: string, isFinal: boolean, speechFinal = isFinal): string {
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration: 1,
    start: 0,
    is_final: isFinal,
    speech_final: speechFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence: 0.99,
          words: [],
        },
      ],
    },
  });
}

afterEach(() => {
  webSocketController?.restore();
  webSocketController = undefined;
});

describe("@talkio/deepgram provider conformance", () => {
  it("declares STT and TTS provider contracts", () => {
    const deepgram = createDeepgram({ apiKey: "test-key", baseUrl: "deepgram.test" });
    const stt = deepgram.stt({ model: "nova-3" });
    const tts = deepgram.tts({ model: "aura-2-thalia-en", encoding: "mulaw", sampleRate: 8000 });

    assertSTTProviderConformance(stt, { expectedName: "Deepgram" });
    assertTTSProviderConformance(tts, { expectedName: "Deepgram" });

    expect(stt.metadata.defaultInputFormat).toEqual({
      encoding: "linear16",
      sampleRate: 16000,
      channels: 1,
    });
    expect(stt.metadata.supportedInputFormats).toContainEqual({
      encoding: "linear16",
      sampleRate: 48000,
      channels: 2,
    });
    expect(stt.metadata.supportedInputFormats).toContainEqual({
      encoding: "mulaw",
      sampleRate: 8000,
      channels: 1,
    });

    expect(tts.metadata.defaultOutputFormat).toEqual({
      encoding: "mulaw",
      sampleRate: 8000,
      channels: 1,
    });
    expect(tts.metadata.supportedOutputFormats).toContainEqual({
      encoding: "linear16",
      sampleRate: 24000,
      channels: 1,
    });
  });

  it("maps Deepgram STT WebSocket messages into STT context events", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
      endpointing: false,
      keyterms: ["talkio", "barge in"],
    });
    const probe = createSTTContextProbe({
      audioFormat: { encoding: "linear16", sampleRate: 48000, channels: 2 },
    });

    stt.start(probe.context);

    const socket = sockets.nextSocket();
    expect(socket.protocols).toEqual(["token", "test-key"]);
    expect(socket.url).toContain("wss://deepgram.test/v1/listen?");
    expect(socket.url).toContain("model=nova-3");
    expect(socket.url).toContain("sample_rate=48000");
    expect(socket.url).toContain("channels=2");
    expect(socket.url).not.toContain("endpointing=");
    expect(new URL(socket.url).searchParams.getAll("keyterm")).toEqual(["talkio", "barge in"]);
    expect(socket.url).not.toContain("keywords=");

    socket.open();
    const audio = new Uint8Array([1, 2, 3]).buffer;
    stt.sendAudio(audio);
    expect(socket.sent).toContain(audio);

    socket.receive(JSON.stringify({ type: "SpeechStarted", channel_index: [0], timestamp: 0 }));
    socket.receive(deepgramTranscript("hello", false));
    socket.receive(deepgramTranscript("hello there", true));
    socket.receive(JSON.stringify({ type: "UtteranceEnd", channel_index: [0], last_word_end: 1 }));
    socket.receive(
      JSON.stringify({
        type: "Error",
        description: "bad request",
        message: "bad request",
        variant: "test",
      }),
    );

    expect(probe.speechStarts).toBe(1);
    expect(probe.speechEnds).toBe(1);
    expect(probe.transcripts).toEqual([
      { text: "hello", isFinal: false },
      { text: "hello there", isFinal: true },
    ]);
    expect(probe.errors[0]?.message).toContain("bad request");

    stt.stop();
    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.closeCalls).toBe(1);
  });

  it("boosts terms the way each model accepts them", () => {
    const sockets = mockWebSocket();
    const base = { apiKey: "test-key", baseUrl: "deepgram.test" };

    createDeepgramSTT({ ...base, model: "nova-2", keywords: ["Talkio:2"] }).start(
      createSTTContextProbe().context,
    );
    const url = new URL(sockets.nextSocket(0).url);
    expect(url.searchParams.getAll("keywords")).toEqual(["Talkio:2"]);
    expect(url.searchParams.has("keyterm")).toBe(false);

    expect(() => createDeepgramSTT({ ...base, model: "nova-3", keywords: ["Talkio"] })).toThrow(
      "keyterms",
    );
    expect(() => createDeepgramSTT({ ...base, model: "nova-2", keyterms: ["Talkio"] })).toThrow(
      "Nova-3",
    );
    const tooMany = Array.from({ length: 101 }, (_, index) => `term ${index}`);
    expect(() => createDeepgramSTT({ ...base, model: "nova-3", keyterms: tooMany })).toThrow(
      "at most 100",
    );
    expect(() =>
      createDeepgramSTT({ ...base, model: "nova-3", keyterms: tooMany.slice(0, 100) }),
    ).not.toThrow();
  });

  it("reports one final transcript per utterance, not per finalized segment", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
    });
    const probe = createSTTContextProbe();

    stt.start(probe.context);
    const socket = sockets.nextSocket();
    socket.open();

    socket.receive(deepgramTranscript("I need", false));
    socket.receive(deepgramTranscript("I need to", true, false));
    socket.receive(deepgramTranscript("change my", false));
    socket.receive(deepgramTranscript("change my booking", true, true));

    expect(probe.transcripts).toEqual([
      { text: "I need", isFinal: false },
      { text: "I need to", isFinal: false },
      { text: "I need to change my", isFinal: false },
      { text: "I need to change my booking", isFinal: true },
    ]);
    stt.stop();
  });

  it("finishes a pending utterance on UtteranceEnd when endpointing never fires", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
      endpointing: false,
    });
    const probe = createSTTContextProbe();

    stt.start(probe.context);
    const socket = sockets.nextSocket();
    socket.open();

    socket.receive(deepgramTranscript("over the noise", true, false));
    socket.receive(deepgramTranscript("", true, false));
    socket.receive(JSON.stringify({ type: "UtteranceEnd", channel_index: [0], last_word_end: 2 }));
    socket.receive(JSON.stringify({ type: "UtteranceEnd", channel_index: [0], last_word_end: 3 }));

    expect(probe.transcripts).toEqual([
      { text: "over the noise", isFinal: false },
      { text: "over the noise", isFinal: true },
    ]);
    expect(probe.speechEnds).toBe(2);
    stt.stop();
  });

  it("ends each utterance at its finalized segment when Deepgram cannot signal the end", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
      endpointing: false,
      interimResults: false,
    });
    const probe = createSTTContextProbe();

    stt.start(probe.context);
    const socket = sockets.nextSocket();
    socket.open();
    socket.receive(deepgramTranscript("book a table", true, false));
    socket.receive(deepgramTranscript("for two please", true, false));

    expect(probe.transcripts).toEqual([
      { text: "book a table", isFinal: true },
      { text: "for two please", isFinal: true },
    ]);
    stt.stop();
  });

  it("still joins segments until speech_final when only interim results are off", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
      interimResults: false,
    });
    const probe = createSTTContextProbe();

    stt.start(probe.context);
    const socket = sockets.nextSocket();
    socket.open();
    socket.receive(deepgramTranscript("I need to", true, false));
    socket.receive(deepgramTranscript("change my booking", true, true));

    expect(probe.transcripts).toEqual([
      { text: "I need to", isFinal: false },
      { text: "I need to change my booking", isFinal: true },
    ]);
    stt.stop();
  });

  it("uses conversational endpointing defaults and omits utterance end without interim results", () => {
    const sockets = mockWebSocket();
    const probe = createSTTContextProbe();

    createDeepgramSTT({ apiKey: "test-key", baseUrl: "deepgram.test", model: "nova-3" }).start(
      probe.context,
    );
    const defaults = new URL(sockets.nextSocket(0).url);
    expect(defaults.searchParams.get("endpointing")).toBe("300");
    expect(defaults.searchParams.get("utterance_end_ms")).toBe("1000");

    createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
      interimResults: false,
    }).start(createSTTContextProbe().context);
    const withoutInterim = new URL(sockets.nextSocket(1).url);
    expect(withoutInterim.searchParams.get("interim_results")).toBe("false");
    expect(withoutInterim.searchParams.has("utterance_end_ms")).toBe(false);
    probe.abort();
  });

  it("keeps an idle stream open with KeepAlive messages", () => {
    vi.useFakeTimers();
    try {
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT({
        apiKey: "test-key",
        baseUrl: "deepgram.test",
        model: "nova-3",
      });
      stt.start(createSTTContextProbe().context);
      const socket = sockets.nextSocket();
      socket.open();
      const keepAlives = () =>
        socket.sent.filter((message) => message === JSON.stringify({ type: "KeepAlive" })).length;

      for (let second = 0; second < 10; second++) {
        stt.sendAudio(new Uint8Array([1]).buffer);
        vi.advanceTimersByTime(1000);
      }
      expect(keepAlives()).toBe(0);

      vi.advanceTimersByTime(2999);
      expect(keepAlives()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(keepAlives()).toBe(1);
      vi.advanceTimersByTime(4000);
      expect(keepAlives()).toBe(2);

      socket.closeFromServer(1000);
      expect(vi.getTimerCount()).toBe(0);
      stt.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops sending KeepAlive messages when stopped", () => {
    vi.useFakeTimers();
    try {
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT({
        apiKey: "test-key",
        baseUrl: "deepgram.test",
        model: "nova-3",
      });
      stt.start(createSTTContextProbe().context);
      sockets.nextSocket().open();
      expect(vi.getTimerCount()).toBe(1);
      stt.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers STT audio until open and closes on abort", () => {
    const sockets = mockWebSocket();
    const stt = createDeepgramSTT({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "nova-3",
    });
    const probe = createSTTContextProbe();

    stt.start(probe.context);

    const socket = sockets.nextSocket();
    const audio = new Uint8Array([4, 5, 6]).buffer;
    stt.sendAudio(audio);
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toBe(audio);

    probe.abort();
    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.closeCalls).toBe(1);

    socket.receive(JSON.stringify({ type: "SpeechStarted", channel_index: [0], timestamp: 0 }));
    expect(probe.speechStarts).toBe(0);
  });

  describe("when the connection drops", () => {
    const options = { apiKey: "test-key", baseUrl: "deepgram.test", model: "nova-3" };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reconnects with backoff and delivers the audio sent meanwhile", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      const probe = createSTTContextProbe();
      stt.start(probe.context);
      const first = sockets.nextSocket(0);
      first.open();

      first.closeFromServer(1011, "internal error");
      const meanwhile = new Uint8Array([7]).buffer;
      stt.sendAudio(meanwhile);
      vi.advanceTimersByTime(249);
      expect(sockets.sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      const second = sockets.nextSocket(1);
      second.open();
      expect(second.sent[0]).toBe(meanwhile);
      expect(probe.errors).toHaveLength(0);

      second.closeFromServer(1011);
      vi.advanceTimersByTime(250);
      expect(sockets.sockets).toHaveLength(3);
      stt.stop();
    });

    it("keeps only the newest audio when an outage outlasts the buffer", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      stt.start(createSTTContextProbe().context);
      sockets.nextSocket(0).open();
      sockets.nextSocket(0).closeFromServer(1011);

      const older = new ArrayBuffer(600_000);
      const newer = new ArrayBuffer(600_000);
      stt.sendAudio(older);
      stt.sendAudio(newer);
      vi.advanceTimersByTime(250);
      sockets.nextSocket(1).open();
      expect(sockets.nextSocket(1).sent).toHaveLength(1);
      expect(sockets.nextSocket(1).sent[0]).toBe(newer);
      stt.stop();
    });

    it("keeps the finalized words of an utterance the drop interrupted", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      const probe = createSTTContextProbe();
      stt.start(probe.context);
      sockets.nextSocket(0).open();
      sockets.nextSocket(0).receive(deepgramTranscript("I need to", true, false));
      sockets.nextSocket(0).closeFromServer(1011);

      vi.advanceTimersByTime(250);
      sockets.nextSocket(1).open();
      sockets.nextSocket(1).receive(deepgramTranscript("change my booking", true, true));
      expect(probe.transcripts.at(-1)).toEqual({
        text: "I need to change my booking",
        isFinal: true,
      });
      stt.stop();
    });

    it("gives up after five attempts with one error and stops buffering", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      const probe = createSTTContextProbe();
      stt.start(probe.context);
      sockets.nextSocket(0).open();
      sockets.nextSocket(0).closeFromServer(1011, "internal error");

      for (const delay of [250, 1000, 2000, 4000, 8000]) {
        vi.advanceTimersByTime(delay);
        sockets.latestSocket().closeFromServer(1006);
      }
      expect(probe.errors.map((error) => error.message)).toEqual([
        "Deepgram WebSocket closed: code 1006 after 5 reconnect attempts",
      ]);
      expect(sockets.sockets).toHaveLength(6);
      expect(vi.getTimerCount()).toBe(0);
      stt.stop();
    });

    it("does not retry a connection that never opened", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      const probe = createSTTContextProbe();
      stt.start(probe.context);
      stt.sendAudio(new Uint8Array([8]).buffer);
      sockets.nextSocket(0).closeFromServer(1008, "invalid credentials");

      vi.advanceTimersByTime(60_000);
      expect(sockets.sockets).toHaveLength(1);
      expect(probe.errors.map((error) => error.message)).toEqual([
        "Deepgram WebSocket closed: invalid credentials",
      ]);
      stt.stop();
    });

    it("stops reconnecting when stopped or restarted", () => {
      vi.useFakeTimers();
      const sockets = mockWebSocket();
      const stt = createDeepgramSTT(options);
      stt.start(createSTTContextProbe().context);
      sockets.nextSocket(0).open();
      sockets.nextSocket(0).closeFromServer(1011);
      stt.stop();
      vi.advanceTimersByTime(60_000);
      expect(sockets.sockets).toHaveLength(1);

      stt.start(createSTTContextProbe().context);
      sockets.nextSocket(1).open();
      sockets.nextSocket(1).closeFromServer(1011);
      stt.sendAudio(new Uint8Array([9]).buffer);
      stt.start(createSTTContextProbe().context);
      vi.advanceTimersByTime(60_000);
      expect(sockets.sockets).toHaveLength(3);
      sockets.nextSocket(2).open();
      expect(sockets.nextSocket(2).sent).toHaveLength(0);
      stt.stop();
    });
  });

  it("maps Deepgram TTS WebSocket messages into TTS context events", () => {
    const sockets = mockWebSocket();
    const tts = createDeepgramTTS({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "aura-2-thalia-en",
    });
    const probe = createTTSContextProbe({
      audioFormat: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
    });

    tts.start(probe.context);

    const socket = sockets.nextSocket();
    expect(socket.protocols).toEqual(["token", "test-key"]);
    expect(socket.url).toContain("wss://deepgram.test/v1/speak?");
    expect(socket.url).toContain("model=aura-2-thalia-en");
    expect(socket.url).toContain("encoding=mulaw");
    expect(socket.url).toContain("sample_rate=8000");

    socket.open();
    tts.speak("hello", { requestId: "request-1" });
    tts.flush({ requestId: "request-1" });
    expect(socket.sent).toContain(JSON.stringify({ type: "Speak", text: "hello" }));
    expect(socket.sent).toContain(JSON.stringify({ type: "Flush" }));

    const audio = new Uint8Array([7, 8, 9]).buffer;
    socket.receive(audio);
    socket.receive(JSON.stringify({ type: "Flushed" }));

    expect(probe.audioChunks).toHaveLength(1);
    expect(probe.audioChunks[0]).toBe(audio);
    expect(probe.completions).toBe(1);
    expect(probe.errors).toHaveLength(0);
    tts.clear();
    expect(socket.sent).toContain(JSON.stringify({ type: "Clear" }));
    tts.stop();
    expect(socket.sent).toContain(JSON.stringify({ type: "Close" }));
    expect(socket.closeCalls).toBe(1);
  });

  it("reports Deepgram TTS errors and does not open when already aborted", () => {
    const sockets = mockWebSocket();
    const tts = createDeepgramTTS({
      apiKey: "test-key",
      baseUrl: "deepgram.test",
      model: "aura-2-thalia-en",
    });
    const probe = createTTSContextProbe();

    tts.start(probe.context);
    const socket = sockets.nextSocket();
    tts.speak("hello", { requestId: "request-1" });
    tts.flush({ requestId: "request-1" });
    socket.receive(
      JSON.stringify({ type: "Error", err_code: "bad_request", err_msg: "bad request" }),
    );
    expect(probe.errors[0]?.message).toContain("bad request");
    expect(socket.closeCalls).toBe(1);

    sockets.clear();
    const abortedProbe = createTTSContextProbe();
    abortedProbe.abort();
    tts.start(abortedProbe.context);
    tts.speak("ignored", { requestId: "request-1" });
    tts.flush({ requestId: "request-1" });
    expect(sockets.sockets).toHaveLength(0);
  });
});
