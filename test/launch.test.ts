import { expect, test } from "bun:test";
import {
  applicationBundleForExecutable,
  buildLaunchServicesArguments,
} from "../src/host/launch.js";

test("derives the application bundle containing the ChatGPT executable", () => {
  expect(
    applicationBundleForExecutable("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
  ).toBe("/Applications/ChatGPT.app");
  expect(() => applicationBundleForExecutable("/tmp/ChatGPT")).toThrow(
    "must be inside a macOS application bundle",
  );
});

test("builds a LaunchServices invocation with private bridge environment", () => {
  expect(
    buildLaunchServicesArguments({
      appBundle: "/Applications/ChatGPT.app",
      appArguments: ["--example", "value with spaces"],
      environment: {
        CODEX_MIDI_SOCKET: "/tmp/socket with spaces",
        CODEX_MIDI_TOKEN: "secret",
        NODE_OPTIONS: '--require="/tmp/preload with spaces.cjs"',
      },
    }),
  ).toEqual([
    "-n",
    "-W",
    "--env",
    "CODEX_MIDI_SOCKET=/tmp/socket with spaces",
    "--env",
    "CODEX_MIDI_TOKEN=secret",
    "--env",
    'NODE_OPTIONS=--require="/tmp/preload with spaces.cjs"',
    "-a",
    "/Applications/ChatGPT.app",
    "--args",
    "--example",
    "value with spaces",
  ]);
});
