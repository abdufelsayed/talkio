/**
 * The streaming WebSocket shared by the Deepgram STT providers.
 *
 * Audio sent while the socket connects is buffered and flushed on open. Once
 * a socket has closed it never opens again, so audio sent after that is
 * dropped instead of piling up.
 *
 * Deepgram closes a stream that receives nothing for 10 seconds, which
 * happens whenever the client stops sending audio (push-to-talk, muting,
 * skipping silence). With `keepAlive`, the socket sends a KeepAlive message
 * once nothing has gone out for a few seconds, as Deepgram recommends.
 *
 * @module stream-socket
 */

export interface StreamSocketOptions {
  url: string;
  apiKey: string;
  /** Names the provider in error messages, e.g. "Deepgram Flux". */
  label: string;
  onMessage: (event: MessageEvent) => void;
  onError: (error: Error) => void;
  /** Send KeepAlive messages while no audio flows. Deepgram documents them for /v1/listen. */
  keepAlive?: boolean;
}

export interface StreamSocket {
  send(audio: ArrayBuffer): void;
  /** Asks Deepgram to finish the stream and closes the socket without reporting errors. */
  close(): void;
}

const NORMAL_CLOSE_CODES = new Set([1000, 1005]);
const KEEP_ALIVE_AFTER_MS = 4000;
const KEEP_ALIVE_CHECK_MS = 1000;
const KEEP_ALIVE_MESSAGE = JSON.stringify({ type: "KeepAlive" });

export function openStreamSocket(options: StreamSocketOptions): StreamSocket {
  const { url, apiKey, label, onMessage, onError } = options;
  const ws = new WebSocket(url, ["token", apiKey]);
  let buffer: ArrayBuffer[] = [];
  let closed = false;
  let lastSentAt = 0;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stopKeepAlive = () => {
    if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  ws.addEventListener("open", () => {
    for (const chunk of buffer) ws.send(chunk);
    buffer = [];
    lastSentAt = Date.now();
    if (!options.keepAlive) return;
    keepAliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || Date.now() - lastSentAt < KEEP_ALIVE_AFTER_MS) return;
      ws.send(KEEP_ALIVE_MESSAGE);
      lastSentAt = Date.now();
    }, KEEP_ALIVE_CHECK_MS);
  });
  ws.addEventListener("message", onMessage);
  ws.addEventListener("error", () => {
    if (!closed) onError(new Error(`${label} WebSocket error: Connection failed`));
  });
  ws.addEventListener("close", (event) => {
    buffer = [];
    stopKeepAlive();
    if (closed || NORMAL_CLOSE_CODES.has(event.code)) return;
    onError(new Error(`${label} WebSocket closed: ${event.reason || `code ${event.code}`}`));
  });

  return {
    send(audio) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
        lastSentAt = Date.now();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        buffer.push(audio);
      }
    },
    close() {
      closed = true;
      buffer = [];
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close();
    },
  };
}
