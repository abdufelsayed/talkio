export type AudioChunkInput = ArrayBuffer | Uint8Array | number;

export function makeAudioChunk(input: AudioChunkInput = 1, size = 1): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (input instanceof Uint8Array) {
    const buffer = new ArrayBuffer(input.byteLength);
    new Uint8Array(buffer).set(input);
    return buffer;
  }
  return new Uint8Array(Array.from({ length: size }, () => input)).buffer;
}
