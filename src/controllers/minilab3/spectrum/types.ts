import type {
  SpectrumAnalyzerConfiguration,
  SpectrumFrame,
  SpectrumTransientFrame,
} from "../../../audio/system-audio-spectrum.js";

export interface SpectrumLighting {
  reset(): void;
  handleTransient?(frame: SpectrumTransientFrame, nowMs?: number): void;
  render(frame: SpectrumFrame, nowMs?: number): number[];
}

export interface ChatGptLightingPreset {
  readonly kind: "chatgpt";
  readonly id: string;
  readonly displayName: string;
}

export interface SpectrumLightingPreset {
  readonly kind: "spectrum";
  readonly id: string;
  readonly displayName: string;
  readonly analyzer: SpectrumAnalyzerConfiguration;
  readonly animationFramesPerSecond?: number;
  createLighting(): SpectrumLighting;
}

export type LightingPreset = ChatGptLightingPreset | SpectrumLightingPreset;
