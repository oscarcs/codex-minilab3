import { expect, test } from "bun:test";
import type { SpectrumFrame } from "../src/audio/system-audio-spectrum.js";
import { createController } from "../src/controllers/index.js";
import {
  BassSpectrumLighting,
  renderChatGptPadColors,
  renderSpectrumColors,
} from "../src/controllers/minilab3/index.js";
import {
  AdaptiveCometLighting,
  renderAdaptiveComet,
} from "../src/controllers/minilab3/spectrum/adaptive-comet.js";
import {
  getLightingPreset,
  listLightingPresetIds,
} from "../src/controllers/minilab3/spectrum/index.js";
import {
  renderTempoKaleidoscope,
  TempoKaleidoscopeLighting,
} from "../src/controllers/minilab3/spectrum/tempo-kaleidoscope.js";
import {
  emptyLightingState,
  type CodexKeyEvent,
} from "../src/core/codex-micro.js";
import {
  createMidiTestBackend,
  flushPromises,
  quietLogger,
} from "./midi-test-backend.js";

test("MiniLab 3 maps live factory-pad reports and documented CC-pad reports", async () => {
  const midi = createMidiTestBackend({
    inputs: ["Minilab3 MIDI"],
    outputs: ["Minilab3 MIDI"],
  });
  const keys: CodexKeyEvent[] = [];
  const joystick: Array<{ angle: number; distance: number }> = [];
  const controller = createController(
    { type: "minilab3" },
    { midi: midi.backend, logger: quietLogger },
  );

  await controller.surface.start({
    async emitKey(event) {
      keys.push(event);
    },
    async emitJoystick(event) {
      joystick.push(event);
    },
  });

  expect(midi.state.sent).toEqual([[0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]]);
  midi.emit([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x00, 0x20, 0x6b, 0x02, 0x00, 0x04, 0x04, 0x45, 0x00, 0x02, 0x01, 0xf7]);
  midi.emit([0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x02, 0x00, 0x40, 0x01, 0x01, 0xf7]);

  // A keyboard key with the same note number is deliberately ignored.
  midi.emit([0x90, 36, 100]);
  midi.emit([0x80, 36, 0]);

  // Factory pads use note messages on MIDI channel 10.
  midi.emit([0x99, 36, 100]);
  midi.emit([0xa9, 36, 127]); // pressure aftertouch is ignored
  midi.emit([0x89, 36, 0]);

  // Bank B preserves the same physical mapping with notes 44-51.
  midi.emit([0x99, 51, 100]);
  midi.emit([0x89, 51, 0]);

  // Arturia/User programs expose the same physical pads as CC 102-109.
  midi.emit([0xb0, 108, 127]);
  midi.emit([0xb0, 108, 0]);

  // Shift is CC 9 (or CC 27 in DAW mode) and overrides usable pads 4-8.
  midi.emit([0xb0, 9, 127]);
  midi.emit([0xb0, 105, 127]);
  midi.emit([0xb0, 105, 0]);
  midi.emit([0xb0, 108, 127]);
  midi.emit([0xb0, 108, 0]);
  // A program change while Shift is down can move its release to CC 27.
  midi.emit([0xb0, 27, 0]);

  // The same pad falls through to its ordinary task when Shift is not held.
  midi.emit([0xb0, 105, 127]);
  midi.emit([0xb0, 105, 0]);

  // A physical clockwise turn sends the centre followed by a lower value.
  midi.emit([0xb0, 114, 64]);
  midi.emit([0xb0, 114, 62]);

  // Main encoder click opens/selects the focused control, including models.
  midi.emit([0xb0, 115, 127]);
  midi.emit([0xb0, 115, 0]);

  // Six units of travel in either direction becomes one joystick flick.
  midi.emit([0xb0, 74, 10]);
  midi.emit([0xb0, 74, 14]);
  midi.emit([0xb0, 74, 16]);
  midi.emit([0xb0, 71, 60]);
  midi.emit([0xb0, 71, 56]);
  midi.emit([0xb0, 71, 54]);
  midi.emit([0xb0, 93, 0]);
  midi.emit([0xb0, 93, 2]);
  midi.emit([0xb0, 93, 6]);
  midi.emit([0xb0, 18, 127]);
  midi.emit([0xb0, 18, 124]);
  midi.emit([0xb0, 18, 121]);

  // The right-hand 2x2 knob block mirrors the first stick set.
  midi.emit([0xb0, 76, 10]);
  midi.emit([0xb0, 76, 16]);
  midi.emit([0xb0, 77, 60]);
  midi.emit([0xb0, 77, 54]);
  midi.emit([0xb0, 19, 0]);
  midi.emit([0xb0, 19, 6]);
  midi.emit([0xb0, 16, 127]);
  midi.emit([0xb0, 16, 121]);
  await flushPromises();

  expect(keys).toEqual([
    { key: "ACT10", act: 1 },
    { key: "ACT10", act: 0 },
    { key: "AG05", act: 1 },
    { key: "AG05", act: 0 },
    { key: "AG04", act: 1 },
    { key: "AG04", act: 0 },
    { key: "ACT06", act: 1 },
    { key: "ACT06", act: 0 },
    { key: "ACT07", act: 1 },
    { key: "ACT07", act: 0 },
    { key: "AG01", act: 1 },
    { key: "AG01", act: 0 },
    { key: "ENC_CW", act: 2 },
    { key: "ENC", act: 1 },
    { key: "ENC", act: 0 },
  ]);
  expect(joystick).toEqual([
    { angle: 0.75, distance: 1 },
    { angle: 0.75, distance: 0 },
    { angle: 0.25, distance: 1 },
    { angle: 0.25, distance: 0 },
    { angle: 0.5, distance: 1 },
    { angle: 0.5, distance: 0 },
    { angle: 0, distance: 1 },
    { angle: 0, distance: 0 },
    { angle: 0.75, distance: 1 },
    { angle: 0.75, distance: 0 },
    { angle: 0.25, distance: 1 },
    { angle: 0.25, distance: 0 },
    { angle: 0.5, distance: 1 },
    { angle: 0.5, distance: 0 },
    { angle: 0, distance: 1 },
    { angle: 0, distance: 0 },
  ]);
  expect(midi.state.openedNames).toEqual(["Minilab3 MIDI", "Minilab3 MIDI"]);
  expect(midi.state.outputOpens).toBe(1);

  await controller.surface.stop();
});

test("MiniLab 3 defaults to ChatGPT OLED and pad lighting on both banks", async () => {
  const midi = createMidiTestBackend({
    inputs: ["Minilab3 MIDI"],
    outputs: ["Minilab3 MIDI"],
  });
  const controller = createController(
    { type: "minilab3" },
    { midi: midi.backend, logger: quietLogger },
  );
  await controller.surface.start({
    async emitKey() {},
    async emitJoystick() {},
  });

  midi.emit([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x00, 0x20, 0x6b, 0x02, 0x00, 0x04, 0x04, 0x45, 0x00, 0x02, 0x01, 0xf7]);
  expect(midi.state.sent.slice(1)).toEqual([
    [0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x02, 0x02, 0x40, 0x6a, 0x21, 0xf7],
    [0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x01, 0x00, 0x40, 0x03, 0xf7],
    [0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x01, 0x00, 0x40, 0x01, 0xf7],
  ]);
  midi.emit([0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x02, 0x00, 0x40, 0x01, 0x01, 0xf7]);
  midi.state.sent.length = 0;

  const lighting = emptyLightingState();
  Object.assign(lighting.threads[0]!, {
    color: 0xff0000,
    brightness: 1,
    effect: 4,
  });
  Object.assign(lighting.threads[1]!, {
    color: 0x00ff00,
    brightness: 1,
    effect: 1,
  });
  Object.assign(lighting.keys, {
    color: 0x204080,
    brightness: 0.5,
    effect: 1,
  });
  await controller.surface.applyLighting(lighting);

  const padColors = [
    7, 4, 11,
    7, 4, 11,
    127, 0, 0,
    0, 127, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ];
  expect(midi.state.sent).toEqual([
    [
      0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x04, 0x02, 0x60,
      0x1f, 0x07, 0x01, 0x00, 0x00, 0x01, 0x00,
      0x01, 67, 79, 68, 69, 88, 0x00,
      0x02, 84, 97, 115, 107, 32, 49, 32, 115, 101, 108, 101, 99, 116, 101, 100, 0x00,
      0xf7,
    ],
    [
      0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x04, 0x02, 0x16, 0x30,
      ...padColors,
      0xf7,
    ],
    [
      0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x04, 0x02, 0x16, 0x40,
      ...padColors,
      0xf7,
    ],
  ]);

  await controller.surface.stop();
  expect(midi.state.sent.at(-1)).toEqual([
    0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42, 0x02, 0x02, 0x40, 0x6a, 0x20, 0xf7,
  ]);
});

test("MiniLab 3 maps bass energy through the purple-to-white heat palette", () => {
  expect(renderSpectrumColors([0, 0.25, 0.5, 0.75, 1, 0.5, 0.25, 0])).toEqual([
    2, 0, 5,
    29, 0, 40,
    86, 3, 51,
    127, 32, 13,
    127, 122, 107,
    86, 3, 51,
    29, 0, 40,
    2, 0, 5,
  ]);
});

test("MiniLab 3 function pads ignore white key and ambient overrides", () => {
  const lighting = emptyLightingState();
  Object.assign(lighting.keys, {
    color: 0xffffff,
    brightness: 1,
    effect: 1,
  });
  const colors = renderChatGptPadColors(lighting);

  expect(colors.slice(0, 3)).toEqual([7, 4, 11]);
  expect(colors.slice(3, 6)).toEqual([7, 4, 11]);
  expect(colors.slice(6)).toEqual(Array.from({ length: 18 }, () => 0));

  Object.assign(lighting.ambient, {
    color: 0xffffff,
    brightness: 1,
    effect: 1,
  });
  expect(renderChatGptPadColors(lighting).slice(0, 6)).toEqual([
    7, 4, 11,
    7, 4, 11,
  ]);
});

test("MiniLab 3 kick lighting travels from Pads 4 and 5 to the ends of the row", () => {
  const lighting = new BassSpectrumLighting();
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const kick: SpectrumFrame = [1, 0, 0, 0, 0, 0, 0, 0];
  lighting.render(silence, 0);

  const centerPulse = lighting.render(kick, 250);
  const unpulsed = renderSpectrumColors(kick);
  expect(padBrightness(centerPulse, 3)).toBeGreaterThan(padBrightness(unpulsed, 3));
  expect(padBrightness(centerPulse, 3)).toBe(padBrightness(centerPulse, 4));

  const edgePulse = renderSpectrumColors(silence, 1);
  expect(padBrightness(edgePulse, 0)).toBe(padBrightness(edgePulse, 7));
  expect(padBrightness(edgePulse, 0)).toBeGreaterThan(padBrightness(edgePulse, 1));
});

test("MiniLab 3 lighting presets are named, selectable, and validated", () => {
  expect(listLightingPresetIds()).toEqual([
    "adaptive-comet",
    "bass-lava",
    "chatgpt",
    "tempo-kaleidoscope",
  ]);
  expect(getLightingPreset().id).toBe("chatgpt");
  expect(() => createController(
    { type: "minilab3", lightingPreset: "missing" },
    { logger: quietLogger },
  )).toThrow(
    'Unknown MiniLab lighting preset "missing". Available presets: adaptive-comet, bass-lava, chatgpt, tempo-kaleidoscope',
  );
});

test("MiniLab 3 adaptive comet sweeps linearly from Pad 1 through Pad 8", () => {
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const atStart = renderAdaptiveComet(silence, 0);
  expect(padBrightness(atStart, 0)).toBeGreaterThan(padBrightness(atStart, 1));

  const atMiddle = renderAdaptiveComet(silence, 0.76 * 4 / 7);
  expect(padBrightness(atMiddle, 4)).toBeGreaterThan(padBrightness(atMiddle, 3));

  const atEnd = renderAdaptiveComet(silence, 0.76);
  expect(padBrightness(atEnd, 7)).toBeGreaterThan(padBrightness(atEnd, 6));
});

test("MiniLab 3 adaptive comet detects an onset in the upper kick bands", () => {
  const lighting = new AdaptiveCometLighting();
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const upperAttack: SpectrumFrame = [0, 0, 0, 0, 0, 0, 1, 0];
  lighting.render(silence, 0);
  const detected = lighting.render(upperAttack, 250);
  const backgroundOnly = renderAdaptiveComet(upperAttack);
  expect(padBrightness(detected, 0)).toBeGreaterThan(padBrightness(backgroundOnly, 0));
});

test("MiniLab 3 tempo scenes follow deliberate linear-row patterns", () => {
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const renderAt = (beatsElapsed: number) => renderTempoKaleidoscope(silence, {
    periodMs: 500,
    beatsElapsed,
    syncConfidence: 0.8,
    reinforcementBeatIndex: undefined,
    reinforcementStrength: 0,
  });

  const onBeat = renderAt(0);
  for (let padIndex = 0; padIndex < 4; padIndex += 1) {
    expect(onBeat.slice(padIndex * 3, padIndex * 3 + 3)).toEqual(
      onBeat.slice((7 - padIndex) * 3, (7 - padIndex) * 3 + 3),
    );
  }
  expect(padBrightness(onBeat, 3)).toBeGreaterThan(padBrightness(onBeat, 0) * 4);
  expect(totalBrightness(onBeat)).toBeGreaterThan(totalBrightness(renderAt(0.49)) * 3);

  const secondBeat = renderAt(1);
  expect(padBrightness(secondBeat, 3)).toBeGreaterThan(padBrightness(secondBeat, 0));
  expect(secondBeat).not.toEqual(onBeat);

  const fourthBeat = renderAt(3);
  expect(padBrightness(fourthBeat, 1)).toBeGreaterThan(padBrightness(fourthBeat, 3) * 3);

  const nextScene = renderAt(32);
  expect(nextScene).not.toEqual(onBeat);
  expect(nextScene.slice(0, 3)).not.toEqual(nextScene.slice(21, 24));
});

test("MiniLab 3 tempo reinforcement extends one scheduled pulse without retriggering", () => {
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const renderAt = (beatsElapsed: number, reinforcementBeatIndex?: number) =>
    renderTempoKaleidoscope(silence, {
      periodMs: 500,
      beatsElapsed,
      syncConfidence: 0.8,
      reinforcementBeatIndex,
      reinforcementStrength: 0.58,
    });

  expect(renderAt(0, 1)).toEqual(renderAt(0));
  expect(renderAt(1, 1)).toEqual(renderAt(1));
  expect(totalBrightness(renderAt(1.2, 1))).toBeGreaterThan(totalBrightness(renderAt(1.2)));
  expect(renderAt(1.49, 1)).toEqual(renderAt(1.49));
});

test("MiniLab 3 tempo kaleidoscope learns repeated onset intervals", () => {
  const lighting = new TempoKaleidoscopeLighting();
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  const kick: SpectrumFrame = [1, 0, 0, 0, 0, 0, 0, 0];
  lighting.render(silence, 0);
  lighting.render(kick, 100);
  lighting.render(silence, 250);
  lighting.render(kick, 600);
  lighting.render(silence, 750);
  lighting.render(kick, 1_100);

  const learnedChoreography = lighting.render(silence, 1_350);
  const unlockedAmbient = renderTempoKaleidoscope(silence, {
    periodMs: undefined,
    beatsElapsed: undefined,
    syncConfidence: 0,
    reinforcementBeatIndex: undefined,
    reinforcementStrength: 0,
  });
  expect(totalBrightness(learnedChoreography)).toBeGreaterThan(totalBrightness(unlockedAmbient));
});

test("MiniLab 3 tempo kaleidoscope learns from the dedicated transient feed", () => {
  const lighting = new TempoKaleidoscopeLighting();
  const silence: SpectrumFrame = [0, 0, 0, 0, 0, 0, 0, 0];
  lighting.handleTransient([-90, -90, -90], 0);
  for (const onsetAt of [100, 600, 1_100]) {
    lighting.handleTransient([-42, -72, -80], onsetAt);
    lighting.handleTransient([-86, -86, -86], onsetAt + 20);
  }

  const learnedChoreography = lighting.render(silence, 1_350);
  const unlockedAmbient = renderTempoKaleidoscope(silence, {
    periodMs: undefined,
    beatsElapsed: undefined,
    syncConfidence: 0,
    reinforcementBeatIndex: undefined,
    reinforcementStrength: 0,
  });
  expect(totalBrightness(learnedChoreography)).toBeGreaterThan(totalBrightness(unlockedAmbient));
});

function padBrightness(colors: readonly number[], padIndex: number): number {
  return colors
    .slice(padIndex * 3, padIndex * 3 + 3)
    .reduce((sum, component) => sum + component, 0);
}

function totalBrightness(colors: readonly number[]): number {
  return colors.reduce((sum, component) => sum + component, 0);
}
