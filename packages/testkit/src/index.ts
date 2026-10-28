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
  assertNoLLMEventsAfterAbort,
  assertNoSTTEventsAfterAbort,
  assertNoTTSEventsAfterAbort,
  assertNoTurnDetectorEventsAfterAbort,
  assertNoVADEventsAfterAbort,
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
  snapshotLLMContextProbe,
  snapshotSTTContextProbe,
  snapshotTTSContextProbe,
  snapshotTurnDetectorContextProbe,
  snapshotVADContextProbe,
  type LLMContextProbe,
  type LLMProbeSnapshot,
  type LLMProviderConformanceOptions,
  type ProviderMetadataConformanceOptions,
  type STTContextProbe,
  type STTProbeSnapshot,
  type STTProviderConformanceOptions,
  type TTSContextProbe,
  type TTSProbeSnapshot,
  type TTSProviderConformanceOptions,
  type TurnDetectorContextProbe,
  type TurnDetectorProbeSnapshot,
  type TurnDetectorProviderConformanceOptions,
  type TurnSignalRecord,
  type VADContextProbe,
  type VADProbeSnapshot,
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
  type TraceExpectation,
} from "./scenario";

export {
  aiTurnLifecycleTraceArbitrary,
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
  assertTraceInvariants,
  assertTraceLatencyBudgets,
  collectTraceLatencies,
  DEFAULT_TRACE_LATENCY_BUDGETS,
  type TraceLatencyBudgets,
  type TraceTurnLatency,
} from "./trace-assertions";

export {
  getRegressionTrace,
  REGRESSION_TRACE_FIXTURES,
  type RegressionTraceFixture,
} from "./regression-traces";

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
