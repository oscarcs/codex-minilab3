/**
 * Exercises the preload as ChatGPT loads it: an actual Node process receives it
 * through NODE_OPTIONS while Bun hosts the TypeScript bridge and assertions.
 */

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Project2077Engine } from "../src/core/project2077-engine.js";
import { UnixSocketHostTransport } from "../src/host/unix-socket-transport.js";

test("scoped preload delegates real HID and carries Project2077 reports end to end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-shim-"));
  const fixture = await writeNodeFixture(directory);
  const preload = resolve("shim/chatgpt-preload.cjs");
  const retainedNodeOptions = `--require=${JSON.stringify(fixture.electronMain)} --trace-warnings`;

  try {
    const unavailable = await runNodeFixture(fixture.runner, {
      socketPath: join(directory, "missing.sock"),
      token: "missing-token",
      preload,
      electronMain: fixture.electronMain,
      mode: "unavailable",
    });
    expect(unavailable).toEqual({
      cacheStable: true,
      scoped: true,
      unrelatedStable: true,
      sentinel: 42,
      scopedDevices: [{ path: "real", vendorId: 1 }],
      unrelatedDevices: [{ path: "real", vendorId: 1 }],
      topologyScoped: true,
      topologyWatch: "real-watch",
      topologyDevices: [],
      realOpen: "real:real-device",
      opened: [["real-device", { nonExclusive: true }]],
      environment: { nodeOptions: retainedNodeOptions },
    });

    const socketPath = join(directory, "bridge.sock");
    const token = "integration-token";
    const lifecycle = { starts: 0, stops: 0 };
    const transport = new UnixSocketHostTransport({ socketPath, token, logger: quietLogger });
    const engine = new Project2077Engine(
      transport,
      {
        async start() {
          lifecycle.starts += 1;
        },
        async applyLighting() {},
        async stop() {
          lifecycle.stops += 1;
        },
      },
      quietLogger,
    );

    await engine.start();
    try {
      const connected = await runNodeFixture(fixture.runner, {
        socketPath,
        token,
        preload,
        electronMain: fixture.electronMain,
        mode: "connected",
      });
      expect(connected.cacheStable).toBe(true);
      expect(connected.scoped).toBe(true);
      expect(connected.unrelatedStable).toBe(true);
      expect(connected.sentinel).toBe(42);
      expect(connected.scopedDevices).toEqual([
        { path: "real", vendorId: 1 },
        {
          path: "codex-midi://project2077",
          vendorId: 0x303a,
          productId: 0x8360,
          manufacturer: "Work Louder",
          product: "Codex Micro",
          usagePage: 0xff00,
          usage: 1,
          release: 0x0100,
        },
      ]);
      expect(connected.unrelatedDevices).toEqual([{ path: "real", vendorId: 1 }]);
      expect(connected.topologyScoped).toBe(true);
      expect(connected.topologyWatch).toBe("real-watch");
      expect(connected.topologyDevices).toEqual([
        {
          path: "codex-midi://project2077",
          vendorId: 0x303a,
          productId: 0x8360,
          manufacturer: "Work Louder",
          product: "Codex Micro",
          usagePage: 0xff00,
          usage: 1,
          release: 0x0100,
        },
      ]);
      expect(connected.realOpen).toBe("real:real-device");
      expect(connected.opened).toEqual([["real-device", { nonExclusive: true }]]);
      expect(connected.writeLength).toBe(64);
      expect(connected.rpc).toEqual({ id: 77, result: { version: "0.3.0" } });
      expect(connected.openedAfterSynthetic).toEqual(connected.opened);
      expect(connected.physicalDevices).toEqual([
        { path: "real", vendorId: 1 },
        {
          path: "physical-project2077",
          vendorId: 0x303a,
          productId: 0x8360,
          usagePage: 0xff00,
        },
      ]);
      expect(connected.physicalTopologyDevices).toEqual([
        { path: "physical-project2077", usagePage: 0xff00, release: 0x0100 },
      ]);
      expect(connected.environment).toEqual({ nodeOptions: retainedNodeOptions });
      await waitFor(() => lifecycle.starts === 1 && lifecycle.stops === 1);
    } finally {
      await engine.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeNodeFixture(directory: string) {
  const electronMain = join(directory, "electron-main.cjs");
  const runner = join(directory, "runner.cjs");
  const nodeHid = join(directory, "node_modules", "node-hid");
  const workLouder = join(
    directory,
    "node_modules",
    "@worklouder",
    "wl-device-kit",
    "dist",
  );
  const buildDirectory = join(directory, ".vite", "build");
  const topologyWatcher = join(directory, "native", "hid_topology_watcher.node");
  const codexMicroService = join(buildDirectory, "codex-micro-service-test.js");
  await mkdir(nodeHid, { recursive: true });
  await mkdir(workLouder, { recursive: true });
  await mkdir(buildDirectory, { recursive: true });
  await mkdir(join(directory, "native"), { recursive: true });
  await writeFile(
    electronMain,
    `Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });
Object.defineProperty(process, "type", { value: "browser", configurable: true });
require.extensions[".node"] = require.extensions[".js"];
`,
  );
  await writeFile(
    join(nodeHid, "index.js"),
    `let currentDevices = [{ path: "real", vendorId: 1 }];
const opened = [];
class HIDAsync {
  static async open(...args) {
    opened.push(args);
    return \`real:\${args[0]}\`;
  }
}
module.exports = {
  devices: () => currentDevices.map((device) => ({ ...device })),
  HIDAsync,
  opened,
  sentinel: 42,
  setDevices: (devices) => { currentDevices = devices; },
};
`,
  );
  await writeFile(
    join(workLouder, "index.js"),
    `const first = require("node-hid");
const second = require("node-hid");
module.exports = { first, second };
`,
  );
  await writeFile(
    topologyWatcher,
    `let currentDevices = [];
module.exports = {
  findCodexMicroInterfaces: () => currentDevices.map((device) => ({ ...device })),
  watch: () => "real-watch",
  setDevices: (devices) => { currentDevices = devices; },
};
`,
  );
  await writeFile(
    codexMicroService,
    `module.exports = require(${JSON.stringify(topologyWatcher)});\n`,
  );
  await writeFile(runner, NODE_RUNNER);
  return { electronMain, runner, codexMicroService };
}

interface NodeFixtureOptions {
  socketPath: string;
  token: string;
  preload: string;
  electronMain: string;
  mode: "unavailable" | "connected";
}

async function runNodeFixture(
  runner: string,
  options: NodeFixtureOptions,
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(["node", runner], {
    env: {
      ...process.env,
      CODEX_MIDI_SOCKET: options.socketPath,
      CODEX_MIDI_TOKEN: options.token,
      CODEX_MIDI_TEST_MODE: options.mode,
      CODEX_MIDI_TEST_SERVICE: fixtureServiceForRunner(runner),
      CODEX_MIDI_TEST_WATCHER: join(dirname(runner), "native", "hid_topology_watcher.node"),
      NODE_OPTIONS: `--require=${JSON.stringify(options.electronMain)} --require=${JSON.stringify(options.preload)} --trace-warnings`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Timed out waiting for Node preload fixture"));
      }, 3_000);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`Node preload fixture failed:\n${stderr || stdout}`);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function fixtureServiceForRunner(runner: string): string {
  return join(dirname(runner), ".vite", "build", "codex-micro-service-test.js");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for shim lifecycle");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NODE_RUNNER = String.raw`
const realBefore = require("node-hid");
const scoped = require("@worklouder/wl-device-kit/dist/index.js");
const realAfter = require("node-hid");
const realTopologyBefore = require(process.env.CODEX_MIDI_TEST_WATCHER);
const scopedTopology = require(process.env.CODEX_MIDI_TEST_SERVICE);

async function main() {
  const result = {
    cacheStable: scoped.first === scoped.second,
    scoped: scoped.first !== realBefore,
    unrelatedStable: realBefore === realAfter,
    sentinel: scoped.first.sentinel,
    scopedDevices: scoped.first.devices(),
    unrelatedDevices: realBefore.devices(),
    topologyScoped: scopedTopology !== realTopologyBefore,
    topologyWatch: scopedTopology.watch(() => {}),
    topologyDevices: scopedTopology.findCodexMicroInterfaces(),
    realOpen: await scoped.first.HIDAsync.open("real-device", { nonExclusive: true }),
    opened: realBefore.opened.map((entry) => [...entry]),
    environment: {
      socket: process.env.CODEX_MIDI_SOCKET,
      token: process.env.CODEX_MIDI_TOKEN,
      nodeOptions: process.env.NODE_OPTIONS,
    },
  };

  if (process.env.CODEX_MIDI_TEST_MODE === "connected") {
    const synthetic = result.scopedDevices.find(
      (device) => device.path === "codex-midi://project2077",
    );
    if (!synthetic) throw new Error("Synthetic Project2077 descriptor is missing");
    const device = await scoped.first.HIDAsync.open(synthetic.path);
    const request = Buffer.from(JSON.stringify({ method: "sys.version", params: null, id: 77 }));
    const report = Buffer.alloc(64);
    report[0] = 6;
    report[1] = 2;
    report[2] = request.length;
    request.copy(report, 3);
    const payloads = [];
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for RPC response")), 1_000);
      device.on("error", reject);
      device.on("data", (incoming) => {
        if (incoming.length !== 64 || incoming[0] !== 6 || incoming[1] !== 2) return;
        payloads.push(incoming.subarray(3, 3 + incoming[2]));
        const payload = Buffer.concat(payloads);
        if (!payload.includes(0x0a)) return;
        clearTimeout(timer);
        resolve(JSON.parse(payload.toString("utf8").trim()));
      });
    });
    result.writeLength = await device.write(report);
    result.rpc = await response;
    await device.close();
    result.openedAfterSynthetic = realBefore.opened.map((entry) => [...entry]);
    realBefore.setDevices([
      { path: "real", vendorId: 1 },
      {
        path: "physical-project2077",
        vendorId: 0x303a,
        productId: 0x8360,
        usagePage: 0xff00,
      },
    ]);
    result.physicalDevices = scoped.first.devices();
    realTopologyBefore.setDevices([
      { path: "physical-project2077", usagePage: 0xff00, release: 0x0100 },
    ]);
    result.physicalTopologyDevices = scopedTopology.findCodexMicroInterfaces();
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`;
