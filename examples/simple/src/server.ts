import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { createAgent, type LLMContext } from "talkio";

import { createDeepgram } from "@talkio/deepgram";

import index from "./index.html";

const PORT = 3000;
type CorrectnessDemoModule = {
  runCorrectnessDemo: () => Promise<unknown>;
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

const llm = async (ctx: LLMContext) => {
  try {
    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages: ctx.messages,
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
  const agent = createAgent({
    stt: deepgram.stt({ model: "nova-3" }),
    llm,
    tts: deepgram.tts({ model: "aura-2-thalia-en" }),
    audio: {
      // Client sends Linear16 PCM converted from Web Audio API Float32Array samples.
      input: { encoding: "linear16", sampleRate: 16000, channels: 1 },
    },
    debug: true,
    interruption: {
      enabled: true,
      minDurationMs: 200,
      speculativeCutoffMs: 0,
    },
    onEvent: (event) => {
      switch (event.type) {
        case "agent:started":
          console.log("[agent] Started");
          break;
        case "agent:stopped":
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
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "transcript", text: event.transcript }));
          }
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
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "response", text: event.text }));
          }
          break;
        case "ai-turn:interruption-pending":
          console.log("[ai] Interruption pending");
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "interruption-pending" }));
          }
          break;
        case "ai-turn:interruption-cancelled":
          console.log("[ai] Interruption cancelled");
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "interruption-cancelled" }));
          }
          break;
        case "ai-turn:interrupted":
          console.log(`[ai] Interrupted after: "${event.partialText}"`);
          break;
      }
    },
  });

  (async () => {
    const reader = agent.audioStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ws.readyState === 1) {
        ws.send(value);
      }
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
