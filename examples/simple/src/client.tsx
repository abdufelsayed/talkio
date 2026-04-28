import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { float32ToLinear16, linear16ToFloat32, resample } from "talkio/audio/conversions";

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const TIMELINE_LIMIT = 240;
const AUDIO_TIMELINE_EVERY = 25;
const PLAYBACK_LEAD_SECONDS = 0.02;

type LogEntry = {
  id: number;
  message: string;
  type: "system" | "human" | "ai";
};

type TimelineEntry = {
  id: number;
  source: "event" | "trace" | "browser";
  name: string;
  detail: string;
  timestamp: number;
  turnId?: string;
  requestId?: string;
};

type AudioMeta = {
  turnId?: string;
  requestId?: string;
  serverSentAt?: number;
  durationMs?: number;
  queueDepth?: number;
  bytes: number;
};

type TurnTiming = {
  firstTokenAt?: number;
  firstSentenceAt?: number;
  firstTTSAudioAt?: number;
  firstAudioSendAt?: number;
  firstServerAudioSentAt?: number;
  speechStartedAt?: number;
};

type AgentTraceEvent = {
  type: string;
  timestamp: number;
  sessionId: string;
  turnId?: string;
  requestId?: string;
  elapsedMs?: number;
  data?: Record<string, unknown>;
};

type ServerEvent = {
  type: string;
  timestamp?: number;
  [key: string]: unknown;
};

type ConnectionStatus = "disconnected" | "connected" | "error";

type CorrectnessDemoCheck = {
  name: string;
  detail: string;
  events?: string[];
};

type CorrectnessDemoResult = {
  summary: string;
  checks: CorrectnessDemoCheck[];
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "--";
  return `${Math.max(0, Math.round(ms))}ms`;
}

function formatTurnDuration(ms: number, turnId: string | undefined): string {
  return `${formatDuration(ms)} t:${shortId(turnId)}`;
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 6) : "--";
}

function formatData(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  return Object.entries(data)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function eventDetail(event: ServerEvent): string {
  if (event.type === "human-turn:transcript") {
    return `${event.isFinal ? "final" : "partial"} "${String(event.text ?? "")}"`;
  }
  if (event.type === "human-turn:ended") {
    return `"${String(event.transcript ?? "")}"`;
  }
  if (event.type === "ai-turn:sentence") {
    return `#${String(event.index ?? 0)} "${String(event.sentence ?? "")}"`;
  }
  if (event.type === "ai-turn:ended") {
    return `spoken=${String(event.wasSpoken)} length=${String(event.text ?? "").length}`;
  }
  if (event.type === "ai-turn:interrupted") {
    return [
      `generated=${String(event.generatedText ?? event.partialText ?? "").length}`,
      `audioStarted=${String(event.audioStartedText ?? "").length}`,
      `audioCompleted=${String(event.audioCompletedText ?? event.spokenText ?? "").length}`,
    ].join(" ");
  }
  if (event.type === "agent:error") {
    return `${String(event.source ?? "unknown")}: ${String(event.message ?? "")}`;
  }
  return formatData(event as Record<string, unknown>);
}

function traceDetail(trace: AgentTraceEvent): string {
  const elapsed = trace.elapsedMs === undefined ? "" : `elapsed=${formatDuration(trace.elapsedMs)}`;
  return [elapsed, formatData(trace.data)].filter(Boolean).join(" ");
}

export function VoiceAgentDemo() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [statusText, setStatusText] = useState("Disconnected");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [demoResult, setDemoResult] = useState<CorrectnessDemoResult | null>(null);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const logIdRef = useRef(0);
  const timelineIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const pendingAudioMetaRef = useRef<AudioMeta[]>([]);
  const turnStartedAtRef = useRef(new Map<string, number>());
  const turnTimingRef = useRef(new Map<string, TurnTiming>());
  const audioTraceCountsRef = useRef(new Map<string, number>());
  const browserAudioCountsRef = useRef(new Map<string, number>());
  const browserPlaybackEndCountsRef = useRef(new Map<string, number>());
  const browserReceiveCountsRef = useRef(new Map<string, number>());
  const scheduledSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextPlaybackTimeRef = useRef(0);
  const playbackGenerationRef = useRef(0);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "system") => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, message, type }]);
  }, []);

  const addTimeline = useCallback(
    (entry: Omit<TimelineEntry, "id" | "timestamp"> & { timestamp?: number }) => {
      setTimeline((prev) => {
        const next = [
          ...prev,
          {
            ...entry,
            id: timelineIdRef.current++,
            timestamp: entry.timestamp ?? Date.now(),
          },
        ];
        return next.slice(-TIMELINE_LIMIT);
      });
    },
    [],
  );

  const setMetric = useCallback((name: string, value: string) => {
    setMetrics((prev) => ({ ...prev, [name]: value }));
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (timelineContainerRef.current) {
      timelineContainerRef.current.scrollTop = timelineContainerRef.current.scrollHeight;
    }
  }, [timeline]);

  const stopPlayback = useCallback(() => {
    playbackGenerationRef.current++;
    const dropped = scheduledSourcesRef.current.size;
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    }
    scheduledSourcesRef.current.clear();
    nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    if (dropped > 0) {
      addTimeline({
        source: "browser",
        name: "browser:playback-stop",
        detail: `dropped=${dropped}`,
      });
      setMetric("Cutoff dropped audio", `${dropped} chunk${dropped === 1 ? "" : "s"}`);
    }
  }, [addTimeline, setMetric]);

  const playAudio = useCallback(
    (buffer: ArrayBuffer, meta: AudioMeta) => {
      const audioContext = audioContextRef.current;
      if (!audioContext) return;

      const receivedAt = Date.now();
      const float32 = linear16ToFloat32(buffer);
      const audioBuffer = audioContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
      audioBuffer.getChannelData(0).set(float32);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      const playbackGeneration = playbackGenerationRef.current;
      const earliestStart = audioContext.currentTime + PLAYBACK_LEAD_SECONDS;
      const startAt = Math.max(earliestStart, nextPlaybackTimeRef.current);
      const scheduledDelayMs = Math.max(0, (startAt - audioContext.currentTime) * 1000);
      const scheduledAt = Date.now() + scheduledDelayMs;
      nextPlaybackTimeRef.current = startAt + audioBuffer.duration;

      scheduledSourcesRef.current.add(source);
      source.addEventListener("ended", () => {
        scheduledSourcesRef.current.delete(source);
        if (playbackGenerationRef.current !== playbackGeneration) return;
        if (scheduledSourcesRef.current.size === 0 && audioContextRef.current) {
          nextPlaybackTimeRef.current = audioContextRef.current.currentTime;
        }
        const countKey = meta.requestId ?? meta.turnId ?? "unknown";
        const count = (browserPlaybackEndCountsRef.current.get(countKey) ?? 0) + 1;
        browserPlaybackEndCountsRef.current.set(countKey, count);
        setMetric("Browser playback completed", `${count} chunks t:${shortId(meta.turnId)}`);
        if (count === 1 || count % AUDIO_TIMELINE_EVERY === 0) {
          addTimeline({
            source: "browser",
            name: "browser:playback-ended",
            detail: `chunks=${count} bytes=${buffer.byteLength}`,
            turnId: meta.turnId,
            requestId: meta.requestId,
          });
        }
      });

      source.start(startAt);

      if (meta.serverSentAt !== undefined) {
        setMetric(
          "Server send to playback",
          formatTurnDuration(scheduledAt - meta.serverSentAt, meta.turnId),
        );
      }
      setMetric(
        "Browser receive to playback",
        formatTurnDuration(scheduledAt - receivedAt, meta.turnId),
      );
      setMetric(
        "Playback buffer lead",
        `${formatDuration(
          Math.max(0, (nextPlaybackTimeRef.current - audioContext.currentTime) * 1000),
        )} t:${shortId(meta.turnId)}`,
      );
      setMetric(
        "Browser playback scheduled",
        `${formatDuration(scheduledDelayMs)} t:${shortId(meta.turnId)}`,
      );

      const countKey = meta.requestId ?? meta.turnId ?? "unknown";
      const count = (browserAudioCountsRef.current.get(countKey) ?? 0) + 1;
      browserAudioCountsRef.current.set(countKey, count);
      if (count === 1 || count % AUDIO_TIMELINE_EVERY === 0) {
        addTimeline({
          source: "browser",
          name: "browser:audio-scheduled",
          detail: `chunks=${count} bytes=${buffer.byteLength} delay=${formatDuration(scheduledDelayMs)} serverQueue=${meta.queueDepth ?? "--"}`,
          turnId: meta.turnId,
          requestId: meta.requestId,
          timestamp: scheduledAt,
        });
      }
    },
    [addTimeline, setMetric],
  );

  const handleTrace = useCallback(
    (trace: AgentTraceEvent) => {
      if (trace.type === "ai-turn:started" && trace.turnId) {
        turnStartedAtRef.current.set(trace.turnId, trace.timestamp);
        turnTimingRef.current.set(trace.turnId, {});
      }

      const turnStartedAt = trace.turnId ? turnStartedAtRef.current.get(trace.turnId) : undefined;
      const fromTurnStart =
        turnStartedAt === undefined ? undefined : trace.timestamp - turnStartedAt;
      const timing = trace.turnId ? turnTimingRef.current.get(trace.turnId) : undefined;

      if (
        trace.type === "llm:first-token" &&
        fromTurnStart !== undefined &&
        timing &&
        timing.firstTokenAt === undefined
      ) {
        timing.firstTokenAt = trace.timestamp;
        setMetric("Turn to first token", formatTurnDuration(fromTurnStart, trace.turnId));
      } else if (
        trace.type === "llm:sentence" &&
        fromTurnStart !== undefined &&
        timing &&
        timing.firstSentenceAt === undefined
      ) {
        timing.firstSentenceAt = trace.timestamp;
        setMetric("Turn to first sentence", formatTurnDuration(fromTurnStart, trace.turnId));
      } else if (
        trace.type === "tts:first-audio" &&
        fromTurnStart !== undefined &&
        timing &&
        timing.firstTTSAudioAt === undefined
      ) {
        timing.firstTTSAudioAt = trace.timestamp;
        setMetric("Turn to first TTS audio", formatTurnDuration(fromTurnStart, trace.turnId));
      } else if (trace.type === "speech:start" && timing && trace.data?.speaking === true) {
        timing.speechStartedAt = trace.timestamp;
        setMetric(
          "Interrupt speech source",
          `${String(trace.data.source ?? "unknown")} audio:${String(trace.data.audioStarted)}`,
        );
      } else if (trace.type === "audio:send" && fromTurnStart !== undefined) {
        if (timing && timing.firstAudioSendAt === undefined) {
          timing.firstAudioSendAt = trace.timestamp;
          setMetric("Turn to audio ready", formatTurnDuration(fromTurnStart, trace.turnId));
        }
      } else if (trace.type === "interruption:pending" && timing?.speechStartedAt !== undefined) {
        setMetric(
          "Interruption pending",
          formatTurnDuration(trace.timestamp - timing.speechStartedAt, trace.turnId),
        );
      } else if (trace.type === "ai-turn:interrupted" && timing?.speechStartedAt !== undefined) {
        setMetric(
          "Interrupt confirmed",
          formatTurnDuration(trace.timestamp - timing.speechStartedAt, trace.turnId),
        );
      }

      const countKey = `${trace.type}:${trace.requestId ?? trace.turnId ?? "unknown"}`;
      const count = (audioTraceCountsRef.current.get(countKey) ?? 0) + 1;
      audioTraceCountsRef.current.set(countKey, count);
      const isNoisyTrace =
        trace.type === "audio:input" ||
        trace.type === "tts:chunk" ||
        trace.type === "ai-turn:audio" ||
        trace.type === "audio:send";
      if (!isNoisyTrace || count === 1 || count % AUDIO_TIMELINE_EVERY === 0) {
        addTimeline({
          source: "trace",
          name: trace.type,
          detail: isNoisyTrace ? `chunks=${count} ${traceDetail(trace)}` : traceDetail(trace),
          turnId: trace.turnId,
          requestId: trace.requestId,
          timestamp: trace.timestamp,
        });
      }
    },
    [addTimeline, setMetric],
  );

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "ai-turn:audio") return;
      if (event.type === "audio:clear") {
        stopPlayback();
        pendingAudioMetaRef.current = [];
      }
      addTimeline({
        source: "event",
        name: event.type,
        detail: eventDetail(event),
        timestamp: event.timestamp ?? Date.now(),
        turnId: typeof event.turnId === "string" ? event.turnId : undefined,
        requestId: typeof event.requestId === "string" ? event.requestId : undefined,
      });
    },
    [addTimeline, stopPlayback],
  );

  const stop = useCallback(() => {
    setIsRunning(false);
    stopPlayback();
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    pendingAudioMetaRef.current = [];
    audioTraceCountsRef.current = new Map();
    browserAudioCountsRef.current = new Map();
    browserPlaybackEndCountsRef.current = new Map();
    browserReceiveCountsRef.current = new Map();
    turnTimingRef.current = new Map();
    setStatus("disconnected");
    setStatusText("Disconnected");
  }, [stopPlayback]);

  const start = useCallback(async () => {
    try {
      setTimeline([]);
      setMetrics({});
      pendingAudioMetaRef.current = [];
      turnStartedAtRef.current = new Map();
      turnTimingRef.current = new Map();
      audioTraceCountsRef.current = new Map();
      browserAudioCountsRef.current = new Map();
      browserPlaybackEndCountsRef.current = new Map();
      browserReceiveCountsRef.current = new Map();
      scheduledSourcesRef.current.clear();
      nextPlaybackTimeRef.current = 0;
      audioContextRef.current = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });

      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: INPUT_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const ws = new WebSocket(`ws://${window.location.host}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setStatus("connected");
        setStatusText("Connected - Speak now");
        addLog("Connected to server");
        setIsRunning(true);

        if (!audioContextRef.current) return;
        if (!mediaStreamRef.current) return;

        const source = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
        const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.addEventListener("audioprocess", (e) => {
          if (ws.readyState === WebSocket.OPEN) {
            const float32 = e.inputBuffer.getChannelData(0);
            const inputSampleRate = e.inputBuffer.sampleRate;
            const normalized =
              inputSampleRate === INPUT_SAMPLE_RATE
                ? float32
                : resample(float32, inputSampleRate, INPUT_SAMPLE_RATE);
            const pcm16 = float32ToLinear16(normalized);
            ws.send(pcm16);
          }
        });

        source.connect(processor);
        processor.connect(audioContextRef.current.destination);
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const meta = pendingAudioMetaRef.current.shift() ?? { bytes: event.data.byteLength };
          const receivedAt = Date.now();
          if (meta.serverSentAt !== undefined) {
            setMetric(
              "Server send to browser",
              formatTurnDuration(receivedAt - meta.serverSentAt, meta.turnId),
            );
          }
          const countKey = meta.requestId ?? meta.turnId ?? "unknown";
          const count = (browserReceiveCountsRef.current.get(countKey) ?? 0) + 1;
          browserReceiveCountsRef.current.set(countKey, count);
          if (count === 1 || count % AUDIO_TIMELINE_EVERY === 0) {
            addTimeline({
              source: "browser",
              name: "browser:audio-received",
              detail: `chunks=${count} bytes=${event.data.byteLength}`,
              turnId: meta.turnId,
              requestId: meta.requestId,
              timestamp: receivedAt,
            });
          }
          playAudio(event.data, meta);
        } else {
          const msg = JSON.parse(event.data);
          if (msg.type === "audio-meta") {
            const turnId = typeof msg.turnId === "string" ? msg.turnId : undefined;
            const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
            const serverSentAt =
              typeof msg.serverSentAt === "number" ? msg.serverSentAt : Date.now();
            const bytes = typeof msg.bytes === "number" ? msg.bytes : 0;
            const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : undefined;
            const queueDepth = typeof msg.queueDepth === "number" ? msg.queueDepth : undefined;
            pendingAudioMetaRef.current.push({
              turnId,
              requestId,
              serverSentAt,
              bytes,
              durationMs,
              queueDepth,
            });

            const turnStartedAt = turnId ? turnStartedAtRef.current.get(turnId) : undefined;
            const timing = turnId ? turnTimingRef.current.get(turnId) : undefined;
            if (
              turnId &&
              turnStartedAt !== undefined &&
              timing !== undefined &&
              timing.firstServerAudioSentAt === undefined
            ) {
              timing.firstServerAudioSentAt = serverSentAt;
              setMetric(
                "Turn to server audio send",
                formatTurnDuration(serverSentAt - turnStartedAt, turnId),
              );
            }
          } else if (msg.type === "trace") {
            handleTrace(msg.trace);
          } else if (msg.type === "event") {
            handleServerEvent(msg.event);
          } else if (msg.type === "transcript") {
            addLog(`[You] ${msg.text}`, "human");
          } else if (msg.type === "response") {
            addLog(`[Agent] ${msg.text}`, "ai");
          } else if (msg.type === "response-interrupted") {
            stopPlayback();
            const completedText = typeof msg.text === "string" ? msg.text.trim() : "";
            const startedText =
              typeof msg.audioStartedText === "string" ? msg.audioStartedText.trim() : "";
            if (completedText || startedText) {
              addLog(
                completedText
                  ? `[Agent interrupted after completed audio] ${completedText}`
                  : `[Agent interrupted while audio was streaming] ${startedText}`,
                "system",
              );
            }
          } else if (msg.type === "status") {
            addLog(msg.text, "system");
          }
        }
      });

      ws.addEventListener("close", () => {
        setStatus("disconnected");
        setStatusText("Disconnected");
        addLog("Disconnected");
        stop();
      });

      ws.addEventListener("error", () => {
        setStatus("error");
        setStatusText("Connection error");
        addLog("WebSocket error");
        stop();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setStatusText(`Error: ${message}`);
      addLog(`Error: ${message}`);
    }
  }, [
    addLog,
    addTimeline,
    handleServerEvent,
    handleTrace,
    playAudio,
    setMetric,
    stop,
    stopPlayback,
  ]);

  const runDemo = useCallback(async () => {
    setIsDemoRunning(true);
    setDemoError(null);
    setDemoResult(null);

    try {
      const response = await fetch("/api/correctness-demo");
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Correctness demo failed");
      }
      setDemoResult(payload);
      addLog("Correctness demo passed", "system");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDemoError(message);
      addLog(`Correctness demo failed: ${message}`, "system");
    } finally {
      setIsDemoRunning(false);
    }
  }, [addLog]);

  const metricItems = useMemo(
    () => [
      ["Turn to first token", metrics["Turn to first token"] ?? "--"],
      ["Turn to first sentence", metrics["Turn to first sentence"] ?? "--"],
      ["Turn to first TTS audio", metrics["Turn to first TTS audio"] ?? "--"],
      ["Turn to audio ready", metrics["Turn to audio ready"] ?? "--"],
      ["Turn to server audio send", metrics["Turn to server audio send"] ?? "--"],
      ["Server send to browser", metrics["Server send to browser"] ?? "--"],
      ["Server send to playback", metrics["Server send to playback"] ?? "--"],
      ["Browser receive to playback", metrics["Browser receive to playback"] ?? "--"],
      ["Browser playback scheduled", metrics["Browser playback scheduled"] ?? "--"],
      ["Playback buffer lead", metrics["Playback buffer lead"] ?? "--"],
      ["Interrupt speech source", metrics["Interrupt speech source"] ?? "--"],
      ["Interruption pending", metrics["Interruption pending"] ?? "--"],
      ["Interrupt confirmed", metrics["Interrupt confirmed"] ?? "--"],
      ["Cutoff dropped audio", metrics["Cutoff dropped audio"] ?? "--"],
      ["Browser playback completed", metrics["Browser playback completed"] ?? "--"],
    ],
    [metrics],
  );

  return (
    <div className="container">
      <h1>Voice Agent Demo</h1>
      <section className="panel">
        <h2>Framework Correctness</h2>
        <p>
          Runs Talkio without live APIs: deterministic scenario, trace replay, generated traces,
          provider conformance, and a broken-provider rejection check.
        </p>
        <button className="demo-btn" onClick={runDemo} disabled={isDemoRunning}>
          {isDemoRunning ? "Running..." : "Run Correctness Demo"}
        </button>
        {demoError ? <div className="demo-error">{demoError}</div> : null}
        {demoResult ? (
          <div className="demo-results">
            <div className="demo-summary">{demoResult.summary}</div>
            {demoResult.checks.map((check) => (
              <div className="demo-check" key={check.name}>
                <strong>{check.name}</strong>
                <span>{check.detail}</span>
                {check.events ? <code>{check.events.join(" -> ")}</code> : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel live-panel">
        <h2>Live Conversation</h2>
        <p>Requires Deepgram and OpenAI API keys on the server.</p>
        <div className={`status ${status}`}>{statusText}</div>
        <div className="button-row">
          <button className="start-btn" onClick={start} disabled={isRunning}>
            Start Conversation
          </button>
          <button className="stop-btn" onClick={stop} disabled={!isRunning}>
            Stop
          </button>
        </div>
        <div className="log" ref={logContainerRef}>
          {logs.map((log) => (
            <div key={log.id} className={`log-entry log-${log.type}`}>
              {log.message}
            </div>
          ))}
        </div>
      </section>

      <section className="panel observability-panel">
        <h2>Observability</h2>
        <div className="metric-grid">
          {metricItems.map(([name, value]) => (
            <div className="metric" key={name}>
              <span>{name}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div className="timeline" ref={timelineContainerRef}>
          {timeline.map((entry) => (
            <div key={entry.id} className={`timeline-entry timeline-${entry.source}`}>
              <span className="timeline-time">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
              <span className="timeline-name">{entry.name}</span>
              <span className="timeline-ids">
                t:{shortId(entry.turnId)} r:{shortId(entry.requestId)}
              </span>
              <span className="timeline-detail">{entry.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
