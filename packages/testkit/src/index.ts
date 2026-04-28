export {
  assertEventInvariants,
  assertEventSequence,
  assertPartialMatch,
  assertSnapshotPartial,
  ScenarioAssertionError,
  type EventType,
  type RecordedEvent,
} from "./assertions";

export { makeAudioChunk, type AudioChunkInput } from "./audio";
export { createTestClock, drainMicrotasks, type TestClock } from "./clock";
export { createEventCapture, type EventCapture, type TypedRecordedEvent } from "./event-capture";

export {
  createFakeLLM,
  createFakeSTT,
  createFakeTTS,
  createFakeTurnDetector,
  createFakeVAD,
  type FakeLLM,
  type FakeSTT,
  type FakeTTS,
  type FakeTurnDetector,
  type FakeVAD,
  type LLMAction,
  type TTSRequest,
} from "./fake-providers";

export { createAgentHarness, type AgentHarness, type HarnessOptions } from "./harness";

export {
  createScenario,
  scenario,
  VoiceScenario,
  type EventExpectation,
  type ScenarioResult,
  type SnapshotExpectation,
} from "./scenario";

export {
  generateScenarioTrace,
  sampleScenarioTrace,
  scenarioTraceArbitrary,
  type FuzzOptions,
  type GeneratedScenarioTrace,
} from "./fuzz";

export {
  adjacencyMapToArray,
  createTestModel,
  getAdjacencyMap,
  getPathsFromEvents,
  getShortestPaths,
  getSimplePaths,
  toDirectedGraph,
  type AdjacencyMap,
  type AdjacencyValue,
  type StatePath,
  type Step,
  type TestModel,
  type TestParam,
  type TestPath,
  type TraversalOptions,
} from "./graph";

export { runTrace, scenarioFromTrace, type ScenarioTrace, type ScenarioTraceStep } from "./trace";
