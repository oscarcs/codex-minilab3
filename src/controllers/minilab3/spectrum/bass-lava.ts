import type { SpectrumFrame } from "../../../audio/system-audio-spectrum.js";
import type { SpectrumLightingPreset } from "./types.js";

const BASS_HEAT_PALETTE = [
  { level: 0, color: [4, 0, 10] },
  { level: 0.18, color: [28, 0, 62] },
  { level: 0.42, color: [132, 0, 126] },
  { level: 0.66, color: [255, 18, 54] },
  { level: 0.84, color: [255, 112, 0] },
  { level: 1, color: [255, 244, 214] },
] as const;
const PAD_PULSE_DISTANCE = [1, 2 / 3, 1 / 3, 0, 0, 1 / 3, 2 / 3, 1] as const;
const KICK_PULSE_DURATION_MS = 320;

export const BASS_LAVA_PRESET = {
  kind: "spectrum",
  id: "bass-lava",
  displayName: "Bass Lava",
  analyzer: {
    bandCenters: [50, 70, 95, 130, 180, 250, 350, 500],
    bandGains: [2.4, 2.15, 1.9, 1.65, 1.45, 1.25, 1.1, 1],
    filterQ: 1.05,
    fastDecay: 0.72,
    bodyDecay: 0.94,
    bodyAttack: 0.45,
    bodyMix: 0.72,
    normalization: {
      mode: "fixed",
      floorDb: -58,
      ceilingDb: -8,
      gamma: 1.35,
    },
  },
  createLighting: () => new BassSpectrumLighting(),
} as const satisfies SpectrumLightingPreset;

export class BassSpectrumLighting {
  #baseline = 0.08;
  #previousBass = 0;
  #lastKickAt = Number.NEGATIVE_INFINITY;
  #pulseStartedAt = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.#baseline = 0.08;
    this.#previousBass = 0;
    this.#lastKickAt = Number.NEGATIVE_INFINITY;
    this.#pulseStartedAt = Number.NEGATIVE_INFINITY;
  }

  render(frame: SpectrumFrame, nowMs = Date.now()): number[] {
    const bass = frame[0] * 0.32 + frame[1] * 0.3 + frame[2] * 0.23 + frame[3] * 0.15;
    const risingEdge = bass - this.#previousBass;
    const kickThreshold = Math.max(0.18, this.#baseline * 1.55);
    if (
      bass >= kickThreshold &&
      risingEdge >= 0.07 &&
      nowMs - this.#lastKickAt >= 190
    ) {
      this.#lastKickAt = nowMs;
      this.#pulseStartedAt = nowMs;
    }
    this.#baseline = this.#baseline * 0.985 + bass * 0.015;
    this.#previousBass = bass;

    const pulseElapsed = nowMs - this.#pulseStartedAt;
    const pulseProgress = pulseElapsed >= 0 && pulseElapsed <= KICK_PULSE_DURATION_MS
      ? pulseElapsed / KICK_PULSE_DURATION_MS
      : undefined;
    return renderSpectrumColors(frame, pulseProgress);
  }
}

export function renderSpectrumColors(frame: SpectrumFrame, pulseProgress?: number): number[] {
  return frame.flatMap((level, index) => {
    const pulseDistance = PAD_PULSE_DISTANCE[index] ?? 0;
    const pulse = pulseProgress === undefined
      ? 0
      : Math.max(0, 1 - Math.abs(pulseProgress - pulseDistance) / 0.38);
    const heat = Math.max(level, pulse * (1 - (pulseProgress ?? 0) * 0.12));
    return interpolateHeatColor(heat).map((component) => Math.round((component / 255) * 127));
  });
}

function interpolateHeatColor(level: number): number[] {
  const clamped = Math.max(0, Math.min(1, level));
  const upperIndex = BASS_HEAT_PALETTE.findIndex((stop) => stop.level >= clamped);
  if (upperIndex <= 0) return [...BASS_HEAT_PALETTE[0].color];
  if (upperIndex < 0) return [...BASS_HEAT_PALETTE.at(-1)!.color];
  const lower = BASS_HEAT_PALETTE[upperIndex - 1]!;
  const upper = BASS_HEAT_PALETTE[upperIndex]!;
  const mix = (clamped - lower.level) / (upper.level - lower.level);
  return lower.color.map((component, index) => {
    const target = upper.color[index]!;
    return component + (target - component) * mix;
  });
}
