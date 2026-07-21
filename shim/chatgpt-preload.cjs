"use strict";

/*
 * Deliberately dependency-free: this file executes inside ChatGPT's privileged
 * Electron main process. It only proxies Work Louder's node-hid import and
 * carries opaque 64-byte reports to the sidecar over a local Unix socket.
 */

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const { isMainThread } = require("node:worker_threads");

const PROTOCOL_VERSION = 1;
const SYNTHETIC_PATH = "codex-midi://project2077";
const REPORT_LENGTH = 64;
const OPEN_TIMEOUT_MS = 2_000;
const MAX_IPC_BUFFER_LENGTH = 1024 * 1024;
const DEVICE_DESCRIPTOR = Object.freeze({
  path: SYNTHETIC_PATH,
  vendorId: 0x303a,
  productId: 0x8360,
  manufacturer: "Work Louder",
  product: "Codex Micro",
  usagePage: 0xff00,
  usage: 1,
  release: 0x0100,
});

function defaultSocketPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return `/tmp/codex-midi-${uid}/project2077.sock`;
}

const CONFIGURED_SOCKET_PATH = process.env.CODEX_MIDI_SOCKET || defaultSocketPath();
const CONFIGURED_TOKEN = process.env.CODEX_MIDI_TOKEN || undefined;

stripInheritedPreload();
delete process.env.CODEX_MIDI_SOCKET;
delete process.env.CODEX_MIDI_TOKEN;

function log(message) {
  const line = `[codex-midi shim] ${message}`;
  if (process.env.CODEX_MIDI_VERBOSE === "1") process.stderr.write(`${line}\n`);
}

function bridgeIsAvailable(path = CONFIGURED_SOCKET_PATH) {
  try {
    return fs.lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

function isRealProject2077(device) {
  return (
    device &&
    device.path !== SYNTHETIC_PATH &&
    device.vendorId === DEVICE_DESCRIPTOR.vendorId &&
    device.productId === DEVICE_DESCRIPTOR.productId &&
    device.usagePage === DEVICE_DESCRIPTOR.usagePage
  );
}

class VirtualHIDAsyncDevice extends EventEmitter {
  constructor(socket) {
    super();
    this._socket = socket;
    this._receiveBuffer = "";
    this._closed = false;
    this._closeEmitted = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this._receive(chunk));
    socket.on("error", (error) => this._emitError(error));
    socket.on("close", () => this._emitClose());
  }

  static open(path = CONFIGURED_SOCKET_PATH, token = CONFIGURED_TOKEN) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      let receiveBuffer = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out connecting to codex-midi at ${path}`));
      }, OPEN_TIMEOUT_MS);

      const cleanupHandshake = () => {
        clearTimeout(timeout);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onError = (error) => fail(error);
      const onClose = () => fail(new Error("codex-midi closed before completing its handshake"));
      const onData = (chunk) => {
        receiveBuffer += chunk;
        if (receiveBuffer.length > MAX_IPC_BUFFER_LENGTH) {
          fail(new Error("codex-midi handshake exceeded 1 MiB"));
          return;
        }
        for (;;) {
          const newline = receiveBuffer.indexOf("\n");
          if (newline < 0) return;
          const line = receiveBuffer.slice(0, newline);
          receiveBuffer = receiveBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            fail(new Error("codex-midi returned invalid JSON during its handshake"));
            return;
          }
          if (typeof message !== "object" || message === null || Array.isArray(message)) {
            fail(new Error("codex-midi returned an invalid handshake"));
            return;
          }
          if (
            message.v !== PROTOCOL_VERSION ||
            message.type !== "hello-ack" ||
            (token !== undefined && message.token !== token)
          ) {
            fail(new Error(message.message || "codex-midi returned an invalid handshake"));
            return;
          }
          if (settled) return;
          settled = true;
          cleanupHandshake();
          const device = new VirtualHIDAsyncDevice(socket);
          if (receiveBuffer) device._receive(receiveBuffer);
          log("virtual Project2077 handle connected");
          resolve(device);
          return;
        }
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "hello",
            role: "node-hid-shim",
            path: SYNTHETIC_PATH,
            ...(token === undefined ? {} : { token }),
          })}\n`,
        );
      });
    });
  }

  async write(dataLike) {
    if (this._closed || this._socket.destroyed) throw new Error("HID device is closed");
    const report = Buffer.from(dataLike);
    if (report.length !== REPORT_LENGTH) {
      throw new RangeError(`Project2077 writes must be ${REPORT_LENGTH} bytes`);
    }
    const line = `${JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "host-report",
      data: report.toString("base64"),
    })}\n`;
    await new Promise((resolve, reject) => {
      this._socket.write(line, (error) => (error ? reject(error) : resolve()));
    });
    return report.length;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._socket.destroyed) {
      this._emitClose();
      return;
    }
    await new Promise((resolve) => {
      this._socket.once("close", resolve);
      this._socket.end();
    });
  }

  _receive(chunk) {
    if (this._closed) return;
    this._receiveBuffer += chunk;
    if (this._receiveBuffer.length > MAX_IPC_BUFFER_LENGTH) {
      this._emitError(new Error("codex-midi IPC receive buffer exceeded 1 MiB"));
      this._socket.destroy();
      return;
    }
    for (;;) {
      const newline = this._receiveBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this._receiveBuffer.slice(0, newline);
      this._receiveBuffer = this._receiveBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this._emitError(new Error("codex-midi sent invalid JSON"));
        this._socket.destroy();
        return;
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        this._emitError(new Error("codex-midi sent an invalid IPC message"));
        this._socket.destroy();
        return;
      }
      if (message.v !== PROTOCOL_VERSION) {
        this._emitError(new Error(`Unsupported codex-midi protocol version: ${message.v}`));
        this._socket.destroy();
        return;
      }
      if (message.type === "error") {
        this._emitError(new Error(message.message || "codex-midi bridge error"));
        this._socket.destroy();
        return;
      }
      if (message.type !== "device-report" || typeof message.data !== "string") {
        this._emitError(new Error(`Unexpected codex-midi message: ${message.type}`));
        this._socket.destroy();
        return;
      }
      const report = Buffer.from(message.data, "base64");
      if (report.length !== REPORT_LENGTH || report.toString("base64") !== message.data) {
        this._emitError(new Error("codex-midi sent an invalid HID report"));
        this._socket.destroy();
        return;
      }
      this.emit("data", report);
    }
  }

  _emitError(error) {
    if (this._closed) return;
    setImmediate(() => {
      if (this._closed) return;
      if (this.listenerCount("error") > 0) this.emit("error", error);
      else log(`virtual HID error before listener attached: ${error.message}`);
    });
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._closed = true;
    this.emit("close");
  }
}

function createNodeHidProxy(realNodeHid, options = {}) {
  if (
    !realNodeHid ||
    typeof realNodeHid.devices !== "function" ||
    !realNodeHid.HIDAsync ||
    typeof realNodeHid.HIDAsync.open !== "function"
  ) {
    throw new TypeError("The installed node-hid API is not compatible with codex-midi");
  }
  const bridgeSocketPath = options.socketPath || CONFIGURED_SOCKET_PATH;
  const bridgeToken = options.token === undefined ? CONFIGURED_TOKEN : options.token;
  const RealHIDAsync = realNodeHid.HIDAsync;
  const HIDAsyncProxy = new Proxy(RealHIDAsync, {
    get(target, property, receiver) {
      if (property === "open") {
        return async (path, ...args) => {
          if (path === SYNTHETIC_PATH) {
            return VirtualHIDAsyncDevice.open(bridgeSocketPath, bridgeToken);
          }
          return Reflect.apply(target.open, target, [path, ...args]);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  return new Proxy(realNodeHid, {
    get(target, property, receiver) {
      if (property === "devices") {
        return (...args) => {
          const realDevices = Reflect.apply(target.devices, target, args);
          if (
            !Array.isArray(realDevices) ||
            realDevices.some(isRealProject2077) ||
            !bridgeIsAvailable(bridgeSocketPath)
          ) {
            return realDevices;
          }
          return [...realDevices, { ...DEVICE_DESCRIPTOR }];
        };
      }
      if (property === "HIDAsync") return HIDAsyncProxy;
      return Reflect.get(target, property, receiver);
    },
  });
}

function createTopologyWatcherProxy(realWatcher, options = {}) {
  if (
    !realWatcher ||
    typeof realWatcher.findCodexMicroInterfaces !== "function" ||
    typeof realWatcher.watch !== "function"
  ) {
    throw new TypeError("The installed HID topology watcher API is not compatible with codex-midi");
  }
  const bridgeSocketPath = options.socketPath || CONFIGURED_SOCKET_PATH;

  return new Proxy(realWatcher, {
    get(target, property, receiver) {
      if (property === "findCodexMicroInterfaces") {
        return (...args) => {
          const realDevices = Reflect.apply(target.findCodexMicroInterfaces, target, args);
          if (
            !Array.isArray(realDevices) ||
            realDevices.length > 0 ||
            !bridgeIsAvailable(bridgeSocketPath)
          ) {
            return realDevices;
          }
          return [...realDevices, { ...DEVICE_DESCRIPTOR }];
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function isCodexMicroTopologyWatcher(request, parent) {
  return (
    typeof request === "string" &&
    /[\\/]hid[_-]topology[_-]watcher\.node$/.test(request) &&
    parent &&
    typeof parent.filename === "string" &&
    /[\\/]\.vite[\\/]build[\\/]codex-micro-service-[^\\/]+\.js$/.test(parent.filename)
  );
}

function installScopedNodeHidHook() {
  if (!isMainThread) return;
  if (!process.versions.electron || process.type !== "browser") return;

  const originalLoad = Module._load;
  let nodeHidProxy;
  let topologyWatcherProxy;
  Module._load = function codexMidiModuleLoad(request, parent, isMain) {
    if (isCodexMicroTopologyWatcher(request, parent)) {
      const realWatcher = Reflect.apply(originalLoad, this, [request, parent, isMain]);
      if (topologyWatcherProxy === undefined) {
        try {
          topologyWatcherProxy = createTopologyWatcherProxy(realWatcher, {
            socketPath: CONFIGURED_SOCKET_PATH,
          });
          log(`intercepted Codex Micro HID topology watcher at ${request}`);
        } catch (error) {
          log(`HID topology watcher compatibility check failed: ${error.message}`);
          return realWatcher;
        }
      }
      return topologyWatcherProxy;
    }
    if (
      request === "node-hid" &&
      parent &&
      typeof parent.filename === "string" &&
      /[\\/]@worklouder[\\/]wl-device-kit[\\/]dist[\\/]index\.js$/.test(parent.filename)
    ) {
      const realNodeHid = Reflect.apply(originalLoad, this, [request, parent, isMain]);
      if (nodeHidProxy === undefined) {
        try {
          nodeHidProxy = createNodeHidProxy(realNodeHid, {
            socketPath: CONFIGURED_SOCKET_PATH,
            token: CONFIGURED_TOKEN,
          });
          log(`intercepted Work Louder node-hid at ${parent.filename}`);
        } catch (error) {
          log(`node-hid compatibility check failed: ${error.message}`);
          return realNodeHid;
        }
      }
      return nodeHidProxy;
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
}

function stripInheritedPreload() {
  const options = process.env.NODE_OPTIONS;
  if (!options) return;
  const remaining = stripManagedRequire(options);
  if (remaining === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = remaining;
}

function stripManagedRequire(options) {
  for (const managed of [
    `--require=${JSON.stringify(__filename)}`,
    `--require=${__filename}`,
  ]) {
    const index = options.indexOf(managed);
    if (index < 0) continue;
    const before = options.slice(0, index);
    const after = options.slice(index + managed.length);
    if ((before && !/\s$/.test(before)) || (after && !/^\s/.test(after))) continue;
    return `${before}${after}`.trim().replace(/\s{2,}/g, " ") || undefined;
  }
  return options;
}

installScopedNodeHidHook();
