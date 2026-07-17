/**
 * Adapts a controller profile to the engine-facing ControllerSurface. This is
 * the shared home for MIDI decoding, aliases, encoder pacing, reconnects, and
 * lighting replay; vendor protocols stay inside controller profiles.
 */

import type {
  CodexButtonKey,
  CodexLightingState,
  ControllerSurface,
  SurfaceInputSink,
} from "../core/codex-micro.js";
import {
  midi,
  type MidiInputHandle,
  type MidiMessage,
  type MidiOutputHandle,
} from "../midi/index.js";
import type { ControllerConfig } from "../config.js";
import type {
  ControllerConnection,
  ControllerContext,
  DisconnectReason,
  JoystickDirection,
  LightingFrame,
  MidiControllerProfile,
} from "./controller-profile.js";

type LogicalTarget =
  | { readonly kind: "key"; readonly key: CodexButtonKey }
  | { readonly kind: "joystick"; readonly direction: JoystickDirection };

interface HeldTarget {
  readonly target: LogicalTarget;
  count: number;
}

interface EncoderState {
  direction: "clockwise" | "counterClockwise";
  pulses: number;
  lastPulseAt: number;
  lastStepAt: number;
}

interface JoystickGestureState {
  value: number;
  accumulatedMovement: number;
  lastMovementAt: number;
  triggered: boolean;
}

const JOYSTICK_POSITIONS: Readonly<Record<JoystickDirection, number>> = {
  right: 0,
  down: 0.25,
  left: 0.5,
  up: 0.75,
};

export function createMidiSurface(
  profile: MidiControllerProfile,
  config: Readonly<ControllerConfig>,
  context: ControllerContext,
): ControllerSurface {
  const inputName = config.inputName ?? profile.ports.input;
  const outputName =
    config.outputName ??
    (config.inputName !== undefined && profile.ports.output === profile.ports.input
      ? config.inputName
      : profile.ports.output);
  const inputChannel = profile.inputChannel ?? 0;
  const noteChannel = profile.noteChannel ?? inputChannel;
  const controlChannel = profile.controlChannel ?? inputChannel;
  const notes = profile.mapping.notes ?? {};
  const buttons = profile.mapping.buttons ?? {};
  const joystick = profile.mapping.joystick ?? {};
  const shiftedNotes = profile.modifier?.mapping.notes ?? {};
  const shiftedButtons = profile.modifier?.mapping.buttons ?? {};
  const shiftedJoystick = profile.modifier?.mapping.joystick ?? {};
  const backend = context.midi ?? midi;
  const logger = context.logger;
  const session = profile.createSession?.(context, config);

  let sink: SurfaceInputSink | undefined;
  let input: MidiInputHandle | undefined;
  let output: MidiOutputHandle | undefined;
  let reconnectTimer: ReturnType<typeof setInterval> | undefined;
  let lightingRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let connecting = false;
  let closing = false;
  let generation = 0;
  let ready = false;
  let latestLighting: Readonly<CodexLightingState> | undefined;
  const renderedLighting = new Map<string, string>();
  const heldControls = new Map<string, string>();
  const heldTargets = new Map<string, HeldTarget>();
  const joystickGestureStates = new Map<string, JoystickGestureState>();
  let encoderState: EncoderState | undefined;
  let modifierActive = false;

  const connection: ControllerConnection = {
    logger,
    send(message) {
      if (output === undefined) throw new Error("MIDI output is not connected");
      output.send(message);
    },
    ready() {
      if (input === undefined || (outputName !== undefined && output === undefined)) return;
      ready = true;
      renderedLighting.clear();
      replayLighting();
    },
    reconnect() {
      closeConnection("error");
    },
  };

  return {
    async start(nextSink) {
      if (sink !== undefined) return;
      const startedGeneration = ++generation;
      sink = nextSink;
      await refreshConnection();
      if (sink !== undefined && generation === startedGeneration) {
        reconnectTimer = setInterval(() => void refreshConnection(), 1_000);
        if (
          profile.lightingRefreshIntervalMs !== undefined &&
          profile.lightingRefreshIntervalMs > 0
        ) {
          lightingRefreshTimer = setInterval(
            refreshLighting,
            profile.lightingRefreshIntervalMs,
          );
        }
      }
    },

    async applyLighting(state) {
      latestLighting = state;
      replayLighting();
    },

    async stop() {
      generation += 1;
      if (reconnectTimer !== undefined) clearInterval(reconnectTimer);
      reconnectTimer = undefined;
      if (lightingRefreshTimer !== undefined) clearInterval(lightingRefreshTimer);
      lightingRefreshTimer = undefined;
      closeConnection("stopped");
      sink = undefined;
    },
  };

  async function refreshConnection(): Promise<void> {
    if (connecting || sink === undefined) return;
    const activeGeneration = generation;
    connecting = true;
    try {
      if (input !== undefined && (outputName === undefined || output !== undefined)) {
        const ports = await backend.listPorts();
        if (!isActive(activeGeneration)) return;
        if (
          !input.isOpen() ||
          !ports.inputs.includes(inputName) ||
          (outputName !== undefined &&
            (output === undefined || !output.isOpen() || !ports.outputs.includes(outputName)))
        ) {
          logger.info(`${profile.displayName} MIDI port disappeared; waiting for it to return`);
          closeConnection("lost");
        }
        return;
      }

      const ports = await backend.listPorts();
      if (!isActive(activeGeneration)) return;
      if (
        !ports.inputs.includes(inputName) ||
        (outputName !== undefined && !ports.outputs.includes(outputName))
      ) {
        return;
      }

      let candidateInput: MidiInputHandle | undefined;
      let candidateOutput: MidiOutputHandle | undefined;
      try {
        candidateInput = await backend.openInput(inputName, handleMessage);
        if (!isActive(activeGeneration)) {
          closeMidiHandles(candidateInput);
          return;
        }
        if (outputName !== undefined) {
          candidateOutput = await backend.openOutput(outputName);
          if (!isActive(activeGeneration)) {
            closeMidiHandles(candidateInput, candidateOutput);
            return;
          }
        }
        input = candidateInput;
        output = candidateOutput;
      } catch (error) {
        closeMidiHandles(candidateInput, candidateOutput);
        logger.warn(`Could not open ${profile.displayName} MIDI ports`, error);
        return;
      }

      logger.info(
        `Connected to ${profile.displayName} MIDI ${
          outputName === undefined
            ? `input: ${inputName}`
            : `ports: ${inputName} / ${outputName}`
        }`,
      );
      try {
        if (session === undefined) connection.ready();
        else session.connect(connection);
      } catch (error) {
        logger.warn(`${profile.displayName} connect hook failed; reconnecting`, error);
        closeConnection("error");
      }
    } catch (error) {
      logger.warn(`Could not refresh ${profile.displayName} MIDI connection`, error);
      closeConnection("error");
    } finally {
      connecting = false;
    }
  }

  function isActive(activeGeneration: number): boolean {
    return sink !== undefined && generation === activeGeneration;
  }

  function handleMessage(_deltaTime: number, message: MidiMessage): void {
    try {
      routeMessage(message);
    } catch (error) {
      logger.warn(`${profile.displayName} MIDI decoder failed; reconnecting`, error);
      closeConnection("error");
    }
  }

  function routeMessage(message: MidiMessage): void {
    if (session?.handleMessage?.(message)) return;
    if (!ready || sink === undefined) return;
    const decoded = decodeChannelMessage(message);
    if (decoded === undefined) return;

    if (decoded.kind === "note") {
      if (noteChannel !== "any" && decoded.channel !== noteChannel) return;
      const key = modifierActive
        ? shiftedNotes[decoded.number] ?? notes[decoded.number]
        : notes[decoded.number];
      if (key !== undefined && key !== null) {
        updateControl(`note:${decoded.channel}:${decoded.number}`, { kind: "key", key }, decoded.pressed);
      }
      return;
    }

    if (controlChannel !== "any" && decoded.channel !== controlChannel) return;

    if (profile.modifier?.buttons.includes(decoded.number)) {
      modifierActive = decoded.value > 0;
      return;
    }

    if (matchesEncoderCc(decoded.number, profile.encoder?.cc)) {
      handleEncoder(decoded.value);
      return;
    }

    const key = modifierActive
      ? shiftedButtons[decoded.number] ?? buttons[decoded.number]
      : buttons[decoded.number];
    if (key !== undefined && key !== null) {
      updateControl(
        `cc:${decoded.channel}:${decoded.number}`,
        { kind: "key", key },
        decoded.value > 0,
      );
      return;
    }

    const direction = modifierActive
      ? shiftedJoystick[decoded.number] ?? joystick[decoded.number]
      : joystick[decoded.number];
    if (direction !== undefined && direction !== null) {
      const controlId = `cc:${decoded.channel}:${decoded.number}`;
      if (profile.joystickGesture === undefined) {
        updateControl(controlId, { kind: "joystick", direction }, decoded.value > 0);
      } else {
        handleJoystickGesture(controlId, direction, decoded.value);
      }
    }
  }

  function handleJoystickGesture(
    controlId: string,
    direction: JoystickDirection,
    value: number,
  ): void {
    const gesture = profile.joystickGesture;
    if (gesture === undefined || sink === undefined) return;
    const timestamp = Date.now();
    const previous = joystickGestureStates.get(controlId);
    if (previous === undefined) {
      joystickGestureStates.set(controlId, {
        value,
        accumulatedMovement: 0,
        lastMovementAt: timestamp,
        triggered: false,
      });
      return;
    }

    const movement = Math.abs(value - previous.value);
    if (movement === 0) return;
    const continues = timestamp - previous.lastMovementAt <= gesture.sequenceTimeoutMs;
    const accumulatedMovement = (continues ? previous.accumulatedMovement : 0) + movement;
    const triggered = continues && previous.triggered;
    const next = {
      value,
      accumulatedMovement,
      lastMovementAt: timestamp,
      triggered,
    };
    joystickGestureStates.set(controlId, next);
    if (triggered || accumulatedMovement < gesture.movementThreshold) return;

    next.triggered = true;
    const angle = JOYSTICK_POSITIONS[direction];
    const pulse = async () => {
      const activeSink = sink;
      if (activeSink === undefined) return;
      // Invoke both in-order now; Project2077's outbound queue preserves that
      // order on the wire while ensuring the release is never skipped.
      const press = activeSink.emitJoystick({ angle, distance: 1 });
      const release = activeSink.emitJoystick({ angle, distance: 0 });
      await Promise.all([press, release]);
    };
    dispatch(pulse(), `joystick ${direction} gesture`);
  }

  function handleEncoder(value: number): void {
    const encoder = profile.encoder;
    if (encoder === undefined || sink === undefined) return;
    const direction = encoder.clockwise.includes(value)
      ? "clockwise"
      : encoder.counterClockwise.includes(value)
        ? "counterClockwise"
        : undefined;
    if (direction === undefined) return;

    const timestamp = Date.now();
    const previous = encoderState;
    if (previous !== undefined && timestamp - previous.lastStepAt < encoder.minStepIntervalMs) {
      return;
    }

    const continues =
      previous?.direction === direction &&
      timestamp - previous.lastPulseAt <= encoder.pulseSequenceTimeoutMs;
    const pulses = continues ? previous.pulses + 1 : 1;
    const lastStepAt = previous?.lastStepAt ?? Number.NEGATIVE_INFINITY;
    if (pulses < encoder.pulsesPerStep) {
      encoderState = { direction, pulses, lastPulseAt: timestamp, lastStepAt };
      return;
    }

    encoderState = {
      direction,
      pulses: 0,
      lastPulseAt: timestamp,
      lastStepAt: timestamp,
    };
    const key = direction === "clockwise" ? "ENC_CW" : "ENC_CC";
    dispatch(sink.emitKey({ key, act: 2 }), `encoder ${direction}`);
  }

  function updateControl(id: string, target: LogicalTarget, pressed: boolean): void {
    const previousId = heldControls.get(id);
    const logicalId = target.kind === "key"
      ? `key:${target.key}`
      : `joystick:${target.direction}`;

    if (pressed) {
      if (previousId === logicalId) return;
      if (previousId !== undefined) releaseTarget(previousId);
      heldControls.set(id, logicalId);

      const held = heldTargets.get(logicalId);
      if (held !== undefined) {
        held.count += 1;
      } else {
        heldTargets.set(logicalId, { target, count: 1 });
        emitTarget(target, true);
      }
      return;
    }

    if (previousId === undefined) return;
    heldControls.delete(id);
    releaseTarget(previousId);
  }

  function releaseTarget(id: string): void {
    const held = heldTargets.get(id);
    if (held === undefined) return;
    if (held.count > 1) {
      held.count -= 1;
      return;
    }
    heldTargets.delete(id);
    emitTarget(held.target, false);
  }

  function emitTarget(target: LogicalTarget, pressed: boolean): void {
    if (sink === undefined) return;
    if (target.kind === "key") {
      dispatch(
        sink.emitKey({ key: target.key, act: pressed ? 1 : 0 }),
        `${target.key} ${pressed ? "press" : "release"}`,
      );
      return;
    }
    dispatch(
      sink.emitJoystick({
        angle: JOYSTICK_POSITIONS[target.direction],
        distance: pressed ? 1 : 0,
      }),
      `joystick ${target.direction} ${pressed ? "press" : "release"}`,
    );
  }

  function releaseHeldControls(): void {
    for (const { target } of heldTargets.values()) emitTarget(target, false);
    heldControls.clear();
    heldTargets.clear();
    joystickGestureStates.clear();
    encoderState = undefined;
    modifierActive = false;
  }

  function replayLighting(): void {
    if (!ready || latestLighting === undefined || profile.renderLighting === undefined) return;
    let frames: readonly LightingFrame[];
    try {
      frames = profile.renderLighting(latestLighting, config);
      for (const frame of frames) {
        const rendered = JSON.stringify(frame.messages);
        if (renderedLighting.get(frame.id) === rendered) continue;
        for (const message of frame.messages) connection.send(message);
        renderedLighting.set(frame.id, rendered);
      }
    } catch (error) {
      logger.warn(`${profile.displayName} lighting write failed; reconnecting`, error);
      closeConnection("error");
    }
  }

  function refreshLighting(): void {
    renderedLighting.clear();
    replayLighting();
  }

  function closeConnection(reason: DisconnectReason): void {
    if (closing || (input === undefined && output === undefined)) return;
    closing = true;
    try {
      try {
        session?.disconnect?.(reason, connection);
      } catch (error) {
        logger.debug(`${profile.displayName} disconnect hook failed`, error);
      }
      const previousInput = input;
      const previousOutput = output;
      input = undefined;
      output = undefined;
      ready = false;
      releaseHeldControls();
      renderedLighting.clear();
      closeMidiHandles(previousInput, previousOutput);
    } finally {
      closing = false;
    }
  }

  function dispatch(operation: Promise<void>, label: string): void {
    operation.catch((error: unknown) => {
      logger.warn(`Could not deliver ${profile.displayName} ${label} event`, error);
    });
  }

  function closeMidiHandles(
    inputHandle?: MidiInputHandle,
    outputHandle?: MidiOutputHandle,
  ): void {
    try {
      inputHandle?.close();
    } catch (error) {
      logger.debug(`${profile.displayName} MIDI input cleanup failed`, error);
    }
    try {
      outputHandle?.close();
    } catch (error) {
      logger.debug(`${profile.displayName} MIDI output cleanup failed`, error);
    }
  }
}

function matchesEncoderCc(number: number, configured: number | readonly number[] | undefined): boolean {
  if (configured === undefined) return false;
  return typeof configured === "number" ? number === configured : configured.includes(number);
}

type DecodedChannelMessage =
  | {
      readonly kind: "note";
      readonly channel: number;
      readonly number: number;
      readonly value: number;
      readonly pressed: boolean;
    }
  | {
      readonly kind: "cc";
      readonly channel: number;
      readonly number: number;
      readonly value: number;
    };

function decodeChannelMessage(message: MidiMessage): DecodedChannelMessage | undefined {
  if (message.length < 3) return undefined;
  const [status, number, value] = message;
  if (status === undefined || number === undefined || value === undefined) return undefined;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  if (kind === 0x90 || kind === 0x80) {
    return {
      kind: "note",
      channel,
      number,
      value,
      pressed: kind === 0x90 && value > 0,
    };
  }
  if (kind === 0xb0) return { kind: "cc", channel, number, value };
  return undefined;
}
