import { expect, test } from "bun:test";
import {
  AdaptiveTempoSync,
  type OnsetRole,
} from "../src/controllers/minilab3/spectrum/tempo-sync.js";

test("adaptive tempo sync fast-locks a regular metronome on its fourth click", () => {
  const sync = new AdaptiveTempoSync();
  for (const atMs of [0, 500, 1_000, 1_500]) {
    sync.observeOnset(atMs, 1, "high");
  }

  expect(sync.status.mode).toBe("tracking");
  expect(sync.status.acceptedOnsets).toBe(4);
  expect(sync.status.bpm).toBeWithin(119, 121);
  expect(sync.status.confidence).toBeGreaterThanOrEqual(0.7);
  expect(sync.beatsElapsed(2_000)).toBeWithin(3.99, 4.01);
});

test("adaptive tempo sync does not fast-lock an irregular opening", () => {
  const sync = new AdaptiveTempoSync();
  for (const atMs of [0, 430, 1_020, 1_485]) {
    sync.observeOnset(atMs, 1, "high");
  }

  expect(sync.status.mode).toBe("acquiring");
  expect(sync.status.acceptedOnsets).toBe(4);
});

test("adaptive tempo sync favors quarter-note structure over high-frequency subdivisions", () => {
  const sync = new AdaptiveTempoSync();
  feedBeatPattern(sync, 120, 14, new Set([5, 10]));

  expect(estimatedBpm(sync)).toBeWithin(117, 123);
  expect(sync.confidence).toBeGreaterThan(0.05);
});

test("adaptive tempo sync resolves a 90 BPM groove instead of its 180 BPM double", () => {
  const sync = new AdaptiveTempoSync();
  feedBeatPattern(sync, 90, 12, new Set([6]));

  expect(estimatedBpm(sync)).toBeWithin(86, 94);
});

test("adaptive tempo sync coasts in phase when a beat is missing", () => {
  const sync = new AdaptiveTempoSync();
  const bpm = 126;
  const periodMs = 60_000 / bpm;
  feedBeatPattern(sync, bpm, 14, new Set([8]));

  const twoBeatsAfterPattern = 14 * periodMs + periodMs * 2;
  const beatsElapsed = sync.beatsElapsed(twoBeatsAfterPattern);
  expect(beatsElapsed).toBeDefined();
  const phase = positiveModulo(beatsElapsed!, 1);
  expect(Math.min(phase, 1 - phase)).toBeLessThan(0.12);
});

test("adaptive tempo sync keeps its clock through a high-frequency fill", () => {
  const sync = new AdaptiveTempoSync();
  feedBeatPattern(sync, 120, 14, new Set());
  for (let hit = 0; hit < 10; hit += 1) {
    sync.observeOnset(7_000 + hit * 110, 0.65, "high");
  }

  expect(estimatedBpm(sync)).toBeWithin(117, 123);
});

test("adaptive tempo sync holds a latched tempo through a brief competing pulse", () => {
  const sync = new AdaptiveTempoSync();
  let atMs = 0;
  for (let beat = 0; beat < 10; beat += 1) {
    sync.observeOnset(atMs, 1.2, beat % 2 === 0 ? "low" : "mid");
    atMs += 500;
  }
  for (let beat = 0; beat < 4; beat += 1) {
    sync.observeOnset(atMs, 1.2, beat % 2 === 0 ? "low" : "mid");
    atMs += 60_000 / 90;
  }

  expect(estimatedBpm(sync)).toBeWithin(119.5, 120.5);
});

test("adaptive tempo sync starts a fresh fast acquisition after silence", () => {
  const sync = new AdaptiveTempoSync();
  for (const atMs of [0, 500, 1_000, 1_500, 5_000, 5_500, 6_000, 6_500]) {
    sync.observeOnset(atMs, 1, "high");
  }

  expect(sync.status.mode).toBe("tracking");
  expect(sync.status.acceptedOnsets).toBe(4);
  expect(sync.status.bpm).toBeWithin(119, 121);
});

test("adaptive tempo sync follows a sustained tempo change without snapping", () => {
  const sync = new AdaptiveTempoSync();
  let atMs = 0;
  for (let beat = 0; beat < 10; beat += 1) {
    sync.observeOnset(atMs, beat % 4 === 0 ? 1.7 : 1, beat % 2 === 0 ? "low" : "mid");
    atMs += 500;
  }
  const beforeChange = estimatedBpm(sync);
  for (let beat = 0; beat < 20; beat += 1) {
    sync.observeOnset(atMs, beat % 4 === 0 ? 1.7 : 1, beat % 2 === 0 ? "low" : "mid");
    atMs += 60_000 / 132;
  }

  expect(beforeChange).toBeWithin(117, 123);
  expect(estimatedBpm(sync)).toBeWithin(128, 134);
});

function feedBeatPattern(
  sync: AdaptiveTempoSync,
  bpm: number,
  beatCount: number,
  missingBeats: ReadonlySet<number>,
): void {
  const periodMs = 60_000 / bpm;
  const events: Array<{ atMs: number; strength: number; role: OnsetRole }> = [];
  for (let beat = 0; beat < beatCount; beat += 1) {
    if (!missingBeats.has(beat)) {
      events.push({
        atMs: beat * periodMs,
        strength: beat % 4 === 0 ? 1.7 : 1.05,
        role: beat % 2 === 0 ? "low" : "mid",
      });
    }
    events.push({
      atMs: (beat + 0.5) * periodMs,
      strength: 0.72,
      role: "high",
    });
  }
  events.sort((left, right) => left.atMs - right.atMs);
  for (const event of events) sync.observeOnset(event.atMs, event.strength, event.role);
}

function estimatedBpm(sync: AdaptiveTempoSync): number {
  expect(sync.periodMs).toBeDefined();
  return 60_000 / sync.periodMs!;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
