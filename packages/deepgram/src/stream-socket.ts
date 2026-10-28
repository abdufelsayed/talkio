/**
 * The streaming WebSocket shared by the Deepgram STT providers.
 *
 * Audio sent while the socket connects is buffered and flushed on open.
 *
 * A connection that drops after opening (a network blip, a server-side close)
 * is reopened with backoff, and the audio sent meanwhile is delivered once it
 * reconnects, so the user's words are not lost. A connection that never
 * opened is not retried: that is almost always configuration, such as a bad
 * API key or parameter. Errors are reported once the socket gives up.
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
  /** Called when a dropped connection has been reopened, before buffered audio is sent. */
  onReconnect?: () => void;
  /** Send KeepAlive messages while no audio flows. Deepgram documents them for /v1/listen. */
  keepAlive?: boolean;
}

export interface StreamSocket {
  send(audio: ArrayBuffer): void;
  /** Asks Deepgram to finish the stream and closes the socket without reporting errors. */
  close(): void;
}

const NORMAL_CLOSE_CODES = new Set([1000, 1005]);
const RECONNECT_DELAYS_MS = [250, 1000, 2000, 4000, 8000];
/** About 30 seconds of 16 kHz linear16 audio. */
const MAX_BUFFERED_BYTES = 1_000_000;
const KEEP_ALIVE_AFTER_MS = 4000;
const KEEP_ALIVE_CHECK_MS = 1000;
const KEEP_ALIVE_MESSAGE = JSON.stringify({ type: "KeepAlive" });

export function openStreamSocket(options: StreamSocketOptions): StreamSocket {
  const { url, apiKey, label, onMessage, onError } = options;
  let buffer: ArrayBuffer[] = [];
  let bufferedBytes = 0;
  let closed = false;
  let opened = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentAt = 0;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stopKeepAlive = () => {
    if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  const clearBuffer = () => {
    buffer = [];
    bufferedBytes = 0;
  };

  const bufferAudio = (audio: ArrayBuffer) => {
    buffer.push(audio);
    bufferedBytes += audio.byteLength;
    while (bufferedBytes > MAX_BUFFERED_BYTES && buffer.length > 1) {
      bufferedBytes -= buffer.shift()?.byteLength ?? 0;
    }
  };

  let ws = connect();

  function connect(): WebSocket {
    const socket = new WebSocket(url, ["token", apiKey]);

    socket.addEventListener("open", () => {
      if (opened) options.onReconnect?.();
      opened = true;
      attempts = 0;
      for (const chunk of buffer) socket.send(chunk);
      clearBuffer();
      lastSentAt = Date.now();
      if (!options.keepAlive) return;
      keepAliveTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastSentAt < KEEP_ALIVE_AFTER_MS) return;
        socket.send(KEEP_ALIVE_MESSAGE);
        lastSentAt = Date.now();
      }, KEEP_ALIVE_CHECK_MS);
    });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", (event) => {
      stopKeepAlive();
      if (closed || NORMAL_CLOSE_CODES.has(event.code)) {
        clearBuffer();
        return;
      }
      const reason = event.reason || `code ${event.code}`;
      const delay = RECONNECT_DELAYS_MS[attempts];
      if (!opened || delay === undefined) {
        clearBuffer();
        const retried = attempts > 0 ? ` after ${attempts} reconnect attempts` : "";
        onError(new Error(`${label} WebSocket closed: ${reason}${retried}`));
        return;
      }
      attempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ws = connect();
      }, delay);
    });
    return socket;
  }

  return {
    send(audio) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
        lastSentAt = Date.now();
      } else if (ws.readyState === WebSocket.CONNECTING || reconnectTimer !== null) {
        bufferAudio(audio);
      }
    },
    close() {
      closed = true;
      clearBuffer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      ws.close();
    },
  };
}
