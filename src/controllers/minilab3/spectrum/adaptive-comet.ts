import type { SpectrumFrame } from "../../../audio/system-audio-spectrum.js";
import type { SpectrumLightingPreset } from "./types.js";

const SILENCE: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
const FLUX_WEIGHTS: SpectrumFrame = [0.7, 0.85, 1, 1, 1, 0.9, 0.8, 0.65];
const COMET_DURATION_MS = 560;
const COMET_TRAVEL_PORTION = 0.76;

export const ADAPTIVE_COMET_PRESET = {
  kind: "spectrum",
  id: "adaptive-comet",
  displayName: "Adaptive Comet",
  analyzer: {
    bandCenters: [40, 60, 90, 140, 220, 340, 520, 800],
    bandGains: [2.8, 2.4, 2, 1.65, 1.35, 1.15, 1, 0.95],
    filterQ: 0.95,
    fastDecay: 0.62,
    bodyDecay: 0.88,
    bodyAttack: 0.4,
    bodyMix: 0.5,
    normalization: {
      mode: "adaptive",
      dynamicRangeDb: 38,
      referenceDecayDbPerFrame: 0.22,
      silenceThresholdDb: -72,
      gamma: 1.2,
    },
  },
  createLighting: () => new AdaptiveCometLighting(),
} as const satisfies SpectrumLightingPreset;

export class AdaptiveCometLighting {
  #previousFrame = SILENCE;
  #fluxMean = 0.025;
  #fluxVariance = 0.0009;
  #lastOnsetAt = Number.NEGATIVE_INFINITY;
  #cometStartedAt = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.#previousFrame = SILENCE;
    this.#fluxMean = 0.025;
    this.#fluxVariance = 0.0009;
    this.#lastOnsetAt = Number.NEGATIVE_INFINITY;
    this.#cometStartedAt = Number.NEGATIVE_INFINITY;
  }

  render(frame: SpectrumFrame, nowMs = Date.now()): number[] {
    const flux = spectralFlux(frame, this.#previousFrame);
    const deviation = Math.sqrt(this.#fluxVariance);
    const threshold = this.#fluxMean + Math.max(0.035, deviation * 1.65);
    const active = Math.max(...frame) >= 0.14;
    if (
      active &&
      flux >= threshold &&
      nowMs - this.#lastOnsetAt >= 180
    ) {
      this.#lastOnsetAt = nowMs;
      this.#cometStartedAt = nowMs;
    }

    const limitedFlux = Math.min(flux, threshold * 1.25);
    const difference = limitedFlux - this.#fluxMean;
    this.#fluxMean += difference * 0.028;
    this.#fluxVariance = this.#fluxVariance * 0.972 + difference * difference * 0.028;
    this.#previousFrame = [...frame] as SpectrumFrame;

    const elapsed = nowMs - this.#cometStartedAt;
    const progress = elapsed >= 0 && elapsed <= COMET_DURATION_MS
      ? elapsed / COMET_DURATION_MS
      : undefined;
    return renderAdaptiveComet(frame, progress);
  }
}

export function renderAdaptiveComet(frame: SpectrumFrame, progress?: number): number[] {
  const travel = progress === undefined
    ? undefined
    : Math.min(1, progress / COMET_TRAVEL_PORTION);
  const headPosition = travel === undefined ? undefined : travel * 7;
  const endFade = progress === undefined || progress <= COMET_TRAVEL_PORTION
    ? 1
    : Math.max(0, (1 - progress) / (1 - COMET_TRAVEL_PORTION));
  const accent = frequencyAccent(frame);

  const colors = Array.from({ length: 8 }, (_, padIndex) => {
    const localBand = frame[padIndex] ?? 0;
    const background: readonly [number, number, number] = [
      3 + localBand * 9,
      localBand * 3,
      15 + localBand * 30,
    ];
    if (headPosition === undefined) return background;

    const behindHead = headPosition - padIndex;
    if (behindHead < -1 || behindHead > 3.2) return background;
    const headGlow = Math.max(0, 1 - Math.abs(behindHead));
    const tailGlow = behindHead >= 0 ? Math.exp(-behindHead * 1.05) * 0.72 : 0;
    const strength = Math.max(headGlow, tailGlow) * endFade;
    const headMix = Math.max(0, 1 - Math.max(0, behindHead));
    const comet = mixColor(accent, [238, 255, 255], headMix * 0.82);
    return background.map((component, index) => (
      Math.min(255, component + comet[index]! * strength)
    ));
  });

  return colors.flatMap((color) => (
    color.map((component) => Math.round((component / 255) * 127))
  ));
}

function spectralFlux(frame: SpectrumFrame, previous: SpectrumFrame): number {
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const weight = FLUX_WEIGHTS[index] ?? 1;
    total += Math.max(0, frame[index]! - previous[index]!) * weight;
    weightTotal += weight;
  }
  return total / weightTotal;
}

function frequencyAccent(frame: SpectrumFrame): readonly [number, number, number] {
  const total = frame.reduce((sum, level) => sum + level, 0);
  if (total <= 0.001) return [84, 52, 255];
  const centroid = frame.reduce((sum, level, index) => sum + level * index, 0) / total;
  if (centroid <= 2.2) return mixColor([255, 24, 178], [116, 54, 255], centroid / 2.2);
  if (centroid <= 5) return mixColor([116, 54, 255], [0, 218, 255], (centroid - 2.2) / 2.8);
  return mixColor([0, 218, 255], [172, 250, 255], (centroid - 5) / 2);
}

function mixColor(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  const mix = Math.max(0, Math.min(1, amount));
  return [
    from[0] + (to[0] - from[0]) * mix,
    from[1] + (to[1] - from[1]) * mix,
    from[2] + (to[2] - from[2]) * mix,
  ];
}
