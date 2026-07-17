/**
 * The controller contract shared by MIDI profiles and the generic controller
 * surface. Hardware protocol details belong in each controller's profile.
 */

import type {
  CodexButtonKey,
  CodexLightingState,
} from "../core/codex-micro.js";
import type { ControllerConfig } from "../config.js";
import type { MidiBackend, MidiMessage } from "../midi/index.js";

export type ControllerLogger = Pick<Console, "debug" | "info" | "warn" | "error">;
export type JoystickDirection = "up" | "down" | "left" | "right";

export interface ControllerContext {
  readonly logger: ControllerLogger;
  readonly midi?: MidiBackend;
}

export interface MidiMapping {
  readonly notes?: Readonly<Record<number, CodexButtonKey | null>>;
  readonly buttons?: Readonly<Record<number, CodexButtonKey | null>>;
  readonly joystick?: Readonly<Record<number, JoystickDirection | null>>;
}

export interface RelativeEncoder {
  /** One CC, or aliases used by different controller programs. */
  readonly cc: number | readonly number[];
  readonly clockwise: readonly number[];
  readonly counterClockwise: readonly number[];
  readonly pulsesPerStep: number;
  readonly minStepIntervalMs: number;
  readonly pulseSequenceTimeoutMs: number;
}

export interface MidiModifier {
  /** CC numbers that report the modifier press and release. */
  readonly buttons: readonly number[];
  /** Overrides applied while the modifier is held; unspecified controls fall through. */
  readonly mapping: MidiMapping;
}

export interface JoystickGesture {
  /** Cumulative absolute CC movement required to emit one stick flick. */
  readonly movementThreshold: number;
  /** A pause this long rearms the control for another gesture. */
  readonly sequenceTimeoutMs: number;
}

export interface LightingFrame {
  readonly id: string;
  readonly messages: readonly MidiMessage[];
}

export type DisconnectReason = "stopped" | "lost" | "error";

export interface ControllerConnection {
  readonly logger: ControllerLogger;
  send(message: MidiMessage): void;
  ready(): void;
  reconnect(): void;
}

export interface ControllerSession {
  connect(connection: ControllerConnection): void;
  handleMessage?(message: MidiMessage): boolean;
  disconnect?(reason: DisconnectReason, connection: ControllerConnection): void;
}

export interface MidiControllerProfile {
  readonly displayName: string;
  readonly ports: {
    readonly input: string;
    readonly output?: string;
  };
  /** Zero-based MIDI channel, or "any" for profiles whose program chooses it. */
  readonly inputChannel?: number | "any";
  /** Optional route-specific channels for devices whose pads and controls differ. */
  readonly noteChannel?: number | "any";
  readonly controlChannel?: number | "any";
  readonly mapping: MidiMapping;
  readonly modifier?: MidiModifier;
  readonly joystickGesture?: JoystickGesture;
  readonly encoder?: RelativeEncoder;
  createSession?(context: ControllerContext, config: Readonly<ControllerConfig>): ControllerSession;
  renderLighting?(
    state: Readonly<CodexLightingState>,
    config: Readonly<ControllerConfig>,
  ): readonly LightingFrame[];
}
