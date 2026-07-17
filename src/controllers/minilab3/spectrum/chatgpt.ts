import type { ChatGptLightingPreset } from "./types.js";

export const CHATGPT_LIGHTING_PRESET = {
  kind: "chatgpt",
  id: "chatgpt",
  displayName: "ChatGPT Lighting (Default)",
} as const satisfies ChatGptLightingPreset;
