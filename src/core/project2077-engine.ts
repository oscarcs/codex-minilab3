/**
 * Implements the Project2077 HID/RPC protocol independently of any controller.
 * A host transport and normalized ControllerSurface are its only dependencies.
 */

import { decodeHidReport, encodeRpcLine } from "./hid-codec.js";
import {
  emptyLightingState,
  type CodexHostTransport,
  type CodexJoystickEvent,
  type CodexKeyEvent,
  type CodexLightingState,
  type ControllerSurface,
  type SurfaceInputSink,
  type ZoneLighting,
  PROJECT2077,
} from "./codex-micro.js";

interface RpcRequest {
  id?: number | string;
  method: string;
  params?: unknown;
}

interface MinimizedThreadLighting {
  id?: unknown;
  c?: unknown;
  b?: unknown;
  e?: unknown;
  s?: unknown;
  sk?: unknown;
  sa?: unknown;
}

interface MinimizedZoneLighting {
  e?: unknown;
  b?: unknown;
  s?: unknown;
  m?: unknown;
  c?: unknown;
}

const MAX_PENDING_REQUEST_BYTES = 256 * 1024;
const FIRMWARE_VERSION = "0.3.0";
type Logger = Pick<Console, "debug" | "info" | "warn" | "error">;

export class Project2077Engine implements SurfaceInputSink {
  readonly #transport: CodexHostTransport;
  readonly #surface: ControllerSurface;
  readonly #logger: Logger;
  #pendingRequest: Buffer = Buffer.alloc(0);
  #lighting: CodexLightingState = emptyLightingState();
  #started = false;
  #hostConnected = false;
  #surfaceActive = false;
  #surfaceQueue: Promise<void> = Promise.resolve();
  #outboundQueue: Promise<void> = Promise.resolve();

  constructor(
    transport: CodexHostTransport,
    surface: ControllerSurface,
    logger: Logger = console,
  ) {
    this.#transport = transport;
    this.#surface = surface;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      await this.#transport.start({
        onHostReport: (report) => this.#receiveHostReport(report),
        onHostConnected: () => {
          this.#hostConnected = true;
          return this.#queueSurfaceUpdate();
        },
        onHostDisconnected: () => {
          this.#hostConnected = false;
          this.#pendingRequest = Buffer.alloc(0);
          return this.#queueSurfaceUpdate();
        },
      });
    } catch (error) {
      this.#started = false;
      await Promise.allSettled([this.#surface.stop(), this.#transport.stop()]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#hostConnected = false;
    this.#pendingRequest = Buffer.alloc(0);
    try {
      await this.#transport.stop();
      await this.#queueSurfaceUpdate();
      await this.#outboundQueue.catch(() => undefined);
    } finally {
      if (this.#surfaceActive) {
        await this.#surface.stop();
        this.#surfaceActive = false;
      }
    }
  }

  async emitKey(event: CodexKeyEvent): Promise<void> {
    const params: { k: string; act: number; ag?: number } = {
      k: event.key,
      act: event.act,
    };
    if (event.agent !== undefined) params.ag = event.agent;
    await this.#sendMessage({ method: "v.oai.hid", params });
  }

  async emitJoystick(event: CodexJoystickEvent): Promise<void> {
    await this.#sendMessage({
      method: "v.oai.rad",
      params: {
        a: clamp(event.angle, 0, 1),
        d: clamp(event.distance, 0, 1),
      },
    });
  }

  async #receiveHostReport(report: Uint8Array): Promise<void> {
    let decoded;
    try {
      decoded = decodeHidReport(report);
    } catch (error) {
      this.#logger.warn("Ignoring malformed Project2077 HID report", error);
      return;
    }
    if (decoded.channel !== PROJECT2077.rpcChannel) return;

    this.#pendingRequest = Buffer.concat([this.#pendingRequest, decoded.payload]);
    if (this.#pendingRequest.length > MAX_PENDING_REQUEST_BYTES) {
      this.#pendingRequest = Buffer.alloc(0);
      this.#logger.warn("Discarded oversized Project2077 RPC request");
      return;
    }

    for (;;) {
      const boundary = findJsonObjectBoundary(this.#pendingRequest);
      if (boundary === null) return;
      if (boundary < 0) {
        this.#pendingRequest = Buffer.alloc(0);
        this.#logger.warn("Discarded invalid Project2077 RPC framing");
        return;
      }

      const messageBytes = this.#pendingRequest.subarray(0, boundary);
      this.#pendingRequest = trimLeadingWhitespace(this.#pendingRequest.subarray(boundary));

      let request: unknown;
      try {
        request = JSON.parse(messageBytes.toString("utf8"));
      } catch (error) {
        this.#logger.warn("Discarded invalid Project2077 JSON-RPC request", error);
        continue;
      }
      await this.#handleRpcRequest(request);
    }
  }

  async #handleRpcRequest(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.method !== "string") {
      this.#logger.warn("Ignoring Project2077 RPC value without a method");
      return;
    }

    const request = value as unknown as RpcRequest;
    const hasId = request.id !== undefined;
    try {
      let result: unknown;
      switch (request.method) {
        case "sys.version":
          result = { version: FIRMWARE_VERSION };
          break;
        case "device.status":
          result = {
            version: FIRMWARE_VERSION,
            profile_index: 0,
            layer_index: 0,
            battery: 100,
            is_charging: true,
          };
          break;
        case "v.oai.thstatus":
          this.#updateThreadLighting(request.params);
          await this.#surface.applyLighting(this.#lighting);
          result = true;
          break;
        case "v.oai.rgbcfg":
          this.#updateZoneLighting(request.params);
          await this.#surface.applyLighting(this.#lighting);
          result = true;
          break;
        default:
          if (hasId) {
            await this.#sendMessage({
              id: request.id,
              error: { code: -32601, message: `Method not found: ${request.method}` },
            });
          }
          return;
      }

      if (hasId) await this.#sendMessage({ id: request.id, result });
    } catch (error) {
      this.#logger.error(`Project2077 RPC method failed: ${request.method}`, error);
      if (hasId) {
        await this.#sendMessage({
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        });
      }
    }
  }

  #updateThreadLighting(params: unknown): void {
    if (!Array.isArray(params)) throw new TypeError("v.oai.thstatus params must be an array");
    const threads = this.#lighting.threads.map((thread) => ({ ...thread }));

    for (const value of params) {
      if (!isRecord(value)) continue;
      const minimized = value as MinimizedThreadLighting;
      if (!Number.isInteger(minimized.id)) continue;
      const id = minimized.id as number;
      if (id < 0 || id >= threads.length) continue;
      const previous = threads[id];
      if (previous === undefined) continue;
      threads[id] = {
        id,
        color: optionalNumber(minimized.c, previous.color, 0, 0xffffff),
        brightness: optionalNumber(minimized.b, previous.brightness, 0, 1),
        effect: optionalNumber(minimized.e, previous.effect, 0, 255),
        speed: optionalNumber(minimized.s, previous.speed, 0, 1),
        syncKeysLighting:
          minimized.sk === undefined ? previous.syncKeysLighting : Boolean(minimized.sk),
        syncAmbientLighting:
          minimized.sa === undefined ? previous.syncAmbientLighting : Boolean(minimized.sa),
      };
    }

    this.#lighting = { ...this.#lighting, threads };
  }

  #updateZoneLighting(params: unknown): void {
    if (!isRecord(params)) throw new TypeError("v.oai.rgbcfg params must be an object");
    this.#lighting = {
      ...this.#lighting,
      ambient: parseZoneLighting(params.ambient, this.#lighting.ambient),
      keys: parseZoneLighting(params.keys, this.#lighting.keys),
    };
  }

  async #sendMessage(value: unknown): Promise<void> {
    const send = async () => {
      for (const report of encodeRpcLine(value)) {
        await this.#transport.sendDeviceReport(report);
      }
    };
    const queued = this.#outboundQueue.then(send, send);
    this.#outboundQueue = queued.catch(() => undefined);
    await queued;
  }

  #queueSurfaceUpdate(): Promise<void> {
    const update = async () => {
      const shouldBeActive = this.#started && this.#hostConnected;
      if (shouldBeActive === this.#surfaceActive) return;
      if (shouldBeActive) {
        await this.#surface.start(this);
        this.#surfaceActive = true;
      } else {
        try {
          await this.#surface.stop();
        } finally {
          this.#surfaceActive = false;
        }
      }
    };
    this.#surfaceQueue = this.#surfaceQueue.then(update, update);
    return this.#surfaceQueue;
  }
}

function parseZoneLighting(value: unknown, previous: ZoneLighting): ZoneLighting {
  if (!isRecord(value)) return previous;
  const minimized = value as MinimizedZoneLighting;
  return {
    effect: optionalNumber(minimized.e, previous.effect, 0, 255),
    brightness: optionalNumber(minimized.b, previous.brightness, 0, 1),
    speed: optionalNumber(minimized.s, previous.speed, 0, 1),
    magic: optionalNumber(minimized.m, previous.magic, 0, 255),
    color: optionalNumber(minimized.c, previous.color, 0, 0xffffff),
  };
}

function optionalNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimLeadingWhitespace(buffer: Buffer): Buffer {
  let offset = 0;
  while (offset < buffer.length && isJsonWhitespace(buffer[offset])) offset += 1;
  return buffer.subarray(offset);
}

/** Returns an exclusive byte boundary, null when incomplete, or -1 when invalid. */
function findJsonObjectBoundary(buffer: Buffer): number | null {
  let offset = 0;
  while (offset < buffer.length && isJsonWhitespace(buffer[offset])) offset += 1;
  if (offset === buffer.length) return null;
  if (buffer[offset] !== 0x7b) return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = offset; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === undefined) return null;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b || byte === 0x5b) depth += 1;
    else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      if (depth < 0) return -1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function isJsonWhitespace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
