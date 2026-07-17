import type { SpectrumTransientFrame } from "../../../audio/system-audio-spectrum.js";
import type { OnsetRole } from "./tempo-sync.js";

export interface DetectedTransient {
  readonly role: OnsetRole;
  readonly strength: number;
}

interface BandState {
  previousDb: number;
  meanRise: number;
  riseVariance: number;
  initialized: boolean;
}

const ROLES: readonly OnsetRole[] = ["low", "mid", "high"];
const MINIMUM_RISE_DB = [1.25, 1.6, 2] as const;
const MINIMUM_LEVEL_DB = [-78, -75, -72] as const;
const ROLE_PRIORITY = [1.15, 1, 0.72] as const;

export class AdaptiveTransientDetector {
  #bands: BandState[] = Array.from({ length: 3 }, createBandState);
  #lastOnsetAt = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.#bands = Array.from({ length: 3 }, createBandState);
    this.#lastOnsetAt = Number.NEGATIVE_INFINITY;
  }

  observe(frame: SpectrumTransientFrame, nowMs: number): DetectedTransient | undefined {
    let strongestIndex: number | undefined;
    let strongestScore = 0;
    let strongestExcess = 0;

    for (let index = 0; index < this.#bands.length; index += 1) {
      const state = this.#bands[index]!;
      const levelDb = frame[index]!;
      if (!state.initialized) {
        state.previousDb = levelDb;
        state.initialized = true;
        continue;
      }

      const rise = Math.max(0, levelDb - state.previousDb);
      const deviation = Math.sqrt(state.riseVariance);
      const threshold = state.meanRise + Math.max(MINIMUM_RISE_DB[index]!, deviation * 2.35);
      const excess = rise - threshold;
      if (levelDb >= MINIMUM_LEVEL_DB[index]! && excess > 0) {
        const score = excess * ROLE_PRIORITY[index]!;
        if (score > strongestScore) {
          strongestIndex = index;
          strongestScore = score;
          strongestExcess = excess;
        }
      }

      const limitedRise = Math.min(rise, threshold + MINIMUM_RISE_DB[index]!);
      const difference = limitedRise - state.meanRise;
      state.meanRise += difference * 0.035;
      state.riseVariance = state.riseVariance * 0.965 + difference * difference * 0.035;
      state.previousDb = levelDb;
    }

    if (strongestIndex === undefined || nowMs - this.#lastOnsetAt < 75) return undefined;
    this.#lastOnsetAt = nowMs;
    return {
      role: ROLES[strongestIndex]!,
      strength: Math.max(0.35, Math.min(2, 0.55 + strongestExcess / 7)),
    };
  }
}

function createBandState(): BandState {
  return {
    previousDb: -120,
    meanRise: 0.15,
    riseVariance: 0.25,
    initialized: false,
  };
}
