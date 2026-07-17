import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ControllerLogger } from "../controllers/controller-profile.js";

export type SpectrumFrame = readonly [number, number, number, number, number, number, number, number];
export type SpectrumTransientFrame = readonly [number, number, number];

export interface SpectrumAnalysisFrame {
  readonly levels?: SpectrumFrame;
  readonly transient?: SpectrumTransientFrame;
}

export type SpectrumNormalizationConfiguration =
  | {
      readonly mode: "fixed";
      readonly floorDb: number;
      readonly ceilingDb: number;
      readonly gamma: number;
    }
  | {
      readonly mode: "adaptive";
      readonly dynamicRangeDb: number;
      readonly referenceDecayDbPerFrame: number;
      readonly silenceThresholdDb: number;
      readonly gamma: number;
    };

export interface SpectrumAnalyzerConfiguration {
  readonly bandCenters: SpectrumFrame;
  readonly bandGains: SpectrumFrame;
  readonly filterQ: number;
  readonly fastDecay: number;
  readonly bodyDecay: number;
  readonly bodyAttack: number;
  readonly bodyMix: number;
  readonly transientFramesPerSecond?: number;
  readonly normalization: SpectrumNormalizationConfiguration;
}

const SOURCE_PATH = fileURLToPath(new URL("../../native/system-audio-spectrum.swift", import.meta.url));
const BUILD_DIRECTORY = fileURLToPath(new URL("../../.build/", import.meta.url));
const BINARY_PATH = fileURLToPath(new URL("../../.build/system-audio-spectrum", import.meta.url));

export class SystemAudioSpectrum {
  readonly #configuration: SpectrumAnalyzerConfiguration;
  readonly #logger: ControllerLogger;
  readonly #onFrame: (frame: SpectrumAnalysisFrame) => void;
  #child: ChildProcessWithoutNullStreams | undefined;
  #stopping = false;
  #reportedTransientFeed = false;

  constructor(
    configuration: SpectrumAnalyzerConfiguration,
    logger: ControllerLogger,
    onFrame: (frame: SpectrumAnalysisFrame) => void,
  ) {
    this.#configuration = configuration;
    this.#logger = logger;
    this.#onFrame = onFrame;
  }

  start(): void {
    if (this.#child !== undefined || process.platform !== "darwin") return;
    if (!this.#ensureHelper()) return;

    this.#stopping = false;
    this.#reportedTransientFeed = false;
    const child = spawn(BINARY_PATH, [JSON.stringify(this.#configuration)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    const output = createInterface({ input: child.stdout });
    const errors = createInterface({ input: child.stderr });
    output.on("line", (line) => this.#handleFrame(line));
    errors.on("line", (line) => {
      if (line === "READY") {
        this.#logger.info("MiniLab system-audio spectrum is active");
      } else if (line.startsWith("ERROR ")) {
        this.#logger.warn(
          "MiniLab system-audio capture failed; allow Screen & System Audio Recording, then relaunch",
          line.slice(6),
        );
      } else {
        this.#logger.debug(`MiniLab audio helper: ${line}`);
      }
    });
    child.once("error", (error) => {
      this.#logger.warn("Could not start the MiniLab system-audio helper", error);
    });
    child.once("exit", (code, signal) => {
      output.close();
      errors.close();
      if (!this.#stopping && code !== 0) {
        this.#logger.warn(`MiniLab system-audio helper exited (${code ?? signal ?? "unknown"})`);
      }
      if (this.#child === child) this.#child = undefined;
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  #ensureHelper(): boolean {
    try {
      const sourceModified = statSync(SOURCE_PATH).mtimeMs;
      let binaryModified = 0;
      try {
        binaryModified = statSync(BINARY_PATH).mtimeMs;
      } catch {
        // Compile below.
      }
      if (binaryModified >= sourceModified) return true;

      this.#logger.info("Building the MiniLab system-audio helper (first launch)");
      mkdirSync(BUILD_DIRECTORY, { recursive: true });
      const result = spawnSync(
        "/usr/bin/xcrun",
        ["swiftc", "-O", "-parse-as-library", SOURCE_PATH, "-o", BINARY_PATH],
        { encoding: "utf8" },
      );
      if (result.status !== 0) {
        this.#logger.warn(
          "Could not build the MiniLab system-audio helper",
          result.stderr.trim() || result.error,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.#logger.warn("Could not prepare the MiniLab system-audio helper", error);
      return false;
    }
  }

  #handleFrame(line: string): void {
    try {
      const value: unknown = JSON.parse(line);
      if (isNumberTuple(value, 8)) {
        this.#onFrame({ levels: clampTuple(value) as unknown as SpectrumFrame });
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const object = value as Record<string, unknown>;
      const levels = isNumberTuple(object.levels, 8)
        ? clampTuple(object.levels) as unknown as SpectrumFrame
        : undefined;
      const transient = isNumberTuple(object.transient, 3)
        ? object.transient as unknown as SpectrumTransientFrame
        : undefined;
      if (levels === undefined && transient === undefined) return;
      if (transient !== undefined && !this.#reportedTransientFeed) {
        this.#reportedTransientFeed = true;
        this.#logger.info("MiniLab 100 Hz transient analysis is active");
      }
      this.#onFrame({
        ...(levels === undefined ? {} : { levels }),
        ...(transient === undefined ? {} : { transient }),
      });
    } catch {
      this.#logger.debug(`Ignored malformed MiniLab spectrum frame: ${line}`);
    }
  }
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function clampTuple(value: readonly number[]): number[] {
  return value.map((item) => Math.min(1, Math.max(0, item)));
}
