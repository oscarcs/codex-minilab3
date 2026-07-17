import type {
  SpectrumFrame,
  SpectrumTransientFrame,
} from "../../../audio/system-audio-spectrum.js";
import { AdaptiveTempoSync, type OnsetRole } from "./tempo-sync.js";
import { AdaptiveTransientDetector } from "./transient-detector.js";
import type { SpectrumLightingPreset } from "./types.js";

const SILENCE: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
const FLUX_WEIGHTS: SpectrumFrame = [0.7, 0.85, 1, 1, 1, 0.9, 0.8, 0.7];
const VISUAL_LATENCY_COMPENSATION_MS = 55;
const BEATS_PER_SCENE = 32;
const BEAT_ACCENTS = [1, 0.72, 0.82, 0.7] as const;

type Rgb = readonly [number, number, number];

interface TempoLightingScene {
  readonly name: string;
  readonly primary: Rgb;
  readonly secondary: Rgb;
  readonly colorMix: readonly number[];
  readonly beatMasks: readonly (readonly number[])[];
}

const TEMPO_LIGHTING_SCENES: readonly TempoLightingScene[] = [
  {
    name: "Midnight Bloom",
    primary: [148, 48, 255],
    secondary: [0, 188, 255],
    colorMix: [1, 0.72, 0.34, 0, 0, 0.34, 0.72, 1],
    beatMasks: [
      [0.08, 0.16, 0.35, 1, 1, 0.35, 0.16, 0.08],
      [0.06, 0.12, 0.72, 0.88, 0.88, 0.72, 0.12, 0.06],
      [0.08, 0.62, 0.9, 0.25, 0.25, 0.9, 0.62, 0.08],
      [0.78, 0.95, 0.48, 0.16, 0.16, 0.48, 0.95, 0.78],
    ],
  },
  {
    name: "Ember Split",
    primary: [255, 148, 18],
    secondary: [224, 12, 122],
    colorMix: [0, 0, 0.16, 0.34, 0.66, 0.84, 1, 1],
    beatMasks: [
      [1, 0.88, 0.7, 0.54, 0.54, 0.7, 0.88, 1],
      [1, 0.9, 0.66, 0.38, 0.08, 0.05, 0.04, 0.03],
      [0.08, 0.22, 0.72, 1, 1, 0.72, 0.22, 0.08],
      [0.03, 0.04, 0.05, 0.08, 0.38, 0.66, 0.9, 1],
    ],
  },
  {
    name: "Deep Green Gates",
    primary: [0, 82, 38],
    secondary: [54, 230, 104],
    colorMix: [0, 0.12, 0.36, 0.72, 0.72, 0.36, 0.12, 0],
    beatMasks: [
      [0.82, 0.9, 1, 0.72, 0.72, 1, 0.9, 0.82],
      [1, 0.82, 0.18, 0.06, 0.06, 0.18, 0.82, 1],
      [0.08, 0.3, 0.92, 1, 1, 0.92, 0.3, 0.08],
      [0.72, 0.72, 0.72, 0.72, 0.72, 0.72, 0.72, 0.72],
    ],
  },
];

export const TEMPO_KALEIDOSCOPE_PRESET = {
  kind: "spectrum",
  id: "tempo-kaleidoscope",
  displayName: "Tempo Scenes",
  analyzer: {
    bandCenters: [40, 70, 110, 180, 350, 800, 1_800, 4_000],
    bandGains: [2.8, 2.35, 1.95, 1.6, 1.3, 1.1, 1.15, 1.3],
    filterQ: 0.9,
    fastDecay: 0.58,
    bodyDecay: 0.84,
    bodyAttack: 0.38,
    bodyMix: 0.38,
    transientFramesPerSecond: 100,
    normalization: {
      mode: "adaptive",
      dynamicRangeDb: 40,
      referenceDecayDbPerFrame: 0.2,
      silenceThresholdDb: -72,
      gamma: 1.18,
    },
  },
  animationFramesPerSecond: 60,
  createLighting: () => new TempoKaleidoscopeLighting(),
} as const satisfies SpectrumLightingPreset;

export class TempoKaleidoscopeLighting {
  #previousFrame = SILENCE;
  #fluxMean = 0.02;
  #fluxVariance = 0.0007;
  #lastOnsetAt: number | undefined;
  #usesDedicatedTransientFeed = false;
  #transientDetector = new AdaptiveTransientDetector();
  #tempoSync = new AdaptiveTempoSync();
  #reinforcementBeatIndex: number | undefined;
  #reinforcementStrength = 0;

  reset(): void {
    this.#previousFrame = SILENCE;
    this.#fluxMean = 0.02;
    this.#fluxVariance = 0.0007;
    this.#lastOnsetAt = undefined;
    this.#usesDedicatedTransientFeed = false;
    this.#transientDetector.reset();
    this.#tempoSync.reset();
    this.#reinforcementBeatIndex = undefined;
    this.#reinforcementStrength = 0;
  }

  handleTransient(frame: SpectrumTransientFrame, nowMs = Date.now()): void {
    this.#usesDedicatedTransientFeed = true;
    const detected = this.#transientDetector.observe(frame, nowMs);
    if (detected !== undefined) this.#registerOnset(detected.role, detected.strength, nowMs);
  }

  render(frame: SpectrumFrame, nowMs = Date.now()): number[] {
    const flux = spectralFlux(frame, this.#previousFrame);
    const deviation = Math.sqrt(this.#fluxVariance);
    const threshold = this.#fluxMean + Math.max(0.038, deviation * 1.8);
    const active = Math.max(...frame) >= 0.15;
    const previousOnset = this.#lastOnsetAt;

    if (
      !this.#usesDedicatedTransientFeed
      && active
      && flux >= threshold
      && (previousOnset === undefined || nowMs - previousOnset >= 140)
    ) {
      const role = onsetRole(frame);
      this.#registerOnset(role, flux / threshold, nowMs);
    }

    const limitedFlux = Math.min(flux, threshold * 1.25);
    const difference = limitedFlux - this.#fluxMean;
    this.#fluxMean += difference * 0.03;
    this.#fluxVariance = this.#fluxVariance * 0.97 + difference * difference * 0.03;
    this.#previousFrame = [...frame] as SpectrumFrame;

    return renderTempoKaleidoscope(frame, {
      periodMs: this.#tempoSync.periodMs,
      beatsElapsed: this.#tempoSync.beatsElapsed(nowMs + VISUAL_LATENCY_COMPENSATION_MS),
      syncConfidence: this.#tempoSync.confidence,
      reinforcementBeatIndex: this.#reinforcementBeatIndex,
      reinforcementStrength: this.#reinforcementStrength,
    });
  }

  #registerOnset(role: OnsetRole, strength: number, nowMs: number): void {
    if (this.#lastOnsetAt !== undefined && nowMs - this.#lastOnsetAt < 100) return;
    this.#tempoSync.observeOnset(nowMs, strength, role);
    this.#lastOnsetAt = nowMs;
    const beatsElapsed = this.#tempoSync.beatsElapsed(nowMs);
    const phaseDistance = beatsElapsed === undefined
      ? 0
      : Math.min(positiveModulo(beatsElapsed, 1), 1 - positiveModulo(beatsElapsed, 1));
    const aligned = role === "low"
      ? phaseDistance <= 0.2
      : role === "mid"
        ? phaseDistance <= 0.14
        : beatsElapsed !== undefined && phaseDistance <= 0.07;
    if (aligned) {
      this.#reinforcementBeatIndex = beatsElapsed === undefined
        ? undefined
        : Math.floor(beatsElapsed) + 1;
      this.#reinforcementStrength = role === "low" ? 0.58 : role === "mid" ? 0.3 : 0;
    }
  }
}

interface TempoKaleidoscopeRenderState {
  readonly periodMs: number | undefined;
  readonly beatsElapsed: number | undefined;
  readonly syncConfidence: number;
  readonly reinforcementBeatIndex: number | undefined;
  readonly reinforcementStrength: number;
}

export function renderTempoKaleidoscope(
  frame: SpectrumFrame,
  state: TempoKaleidoscopeRenderState,
): number[] {
  const beatIndex = state.beatsElapsed === undefined ? 0 : Math.floor(state.beatsElapsed);
  const beatPhase = state.beatsElapsed === undefined ? 1 : positiveModulo(state.beatsElapsed, 1);
  const beatAgeMs = state.periodMs === undefined ? Number.POSITIVE_INFINITY : beatPhase * state.periodMs;
  const reinforcement = beatIndex === state.reinforcementBeatIndex
    ? state.reinforcementStrength
    : 0;
  const predictedPulse = impactEnvelope(beatAgeMs, 82 + reinforcement * 48);
  const beatPulse = predictedPulse * (0.82 + state.syncConfidence * 0.18);
  const scene = TEMPO_LIGHTING_SCENES[
    positiveModulo(Math.floor(beatIndex / BEATS_PER_SCENE), TEMPO_LIGHTING_SCENES.length)
  ]!;
  const beatInBar = positiveModulo(beatIndex, 4);
  const beatMask = scene.beatMasks[beatInBar]!;
  const beatAccent = BEAT_ACCENTS[beatInBar]!;
  const lowEnergy = (frame[0] + frame[1] + frame[2]) / 3;
  const audioLift = lowEnergy * 0.025;
  const lockedAmbient = state.beatsElapsed === undefined ? 0 : 0.012;

  return Array.from({ length: 8 }, (_, padIndex) => {
    const strength = Math.min(
      1,
      0.008 + lockedAmbient + audioLift + beatMask[padIndex]! * beatPulse * beatAccent,
    );
    const paletteColor = mixRgb(scene.primary, scene.secondary, scene.colorMix[padIndex]!);
    const color: Rgb = [
      paletteColor[0] * strength,
      paletteColor[1] * strength,
      paletteColor[2] * strength,
    ];

    return color.map((component) => Math.round((Math.min(255, component) / 255) * 127));
  }).flat();
}

function mixRgb(first: Rgb, second: Rgb, amount: number): Rgb {
  return [
    first[0] + (second[0] - first[0]) * amount,
    first[1] + (second[1] - first[1]) * amount,
    first[2] + (second[2] - first[2]) * amount,
  ];
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

function onsetRole(frame: SpectrumFrame): OnsetRole {
  const low = frame[0] + frame[1] + frame[2];
  const middle = frame[3] + frame[4] + frame[5];
  const high = frame[6] + frame[7];
  if (low >= middle && low >= high) return "low";
  if (middle >= high) return "mid";
  return "high";
}

function impactEnvelope(ageMs: number, decayMs = 82): number {
  if (ageMs < 0 || ageMs > 240) return 0;
  if (ageMs <= 38) return 1;
  return Math.exp(-(ageMs - 38) / decayMs);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
