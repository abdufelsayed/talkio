/**
 * The streaming WebSocket shared by the Deepgram STT providers.
 *
 * Audio sent while the socket connects is buffered and flushed on open. Once
 * a socket has closed it never opens again, so audio sent after that is
 * dropped instead of piling up.
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
}

export interface StreamSocket {
  send(audio: ArrayBuffer): void;
  /** Asks Deepgram to finish the stream and closes the socket without reporting errors. */
  close(): void;
}

const NORMAL_CLOSE_CODES = new Set([1000, 1005]);

export function openStreamSocket(options: StreamSocketOptions): StreamSocket {
  const { url, apiKey, label, onMessage, onError } = options;
  const ws = new WebSocket(url, ["token", apiKey]);
  let buffer: ArrayBuffer[] = [];
  let closed = false;

  ws.addEventListener("open", () => {
    for (const chunk of buffer) ws.send(chunk);
    buffer = [];
  });
  ws.addEventListener("message", onMessage);
  ws.addEventListener("error", () => {
    if (!closed) onError(new Error(`${label} WebSocket error: Connection failed`));
  });
  ws.addEventListener("close", (event) => {
    buffer = [];
    if (closed || NORMAL_CLOSE_CODES.has(event.code)) return;
    onError(new Error(`${label} WebSocket closed: ${event.reason || `code ${event.code}`}`));
  });

  return {
    send(audio) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
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
