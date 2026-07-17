/**
 * The only boundary around the native MIDI addon.
 * The addon loads lazily so config, help, and unit-test paths remain hardware-free.
 */

export type MidiMessage = readonly number[];

export type MidiMessageHandler = (
  deltaTime: number,
  message: MidiMessage,
) => void;

export interface MidiPortSummary {
  inputs: string[];
  outputs: string[];
}

export interface MidiInputHandle {
  isOpen(): boolean;
  close(): void;
}

export interface MidiOutputHandle {
  isOpen(): boolean;
  send(message: MidiMessage): void;
  close(): void;
}

export interface MidiBackend {
  listPorts(): Promise<MidiPortSummary>;
  openInput(name: string, handler: MidiMessageHandler): Promise<MidiInputHandle>;
  openOutput(name: string): Promise<MidiOutputHandle>;
}

type MidiModule = typeof import("@julusian/midi");
type NativeInput = InstanceType<MidiModule["Input"]>;
type NativeOutput = InstanceType<MidiModule["Output"]>;

export const midi = createNativeMidiBackend();

export function createNativeMidiBackend(
  load = (): Promise<MidiModule> => import("@julusian/midi"),
): MidiBackend {
  return {
    async listPorts() {
      const { Input, Output } = await load();
      const input = new Input();
      const output = new Output();
      try {
        return {
          inputs: portNames(input),
          outputs: portNames(output),
        };
      } finally {
        input.destroy();
        output.destroy();
      }
    },

    async openInput(name, handler) {
      const { Input } = await load();
      const input = new Input();
      const onMessage = (deltaTime: number, message: number[]) => {
        handler(deltaTime, message);
      };
      try {
        input.on("message", onMessage);
        input.ignoreTypes(false, true, true);
        input.openPort(exactPort(input, name));
        if (!input.isPortOpen()) throw new Error(`MIDI input did not open: ${name}`);
      } catch (error) {
        closeNativeInput(input, onMessage);
        throw error;
      }

      return {
        isOpen: () => input.isPortOpen(),
        close: () => closeNativeInput(input, onMessage),
      };
    },

    async openOutput(name) {
      const { Output } = await load();
      const output = new Output();
      try {
        output.openPort(exactPort(output, name));
        if (!output.isPortOpen()) throw new Error(`MIDI output did not open: ${name}`);
      } catch (error) {
        closeNativeOutput(output);
        throw error;
      }

      return {
        isOpen: () => output.isPortOpen(),
        send: (message) => output.sendMessage([...message]),
        close: () => closeNativeOutput(output),
      };
    },
  };
}

function portNames(port: Pick<NativeInput, "getPortCount" | "getPortName">): string[] {
  return Array.from({ length: port.getPortCount() }, (_, index) => port.getPortName(index));
}

function exactPort(
  port: Pick<NativeInput, "getPortCount" | "getPortName">,
  name: string,
): number {
  const index = portNames(port).indexOf(name);
  if (index === -1) throw new Error(`MIDI port not found: ${name}`);
  return index;
}

function closeNativeInput(
  input: NativeInput,
  handler: (deltaTime: number, message: number[]) => void,
): void {
  try {
    input.off("message", handler);
    if (input.isPortOpen()) input.closePort();
  } finally {
    input.destroy();
  }
}

function closeNativeOutput(output: NativeOutput): void {
  try {
    if (output.isPortOpen()) output.closePort();
  } finally {
    output.destroy();
  }
}
