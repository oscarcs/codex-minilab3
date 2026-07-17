/**
 * Arturia MiniLab 3 profile for its ordinary MIDI endpoint.
 *
 * Arturia documents the controls below as CC messages in the Arturia/User and
 * DAW programs. The factory pads emit channel-10 notes. The main encoder emits
 * a centered relative value: 64 followed by a delta above or below 64.
 * The profile intentionally ignores keys and faders so playing the keyboard
 * cannot trigger a Codex action.
 */

import {
  type CodexLightingState,
  type ThreadLighting,
  type ZoneLighting,
} from "../../core/codex-micro.js";
import type { ControllerConfig } from "../../config.js";
import {
  SystemAudioSpectrum,
  type SpectrumFrame,
} from "../../audio/system-audio-spectrum.js";
import type { MidiMessage } from "../../midi/index.js";
import type {
  ControllerConnection,
  ControllerContext,
  ControllerSession,
  LightingFrame,
  MidiControllerProfile,
  MidiMapping,
} from "../controller-profile.js";
import {
  DEFAULT_LIGHTING_PRESET,
  getLightingPreset,
} from "./spectrum/index.js";

export {
  BassSpectrumLighting,
  renderSpectrumColors,
} from "./spectrum/bass-lava.js";

const MINILAB3_MAPPING = {
  notes: {
    36: "ACT10", // Pad 1: microphone
    37: "ACT12", // Pad 2: submit
    38: "AG00", // Pad 3: task 1
    39: "AG01", // Pad 4: task 2
    40: "AG02", // Pad 5: task 3
    41: "AG03", // Pad 6: task 4
    42: "AG04", // Pad 7: task 5
    43: "AG05", // Pad 8: task 6
    44: "ACT10", // Bank B pad 1
    45: "ACT12", // Bank B pad 2
    46: "AG00", // Bank B pad 3
    47: "AG01", // Bank B pad 4
    48: "AG02", // Bank B pad 5
    49: "AG03", // Bank B pad 6
    50: "AG04", // Bank B pad 7
    51: "AG05", // Bank B pad 8
  },
  buttons: {
    102: "ACT10", // Pad 1: microphone
    103: "ACT12", // Pad 2: submit
    104: "AG00", // Pad 3: task 1
    105: "AG01", // Pad 4: task 2
    106: "AG02", // Pad 5: task 3
    107: "AG03", // Pad 6: task 4
    108: "AG04", // Pad 7: task 5
    109: "AG05", // Pad 8: task 6
    113: "ENC", // Shift + main encoder click
    115: "ENC", // Main encoder click
    118: "ENC", // Main encoder click in DAW mode
    119: "ENC", // Shift + main encoder click in DAW mode
  },
  joystick: {
    74: "up", // Knob 1
    71: "down", // Knob 2
    76: "up", // Knob 3
    77: "down", // Knob 4
    93: "left", // Knob 5
    18: "right", // Knob 6
    19: "left", // Knob 7
    16: "right", // Knob 8
    86: "up", // DAW mode knob 1
    87: "down", // DAW mode knob 2
    89: "up", // DAW mode knob 3
    90: "down", // DAW mode knob 4
    110: "left", // DAW mode knob 5
    111: "right", // DAW mode knob 6
    116: "left", // DAW mode knob 7
    117: "right", // DAW mode knob 8
  },
} satisfies MidiMapping;

const ARTURIA_HEADER = [0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42] as const;
const DEVICE_INQUIRY: MidiMessage = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const CONNECT_DAW = arturiaMessage([0x02, 0x02, 0x40, 0x6a, 0x21]);
const DISCONNECT_DAW = arturiaMessage([0x02, 0x02, 0x40, 0x6a, 0x20]);
const REQUEST_PAD_BANK = arturiaMessage([0x01, 0x00, 0x40, 0x03]);
const REQUEST_MODE = arturiaMessage([0x01, 0x00, 0x40, 0x01]);
const ARTURIA_MODE_REPLY = arturiaMessage([0x02, 0x00, 0x40, 0x01, 0x00]);
const DAW_MODE_REPLY = arturiaMessage([0x02, 0x00, 0x40, 0x01, 0x01]);
const ARTURIA_MODE_CHANGED = arturiaMessage([0x02, 0x00, 0x40, 0x62, 0x01]);
const DAW_MODE_CHANGED = arturiaMessage([0x02, 0x00, 0x40, 0x62, 0x02]);
const PAD_BANK_A_REPLY = arturiaMessage([0x02, 0x00, 0x40, 0x63, 0x00]);
const PAD_BANK_B_REPLY = arturiaMessage([0x02, 0x00, 0x40, 0x63, 0x01]);
const DEVICE_REPLY_PREFIX = [0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x00, 0x20, 0x6b, 0x02, 0x00, 0x04] as const;
const SILENT_SPECTRUM: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
const PASSIVE_FUNCTION_COLOR = 0x34204f;
const PASSIVE_FUNCTION_BRIGHTNESS = 0.28;

const MINILAB3_PROFILE = {
  displayName: "Arturia MiniLab 3",
  ports: { input: "Minilab3 MIDI", output: "Minilab3 MIDI" },
  noteChannel: 9,
  controlChannel: "any",
  mapping: MINILAB3_MAPPING,
  joystickGesture: {
    movementThreshold: 6,
    sequenceTimeoutMs: 250,
  },
  modifier: {
    // Arturia/User programs use CC 9; DAW mode uses CC 27.
    buttons: [9, 27],
    mapping: {
      buttons: {
        105: "ACT06", // Shift + Pad 4: Fast
        106: "ACT07", // Shift + Pad 5: Approve
        107: "ACT08", // Shift + Pad 6: Reject
        108: "ACT09", // Shift + Pad 7: Fork
      },
    },
  },
  encoder: {
    cc: [114, 28, 29],
    // MiniLab relative deltas run opposite to the Codex encoder event names.
    clockwise: Array.from({ length: 64 }, (_, index) => index),
    counterClockwise: Array.from({ length: 63 }, (_, index) => 65 + index),
    pulsesPerStep: 1,
    minStepIntervalMs: 40,
    pulseSequenceTimeoutMs: 250,
  },
  createSession: createMiniLab3Session,
  renderLighting: renderMiniLab3Lighting,
} satisfies MidiControllerProfile;

export default MINILAB3_PROFILE;

function createMiniLab3Session(
  context: ControllerContext,
  config: Readonly<ControllerConfig>,
): ControllerSession {
  const lightingPreset = getLightingPreset(
    config.lightingPreset ?? config.spectrumPreset ?? DEFAULT_LIGHTING_PRESET,
  );
  const spectrumPreset = lightingPreset.kind === "spectrum" ? lightingPreset : undefined;
  const spectrumLighting = spectrumPreset?.createLighting();
  let connection: ControllerConnection | undefined;
  let warnedAboutProgram = false;
  let activePadBank = 0x30;
  let latestSpectrumColors = spectrumLighting?.render(SILENT_SPECTRUM) ?? [];
  let lastSpectrumSignature = "";
  let spectrum: SystemAudioSpectrum | undefined;
  let spectrumAnimationTimer: ReturnType<typeof setInterval> | undefined;
  let latestSpectrumFrame = SILENT_SPECTRUM;

  return {
    connect(nextConnection) {
      connection = nextConnection;
      warnedAboutProgram = false;
      nextConnection.send(DEVICE_INQUIRY);
    },

    handleMessage(message) {
      if (startsWith(message, DEVICE_REPLY_PREFIX)) {
        requestInitialState();
        return true;
      }
      if (matches(message, DAW_MODE_CHANGED)) {
        connection?.logger.info("MiniLab 3 DAW program selected; enabling OLED and pad feedback");
        requestInitialState();
        return true;
      }
      if (matches(message, ARTURIA_MODE_CHANGED)) {
        stopLighting();
        connection?.logger.warn(
          "MiniLab 3 is in Arturia mode; press Shift + Pad 3 for OLED and RGB feedback",
        );
        return true;
      }
      if (matches(message, PAD_BANK_A_REPLY) || matches(message, PAD_BANK_B_REPLY)) {
        activePadBank = matches(message, PAD_BANK_B_REPLY) ? 0x40 : 0x30;
        lastSpectrumSignature = "";
        if (spectrumLighting !== undefined) sendSpectrumColors(latestSpectrumColors);
        return true;
      }
      if (matches(message, DAW_MODE_REPLY)) {
        connection?.logger.info("MiniLab 3 DAW feedback is ready");
        connection?.ready();
        startLighting();
        return true;
      }
      if (matches(message, ARTURIA_MODE_REPLY)) {
        if (!warnedAboutProgram) {
          connection?.logger.warn(
            "MiniLab 3 controls are ready; press Shift + Pad 3 to enable OLED and RGB feedback",
          );
          warnedAboutProgram = true;
        }
        connection?.ready();
        return true;
      }
      return isArturiaStateMessage(message);
    },

    disconnect(reason, activeConnection) {
      stopLighting();
      lastSpectrumSignature = "";
      if (reason === "stopped") activeConnection.send(DISCONNECT_DAW);
      connection = undefined;
    },
  };

  function requestInitialState(): void {
    const active = connection;
    if (active === undefined) return;
    active.send(CONNECT_DAW);
    active.send(REQUEST_PAD_BANK);
    active.send(REQUEST_MODE);
  }

  function startLighting(): void {
    const active = connection;
    if (active === undefined) return;
    active.logger.info(
      `MiniLab lighting preset: ${lightingPreset.displayName} (${lightingPreset.id})`,
    );
    if (spectrumPreset === undefined || spectrumLighting === undefined || spectrum !== undefined) return;
    spectrumLighting.reset();
    latestSpectrumFrame = SILENT_SPECTRUM;
    latestSpectrumColors = spectrumLighting.render(SILENT_SPECTRUM);
    sendSpectrumColors(latestSpectrumColors);
    if (context.midi !== undefined) return;
    spectrum = new SystemAudioSpectrum(spectrumPreset.analyzer, active.logger, (analysis) => {
      if (analysis.transient !== undefined) {
        spectrumLighting.handleTransient?.(analysis.transient);
      }
      if (analysis.levels !== undefined) {
        latestSpectrumFrame = analysis.levels;
        if (spectrumAnimationTimer === undefined) renderSpectrumFrame();
      }
    });
    if (spectrumPreset.animationFramesPerSecond !== undefined) {
      spectrumAnimationTimer = setInterval(
        renderSpectrumFrame,
        1_000 / spectrumPreset.animationFramesPerSecond,
      );
    }
    spectrum.start();
  }

  function renderSpectrumFrame(): void {
    if (spectrumLighting === undefined) return;
    latestSpectrumColors = spectrumLighting.render(latestSpectrumFrame);
    sendSpectrumColors(latestSpectrumColors);
  }

  function stopLighting(): void {
    spectrum?.stop();
    spectrum = undefined;
    if (spectrumAnimationTimer !== undefined) clearInterval(spectrumAnimationTimer);
    spectrumAnimationTimer = undefined;
  }

  function sendSpectrumColors(colors: readonly number[]): void {
    const active = connection;
    if (active === undefined) return;
    const signature = `${activePadBank}:${colors.join(",")}`;
    if (signature === lastSpectrumSignature) return;
    lastSpectrumSignature = signature;
    active.send(padBankMessage(activePadBank, colors));
  }
}

function renderMiniLab3Lighting(
  state: Readonly<CodexLightingState>,
  config: Readonly<ControllerConfig>,
): LightingFrame[] {
  const selected = state.threads.findIndex(
    (thread) => thread.effect === 4 && isLitThread(thread),
  );
  const active = selected >= 0 ? selected : state.threads.findIndex(isLitThread);

  const line2 = selected >= 0
    ? `Task ${selected + 1} selected`
    : active >= 0
      ? `Task ${active + 1} active`
      : "Connected";

  const frames: LightingFrame[] = [
    { id: "screen", messages: [screenMessage("CODEX", line2)] },
  ];
  const preset = getLightingPreset(
    config.lightingPreset ?? config.spectrumPreset ?? DEFAULT_LIGHTING_PRESET,
  );
  if (preset.kind === "chatgpt") {
    const colors = renderChatGptPadColors(state);
    frames.push(
      { id: "chatgpt-pads-a", messages: [padBankMessage(0x30, colors)] },
      { id: "chatgpt-pads-b", messages: [padBankMessage(0x40, colors)] },
    );
  }
  return frames;
}

export function renderChatGptPadColors(state: Readonly<CodexLightingState>): number[] {
  const keyColor = renderFunctionPadColor();
  const colors: number[] = [...keyColor, ...keyColor];
  for (let threadId = 0; threadId < 6; threadId += 1) {
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    colors.push(...(thread === undefined ? [0, 0, 0] : renderCodexColor(thread)));
  }
  return colors;
}

function renderFunctionPadColor(): number[] {
  return renderRgb(PASSIVE_FUNCTION_COLOR, PASSIVE_FUNCTION_BRIGHTNESS);
}

function renderCodexColor(lighting: Readonly<ThreadLighting | ZoneLighting>): number[] {
  if (lighting.effect === 0 || lighting.brightness <= 0 || lighting.color === 0) return [0, 0, 0];
  return renderRgb(lighting.color, lighting.brightness);
}

function renderRgb(color: number, brightness: number): number[] {
  const normalizedBrightness = Math.max(0, Math.min(1, brightness));
  return [16, 8, 0].map((shift) => (
    Math.round((((color >> shift) & 0xff) / 255) * normalizedBrightness * 127)
  ));
}

function isLitThread(thread: Readonly<ThreadLighting>): boolean {
  return thread.effect !== 0 && thread.color !== 0 && thread.brightness > 0;
}

function screenMessage(line1: string, line2: string): MidiMessage {
  return arturiaMessage([
    0x04, 0x02, 0x60,
    0x1f, 0x07, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, ...ascii(line1, 10), 0x00,
    0x02, ...ascii(line2, 18), 0x00,
  ]);
}

function padBankMessage(bank: number, colors: readonly number[]): MidiMessage {
  return arturiaMessage([0x04, 0x02, 0x16, bank, ...colors]);
}

function arturiaMessage(body: readonly number[]): MidiMessage {
  return [...ARTURIA_HEADER, ...body, 0xf7];
}

function ascii(value: string, maxLength: number): number[] {
  return [...value.slice(0, maxLength)].map((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code < 127 ? code : 0x3f;
  });
}

function startsWith(message: readonly number[], prefix: readonly number[]): boolean {
  return message.length >= prefix.length && prefix.every((value, index) => message[index] === value);
}

function matches(message: readonly number[], expected: readonly number[]): boolean {
  return message.length === expected.length && expected.every((value, index) => message[index] === value);
}

function isArturiaStateMessage(message: readonly number[]): boolean {
  return startsWith(message, [...ARTURIA_HEADER, 0x02, 0x00, 0x40]);
}
