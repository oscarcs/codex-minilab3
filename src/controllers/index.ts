import type { ControllerConfig } from "../config.js";
import minilab3 from "./minilab3/index.js";
import type { ControllerContext, MidiControllerProfile } from "./controller-profile.js";
import { createMidiSurface } from "./midi-surface.js";

const profiles = { minilab3 } satisfies Record<string, MidiControllerProfile>;

export function listControllerIds(): string[] {
  return Object.keys(profiles).sort();
}

export function createController(config: ControllerConfig, context: ControllerContext) {
  const profile = profiles[config.type as keyof typeof profiles];
  if (profile === undefined) {
    throw new Error(
      `Unknown controller type "${config.type}". Available types: ${listControllerIds().join(", ")}`,
    );
  }
  return {
    displayName: profile.displayName,
    surface: createMidiSurface(profile, config, context),
  };
}
