import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";
import { loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("loadConfig accepts bridge, controller ports, and a lighting preset", async () => {
  const path = await writeConfig({
    socketPath: "/tmp/codex-midi-test.sock",
    controller: {
      type: "minilab3",
      inputName: "Minilab3 Input",
      outputName: "Minilab3 Output",
      lightingPreset: "bass-lava",
    },
  });

  assert.deepEqual(await loadConfig(path), {
    socketPath: "/tmp/codex-midi-test.sock",
    controller: {
      type: "minilab3",
      inputName: "Minilab3 Input",
      outputName: "Minilab3 Output",
      lightingPreset: "bass-lava",
    },
  });
});

test("loadConfig retains the legacy spectrum preset key during migration", async () => {
  const path = await writeConfig({
    controller: { type: "minilab3", spectrumPreset: "tempo-kaleidoscope" },
  });

  assert.deepEqual(await loadConfig(path), {
    controller: { type: "minilab3", spectrumPreset: "tempo-kaleidoscope" },
  });
});

test("loadConfig rejects options outside the public v1 configuration", async () => {
  const path = await writeConfig({
    controller: { type: "minilab3", mapping: { pads: { 49: "AG05" } } },
  });

  await assert.rejects(loadConfig(path), {
    name: "TypeError",
    message: "Unknown controller option: mapping",
  });
});

test("loadConfig rejects the legacy string controller form", async () => {
  const path = await writeConfig({ controller: "minilab3" });

  await assert.rejects(loadConfig(path), {
    name: "TypeError",
    message: 'controller must be an object such as { "type": "minilab3" }',
  });
});

test("loadConfig rejects an empty lighting preset", async () => {
  const path = await writeConfig({
    controller: { type: "minilab3", lightingPreset: "" },
  });

  await assert.rejects(loadConfig(path), {
    name: "TypeError",
    message: "controller.lightingPreset must be a non-empty string",
  });
});

async function writeConfig(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-config-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
}
