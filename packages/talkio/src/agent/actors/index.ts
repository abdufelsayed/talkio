/**
 * Actor Logic Exports
 *
 * Central export point for all XState callback actors used by the agent state machine.
 *
 * These actors are registered in the agent machine setup and handle different
 * aspects of the voice conversation:
 * - `sttActor` - Speech-to-text transcription
 * - `vadActor` - Voice activity detection (optional)
 * - `turnDetectorActor` - Turn boundary detection (optional)
 * - `llmActor` - The talker's turns
 * - `thinkerActor` - The thinker's background work
 * - `ttsActor` - Text-to-speech synthesis
 * - `audioStreamerActor` - Audio output streaming
 *
 * Each actor is implemented as an XState callback actor that communicates
 * with the state machine via events.
 *
 * @module agent/actors
 */

export { llmActor } from "./llm";
export { thinkerActor } from "./thinker";
export { audioStreamerActor } from "./streamer";
export { sttActor } from "./stt";
export { ttsActor } from "./tts";
export { turnDetectorActor } from "./turn-detector";
export { vadActor } from "./vad";
