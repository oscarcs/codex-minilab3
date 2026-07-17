import { readFile } from "node:fs/promises";

export interface ControllerConfig {
  readonly type: string;
  readonly inputName?: string;
  readonly outputName?: string;
  readonly lightingPreset?: string;
  /** Legacy name retained for existing local configuration files. */
  readonly spectrumPreset?: string;
}

export interface BridgeConfig {
  socketPath?: string;
  controller?: ControllerConfig;
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const source = await readFile(path, "utf8");
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new TypeError("Bridge configuration must be a JSON object");
  const allowed = ["socketPath", "controller"];
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`Unknown bridge configuration option: ${unknownKey}`);
  }

  if (value.socketPath !== undefined && typeof value.socketPath !== "string") {
    throw new TypeError("socketPath must be a string");
  }

  if (value.controller !== undefined) {
    if (!isRecord(value.controller)) {
      throw new TypeError('controller must be an object such as { "type": "minilab3" }');
    }
    const allowedControllerKeys = [
      "type",
      "inputName",
      "outputName",
      "lightingPreset",
      "spectrumPreset",
    ];
    const unknownControllerKey = Object.keys(value.controller).find(
      (key) => !allowedControllerKeys.includes(key),
    );
    if (unknownControllerKey !== undefined) {
      throw new TypeError(`Unknown controller option: ${unknownControllerKey}`);
    }
    if (typeof value.controller.type !== "string" || value.controller.type.length === 0) {
      throw new TypeError("controller.type must be a non-empty string");
    }
    for (const port of ["inputName", "outputName"] as const) {
      const name = value.controller[port];
      if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
        throw new TypeError(`controller.${port} must be a non-empty string`);
      }
    }
    for (const presetKey of ["lightingPreset", "spectrumPreset"] as const) {
      const preset = value.controller[presetKey];
      if (preset !== undefined && (typeof preset !== "string" || preset.length === 0)) {
        throw new TypeError(`controller.${presetKey} must be a non-empty string`);
      }
    }
  }

  return value as BridgeConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
