import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import {
  emptyLightingState,
  type CodexJoystickEvent,
  type CodexKeyEvent,
} from "../src/core/codex-micro.js";
import { createController, listControllerIds } from "../src/controllers/index.js";
import { createMidiSurface } from "../src/controllers/midi-surface.js";
import type { MidiControllerProfile } from "../src/controllers/controller-profile.js";
import {
  createMidiTestBackend,
  flushPromises,
  quietLogger,
} from "./midi-test-backend.js";

const profile = {
  displayName: "Test controller",
  ports: { input: "Test In", output: "Test Out" },
  inputChannel: 0,
  mapping: {
    notes: { 36: "ACT06", 37: "ACT06" },
    buttons: { 10: "ENC" },
    joystick: { 20: "up", 21: "up" },
  },
  modifier: {
    buttons: [9],
    mapping: {
      notes: { 36: "ACT09" },
      buttons: { 10: "ACT08" },
      joystick: { 20: "right" },
    },
  },
  encoder: {
    cc: 14,
    clockwise: [1],
    counterClockwise: [65],
    pulsesPerStep: 2,
    minStepIntervalMs: 100,
    pulseSequenceTimeoutMs: 50,
  },
  renderLighting(state) {
    return [{ id: "status", messages: [[0x90, 1, Math.round(state.keys.brightness * 127)]] }];
  },
} satisfies MidiControllerProfile;

afterEach(() => {
  setSystemTime();
  if (jest.isFakeTimers()) jest.useRealTimers();
});

describe("MIDI controller", () => {
  test("treats zero-velocity Note-On as a release", async () => {
    const fixture = await startFixture();
    fixture.midi.emit([0x90, 36, 127]);
    fixture.midi.emit([0x90, 36, 0]);
    await flushPromises();
    expect(fixture.keys).toEqual([
      { key: "ACT06", act: 1 },
      { key: "ACT06", act: 0 },
    ]);
    await fixture.surface.stop();
  });

  test("emits final releases only after every key and joystick alias is released", async () => {
    const fixture = await startFixture();
    fixture.midi.emit([0x90, 36, 127]);
    fixture.midi.emit([0x90, 37, 127]);
    fixture.midi.emit([0x80, 36, 0]);
    fixture.midi.emit([0x80, 37, 0]);
    fixture.midi.emit([0xb0, 20, 127]);
    fixture.midi.emit([0xb0, 21, 127]);
    fixture.midi.emit([0xb0, 20, 0]);
    fixture.midi.emit([0xb0, 21, 0]);
    await flushPromises();

    expect(fixture.keys).toEqual([
      { key: "ACT06", act: 1 },
      { key: "ACT06", act: 0 },
    ]);
    expect(fixture.joystick).toEqual([
      { angle: 0.75, distance: 1 },
      { angle: 0.75, distance: 0 },
    ]);
    await fixture.surface.stop();
  });

  test("handles CC presses and releases", async () => {
    const fixture = await startFixture();
    fixture.midi.emit([0xb0, 10, 127]);
    fixture.midi.emit([0xb0, 10, 0]);
    await flushPromises();
    expect(fixture.keys).toEqual([
      { key: "ENC", act: 1 },
      { key: "ENC", act: 0 },
    ]);
    await fixture.surface.stop();
  });

  test("overrides mapped controls while a MIDI modifier is held", async () => {
    const fixture = await startFixture();
    fixture.midi.emit([0xb0, 9, 127]);
    fixture.midi.emit([0xb0, 10, 127]);
    // Releasing the modifier first must still release the shifted destination.
    fixture.midi.emit([0xb0, 9, 0]);
    fixture.midi.emit([0xb0, 10, 0]);
    fixture.midi.emit([0xb0, 10, 127]);
    fixture.midi.emit([0xb0, 10, 0]);
    await flushPromises();
    expect(fixture.keys).toEqual([
      { key: "ACT08", act: 1 },
      { key: "ACT08", act: 0 },
      { key: "ENC", act: 1 },
      { key: "ENC", act: 0 },
    ]);
    await fixture.surface.stop();
  });

  test("turns absolute CC movement in either direction into one joystick flick", async () => {
    setSystemTime(1_000);
    const gestureProfile = {
      ...profile,
      mapping: { ...profile.mapping, joystick: { 22: "right" } },
      joystickGesture: { movementThreshold: 6, sequenceTimeoutMs: 250 },
    } satisfies MidiControllerProfile;
    const fixture = await startFixture(gestureProfile);

    // Counter-clockwise movement accumulates to one gesture.
    fixture.midi.emit([0xb0, 22, 20]);
    fixture.midi.emit([0xb0, 22, 18]);
    fixture.midi.emit([0xb0, 22, 15]);
    fixture.midi.emit([0xb0, 22, 14]);
    // Continuing the same turn cannot flood repeated actions.
    fixture.midi.emit([0xb0, 22, 5]);

    // A pause rearms it, and clockwise movement works identically.
    setSystemTime(1_251);
    fixture.midi.emit([0xb0, 22, 7]);
    fixture.midi.emit([0xb0, 22, 10]);
    fixture.midi.emit([0xb0, 22, 13]);
    await flushPromises();

    expect(fixture.joystick).toEqual([
      { angle: 0, distance: 1 },
      { angle: 0, distance: 0 },
      { angle: 0, distance: 1 },
      { angle: 0, distance: 0 },
    ]);
    await fixture.surface.stop();
  });

  test("gears relative encoders, normalizes direction, and rate-limits bursts", async () => {
    setSystemTime(1_000);
    const fixture = await startFixture();
    fixture.midi.emit([0xb0, 14, 1]);
    fixture.midi.emit([0xb0, 14, 1]);
    fixture.midi.emit([0xb0, 14, 1]);
    fixture.midi.emit([0xb0, 14, 1]);
    await flushPromises();
    expect(fixture.keys).toEqual([{ key: "ENC_CW", act: 2 }]);

    setSystemTime(1_101);
    fixture.midi.emit([0xb0, 14, 65]);
    fixture.midi.emit([0xb0, 14, 65]);
    await flushPromises();
    expect(fixture.keys.at(-1)).toEqual({ key: "ENC_CC", act: 2 });
    await fixture.surface.stop();
  });

  test("resets partial encoder motion after a direction change or sequence timeout", async () => {
    setSystemTime(1_000);
    const fixture = await startFixture();
    fixture.midi.emit([0xb0, 14, 1]);
    fixture.midi.emit([0xb0, 14, 65]);
    expect(fixture.keys).toEqual([]);
    fixture.midi.emit([0xb0, 14, 65]);
    await flushPromises();
    expect(fixture.keys).toEqual([{ key: "ENC_CC", act: 2 }]);

    setSystemTime(1_101);
    fixture.midi.emit([0xb0, 14, 1]);
    setSystemTime(1_152);
    fixture.midi.emit([0xb0, 14, 1]);
    expect(fixture.keys).toHaveLength(1);
    fixture.midi.emit([0xb0, 14, 1]);
    await flushPromises();
    expect(fixture.keys.at(-1)).toEqual({ key: "ENC_CW", act: 2 });
    await fixture.surface.stop();
  });

  test("forces held controls up when the surface disconnects", async () => {
    const fixture = await startFixture();
    fixture.midi.emit([0x90, 36, 127]);
    fixture.midi.emit([0xb0, 20, 127]);
    await flushPromises();
    await fixture.surface.stop();
    await flushPromises();
    expect(fixture.keys.at(-1)).toEqual({ key: "ACT06", act: 0 });
    expect(fixture.joystick.at(-1)).toEqual({ angle: 0.75, distance: 0 });
  });

  test("sends only changed lighting and replays it after reconnect", async () => {
    jest.useFakeTimers();
    const fixture = await startFixture();
    const lighting = emptyLightingState();
    lighting.keys.brightness = 0.5;
    await fixture.surface.applyLighting(lighting);
    await fixture.surface.applyLighting(lighting);
    expect(fixture.midi.state.sent).toEqual([[0x90, 1, 64]]);

    const changedLighting = emptyLightingState();
    changedLighting.keys.brightness = 0.25;
    await fixture.surface.applyLighting(changedLighting);
    expect(fixture.midi.state.sent).toEqual([
      [0x90, 1, 64],
      [0x90, 1, 32],
    ]);

    fixture.midi.dropConnection();
    await advanceReconnect(2);
    expect(fixture.midi.state.inputCloses).toBeGreaterThanOrEqual(1);
    expect(fixture.midi.state.outputCloses).toBeGreaterThanOrEqual(1);
    expect(fixture.midi.state.sent).toEqual([
      [0x90, 1, 64],
      [0x90, 1, 32],
      [0x90, 1, 32],
    ]);
    await fixture.surface.stop();
  });

  test("reconnects and replays lighting after an output write fails", async () => {
    jest.useFakeTimers();
    const fixture = await startFixture();
    fixture.midi.state.failNextSend = true;
    const lighting = emptyLightingState();
    lighting.keys.brightness = 1;
    await fixture.surface.applyLighting(lighting);
    await advanceReconnect();
    expect(fixture.midi.state.sent).toEqual([[0x90, 1, 127]]);
    await fixture.surface.stop();
  });

  test("closes a partially opened input when output opening fails", async () => {
    const midi = createMidiTestBackend();
    midi.state.failOutput = true;
    const surface = createMidiSurface(profile, { type: "test" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    expect(midi.state.inputCloses).toBe(1);
    await surface.stop();
  });

  test("supports input-only profiles without opening a MIDI output", async () => {
    const midi = createMidiTestBackend();
    const inputOnly = {
      displayName: "Input only",
      ports: { input: "Test In" },
      mapping: { notes: { 36: "ACT06" } },
    } satisfies MidiControllerProfile;
    const keys: CodexKeyEvent[] = [];
    const surface = createMidiSurface(inputOnly, { type: "input-only" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    await surface.start({
      emitKey: async (event) => { keys.push(event); },
      emitJoystick: async () => {},
    });
    midi.emit([0x90, 36, 127]);
    await flushPromises();
    expect(keys).toEqual([{ key: "ACT06", act: 1 }]);
    expect(midi.state.outputOpens).toBe(0);
    await surface.stop();
  });

  test("does not open ports or install reconnect work after stop wins a startup race", async () => {
    const midi = createMidiTestBackend();
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    const listPorts = midi.backend.listPorts;
    midi.backend.listPorts = async () => {
      await listGate;
      return listPorts();
    };
    const surface = createMidiSurface(profile, { type: "test" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    const starting = surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    await flushPromises();
    await surface.stop();
    releaseList();
    await starting;
    await flushPromises();
    expect(midi.state.inputOpens).toBe(0);
    expect(midi.state.outputOpens).toBe(0);
  });

  test("recovers after transient port enumeration and handle-status failures", async () => {
    jest.useFakeTimers();
    const midi = createMidiTestBackend();
    midi.state.listFailures = 1;
    const surface = createMidiSurface(profile, { type: "test" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    expect(midi.state.inputOpens).toBe(0);
    await advanceReconnect();
    expect(midi.state.inputOpens).toBe(1);

    midi.state.inputStatusFailures = 1;
    await advanceReconnect(2);
    expect(midi.state.outputOpens).toBe(2);
    expect(midi.state.inputCloses).toBeGreaterThanOrEqual(1);
    await surface.stop();
  });

  test("cleans up every candidate handle when stop wins output opening", async () => {
    const midi = createMidiTestBackend();
    midi.state.throwInputClose = true;
    let releaseOutput!: () => void;
    const outputGate = new Promise<void>((resolve) => { releaseOutput = resolve; });
    let markOutputStarted!: () => void;
    const outputStarted = new Promise<void>((resolve) => { markOutputStarted = resolve; });
    const openOutput = midi.backend.openOutput;
    midi.backend.openOutput = async (name) => {
      markOutputStarted();
      await outputGate;
      return openOutput(name);
    };
    const surface = createMidiSurface(profile, { type: "test" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    const starting = surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    await outputStarted;
    await surface.stop();
    releaseOutput();
    await starting;
    expect(midi.state.inputCloses).toBe(1);
    expect(midi.state.outputCloses).toBe(1);
  });

  test("reconnects when a controller-local decoder throws", async () => {
    jest.useFakeTimers();
    const throwingProfile = {
      ...profile,
      createSession() {
        return {
          connect(connection) { connection.ready(); },
          handleMessage() { throw new Error("bad vendor frame"); },
        };
      },
    } satisfies MidiControllerProfile;
    const midi = createMidiTestBackend();
    const surface = createMidiSurface(throwingProfile, { type: "test" }, {
      midi: midi.backend,
      logger: quietLogger,
    });
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    midi.emit([0xf0, 0x01, 0xf7]);
    await advanceReconnect();
    expect(midi.state.outputOpens).toBe(2);
    expect(midi.state.inputCloses).toBeGreaterThanOrEqual(1);
    await surface.stop();
  });
});

describe("controller profiles", () => {
  test("lists and constructs registered profiles", () => {
    expect(listControllerIds()).toEqual(["minilab3"]);
    const controller = createController({ type: "minilab3" }, { logger: quietLogger });
    expect(controller.displayName).toBe("Arturia MiniLab 3");
  });

  test("rejects unknown controller types", () => {
    expect(() => createController({ type: "unknown" }, { logger: quietLogger })).toThrow(
      'Unknown controller type "unknown". Available types: minilab3',
    );
  });

  test("uses exact input and output port overrides", async () => {
    const midi = createMidiTestBackend({ inputs: ["Custom In"], outputs: ["Custom Out"] });
    const surface = createMidiSurface(profile, {
      type: "test",
      inputName: "Custom In",
      outputName: "Custom Out",
    }, { midi: midi.backend, logger: quietLogger });
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    expect(midi.state.openedNames).toEqual(["Custom In", "Custom Out"]);
    await surface.stop();
  });

  test("does not copy an input override onto a distinct output port", async () => {
    const midi = createMidiTestBackend({ inputs: ["Custom In"], outputs: ["Test Out"] });
    const surface = createMidiSurface(profile, {
      type: "test",
      inputName: "Custom In",
    }, { midi: midi.backend, logger: quietLogger });
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    expect(midi.state.openedNames).toEqual(["Custom In", "Test Out"]);
    await surface.stop();
  });

  test("uses one override for matching input and output port names", async () => {
    const midi = createMidiTestBackend({ inputs: ["Custom Port"], outputs: ["Custom Port"] });
    const sharedPortProfile = {
      ...profile,
      ports: { input: "Default Port", output: "Default Port" },
    } satisfies MidiControllerProfile;
    const surface = createMidiSurface(
      sharedPortProfile,
      { type: "test", inputName: "Custom Port" },
      { midi: midi.backend, logger: quietLogger },
    );
    await surface.start({ emitKey: async () => {}, emitJoystick: async () => {} });
    expect(midi.state.openedNames).toEqual(["Custom Port", "Custom Port"]);
    await surface.stop();
  });
});

async function startFixture(controllerProfile: MidiControllerProfile = profile) {
  const midi = createMidiTestBackend();
  const keys: CodexKeyEvent[] = [];
  const joystick: CodexJoystickEvent[] = [];
  const surface = createMidiSurface(controllerProfile, { type: "test" }, {
    midi: midi.backend,
    logger: quietLogger,
  });
  await surface.start({
    emitKey: async (event) => { keys.push(event); },
    emitJoystick: async (event) => { joystick.push(event); },
  });
  return { midi, keys, joystick, surface };
}

async function advanceReconnect(cycles = 1): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    jest.advanceTimersByTime(1_000);
    await flushPromises();
  }
}
