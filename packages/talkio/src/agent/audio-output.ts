/**
 * Output audio buffer behind the agent's public `audioStream`.
 *
 * The stream is pull-based: chunks wait here until the consumer reads them.
 * Because unread chunks are still owned by the agent, an interruption can
 * discard them, so a server relaying the stream never forwards audio from a
 * turn the user already cut off.
 *
 * @module agent/audio-output
 */

export interface OutputChunk {
  audio: ArrayBuffer;
  turnId?: string;
  requestId?: string;
}

export interface AudioOutputBuffer {
  readonly stream: ReadableStream<ArrayBuffer>;
  /** Queues a chunk; returns the number of old chunks dropped to stay within the limit. */
  push(chunk: OutputChunk): number;
  /** Discards unread chunks, only those of `turnId` when given; returns how many. */
  clear(turnId?: string): number;
  close(): void;
}

/** About five minutes of 24 kHz linear16 audio. */
export const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createAudioOutputBuffer(
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
): AudioOutputBuffer {
  const queue: OutputChunk[] = [];
  let queuedBytes = 0;
  let controller: ReadableStreamDefaultController<ArrayBuffer> | null = null;
  let waitingForData = false;
  let closed = false;

  const flushToReader = () => {
    if (!controller || !waitingForData) return;
    const next = queue.shift();
    if (!next) return;
    queuedBytes -= next.audio.byteLength;
    waitingForData = false;
    controller.enqueue(next.audio);
  };

  const stream = new ReadableStream<ArrayBuffer>(
    {
      start(streamController) {
        controller = streamController;
      },
      pull() {
        waitingForData = true;
        flushToReader();
      },
      cancel() {
        closed = true;
        queue.length = 0;
        queuedBytes = 0;
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    push(chunk) {
      if (closed) return 0;
      queue.push(chunk);
      queuedBytes += chunk.audio.byteLength;
      let dropped = 0;
      while (queuedBytes > maxBufferedBytes && queue.length > 1) {
        const oldest = queue.shift();
        if (!oldest) break;
        queuedBytes -= oldest.audio.byteLength;
        dropped++;
      }
      flushToReader();
      return dropped;
    },
    clear(turnId) {
      let removed = 0;
      for (let index = queue.length - 1; index >= 0; index--) {
        const chunk = queue[index];
        if (!chunk || (turnId !== undefined && chunk.turnId !== turnId)) continue;
        queue.splice(index, 1);
        queuedBytes -= chunk.audio.byteLength;
        removed++;
      }
      return removed;
    },
    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
      try {
        controller?.close();
      } catch {
        return;
      }
    },
  };
}
