import { ADAPTIVE_COMET_PRESET } from "./adaptive-comet.js";
import { BASS_LAVA_PRESET } from "./bass-lava.js";
import { CHATGPT_LIGHTING_PRESET } from "./chatgpt.js";
import { TEMPO_KALEIDOSCOPE_PRESET } from "./tempo-kaleidoscope.js";
import type { LightingPreset } from "./types.js";

const PRESETS = {
  [CHATGPT_LIGHTING_PRESET.id]: CHATGPT_LIGHTING_PRESET,
  [ADAPTIVE_COMET_PRESET.id]: ADAPTIVE_COMET_PRESET,
  [BASS_LAVA_PRESET.id]: BASS_LAVA_PRESET,
  [TEMPO_KALEIDOSCOPE_PRESET.id]: TEMPO_KALEIDOSCOPE_PRESET,
} satisfies Record<string, LightingPreset>;

export const DEFAULT_LIGHTING_PRESET = CHATGPT_LIGHTING_PRESET.id;

export function listLightingPresetIds(): string[] {
  return Object.keys(PRESETS).sort();
}

export function listLightingPresets(): Array<{ id: string; displayName: string }> {
  const ids = [
    DEFAULT_LIGHTING_PRESET,
    ...listLightingPresetIds().filter((id) => id !== DEFAULT_LIGHTING_PRESET),
  ];
  return ids.map((id) => {
    const preset = PRESETS[id as keyof typeof PRESETS];
    return { id: preset.id, displayName: preset.displayName };
  });
}

export function getLightingPreset(id: string = DEFAULT_LIGHTING_PRESET): LightingPreset {
  const preset = PRESETS[id as keyof typeof PRESETS];
  if (preset === undefined) {
    throw new Error(
      `Unknown MiniLab lighting preset "${id}". Available presets: ${listLightingPresetIds().join(", ")}`,
    );
  }
  return preset;
}

export type { LightingPreset, SpectrumLighting, SpectrumLightingPreset } from "./types.js";
