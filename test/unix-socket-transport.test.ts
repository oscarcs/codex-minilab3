import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import type {
  CodexLightingState,
  ControllerSurface,
  SurfaceInputSink,
} from "../src/core/codex-micro.js";
import { Project2077Engine } from "../src/core/project2077-engine.js";
import { UnixSocketHostTransport } from "../src/host/unix-socket-transport.js";
import { encodeIpcMessage } from "../src/host/shim-protocol.js";

test("Unix transport handshakes and carries exact 64-byte reports in both directions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-test-"));
  const socketPath = join(directory, "bridge.sock");
  const received: Buffer[] = [];
  const transport = new UnixSocketHostTransport({ socketPath, logger: quietLogger });
  await transport.start({
    onHostReport: (report) => {
      received.push(Buffer.from(report));
    },
    ...noHostLifecycle,
  });

  const client = await connect(socketPath);
  const lines = lineReader(client);
  client.write(
    encodeIpcMessage({
      v: 1,
      type: "hello",
      role: "node-hid-shim",
      path: "codex-midi://project2077",
    }),
  );
  assert.deepEqual(await lines.next(), { v: 1, type: "hello-ack" });

  const hostReport = Buffer.alloc(64, 0x5a);
  const hostLine = encodeIpcMessage({
    v: 1,
    type: "host-report",
    data: hostReport.toString("base64"),
  });
  client.write(hostLine.slice(0, 7));
  client.write(hostLine.slice(7));
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], hostReport);

  const deviceReport = Buffer.alloc(64, 0xa5);
  await transport.sendDeviceReport(deviceReport);
  const response = await lines.next();
  assert.equal(response.type, "device-report");
  assert.deepEqual(Buffer.from(response.data as string, "base64"), deviceReport);

  client.destroy();
  await transport.stop();
  await assert.rejects(stat(socketPath), /ENOENT/);
});

test("Unix transport allows only one protocol-validated Project2077 host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-test-"));
  const socketPath = join(directory, "bridge.sock");
  const transport = new UnixSocketHostTransport({ socketPath, logger: quietLogger });
  await transport.start({ onHostReport: () => {}, ...noHostLifecycle });
  const first = await connect(socketPath);
  const firstLines = lineReader(first);
  const hello = encodeIpcMessage({
    v: 1,
    type: "hello",
    role: "node-hid-shim",
    path: "codex-midi://project2077",
  });
  first.write(hello);
  assert.equal((await firstLines.next()).type, "hello-ack");

  const second = await connect(socketPath);
  const secondLines = lineReader(second);
  second.write(hello);
  const error = await secondLines.next();
  assert.equal(error.type, "error");
  assert.match(error.message as string, /already connected/);

  first.destroy();
  second.destroy();
  await transport.stop();
});

test("Unix transport rejects non-object JSON and ignores later queued messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-test-"));
  const socketPath = join(directory, "bridge.sock");
  let connections = 0;
  const reports: Uint8Array[] = [];
  const transport = new UnixSocketHostTransport({ socketPath, logger: quietLogger });
  await transport.start({
    onHostReport: (report) => { reports.push(report); },
    onHostConnected: () => { connections += 1; },
    onHostDisconnected: () => {},
  });
  const client = await connect(socketPath);
  const lines = lineReader(client);
  const validHello = encodeIpcMessage({
    v: 1,
    type: "hello",
    role: "node-hid-shim",
    path: "codex-midi://project2077",
  });
  const validReport = encodeIpcMessage({
    v: 1,
    type: "host-report",
    data: Buffer.alloc(64).toString("base64"),
  });
  client.write(`null\n${validHello}${validReport}`);
  assert.deepEqual(await lines.next(), {
    v: 1,
    type: "error",
    message: "Invalid JSON IPC message",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connections, 0);
  assert.equal(reports.length, 0);
  client.destroy();
  await transport.stop();
});

test("a failed second transport never unlinks the active transport socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-test-"));
  const socketPath = join(directory, "bridge.sock");
  const first = new UnixSocketHostTransport({ socketPath, logger: quietLogger });
  const second = new UnixSocketHostTransport({ socketPath, logger: quietLogger });
  await first.start({ onHostReport: () => {}, ...noHostLifecycle });
  await assert.rejects(
    second.start({ onHostReport: () => {}, ...noHostLifecycle }),
    /already listening/,
  );
  await second.stop();
  assert.equal((await stat(socketPath)).isSocket(), true);
  const client = await connect(socketPath);
  client.destroy();
  await first.stop();
});

test("only an authenticated shim activates the controller surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-midi-auth-test-"));
  const socketPath = join(directory, "bridge.sock");
  const surface = new CountingSurface();
  const transport = new UnixSocketHostTransport({
    socketPath,
    token: "correct-token",
    logger: quietLogger,
  });
  const engine = new Project2077Engine(transport, surface, quietLogger);
  await engine.start();

  const unauthorized = await connect(socketPath);
  const unauthorizedLines = lineReader(unauthorized);
  unauthorized.write(hello("wrong-token"));
  assert.equal((await unauthorizedLines.next()).type, "error");
  unauthorized.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(surface.starts, 0);

  const first = await connect(socketPath);
  const firstLines = lineReader(first);
  first.write(hello("correct-token"));
  assert.equal((await firstLines.next()).type, "hello-ack");
  await waitFor(() => surface.starts === 1);
  first.destroy();
  await waitFor(() => surface.stops === 1);

  const second = await connect(socketPath);
  const secondLines = lineReader(second);
  second.write(hello("correct-token"));
  assert.equal((await secondLines.next()).type, "hello-ack");
  await waitFor(() => surface.starts === 2);
  second.destroy();
  await waitFor(() => surface.stops === 2);
  await engine.stop();
});

class CountingSurface implements ControllerSurface {
  starts = 0;
  stops = 0;
  async start(_sink: SurfaceInputSink) { this.starts += 1; }
  async applyLighting(_state: Readonly<CodexLightingState>) {}
  async stop() { this.stops += 1; }
}

function hello(token: string): string {
  return encodeIpcMessage({
    v: 1,
    type: "hello",
    role: "node-hid-shim",
    path: "codex-midi://project2077",
    token,
  });
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function lineReader(socket: Socket): { next(): Promise<Record<string, unknown>> } {
  let buffer = "";
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(value);
      else waiter(value);
    }
  });
  return {
    next: () => {
      const value = queued.shift();
      return value === undefined
        ? new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve))
        : Promise.resolve(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noHostLifecycle = {
  onHostConnected: () => {},
  onHostDisconnected: () => {},
};
