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
  assertAudioFormatConformance,
  assertFormatListConformance,
  assertLLMProviderConformance,
  assertProviderMetadataConformance,
  assertSTTProviderConformance,
  assertTTSProviderConformance,
  assertTurnDetectorProviderConformance,
  assertVADProviderConformance,
  createLLMContextProbe,
  createSTTContextProbe,
  createTTSContextProbe,
  createTurnDetectorContextProbe,
  createVADContextProbe,
  type LLMContextProbe,
  type LLMProviderConformanceOptions,
  type ProviderMetadataConformanceOptions,
  type STTContextProbe,
  type STTProviderConformanceOptions,
  type TTSContextProbe,
  type TTSProviderConformanceOptions,
  type TurnDetectorContextProbe,
  type TurnDetectorProviderConformanceOptions,
  type VADContextProbe,
  type VADProviderConformanceOptions,
} from "./conformance";

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
  installMockWebSocket,
  MockWebSocket,
  type MockWebSocketController,
  type MockWebSocketEvent,
  type MockWebSocketListener,
} from "./mock-websocket";

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
  assertHumanSimulationPass,
  DEFAULT_HUMAN_SIMULATION_THRESHOLDS,
  humanSimulationPlanArbitrary,
  runHumanSimulation,
  type HumanSimulationOptions,
  type HumanSimulationScore,
  type HumanSimulationThresholds,
} from "./human-simulation";

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
