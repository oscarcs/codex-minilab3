#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  loadConfig,
  type BridgeConfig,
  type ControllerConfig,
} from "./config.js";
import { createController, listControllerIds } from "./controllers/index.js";
import type { ControllerLogger } from "./controllers/controller-profile.js";
import { Project2077Engine } from "./core/project2077-engine.js";
import { UnixSocketHostTransport } from "./host/unix-socket-transport.js";
import {
  activateApplication,
  CHATGPT_APP_BUNDLE_ENV,
  launchChatGPT,
} from "./host/launch.js";
import { midi } from "./midi/index.js";
import { listLightingPresets } from "./controllers/minilab3/spectrum/index.js";

interface BridgeCliOptions {
  configPath?: string;
  socketPath?: string;
  controllerType?: string;
  verbose: boolean;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift();
  switch (command) {
    case "bridge":
      await runBridge(args);
      return;
    case "launch":
      await runLaunch(args);
      return;
    case "midi":
      await runMidi(args);
      return;
    case "controllers":
      if (takeHelp(args)) {
        process.stdout.write(CONTROLLERS_HELP);
        return;
      }
      if (args.length > 0) throw new Error(`Unknown controllers option: ${args[0]}`);
      process.stdout.write(`${listControllerIds().join("\n")}\n`);
      return;
    case "lighting-presets":
    case "spectrum-presets": // Backward-compatible alias for older launchers.
      if (takeHelp(args)) {
        process.stdout.write(LIGHTING_PRESETS_HELP);
        return;
      }
      if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
        throw new Error(`Unknown lighting-presets option: ${args[0]}`);
      }
      if (args[0] === "--json") {
        process.stdout.write(`${JSON.stringify(listLightingPresets())}\n`);
      } else {
        process.stdout.write(
          `${listLightingPresets().map(({ id, displayName }) => `${id}\t${displayName}`).join("\n")}\n`,
        );
      }
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

async function runBridge(args: string[]): Promise<void> {
  if (takeHelp(args)) {
    process.stdout.write(BRIDGE_HELP);
    return;
  }
  const cli = parseBridgeOptions(args);
  const fileConfig = cli.configPath === undefined ? {} : await loadConfig(resolve(cli.configPath));
  const config = mergeBridgeOptions(fileConfig, cli);
  const logger = createLogger(cli.verbose);
  const controller = createController(config.controller ?? DEFAULT_CONTROLLER, { logger });
  const transport = new UnixSocketHostTransport({
    ...(config.socketPath === undefined ? {} : { socketPath: config.socketPath }),
    ...(process.env.CODEX_MIDI_TOKEN === undefined ? {} : { token: process.env.CODEX_MIDI_TOKEN }),
    logger,
  });
  const chatGPTBundle = process.env[CHATGPT_APP_BUNDLE_ENV];
  const engine = new Project2077Engine(transport, controller.surface, logger, {
    ...(chatGPTBundle === undefined || chatGPTBundle.length === 0
      ? {}
      : { activateHost: () => activateApplication(chatGPTBundle) }),
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`Stopping codex-minilab3 (${signal})`);
    void engine.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("Could not stop codex-midi cleanly", error);
        process.exit(1);
      },
    );
  };
  const onTerminate = () => stop("SIGTERM");
  const exitOnInterrupt = () => stop("SIGINT");
  process.once("SIGINT", exitOnInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await engine.start();
    logger.info(`Codex MIDI bridge ready (${controller.displayName}; waiting for ChatGPT)`);
  } catch (error) {
    process.off("SIGINT", exitOnInterrupt);
    process.off("SIGTERM", onTerminate);
    throw error;
  }
}

async function runLaunch(args: string[]): Promise<void> {
  if (takeHelp(args)) {
    process.stdout.write(LAUNCH_HELP);
    return;
  }
  let configPath: string | undefined;
  let chatGPTPath: string | undefined;
  let appArguments: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      appArguments = args.slice(index + 1);
      break;
    }
    if (argument === "--config") configPath = requiredValue(args, ++index, argument);
    else if (argument === "--chatgpt") chatGPTPath = requiredValue(args, ++index, argument);
    else throw new Error(`Unknown launch option: ${argument}`);
  }
  const status = await launchChatGPT({
    ...(configPath === undefined ? {} : { configPath }),
    ...(chatGPTPath === undefined ? {} : { chatGPTPath }),
    appArguments,
  });
  process.exitCode = status;
}

async function runMidi(args: string[]): Promise<void> {
  const command = args.shift();
  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(MIDI_HELP);
    return;
  }
  if (takeHelp(args)) {
    process.stdout.write(MIDI_HELP);
    return;
  }
  if (command === "list") {
    if (args.length > 0) throw new Error(`Unknown midi list option: ${args[0]}`);
    const ports = await midi.listPorts();
    process.stdout.write(
      `MIDI inputs:\n${formatPorts(ports.inputs)}\nMIDI outputs:\n${formatPorts(ports.outputs)}\n`,
    );
    return;
  }
  if (command === "monitor") {
    let inputName: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--input") inputName = requiredValue(args, ++index, argument);
      else if (inputName === undefined && argument !== undefined && !argument.startsWith("-")) {
        inputName = argument;
      }
      else throw new Error(`Unknown midi monitor option: ${argument}`);
    }
    if (inputName === undefined) throw new Error("midi monitor requires --input <exact port name>");
    const input = await midi.openInput(inputName, (deltaTime, message) => {
      const bytes = message.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase());
      process.stdout.write(`+${(Math.max(0, deltaTime) * 1_000).toFixed(3)}ms  ${bytes.join(" ")}\n`);
    });
    process.stdout.write(`Monitoring MIDI input ${inputName}; press Ctrl-C to stop.\n`);
    try {
      await new Promise<void>((resolveSignal) => {
        const onSignal = () => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          resolveSignal();
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
      });
    } finally {
      input.close();
    }
    return;
  }
  throw new Error(`Unknown midi command: ${command}`);
}

function parseBridgeOptions(args: readonly string[]): BridgeCliOptions {
  const options: BridgeCliOptions = { verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--config":
        options.configPath = requiredValue(args, ++index, argument);
        break;
      case "--socket":
        options.socketPath = requiredValue(args, ++index, argument);
        break;
      case "--controller":
        options.controllerType = requiredValue(args, ++index, argument);
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new Error(`Unknown bridge option: ${argument}`);
    }
  }
  return options;
}

function mergeBridgeOptions(config: BridgeConfig, cli: BridgeCliOptions): BridgeConfig {
  const configuredController = config.controller ?? DEFAULT_CONTROLLER;
  const controller =
    cli.controllerType === undefined || cli.controllerType === configuredController.type
      ? configuredController
      : { type: cli.controllerType };
  return {
    ...config,
    ...(cli.socketPath === undefined ? {} : { socketPath: cli.socketPath }),
    controller,
  };
}

function requiredValue(args: readonly string[], index: number, option: string | undefined): string {
  const value = args[index];
  if (value === undefined || value.length === 0) throw new Error(`${option} requires a value`);
  return value;
}

function takeHelp(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function formatPorts(ports: readonly string[]): string {
  return ports.length === 0 ? "  (none)" : ports.map((port, index) => `  ${index}: ${port}`).join("\n");
}

function createLogger(verbose: boolean): ControllerLogger {
  return {
    debug: verbose ? console.debug.bind(console) : () => {},
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
}

const DEFAULT_CONTROLLER: ControllerConfig = { type: "minilab3" };

const HELP = `codex-minilab3 - use an Arturia MiniLab 3 as a Codex Micro

Usage:
  codex-minilab3 bridge [options]       Start the dormant compatibility bridge
  codex-minilab3 launch [options]       Launch stock ChatGPT with a temporary shim
  codex-minilab3 midi list              List exact MIDI port names
  codex-minilab3 midi monitor --input <name>
  codex-minilab3 controllers            List installed controller profiles
  codex-minilab3 lighting-presets       List MiniLab lighting presets
`;

const BRIDGE_HELP = `Usage: codex-minilab3 bridge [--config <file>] [--socket <path>] [--controller <id>] [--verbose]\n`;
const LAUNCH_HELP = `Usage: codex-minilab3 launch [--config <file>] [--chatgpt <executable>] [-- <ChatGPT args>]\n`;
const MIDI_HELP = `Usage: codex-minilab3 midi list | codex-minilab3 midi monitor --input <exact port name>\n`;
const CONTROLLERS_HELP = `Usage: codex-minilab3 controllers\n`;
const LIGHTING_PRESETS_HELP = `Usage: codex-minilab3 lighting-presets [--json]\n`;

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
