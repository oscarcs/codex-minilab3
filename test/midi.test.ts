import { expect, test } from "bun:test";
import { createNativeMidiBackend } from "../src/midi/index.js";

test("native MIDI addon is lazy and enumeration always cleans up", async () => {
  let loads = 0;
  const inputs = new FakeInput();
  const outputs = new FakeOutput();
  const backend = createNativeMidiBackend(async () => {
    loads += 1;
    return {
      Input: class { constructor() { return inputs; } },
      Output: class { constructor() { return outputs; } },
    } as never;
  });

  expect(loads).toBe(0);
  expect(await backend.listPorts()).toEqual({ inputs: ["In A"], outputs: ["Out A"] });
  expect(loads).toBe(1);
  expect(inputs.destroyed).toBe(1);
  expect(outputs.destroyed).toBe(1);
});

test("native MIDI wrappers open exact ports, subscribe, send, and close", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const backend = createNativeMidiBackend(async () => ({
    Input: class { constructor() { return input; } },
    Output: class { constructor() { return output; } },
  }) as never);
  const received: number[][] = [];
  const inputHandle = await backend.openInput("In A", (_delta, message) => {
    received.push([...message]);
  });
  const outputHandle = await backend.openOutput("Out A");
  input.emit([0x90, 36, 127]);
  input.emit([0xf0, 0x7d, 0x01, 0xf7]);
  outputHandle.send([0x80, 36, 0]);
  expect(input.ignoredTypes).toEqual([false, true, true]);
  expect(received).toEqual([[0x90, 36, 127], [0xf0, 0x7d, 0x01, 0xf7]]);
  expect(output.sent).toEqual([[0x80, 36, 0]]);
  inputHandle.close();
  outputHandle.close();
  expect(input.destroyed).toBe(1);
  expect(output.destroyed).toBe(1);
});

test("failed exact input and output opens destroy their native candidates", async () => {
  const missingInput = new FakeInput();
  missingInput.inputName = "Somewhere Else";
  const failedOutput = new FakeOutput();
  failedOutput.failOpen = true;
  const backend = createNativeMidiBackend(async () => ({
    Input: class { constructor() { return missingInput; } },
    Output: class { constructor() { return failedOutput; } },
  }) as never);
  await expect(backend.openInput("Missing", () => {})).rejects.toThrow("MIDI port not found");
  await expect(backend.openOutput("Out A")).rejects.toThrow("output open failed");
  expect(missingInput.destroyed).toBe(1);
  expect(failedOutput.destroyed).toBe(1);
});

class FakeInput {
  inputName = "In A";
  destroyed = 0;
  opened = false;
  ignoredTypes: boolean[] = [];
  handler: ((delta: number, message: number[]) => void) | undefined;
  getPortCount() { return 1; }
  getPortName() { return this.inputName; }
  on(_event: string, handler: (delta: number, message: number[]) => void) { this.handler = handler; return this; }
  off() { this.handler = undefined; return this; }
  ignoreTypes(...types: boolean[]) { this.ignoredTypes = types; }
  openPort(index: number) { if (index !== 0) throw new Error("wrong input"); this.opened = true; }
  closePort() { this.opened = false; }
  isPortOpen() { return this.opened; }
  destroy() {
    this.destroyed += 1;
    this.opened = false;
  }
  emit(message: number[]) { this.handler?.(0, message); }
}

class FakeOutput {
  failOpen = false;
  destroyed = 0;
  opened = false;
  sent: number[][] = [];
  getPortCount() { return 1; }
  getPortName() { return "Out A"; }
  openPort(index: number) {
    if (this.failOpen) throw new Error("output open failed");
    if (index !== 0) throw new Error("wrong output");
    this.opened = true;
  }
  closePort() { this.opened = false; }
  isPortOpen() { return this.opened; }
  sendMessage(message: number[]) { this.sent.push(message); }
  destroy() { this.destroyed += 1; this.opened = false; }
}
