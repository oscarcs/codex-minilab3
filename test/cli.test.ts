import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const launcher = fileURLToPath(new URL("../bin/codex-minilab3", import.meta.url));

test("help paths never initialize the native MIDI addon", () => {
  for (const args of [
    ["midi", "monitor", "--help"],
    ["midi", "list", "--help"],
    ["controllers", "--help"],
    ["lighting-presets", "--help"],
  ]) {
    const result = runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  }
});

test("top-level help exposes only the public v1 commands", () => {
  const result = runCli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("codex-minilab3 bridge");
  expect(result.stdout).toContain("codex-minilab3 launch");
  expect(result.stdout).toContain("codex-minilab3 midi list");
  expect(result.stdout).toContain("codex-minilab3 midi monitor");
  expect(result.stdout).toContain("codex-minilab3 controllers");
  expect(result.stdout).toContain("codex-minilab3 lighting-presets");
  expect(result.stderr).toBe("");
});

test("lighting preset metadata is available for native launchers", () => {
  const result = runCli(["lighting-presets", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { id: "chatgpt", displayName: "ChatGPT Lighting (Default)" },
    { id: "adaptive-comet", displayName: "Adaptive Comet" },
    { id: "bass-lava", displayName: "Bass Lava" },
    { id: "tempo-kaleidoscope", displayName: "Tempo Scenes" },
  ]);
  expect(result.stderr).toBe("");
});

test("checkout CLI resolves the project and forwards commands from any directory", () => {
  const result = Bun.spawnSync([launcher, "--help"], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("codex-minilab3 launch");
  expect(result.stderr.toString()).toBe("");

  const presets = Bun.spawnSync([launcher, "lighting-presets", "--json"], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(presets.exitCode).toBe(0);
  expect(JSON.parse(presets.stdout.toString())[0]).toEqual({
    id: "chatgpt",
    displayName: "ChatGPT Lighting (Default)",
  });
  expect(presets.stderr.toString()).toBe("");
});

test("midi monitor rejects unknown options before touching hardware", () => {
  const result = runCli(["midi", "monitor", "--unknown"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unknown midi monitor option: --unknown");
  expect(result.stderr).not.toContain("MidiInCore");
});

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
