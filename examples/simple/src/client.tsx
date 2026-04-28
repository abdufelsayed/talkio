import { useCallback, useEffect, useRef, useState } from "react";
import { float32ToLinear16, linear16ToFloat32 } from "talkio";

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

type LogEntry = {
  id: number;
  message: string;
  type: "system" | "human" | "ai";
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

export function VoiceAgentDemo() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [statusText, setStatusText] = useState("Disconnected");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [demoResult, setDemoResult] = useState<CorrectnessDemoResult | null>(null);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playbackGenerationRef = useRef(0);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "system") => {
    setLogs((prev) => [...prev, { id: logIdRef.current++, message, type }]);
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const processAudioQueue = useCallback(() => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    if (!audioContextRef.current) return;

    isPlayingRef.current = true;
    const playbackGeneration = playbackGenerationRef.current;
    const buffer = audioQueueRef.current.shift();
    if (!buffer) return;
    const float32 = linear16ToFloat32(buffer);
    const audioBuffer = audioContextRef.current.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    currentSourceRef.current = source;
    source.addEventListener("ended", () => {
      if (currentSourceRef.current === source) {
        currentSourceRef.current = null;
      }
      if (playbackGenerationRef.current !== playbackGeneration) return;
      isPlayingRef.current = false;
      processAudioQueue();
    });
    source.start();
  }, []);

  const stopPlayback = useCallback(() => {
    playbackGenerationRef.current++;
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    const source = currentSourceRef.current;
    currentSourceRef.current = null;
    try {
      source?.stop();
    } catch {
      // The source may already have ended.
    }
  }, []);

  const playAudio = useCallback(
    (buffer: ArrayBuffer) => {
      audioQueueRef.current.push(buffer);
      processAudioQueue();
    },
    [processAudioQueue],
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
    setStatus("disconnected");
    setStatusText("Disconnected");
  }, [stopPlayback]);

  const start = useCallback(async () => {
    try {
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
        setStatusText("Connected - Speak now!");
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
            const pcm16 = float32ToLinear16(float32);
            ws.send(pcm16);
          }
        });

        source.connect(processor);
        processor.connect(audioContextRef.current.destination);
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          playAudio(event.data);
        } else {
          const msg = JSON.parse(event.data);
          if (msg.type === "transcript") {
            addLog(`[You] ${msg.text}`, "human");
          } else if (msg.type === "response") {
            addLog(`[Agent] ${msg.text}`, "ai");
          } else if (msg.type === "status") {
            addLog(msg.text, "system");
          } else if (msg.type === "interruption-pending") {
            stopPlayback();
          } else if (msg.type === "interruption-cancelled") {
            addLog("Interruption cancelled", "system");
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
  }, [addLog, playAudio, stop, stopPlayback]);

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
      <section className="panel">
        <h2>Live Conversation</h2>
        <p>Requires Deepgram and OpenAI API keys on the server.</p>
        <div className={`status ${status}`}>{statusText}</div>
        <button className="start-btn" onClick={start} disabled={isRunning}>
          Start Conversation
        </button>
        <button className="stop-btn" onClick={stop} disabled={!isRunning}>
          Stop
        </button>
        <div className="log" ref={logContainerRef}>
          {logs.map((log) => (
            <div key={log.id} className={`log-entry log-${log.type}`}>
              {log.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
