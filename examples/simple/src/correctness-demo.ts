import { createDeepgramSTT, createDeepgramTTS } from "@talkio/deepgram";
import {
  assertSTTProviderConformance,
  assertTTSProviderConformance,
  createScenario,
  createSTTContextProbe,
  createTTSContextProbe,
  generateScenarioTrace,
  installMockWebSocket,
  runTrace,
  type ScenarioTrace,
} from "@talkio/testkit";

export type CorrectnessDemoCheck = {
  name: string;
  detail: string;
  events?: string[];
};

export type CorrectnessDemoResult = {
  summary: string;
  checks: CorrectnessDemoCheck[];
};

async function runGoldenScenario(): Promise<CorrectnessDemoCheck> {
  const result = await createScenario()
    .start()
    .expectEvent("agent:started")
    .sttPartial("hello")
    .sttFinal("hello")
    .expectEvent("human-turn:started")
    .expectEvent("human-turn:transcript", { text: "hello", isFinal: false })
    .expectEvent("human-turn:transcript", { text: "hello", isFinal: true })
    .expectEvent("human-turn:ended", { transcript: "hello" })
    .expectEvent("ai-turn:started")
    .llmToken("Hi")
    .llmSentence("Hi there.", 0)
    .ttsChunk(7, 4)
    .llmComplete("Hi there.")
    .ttsComplete()
    .expectEvent("ai-turn:ended", { wasSpoken: true })
    .expectSnapshot((snapshot) => snapshot.messages.length === 2)
    .stop()
    .expectEvent("agent:stopped")
    .assertInvariants()
    .run();

  const events = result.events.events.map((entry) => entry.event.type);
  return {
    name: "Golden voice-agent scenario",
    detail: `Verified ${events.length} ordered public events and the final conversation snapshot.`,
    events,
  };
}

async function runTraceReplay(): Promise<CorrectnessDemoCheck> {
  const trace: ScenarioTrace = [
    { type: "start" },
    { type: "expect.event", event: "agent:started" },
    { type: "stt.final", text: "what can you do?" },
    {
      type: "expect.event",
      event: "human-turn:ended",
      partial: { transcript: "what can you do?" },
    },
    { type: "expect.event", event: "ai-turn:started" },
    { type: "llm.sentence", text: "I can test voice-agent orchestration.", index: 0 },
    { type: "tts.chunk", value: 3, size: 3 },
    { type: "llm.complete", text: "I can test voice-agent orchestration." },
    { type: "tts.complete" },
    { type: "expect.event", event: "ai-turn:ended", partial: { wasSpoken: true } },
    { type: "stop" },
    { type: "expect.event", event: "agent:stopped" },
    { type: "assert.invariants" },
  ];

  const result = await runTrace(trace);
  return {
    name: "Replayable JSON trace",
    detail: `Replayed a serializable trace with ${result.events.events.length} public events.`,
  };
}

async function runGeneratedCoverage(): Promise<CorrectnessDemoCheck> {
  const seed = 4242;
  const runs = 25;
  const turns = 3;

  for (let index = 0; index < runs; index++) {
    const generated = generateScenarioTrace({ seed: seed + index, turns });
    const result = await runTrace(generated.trace);
    result.events.assertInvariants();
  }

  return {
    name: "Generated trace coverage",
    detail: `Ran ${runs} fixed-seed traces with ${turns} turns each and checked public event invariants.`,
  };
}

function runDeepgramOfflineConformance(): CorrectnessDemoCheck {
  const stt = createDeepgramSTT({
    apiKey: "demo-key",
    baseUrl: "deepgram.test",
    model: "nova-3",
  });
  const tts = createDeepgramTTS({
    apiKey: "demo-key",
    baseUrl: "deepgram.test",
    model: "aura-2-thalia-en",
  });

  assertSTTProviderConformance(stt, { expectedName: "Deepgram", requireVersion: true });
  assertTTSProviderConformance(tts, { expectedName: "Deepgram", requireVersion: true });

  const sockets = installMockWebSocket();
  try {
    const sttProbe = createSTTContextProbe({
      audioFormat: { encoding: "linear16", sampleRate: 48000, channels: 2 },
    });
    stt.start(sttProbe.context);

    const sttSocket = sockets.nextSocket();
    if (!sttSocket.url.includes("sample_rate=48000") || !sttSocket.url.includes("channels=2")) {
      throw new Error("Deepgram STT URL did not use the runtime input format");
    }

    sttSocket.open();
    sttSocket.receive(
      JSON.stringify({
        type: "Results",
        channel_index: [0, 1],
        duration: 1,
        start: 0,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [{ transcript: "hello", confidence: 0.99, words: [] }],
        },
      }),
    );
    if (sttProbe.transcripts[0]?.text !== "hello") {
      throw new Error("Deepgram STT transcript did not map into the Talkio context");
    }
    stt.stop();

    const ttsProbe = createTTSContextProbe({
      audioFormat: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
    });
    tts.synthesize("hello", ttsProbe.context);

    const ttsSocket = sockets.latestSocket();
    if (!ttsSocket.url.includes("encoding=mulaw") || !ttsSocket.url.includes("sample_rate=8000")) {
      throw new Error("Deepgram TTS URL did not use the runtime output format");
    }

    ttsSocket.open();
    const audio = new Uint8Array([1, 2, 3]).buffer;
    ttsSocket.receive(audio);
    ttsSocket.receive(JSON.stringify({ type: "Flushed" }));
    if (ttsProbe.audioChunks[0] !== audio || ttsProbe.completions !== 1) {
      throw new Error("Deepgram TTS events did not map into the Talkio context");
    }
  } finally {
    sockets.restore();
  }

  return {
    name: "Offline Deepgram conformance",
    detail:
      "Validated metadata, formats, WebSocket mapping, audio chunks, and completion without API keys.",
  };
}

function runBrokenProviderCheck(): CorrectnessDemoCheck {
  const brokenProvider = {
    metadata: {
      name: "BrokenSTT",
      version: "0.0.0",
      type: "stt",
      supportedInputFormats: [{ encoding: "linear16", sampleRate: 16000, channels: 1 }],
      defaultInputFormat: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
    },
    start: () => {},
    stop: () => {},
    sendAudio: () => {},
  };

  try {
    assertSTTProviderConformance(
      brokenProvider as Parameters<typeof assertSTTProviderConformance>[0],
    );
  } catch (error) {
    return {
      name: "Negative provider check",
      detail: `Rejected a deliberately broken provider: ${(error as Error).message}`,
    };
  }

  throw new Error("Broken provider unexpectedly passed conformance");
}

export async function runCorrectnessDemo(): Promise<CorrectnessDemoResult> {
  const checks: CorrectnessDemoCheck[] = [];

  checks.push(await runGoldenScenario());
  checks.push(await runTraceReplay());
  checks.push(await runGeneratedCoverage());
  checks.push(runDeepgramOfflineConformance());
  checks.push(runBrokenProviderCheck());

  return {
    summary:
      "Passed deterministic scenarios, replayable traces, generated traces, provider conformance, and a negative provider check.",
    checks,
  };
}
