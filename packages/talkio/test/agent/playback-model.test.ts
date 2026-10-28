import { describe, expect, it } from "vitest";

import {
  createPlayback,
  heardText,
  pausePlayback,
  playbackPosition,
  releaseAudio,
  resumePlayback,
  type TimedSpeech,
} from "../../src/agent/playback";

function sentence(text: string, startMs: number, durationMs: number, synthesized = true) {
  return { text, startMs, durationMs, synthesized, words: [] } satisfies TimedSpeech;
}

describe("playback model", () => {
  it("does not count elapsed time twice when audio arrives while playing", () => {
    let playback = releaseAudio(createPlayback(0), 0, 1000, 0);
    playback = releaseAudio(playback, 300, 500, 0);
    expect(playbackPosition(playback, 400)).toBe(400);
    expect(playbackPosition(playback, 2000)).toBe(1500);
  });

  it("restarts from where the listener ran dry", () => {
    let playback = releaseAudio(createPlayback(0), 0, 300, 0);
    expect(playbackPosition(playback, 1000)).toBe(300);
    playback = releaseAudio(playback, 1000, 300, 50);
    expect(playbackPosition(playback, 1040)).toBe(300);
    expect(playbackPosition(playback, 1150)).toBe(400);
  });

  it("holds the playhead while paused", () => {
    let playback = releaseAudio(createPlayback(0), 0, 1000, 0);
    playback = pausePlayback(playback, 200);
    expect(playbackPosition(playback, 900)).toBe(200);
    playback = resumePlayback(playback, 900);
    expect(playbackPosition(playback, 1000)).toBe(300);
  });

  it("counts finished sentences in full and cuts the playing one", () => {
    const speech = [
      sentence("First part.", 0, 400),
      sentence("Then four more words.", 400, 400),
      sentence("Not reached.", 800, 400),
    ];
    expect(heardText(speech, 0)).toBe("");
    expect(heardText(speech, 400)).toBe("First part.");
    expect(heardText(speech, 600)).toBe("First part. Then four");
    expect(heardText(speech, 2000)).toBe("First part. Then four more words. Not reached.");
  });

  it("assumes an even speech rate for sentences still being synthesized", () => {
    const speech = [sentence("one two three four five", 0, 500, false)];
    expect(heardText(speech, 760)).toBe("one two");
  });

  it("ignores sentences whose audio never reached the listener", () => {
    expect(heardText([{ ...sentence("Never released.", 0, 0), startMs: null }], 1000)).toBe("");
  });
});
