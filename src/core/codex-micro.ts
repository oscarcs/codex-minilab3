/** Normalized Codex Micro events, lighting, and replaceable host/controller contracts. */

export const PROJECT2077 = {
  vendorId: 0x303a,
  productId: 0x8360,
  usagePage: 0xff00,
  usage: 1,
  reportId: 6,
  rpcChannel: 2,
  reportLength: 64,
  maxPayloadLength: 61,
} as const;

export type CodexButtonKey =
  | `AG0${0 | 1 | 2 | 3 | 4 | 5}`
  | `ACT${"06" | "07" | "08" | "09" | "10" | "11" | "12"}`
  | "ENC";

export type CodexKey =
  | CodexButtonKey
  | "ENC_CW"
  | "ENC_CC";

export interface CodexKeyEvent {
  key: CodexKey;
  act: number;
  agent?: number;
}

export interface CodexJoystickEvent {
  angle: number;
  distance: number;
}

export interface ThreadLighting {
  id: number;
  color: number;
  brightness: number;
  effect: number;
  speed: number;
  syncKeysLighting: boolean;
  syncAmbientLighting: boolean;
}

export interface ZoneLighting {
  effect: number;
  brightness: number;
  speed: number;
  magic: number;
  color: number;
}

export interface CodexLightingState {
  threads: ThreadLighting[];
  keys: ZoneLighting;
  ambient: ZoneLighting;
}

export interface SurfaceInputSink {
  emitKey(event: CodexKeyEvent): Promise<void>;
  emitJoystick(event: CodexJoystickEvent): Promise<void>;
}

export interface ControllerSurface {
  start(sink: SurfaceInputSink): Promise<void>;
  applyLighting(state: Readonly<CodexLightingState>): Promise<void>;
  stop(): Promise<void>;
}

export interface HostReportHandler {
  onHostReport(report: Uint8Array): Promise<void> | void;
  onHostConnected(): Promise<void> | void;
  onHostDisconnected(): Promise<void> | void;
}

/**
 * The one replaceable boundary on the Codex side. The Unix-socket shim is the
 * first implementation; a serial USB gadget or CoreHID virtual device can
 * implement the same raw-report contract later.
 */
export interface CodexHostTransport {
  start(handler: HostReportHandler): Promise<void>;
  sendDeviceReport(report: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}

export const OFF_ZONE: ZoneLighting = {
  effect: 0,
  brightness: 0,
  speed: 0,
  magic: 0,
  color: 0,
};

export function emptyLightingState(): CodexLightingState {
  return {
    threads: Array.from({ length: 6 }, (_, id) => ({
      id,
      color: 0,
      brightness: 0,
      effect: 0,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
    keys: { ...OFF_ZONE },
    ambient: { ...OFF_ZONE },
  };
}
