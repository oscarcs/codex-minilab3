import assert from "node:assert/strict";
import { test } from "bun:test";
import { decodeHidReport, encodeHidPayload } from "../src/core/hid-codec.js";
import type {
  CodexHostTransport,
  CodexLightingState,
  ControllerSurface,
  HostReportHandler,
  SurfaceInputSink,
} from "../src/core/codex-micro.js";
import { Project2077Engine } from "../src/core/project2077-engine.js";

class FakeTransport implements CodexHostTransport {
  handler: HostReportHandler | null = null;
  readonly output: Buffer[] = [];

  async start(handler: HostReportHandler): Promise<void> {
    this.handler = handler;
  }

  async sendDeviceReport(report: Uint8Array): Promise<void> {
    this.output.push(Buffer.from(report));
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async connect(): Promise<void> {
    assert.ok(this.handler);
    await this.handler.onHostConnected?.();
  }

  async disconnect(): Promise<void> {
    assert.ok(this.handler);
    await this.handler.onHostDisconnected?.();
  }

  async send(value: unknown): Promise<void> {
    assert.ok(this.handler);
    for (const report of encodeHidPayload(Buffer.from(JSON.stringify(value)))) {
      await this.handler.onHostReport(report);
    }
  }

  messages(): unknown[] {
    const text = Buffer.concat(
      this.output.map((report) => decodeHidReport(report).payload),
    ).toString("utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
}

class FakeSurface implements ControllerSurface {
  sink: SurfaceInputSink | null = null;
  readonly lighting: CodexLightingState[] = [];

  async start(sink: SurfaceInputSink): Promise<void> {
    this.sink = sink;
  }

  async applyLighting(state: Readonly<CodexLightingState>): Promise<void> {
    this.lighting.push(structuredClone(state));
  }

  async stop(): Promise<void> {
    this.sink = null;
  }
}

class BlockingFirstWriteTransport extends FakeTransport {
  readonly firstWriteStarted = deferred<void>();
  readonly releaseFirstWrite = deferred<void>();

  override async sendDeviceReport(report: Uint8Array): Promise<void> {
    await super.sendDeviceReport(report);
    if (this.output.length === 1) {
      this.firstWriteStarted.resolve();
      await this.releaseFirstWrite.promise;
    }
  }
}

test("engine answers version and device status with exact Work Louder fields", async () => {
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  await transport.connect();
  await transport.send({ method: "sys.version", params: null, id: 0 });
  await transport.send({ method: "device.status", params: null, id: 1 });
  assert.deepEqual(transport.messages(), [
    { id: 0, result: { version: "0.3.0" } },
    {
      id: 1,
      result: {
        version: "0.3.0",
        profile_index: 0,
        layer_index: 0,
        battery: 100,
        is_charging: true,
      },
    },
  ]);
  await engine.stop();
});

test("engine applies minimized thread and zone lighting and acknowledges each call", async () => {
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  await transport.connect();
  await transport.send({
    method: "v.oai.thstatus",
    params: [{ id: 0, c: 0x123456, b: 0.5, e: 4, s: 0.4, sk: 0, sa: 1 }],
    id: 4,
  });
  await transport.send({
    method: "v.oai.rgbcfg",
    params: {
      ambient: { e: 2, b: 1, s: 0.4, m: 0, c: 0xff00ff },
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    },
    id: 5,
  });

  assert.equal(surface.lighting.length, 2);
  assert.deepEqual(surface.lighting[0]?.threads[0], {
    id: 0,
    color: 0x123456,
    brightness: 0.5,
    effect: 4,
    speed: 0.4,
    syncKeysLighting: false,
    syncAmbientLighting: true,
  });
  assert.deepEqual(surface.lighting[1]?.ambient, {
    effect: 2,
    brightness: 1,
    speed: 0.4,
    magic: 0,
    color: 0xff00ff,
  });
  assert.deepEqual(transport.messages(), [
    { id: 4, result: true },
    { id: 5, result: true },
  ]);
  await engine.stop();
});

test("surface events become exact HID and joystick notifications", async () => {
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  await transport.connect();
  assert.ok(surface.sink);
  await surface.sink.emitKey({ key: "AG00", act: 1, agent: 0 });
  await surface.sink.emitJoystick({ angle: 0, distance: 0 });
  assert.deepEqual(transport.messages(), [
    { method: "v.oai.hid", params: { k: "AG00", act: 1, ag: 0 } },
    { method: "v.oai.rad", params: { a: 0, d: 0 } },
  ]);
  await engine.stop();
});

test("disconnect discards an incomplete request and unknown methods return an RPC error", async () => {
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  await transport.connect();
  assert.ok(transport.handler);
  const incomplete = encodeHidPayload(
    Buffer.from(
      JSON.stringify({
        method: "v.oai.thstatus",
        params: [{ id: 0, c: 1, ignored: "x".repeat(100) }],
        id: 8,
      }),
    ),
  );
  assert.ok(incomplete.length > 1);
  await transport.handler.onHostReport(incomplete[0] as Buffer);
  await transport.disconnect();
  await transport.connect();
  await transport.send({ method: "does.not.exist", id: 9 });
  assert.deepEqual(transport.messages(), [
    { id: 9, error: { code: -32601, message: "Method not found: does.not.exist" } },
  ]);
  await engine.stop();
});

test("multi-report responses never interleave with controller notifications", async () => {
  const transport = new BlockingFirstWriteTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  await transport.connect();

  const statusCall = transport.send({ method: "device.status", params: null, id: 12 });
  await transport.firstWriteStarted.promise;
  assert.ok(surface.sink);
  const keyEvent = surface.sink.emitKey({ key: "AG00", act: 1 });
  transport.releaseFirstWrite.resolve();
  await Promise.all([statusCall, keyEvent]);

  assert.deepEqual(transport.messages(), [
    {
      id: 12,
      result: {
        version: "0.3.0",
        profile_index: 0,
        layer_index: 0,
        battery: 100,
        is_charging: true,
      },
    },
    { method: "v.oai.hid", params: { k: "AG00", act: 1 } },
  ]);
  await engine.stop();
});

test("surface stays dormant until a validated host connects and stops on disconnect", async () => {
  const transport = new FakeTransport();
  const surface = new FakeSurface();
  const engine = new Project2077Engine(transport, surface);
  await engine.start();
  assert.equal(surface.sink, null);
  await transport.connect();
  assert.ok(surface.sink);
  await transport.disconnect();
  assert.equal(surface.sink, null);
  await engine.stop();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
