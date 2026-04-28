import { afterEach, describe, expect, it } from "vitest";

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

function deepgramTranscript(text: string, isFinal: boolean): string {
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration: 1,
    start: 0,
    is_final: isFinal,
    speech_final: isFinal,
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

    assertSTTProviderConformance(stt, { expectedName: "Deepgram", requireVersion: true });
    assertTTSProviderConformance(tts, { expectedName: "Deepgram", requireVersion: true });

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
      keywords: ["talkio"],
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
    expect(socket.sent).toEqual([audio]);

    probe.abort();
    expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.closeCalls).toBe(1);

    socket.receive(JSON.stringify({ type: "SpeechStarted", channel_index: [0], timestamp: 0 }));
    expect(probe.speechStarts).toBe(0);
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

    tts.synthesize("hello", probe.context);

    const socket = sockets.nextSocket();
    expect(socket.protocols).toEqual(["token", "test-key"]);
    expect(socket.url).toContain("wss://deepgram.test/v1/speak?");
    expect(socket.url).toContain("model=aura-2-thalia-en");
    expect(socket.url).toContain("encoding=mulaw");
    expect(socket.url).toContain("sample_rate=8000");

    socket.open();
    expect(socket.sent).toContain(JSON.stringify({ type: "Speak", text: "hello" }));
    expect(socket.sent).toContain(JSON.stringify({ type: "Flush" }));

    const audio = new Uint8Array([7, 8, 9]).buffer;
    socket.receive(audio);
    socket.receive(JSON.stringify({ type: "Flushed" }));

    expect(probe.audioChunks).toEqual([audio]);
    expect(probe.completions).toBe(1);
    expect(probe.errors).toHaveLength(0);
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

    tts.synthesize("hello", probe.context);
    const socket = sockets.nextSocket();
    socket.receive(
      JSON.stringify({ type: "Error", err_code: "bad_request", err_msg: "bad request" }),
    );
    expect(probe.errors[0]?.message).toContain("bad request");
    expect(socket.closeCalls).toBe(1);

    sockets.clear();
    const abortedProbe = createTTSContextProbe();
    abortedProbe.abort();
    tts.synthesize("ignored", abortedProbe.context);
    expect(sockets.sockets).toHaveLength(0);
  });
});
