import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { createAgent, type AgentTraceEvent, type LLMContext, type PublicAgentEvent } from "talkio";

import { createDeepgram } from "@talkio/deepgram";

import index from "./index.html";

const PORT = 3000;
const CONSOLE_TRACE_SAMPLE_EVERY = 25;
const HIDDEN_CONSOLE_TRACE_TYPES = new Set(["tts:chunk", "ai-turn:audio"]);
const SAMPLED_CONSOLE_TRACE_TYPES = new Set(["audio:input", "audio:send"]);

type CorrectnessDemoModule = {
  runCorrectnessDemo: () => Promise<unknown>;
};

type AudioFrameMeta = {
  turnId?: string;
  requestId?: string;
  bytes: number;
};
// Keep fast-check out of Bun's browser bundle for the index.html route.
const importCorrectnessDemo = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<CorrectnessDemoModule>;
const correctnessDemoSpecifier = `${import.meta.dir}/${["correctness", "demo"].join("-")}.ts`;

const hasLiveCredentials = Boolean(process.env.DEEPGRAM_API_KEY && process.env.OPENAI_API_KEY);

if (!hasLiveCredentials) {
  console.warn("Live voice mode needs DEEPGRAM_API_KEY and OPENAI_API_KEY.");
  console.warn("The offline correctness demo still works without API keys.");
}

const deepgram = createDeepgram({
  apiKey: process.env.DEEPGRAM_API_KEY,
});

type WebSocketClient = {
  readyState: number;
  send: (data: string | ArrayBuffer) => void;
};

interface ClientSession {
  agent: ReturnType<typeof createAgent>;
}

const sessions = new Map<WebSocketClient, ClientSession>();

function sendJSON(ws: WebSocketClient, payload: Record<string, unknown>): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function serializeEvent(event: PublicAgentEvent): Record<string, unknown> {
  if (event.type === "agent:error") {
    return {
      type: event.type,
      source: event.source,
      message: event.error.message,
      timestamp: event.timestamp,
    };
  }

  if (event.type === "ai-turn:audio") {
    return {
      type: event.type,
      turnId: event.turnId,
      requestId: event.requestId,
      bytes: event.audio.byteLength,
      timestamp: event.timestamp,
    };
  }

  return { ...event };
}

function formatTrace(event: AgentTraceEvent, sessionStartedAt: number): string {
  const elapsed = event.timestamp - sessionStartedAt;
  const ids = [
    event.turnId ? `turn=${event.turnId.slice(0, 6)}` : null,
    event.requestId ? `req=${event.requestId.slice(0, 6)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const details = event.data ? ` ${JSON.stringify(event.data)}` : "";
  return `[trace +${elapsed}ms${ids ? ` ${ids}` : ""}] ${event.type}${details}`;
}

function formatSampledTrace(
  event: AgentTraceEvent,
  sessionStartedAt: number,
  count: number,
  totalBytes: number,
): string {
  const elapsed = event.timestamp - sessionStartedAt;
  const ids = [
    event.turnId ? `turn=${event.turnId.slice(0, 6)}` : null,
    event.requestId ? `req=${event.requestId.slice(0, 6)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const sampledDetails = `chunks=${count} bytes=${totalBytes}`;
  return `[trace +${elapsed}ms${ids ? ` ${ids}` : ""}] ${event.type} ${sampledDetails}`;
}

const llm = async (ctx: LLMContext) => {
  try {
    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages: [
        {
          role: "system",
          content:
            "You are a realtime voice agent. Reply conversationally in one or two short sentences. Avoid markdown, numbered lists, and long menus unless the user explicitly asks for detail.",
        },
        ...ctx.messages,
      ],
      abortSignal: ctx.signal,
    });

    let fullText = "";
    let sentenceBuffer = "";
    let sentenceIndex = 0;

    for await (const chunk of result.textStream) {
      ctx.token(chunk);
      fullText += chunk;
      sentenceBuffer += chunk;

      const sentenceEnders = /[.!?]\s+/g;
      let match;
      let lastIndex = 0;

      while ((match = sentenceEnders.exec(sentenceBuffer)) !== null) {
        const sentence = sentenceBuffer.slice(lastIndex, match.index + 1).trim();
        if (sentence) {
          ctx.sentence(sentence, sentenceIndex++);
        }
        lastIndex = match.index + match[0].length;
      }

      sentenceBuffer = sentenceBuffer.slice(lastIndex);
    }

    if (sentenceBuffer.trim()) {
      ctx.sentence(sentenceBuffer.trim(), sentenceIndex);
    }

    ctx.complete(fullText);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    ctx.error(error instanceof Error ? error : new Error(String(error)));
  }
};

function createSession(ws: WebSocketClient): ClientSession {
  const sessionStartedAt = Date.now();
  const sampledTraceCounts = new Map<string, number>();
  const sampledTraceBytes = new Map<string, number>();
  const pendingAudioMeta: AudioFrameMeta[] = [];

  const handleTrace = (event: AgentTraceEvent) => {
    sendJSON(ws, { type: "trace", trace: event });

    if (event.type === "audio:send") {
      pendingAudioMeta.push({
        turnId: event.turnId,
        requestId: event.requestId,
        bytes: Number(event.data?.bytes ?? 0),
      });
    }

    if (HIDDEN_CONSOLE_TRACE_TYPES.has(event.type)) return;

    if (SAMPLED_CONSOLE_TRACE_TYPES.has(event.type)) {
      const key = `${event.type}:${event.requestId ?? event.turnId ?? "session"}`;
      const count = (sampledTraceCounts.get(key) ?? 0) + 1;
      const bytes = (sampledTraceBytes.get(key) ?? 0) + Number(event.data?.bytes ?? 0);
      sampledTraceCounts.set(key, count);
      sampledTraceBytes.set(key, bytes);
      if (count === 1 || count % CONSOLE_TRACE_SAMPLE_EVERY === 0) {
        console.log(formatSampledTrace(event, sessionStartedAt, count, bytes));
      }
      return;
    }

    console.log(formatTrace(event, sessionStartedAt));
  };

  const agent = createAgent({
    stt: deepgram.stt({ model: "nova-3" }),
    llm,
    tts: deepgram.tts({ model: "aura-2-thalia-en" }),
    audio: {
      // Client sends Linear16 PCM converted from Web Audio API Float32Array samples.
      input: { encoding: "linear16", sampleRate: 16000, channels: 1 },
    },
    debug: false,
    interruption: {
      enabled: true,
      minDurationMs: 200,
      speculativeCutoffMs: 0,
    },
    observability: {
      level: "trace",
      onTrace: handleTrace,
    },
    onEvent: (event) => {
      if (event.type !== "ai-turn:audio") {
        sendJSON(ws, { type: "event", event: serializeEvent(event) });
      }

      switch (event.type) {
        case "agent:started":
          console.log("[agent] Started");
          break;
        case "agent:stopped":
          pendingAudioMeta.length = 0;
          console.log("[agent] Stopped");
          break;
        case "agent:error":
          console.error(`[agent] Error from ${event.source}:`, event.error.message);
          break;
        case "human-turn:started":
          console.log("\n[human] Speaking...");
          break;
        case "human-turn:transcript":
          console.log(`[human] ${event.isFinal ? "Final" : "Partial"}: "${event.text}"`);
          break;
        case "human-turn:ended":
          console.log(`[human] Ended: "${event.transcript}"`);
          sendJSON(ws, { type: "transcript", text: event.transcript });
          break;
        case "human-turn:abandoned":
          console.log(`[human] Abandoned: ${event.reason}`);
          break;
        case "ai-turn:started":
          console.log("\n[ai] Generating response...");
          break;
        case "ai-turn:sentence":
          console.log(`[ai] Sentence ${event.index}: "${event.sentence}"`);
          break;
        case "ai-turn:ended":
          console.log(`[ai] Ended (spoken: ${event.wasSpoken})`);
          sendJSON(ws, { type: "response", text: event.text });
          break;
        case "ai-turn:interruption-pending":
          console.log("[ai] Interruption pending");
          break;
        case "ai-turn:interruption-cancelled":
          console.log("[ai] Interruption cancelled");
          break;
        case "ai-turn:interrupted":
          {
            pendingAudioMeta.length = 0;
            const interrupted = event as typeof event & {
              audioStartedText?: string;
              audioCompletedText?: string;
            };
            const audioStartedText = interrupted.audioStartedText ?? event.spokenText;
            const audioCompletedText = interrupted.audioCompletedText ?? event.spokenText;
            console.log(`[ai] Interrupted after completed audio: "${audioCompletedText}"`);
            sendJSON(ws, {
              type: "response-interrupted",
              text: audioCompletedText,
              generatedText: event.generatedText,
              audioStartedText,
              audioCompletedText,
            });
          }
          break;
      }
    },
  });

  (async () => {
    const reader = agent.audioStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const meta = pendingAudioMeta.shift() ?? { bytes: value.byteLength };
      sendJSON(ws, {
        type: "audio-meta",
        turnId: meta.turnId,
        requestId: meta.requestId,
        bytes: meta.bytes,
        serverSentAt: Date.now(),
      });
      if (ws.readyState === 1) ws.send(value);
    }
  })();

  agent.start();

  return { agent };
}

Bun.serve({
  port: PORT,
  routes: {
    "/api/correctness-demo": {
      GET: async () => {
        try {
          const { runCorrectnessDemo } = await importCorrectnessDemo(correctnessDemoSpecifier);
          return Response.json(await runCorrectnessDemo());
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
    "/*": index,
  },
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) {
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log("[server] Client connected");
      if (!hasLiveCredentials) {
        ws.send(
          JSON.stringify({
            type: "status",
            text: "Set DEEPGRAM_API_KEY and OPENAI_API_KEY to use live voice mode.",
          }),
        );
        ws.close();
        return;
      }

      const client = ws as unknown as WebSocketClient;
      const session = createSession(client);
      sessions.set(client, session);
      ws.send(JSON.stringify({ type: "status", text: "Connected to voice agent" }));
    },
    message(ws, message) {
      const client = ws as unknown as WebSocketClient;
      const session = sessions.get(client);
      if (!session) return;

      // sendAudio accepts multiple input types: ArrayBuffer, Buffer, Uint8Array,
      // Int16Array, Float32Array - no manual conversion needed!
      if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
        session.agent.sendAudio(message);
      }
    },
    close(ws) {
      console.log("[server] Client disconnected");
      const client = ws as unknown as WebSocketClient;
      const session = sessions.get(client);
      if (session) {
        session.agent.stop();
        sessions.delete(client);
      }
    },
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Voice agent server running at http://localhost:${PORT}`);
console.log("Open this URL in your browser to start a conversation");
